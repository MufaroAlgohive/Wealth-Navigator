/**
 * Railway broker-ingest worker — Mint OEM Finalisation Phase C4.
 *
 * Polls the broker API (mock by default) every `BROKER_POLL_INTERVAL_MS`
 * for fills, writes them to INSTITUTIONAL `oems_order_audit`, marks
 * orders 'filled' when 100% covered, and flips
 * `rebalance_request_c.status='executed'` when a book completes.
 *
 * Mirrors the IRESS worker layout (env / supabase / fills / http-api /
 * index modules) so an operator familiar with one worker can run the
 * other. Distinct service_name `broker-ingest` in
 * `integration_worker_health` so `/api/integration/health` can surface
 * both rows.
 *
 * Run from `wealth-navigator/`:
 *   bun run workers/broker-ingest/src/index.ts
 */

import { loadWorkerEnv } from "./env";
import { pollOnce } from "./fills";
import { type HttpApiState, startHttpApi } from "./http-api";
import { createInstitutionalSupabase, writeHeartbeat } from "./supabase";

const env = loadWorkerEnv();
const supabase = createInstitutionalSupabase(env);

const state: HttpApiState = {
  cursor: env.initialCursor,
  pollsCompleted: 0,
  fillsApplied: 0,
  booksCompleted: [],
  rebalanceRequestIdsExecuted: [],
  lastError: null,
};

function logStartup(): void {
  console.info(
    JSON.stringify({
      level: "info",
      event: "starting",
      workerId: env.workerId,
      brokerMode: env.brokerMode,
      dryRun: env.dryRun,
      allowWrites: env.allowWrites,
      brokerApiConfigured: Boolean(env.brokerApiUrl),
      pollIntervalMs: env.pollIntervalMs,
      heartbeatSec: env.heartbeatSec,
    }),
  );
  if (!env.dryRun && env.allowWrites) {
    console.warn("[broker-ingest] WRITES ENABLED — TARGETING LIVE SUPABASE. Ctrl+C within 10s to abort.");
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pollLoop(): Promise<void> {
  while (!shuttingDown) {
    try {
      const { cursor, apply } = await pollOnce(env, supabase, state.cursor);
      state.cursor = cursor;
      state.pollsCompleted += 1;
      state.fillsApplied += apply.updatedAuditRows;
      state.booksCompleted = Array.from(new Set([...state.booksCompleted, ...apply.booksCompleted]));
      state.rebalanceRequestIdsExecuted = Array.from(
        new Set([...state.rebalanceRequestIdsExecuted, ...apply.rebalanceRequestIdsExecuted]),
      );
      state.lastError = null;
      if (apply.updatedAuditRows > 0) {
        console.info(
          JSON.stringify({
            level: "info",
            event: "fill_sync_complete",
            updated: apply.updatedAuditRows,
            booksCompleted: apply.booksCompleted.length,
            rebalanceExecuted: apply.rebalanceRequestIdsExecuted.length,
            dayOnePnlCents: apply.totalDayOnePnlCents,
          }),
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      state.lastError = msg;
      console.error(`[broker-ingest] poll iteration error: ${msg}`);
      try {
        await writeHeartbeat(supabase, env, {
          workerId: env.workerId,
          status: "degraded",
          brokerMode: env.brokerMode,
          lastFillSyncAt: state.cursor,
          fillsProcessed: state.fillsApplied,
          metadata: { error: msg, loop: "fills" },
        });
      } catch {
        /* best-effort */
      }
    }
    await sleep(env.pollIntervalMs);
  }
}

async function heartbeatLoop(): Promise<void> {
  while (!shuttingDown) {
    const status = state.lastError ? "degraded" : state.pollsCompleted > 0 ? "healthy" : "degraded";
    try {
      await writeHeartbeat(supabase, env, {
        workerId: env.workerId,
        status,
        brokerMode: env.brokerMode,
        lastFillSyncAt: state.cursor,
        fillsProcessed: state.fillsApplied,
        metadata: { loop: "heartbeat" },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[broker-ingest] heartbeat loop error: ${msg}`);
    }
    await sleep(env.heartbeatSec * 1000);
  }
}

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.error(`[broker-ingest] ${signal}: shutting down`);
  try {
    await writeHeartbeat(supabase, env, {
      workerId: env.workerId,
      status: "stopped",
      brokerMode: env.brokerMode,
      lastFillSyncAt: state.cursor,
      fillsProcessed: state.fillsApplied,
      metadata: { shutdown: signal, graceful: true },
    });
  } catch {
    /* best-effort */
  }
  process.exit(0);
}

process.once("SIGINT", () => {
  void shutdown("SIGINT");
});
process.once("SIGTERM", () => {
  void shutdown("SIGTERM");
});

// SECURITY (opt-in enforcement): the worker HTTP surface fails OPEN when
// WORKER_HTTP_TOKEN is unset (see http-api.ts checkAuth) so an auto-deploy that
// forgets the token never bricks the worker. To CLOSE that hole deliberately,
// set WORKER_HTTP_TOKEN *and* WORKER_REQUIRE_HTTP_TOKEN=1. If enforcement is
// required but the token is missing, refuse to start — loud and recoverable.
// Mirrors the iress-ingest worker so both surfaces harden the same way.
if (
  process.env.WORKER_REQUIRE_HTTP_TOKEN === "1" &&
  !process.env.WORKER_HTTP_TOKEN &&
  process.env.WORKER_HTTP_DISABLED !== "1"
) {
  console.error(
    "[broker-ingest] refusing to start: WORKER_REQUIRE_HTTP_TOKEN=1 but WORKER_HTTP_TOKEN is unset (set the token, or clear the require flag)",
  );
  process.exit(1);
}

logStartup();
void heartbeatLoop();
void pollLoop();

if (process.env.WORKER_HTTP_DISABLED !== "1") {
  if (!process.env.WORKER_HTTP_TOKEN) {
    console.error(
      "[broker-ingest] CRITICAL: worker HTTP API is UNAUTHENTICATED (WORKER_HTTP_TOKEN unset). " +
        "Anyone who can reach this port can inject fills into the audit table. " +
        "Set WORKER_HTTP_TOKEN on the worker + BFF, then WORKER_REQUIRE_HTTP_TOKEN=1 to enforce.",
    );
  }
  startHttpApi({ env, supabase, state }).catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[broker-ingest] http api failed to start: ${message}`);
  });
}
