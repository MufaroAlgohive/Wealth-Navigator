import { isSupabaseConfigured, createServiceRoleClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export type WorkerEventLevel = "info" | "warn" | "error";

export interface WorkerEvent {
  ts: string;
  level: WorkerEventLevel;
  event: string;
  msg?: string;
  data?: Record<string, unknown>;
}

export interface WorkerHealthRow {
  worker_id: string;
  service_name: string;
  status: string;
  last_heartbeat_at: string;
  last_quote_sync_at: string | null;
  iress_mode: string | null;
  metadata: Record<string, unknown>;
  updated_at: string;
  symbols_covered?: string[];
  symbol_exchanges?: Record<string, string>;
  accounts?: string[];
  account_configured?: boolean;
  /**
   * Newest-first structured events the worker emitted since the last
   * restart — cap 50. Sourced from `metadata.recent_events` on the
   * heartbeat row, written by `workers/iress-ingest/src/events.ts`.
   * Includes `time_series_entitlement_missing`, `license_seat_occupied`,
   * `quote_sync_complete`, `pricing_quote_get_failed`, etc. Used by
   * `/oems/integration`'s "Worker diagnostic events" panel.
   */
  recent_events?: WorkerEvent[];
}

function normalizeEventList(input: unknown): WorkerEvent[] {
  if (!Array.isArray(input)) return [];
  const out: WorkerEvent[] = [];
  for (const raw of input) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    if (typeof r.event !== "string" || typeof r.ts !== "string") continue;
    const level: WorkerEventLevel =
      r.level === "warn" || r.level === "error" || r.level === "info" ? r.level : "info";
    const ev: WorkerEvent = { ts: r.ts, level, event: r.event };
    if (typeof r.msg === "string") ev.msg = r.msg;
    if (r.data && typeof r.data === "object" && !Array.isArray(r.data)) {
      ev.data = r.data as Record<string, unknown>;
    }
    out.push(ev);
  }
  return out;
}

export async function GET() {
  if (!isSupabaseConfigured()) {
    return Response.json(
      { error: "Supabase not configured", workers: [] as WorkerHealthRow[] },
      { status: 503 },
    );
  }

  const supabase = createServiceRoleClient();
  const { data, error } = await supabase
    .from("integration_worker_health")
    .select("*")
    .order("last_heartbeat_at", { ascending: false });

  if (error) {
    return Response.json({ error: error.message, workers: [] as WorkerHealthRow[] }, { status: 500 });
  }

  // Audit #2 — ghost-worker filter. Railway's deploy-hooks can leave a
  // prior replica's heartbeat row in `integration_worker_health` if its
  // `main.ts` shutdown handler didn't run (or ran but the final upsert
  // never landed). Until the operator deletes the ghost service, that
  // row is still a valid `last_heartbeat_at` candidate and the page
  // renders two workers. Filter here:
  //   1. Drop `status = "stopped"` rows (worker shut down cleanly).
  //   2. Pick the single most-recent `service_name` and keep only rows
  //      for that service. A "service" is one Railway deployment with
  //      one or more replicas sharing the same `service_name`.
  const rawRows = (data ?? []).filter((r) => String(r.status ?? "").toLowerCase() !== "stopped");
  // Use the most-recent row's `service_name` (Railway gives each
  // deployment a stable service name like "Iress-Worker") as the
  // primary identity. If multiple replicas of the same service are
  // heartbeating, the operator wants to see all of them — the page
  // aggregates the timestamps into "primary worker" via
  // `pickPrimaryWorker` in `src/lib/hooks/use-worker-health.ts`.
  const primary = rawRows[0];
  const primaryService = primary?.service_name ?? null;
  const primaryWorkerId = primary?.worker_id ?? null;
  const liveRows = rawRows.filter(
    (r) => primaryService == null || r.service_name === primaryService || r.worker_id === primaryWorkerId,
  );

  const workers = liveRows.map((row) => {
    const meta = (row.metadata ?? {}) as Record<string, unknown>;
    const symbols = meta.symbols_covered;
    const symbolExchanges = meta.symbol_exchanges;
    const accounts = meta.accounts;
    return {
      ...row,
      metadata: meta,
      symbols_covered: Array.isArray(symbols) ? (symbols as string[]) : undefined,
      symbol_exchanges:
        symbolExchanges && typeof symbolExchanges === "object" && !Array.isArray(symbolExchanges)
          ? (symbolExchanges as Record<string, string>)
          : undefined,
      accounts: Array.isArray(accounts) ? (accounts as string[]) : [],
      account_configured: typeof meta.account_configured === "boolean"
        ? (meta.account_configured as boolean)
        : Array.isArray(accounts) && accounts.length > 0,
      recent_events: normalizeEventList(meta.recent_events),
    } satisfies WorkerHealthRow;
  });

  return Response.json({
    workers,
    count: workers.length,
    /**
     * Number of rows dropped by the ghost filter. Surfaced in the
     * integration page as a "n ghost worker rows hidden" notice so the
     * operator knows the safety net is doing its job.
     */
    ghostRowsHidden: (data ?? []).length - workers.length,
  });
}
