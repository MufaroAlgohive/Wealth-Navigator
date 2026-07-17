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
  /**
   * Last completed quote cycle's counts. `synced === 0 && requested > 0`
   * means the loop ran end-to-end but captured nothing — a data outage that
   * still stamps `lastQuoteSyncAt` (main.ts stamps it on every non-throwing
   * cycle), so `lastQuoteSyncAt` alone cannot detect it.
   */
  getLastQuoteStats: () => { synced: number; requested: number };
  isStopping: () => boolean;
  intervalMs?: number;
}

/** Quote-loop staleness threshold, in quote intervals, before "degraded". */
const STALE_QUOTE_CYCLES = 4;

/**
 * Heartbeat status from the last quote cycle. `degraded` when: never synced;
 * or the last stamp is older than `staleMs` (loop throwing / wedged); or the
 * last cycle captured 0 of a non-empty watchlist (a total data outage that
 * still advances `lastQuoteSyncAt`). Pure + exported for unit tests.
 */
export function computeHealthStatus(args: {
  lastQuoteSyncAt: string | undefined;
  synced: number;
  requested: number;
  staleMs: number;
  now: number;
}): "healthy" | "degraded" {
  if (!args.lastQuoteSyncAt) return "degraded";
  const ts = Date.parse(args.lastQuoteSyncAt);
  if (Number.isFinite(ts) && args.now - ts > args.staleMs) return "degraded";
  if (args.requested > 0 && args.synced === 0) return "degraded";
  return "healthy";
}

export async function runHealthLoop(opts: HealthLoopOptions): Promise<void> {
  const intervalMs = opts.intervalMs ?? opts.env.heartbeatSec * 1000;
  // Degrade if the quote loop hasn't advanced in this many quote intervals.
  const staleMs = Math.max(opts.env.quoteIntervalSec, 1) * STALE_QUOTE_CYCLES * 1000;
  while (!opts.isStopping()) {
    const lastQuoteSyncAt = opts.getLastQuoteSyncAt();
    const { synced, requested } = opts.getLastQuoteStats();
    const status = computeHealthStatus({
      lastQuoteSyncAt,
      synced,
      requested,
      staleMs,
      now: Date.now(),
    });
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
