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

  const workers = (data ?? []).map((row) => {
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

  return Response.json({ workers, count: workers.length });
}
