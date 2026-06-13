/**
 * Worker heartbeat — writes to `integration_worker_health` every
 * `IRESS_WORKER_HEARTBEAT_SEC` seconds. Caller (main.ts) drives the loop and
 * passes in the last successful quote-sync timestamp.
 *
 * Audit #2 (worker side) — Railway redeploys can leave the prior replica
 * heartbeating if the shutdown handler doesn't write a final row with
 * `status: "stopped"`. The BFF (`/api/worker-health`) is the safety net
 * that filters stale rows, but the worker should also mark itself
 * `stopped` on clean exit so an operator inspecting
 * `integration_worker_health` directly sees the right state.
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

/**
 * Audit #2 — write a single final heartbeat with
 * `status: "stopped"`. Called from the SIGINT/SIGTERM shutdown handler
 * in main.ts. Best-effort; never throws. We do NOT set
 * `status: "error"` because the prior behavior made healthy
 * shutdowns look like a crash to the BFF ghost filter.
 */
export async function gracefulStop(opts: {
  supabase: WorkerSupabase | null;
  env: WorkerEnv;
  lastQuoteSyncAt: string | undefined;
  signal: string;
}): Promise<void> {
  try {
    await writeHeartbeat(opts.supabase, opts.env, {
      workerId: opts.env.workerId,
      status: "stopped",
      iressMode: opts.env.iressMode,
      lastQuoteSyncAt: opts.lastQuoteSyncAt,
      symbolsCovered: opts.env.watchlistSymbols,
      metadata: { shutdown: opts.signal, graceful: true },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[iress-ingest] gracefulStop heartbeat failed: ${msg}`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
