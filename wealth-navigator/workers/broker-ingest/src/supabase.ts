import { type SupabaseClient, createClient } from "@supabase/supabase-js";
import type { WorkerEnv } from "./env";

export type WorkerSupabase = SupabaseClient;

export function createInstitutionalSupabase(env: WorkerEnv): WorkerSupabase | null {
  if (!env.institutionalSupabaseUrl || !env.institutionalSupabaseKey) {
    console.warn("[broker-ingest] INSTITUTIONAL Supabase URL / service key not set — writes disabled");
    return null;
  }
  return createClient(env.institutionalSupabaseUrl, env.institutionalSupabaseKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export interface HeartbeatPayload {
  workerId: string;
  status: "healthy" | "degraded" | "error" | "stopped";
  brokerMode: string;
  lastFillSyncAt?: string;
  fillsProcessed?: number;
  metadata?: Record<string, unknown>;
}

/**
 * Best-effort heartbeat write to INSTITUTIONAL `integration_worker_health`.
 * Mirrors the iress-ingest heartbeat so /api/integration/health surfaces a
 * broker-feed row alongside the IRESS row. The `service_name` is
 * `broker-ingest` so the BFF can fan it out under a distinct key.
 */
export async function writeHeartbeat(
  supabase: WorkerSupabase | null,
  env: WorkerEnv,
  payload: HeartbeatPayload,
): Promise<void> {
  const row = {
    worker_id: payload.workerId,
    service_name: "broker-ingest",
    status: payload.status,
    last_heartbeat_at: new Date().toISOString(),
    last_quote_sync_at: payload.lastFillSyncAt ?? null,
    iress_mode: payload.brokerMode, // column reused; semantic is "mode"
    metadata: {
      fills_processed: payload.fillsProcessed ?? 0,
      poll_interval_ms: env.pollIntervalMs,
      dry_run: env.dryRun,
      allow_writes: env.allowWrites,
      broker_api_configured: Boolean(env.brokerApiUrl),
      ...(payload.metadata ?? {}),
    },
    updated_at: new Date().toISOString(),
  };

  if (env.dryRun || !env.allowWrites || !supabase) {
    console.info("[broker-ingest] heartbeat (dry-run)", JSON.stringify(row));
    return;
  }

  const { error } = await supabase.from("integration_worker_health").upsert(row, {
    onConflict: "worker_id",
  });
  if (error) {
    console.error(`[broker-ingest] heartbeat upsert failed: ${error.message}`);
  }
}
