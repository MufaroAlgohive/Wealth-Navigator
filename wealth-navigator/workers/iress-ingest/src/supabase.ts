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
