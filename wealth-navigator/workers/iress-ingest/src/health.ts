/**
 * Worker heartbeat — writes to `integration_worker_health` every
 * `IRESS_WORKER_HEARTBEAT_SEC` seconds. Caller (main.ts) drives the loop and
 * passes in the last successful quote-sync timestamp.
 */

import { writeHeartbeat, type WorkerSupabase } from "./supabase";
import type { WorkerEnv } from "./env";

export interface HealthLoopOptions {
  supabase: WorkerSupabase | null;
  env: WorkerEnv;
  getLastQuoteSyncAt: () => string | undefined;
  isStopping: () => boolean;
  intervalMs?: number;
}

export async function runHealthLoop(opts: HealthLoopOptions): Promise<void> {
  const intervalMs = opts.intervalMs ?? opts.env.heartbeatSec * 1000;
  while (!opts.isStopping()) {
    const lastQuoteSyncAt = opts.getLastQuoteSyncAt();
    const status: "healthy" | "degraded" = lastQuoteSyncAt ? "healthy" : "degraded";
    try {
      await writeHeartbeat(opts.supabase, opts.env, {
        workerId: opts.env.workerId,
        status,
        iressMode: opts.env.iressMode,
        lastQuoteSyncAt,
        symbolsCovered: opts.env.watchlistSymbols,
        metadata: { loop: "health" },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[iress-ingest] health loop error: ${msg}`);
    }
    await sleep(intervalMs);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
