import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { WorkerEnv } from "./env";

export type WorkerSupabase = SupabaseClient;

export function createWorkerSupabase(env: WorkerEnv): WorkerSupabase | null {
  if (!env.supabaseUrl || !env.supabaseServiceKey) {
    console.warn(
      "[iress-ingest] SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set — heartbeat + writes disabled",
    );
    return null;
  }
  return createClient(env.supabaseUrl, env.supabaseServiceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export interface HeartbeatPayload {
  workerId: string;
  status: "healthy" | "degraded" | "error";
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
