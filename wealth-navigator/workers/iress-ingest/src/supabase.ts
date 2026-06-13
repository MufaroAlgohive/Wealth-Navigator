import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { WorkerEnv } from "./env";
import { recentWorkerEvents } from "./events";

export type WorkerSupabase = SupabaseClient;

function makeClient(url: string, key: string, label: string): WorkerSupabase | null {
  if (!url || !key) {
    console.warn(
      `[iress-ingest] ${label} Supabase URL / service key not set — writes to this target disabled`,
    );
    return null;
  }
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/**
 * INSTITUTIONAL prod (nnwz…) — desk trading book + analytics + worker ops
 * (oems_*, integration_worker_health, worker_session_metadata, curves, …).
 */
export function createInstitutionalSupabase(env: WorkerEnv): WorkerSupabase | null {
  return makeClient(env.institutionalSupabaseUrl, env.institutionalSupabaseKey, "INSTITUTIONAL");
}

/**
 * RETAIL prod (mfxng…) — shared price tables securities_c / stock_intraday_c.
 * Used by the quote-ingest loop once `RETAIL_SUPABASE_*` is configured.
 */
export function createRetailSupabase(env: WorkerEnv): WorkerSupabase | null {
  return makeClient(env.retailSupabaseUrl, env.retailSupabaseKey, "RETAIL");
}

/**
 * @deprecated Back-compat alias → INSTITUTIONAL. Prefer
 * `createInstitutionalSupabase()` / `createRetailSupabase()`.
 */
export function createWorkerSupabase(env: WorkerEnv): WorkerSupabase | null {
  return createInstitutionalSupabase(env);
}

export interface HeartbeatPayload {
  workerId: string;
  // Audit #2 — `stopped` is the clean-shutdown state the new
  // `gracefulStop()` helper writes; the BFF ghost filter treats
  // it the same as "error" (filter it out) but a human reading
  // `integration_worker_health` directly sees the right value.
  status: "healthy" | "degraded" | "error" | "stopped";
  iressMode: string;
  lastQuoteSyncAt?: string;
  symbolsCovered?: string[];
  metadata?: Record<string, unknown>;
}

export async function writeHeartbeat(
  supabase: WorkerSupabase | null,
  env: WorkerEnv,
  payload: HeartbeatPayload,
): Promise<void> {
  // Surface the env state the operator needs to see from the integration
  // page: how many symbols the worker covers, which exchanges it polls,
  // and — most importantly — whether `IRESS_ACCOUNT_CODE` is configured
  // (the worker's order poll loop is a no-op without it).
  const accounts = (env.iressAccountCode ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const row = {
    worker_id: payload.workerId,
    service_name: "iress-ingest",
    status: payload.status,
    last_heartbeat_at: new Date().toISOString(),
    last_quote_sync_at: payload.lastQuoteSyncAt ?? null,
    iress_mode: payload.iressMode,
    metadata: {
      ...(payload.metadata ?? {}),
      symbols_covered: payload.symbolsCovered ?? env.watchlistSymbols,
      // Stable list of exchanges per watchlist symbol so the UI can show
      // the rate-code routing (FX for USDZAR, MM for JIBAR_3M).
      symbol_exchanges: env.watchlistExchanges,
      // Order-mirror readiness — the integration page surfaces this as
      // "open-orders panel will stay empty" when the list is empty.
      accounts,
      account_configured: accounts.length > 0,
      // Most recent structured events (`time_series_entitlement_missing`,
      // `quote_sync_complete`, 25008 back-off, PricingQuoteGet failures,
      // …) capped at 50 newest-first. Surfaced in
      // `/oems/integration` so the operator can diagnose ingest failures
      // without tailing Railway logs. Read by the BFF at heartbeat time
      // and stored verbatim in this JSONB column — no separate table
      // needed.
      recent_events: recentWorkerEvents(),
    },
    updated_at: new Date().toISOString(),
  };

  if (env.dryRun || !env.allowWrites || !supabase) {
    console.info("[iress-ingest] heartbeat (dry-run)", JSON.stringify(row));
    return;
  }

  const { error } = await supabase.from("integration_worker_health").upsert(row, {
    onConflict: "worker_id",
  });
  if (error) {
    console.error(`[iress-ingest] heartbeat upsert failed: ${error.message}`);
  }
}
