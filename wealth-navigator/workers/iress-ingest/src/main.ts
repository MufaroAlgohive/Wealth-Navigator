/**
 * Railway IRESS ingest worker — owns one IRESS license seat, syncs quotes to Supabase.
 *
 * Run from wealth-navigator root:
 *   bun run workers/iress-ingest/src/main.ts
 */

import { loadWorkerEnv } from "./env";
import { syncWatchlistQuotes } from "./quotes";
import { WorkerSessionManager, LICENSE_RELEASE_DELAY_MS } from "./session";
import { createWorkerSupabase, writeHeartbeat } from "./supabase";
import { runHealthLoop } from "./health";
import { pollAccountsForOrders } from "./orders";
import { startHttpApi } from "./http-api";
import { loadTimeSeriesConfig, syncTimeSeries } from "./timeseries";
import { loadIpsConfig, syncIps } from "./ips";

const env = loadWorkerEnv();

if (env.iressMode === "live") {
  const missing = [
    !process.env.IRESS_USERNAME && "IRESS_USERNAME",
    !process.env.IRESS_PASSWORD && "IRESS_PASSWORD",
    !process.env.IRESS_COMPANY_NAME && "IRESS_COMPANY_NAME",
  ].filter(Boolean) as string[];
  if (missing.length > 0) {
    console.error(
      `[iress-ingest] refusing to start: IRESS_MODE=live but missing ${missing.join(", ")}`,
    );
    process.exit(1);
  }
}

const sessions = new WorkerSessionManager({
  workerId: env.workerId,
  node: process.env.HOSTNAME ?? process.env.RAILWAY_REPLICA_ID ?? env.workerId,
  applicationLabel: env.applicationLabel,
  supabase: null, // bound after the live client is built
  allowWrites: env.allowWrites,
  dryRun: env.dryRun,
});
const supabase = createWorkerSupabase(env);

// Rebind supabase on the session manager now that it exists.
(sessions as unknown as { deps: { supabase: typeof supabase } }).deps.supabase = supabase;

let shuttingDown = false;
let lastQuoteSyncAt: string | undefined;
let lastAccountCode = env.iressAccountCode;
const timeSeriesConfig = loadTimeSeriesConfig(env);
const ipsConfig = loadIpsConfig(env);

function logStartup(): void {
  console.info(
    JSON.stringify({
      level: "info",
      event: "starting",
      workerId: env.workerId,
      iressMode: env.iressMode,
      dryRun: env.dryRun,
      allowWrites: env.allowWrites,
      symbols: env.watchlistSymbols.length,
      heartbeatSec: env.heartbeatSec,
      quoteIntervalSec: env.quoteIntervalSec,
      orderPollSec: env.orderPollIntervalSec,
      instrumentSync: env.instrumentSync,
    }),
  );
  if (!env.dryRun && env.allowWrites) {
    console.warn(
      "[iress-ingest] WRITES ENABLED — TARGETING LIVE SUPABASE. Press Ctrl+C within 10s to abort.",
    );
  }
}

async function quoteLoop(): Promise<void> {
  while (!shuttingDown) {
    try {
      const result = await syncWatchlistQuotes(env, sessions, supabase);
      // Always stamp lastQuoteSyncAt + a complete log — even on synced=0 —
      // so the heartbeat can flip to healthy and the operator can see
      // that the loop ran end-to-end. The detail line is emitted from
      // `syncWatchlistQuotes` as a structured `quote_sync_complete` event.
      lastQuoteSyncAt = new Date().toISOString();
      if (result.synced > 0) {
        console.info(
          `[iress-ingest] quote sync complete (${result.synced} symbols, ${result.missingInstruments.length} missing)`,
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[iress-ingest] quote sync error: ${msg}`);
      try {
        await writeHeartbeat(supabase, env, {
          workerId: env.workerId,
          status: "degraded",
          iressMode: env.iressMode,
          lastQuoteSyncAt,
          metadata: { error: msg },
        });
      } catch {
        /* best-effort */
      }
    }
    await sleep(env.quoteIntervalSec * 1000);
  }
}

async function orderLoop(): Promise<void> {
  if (env.orderPollIntervalSec <= 0) return;
  while (!shuttingDown) {
    try {
      const accounts = lastAccountCode
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      const result = await pollAccountsForOrders({
        env,
        sessions,
        supabase,
        accounts,
      });
      if (result.upserted > 0) {
        console.info(
          `[iress-ingest] order poll upserted ${result.upserted} orders across ${result.accounts.length} accounts`,
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[iress-ingest] order poll error: ${msg}`);
    }
    await sleep(env.orderPollIntervalSec * 1000);
  }
}

async function timeSeriesLoop(): Promise<void> {
  if (timeSeriesConfig.intervalSec <= 0) return;
  while (!shuttingDown) {
    try {
      const result = await syncTimeSeries({
        env,
        config: timeSeriesConfig,
        sessions,
        supabase,
      });
      console.info(
        JSON.stringify({
          level: "info",
          event: "time_series_sync_complete",
          source: "iress-worker",
          requested: {
            index: result.requestedIndex,
            sector: result.requestedSector,
            curve: result.requestedCurve,
          },
          ok: {
            index: result.indexPoints,
            sector: result.sectorPoints,
            curve: result.curvePoints,
          },
          errors: result.errors,
          entitlementRequired: result.entitlementRequired,
        }),
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[iress-ingest] time series sync error: ${msg}`);
    }
    await sleep(timeSeriesConfig.intervalSec * 1000);
  }
}

async function ipsLoop(): Promise<void> {
  if (ipsConfig.intervalSec <= 0) return;
  while (!shuttingDown) {
    try {
      const result = await syncIps({
        env,
        config: ipsConfig,
        sessions,
        supabase,
      });
      console.info(
        JSON.stringify({
          level: "info",
          event: "ips_sync_complete",
          source: "iress-worker",
          accountsRequested: result.accountsRequested,
          ok: {
            accounts: result.accountsUpserted,
            positions: result.positionsUpserted,
            transactions: result.transactionsUpserted,
          },
          errors: result.errors,
          entitlementRequired: result.entitlementRequired,
        }),
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[iress-ingest] ips sync error: ${msg}`);
    }
    await sleep(ipsConfig.intervalSec * 1000);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.error(`[iress-ingest] ${signal}: releasing IRESS license…`);
  try {
    await writeHeartbeat(supabase, env, {
      workerId: env.workerId,
      status: "error",
      iressMode: env.iressMode,
      lastQuoteSyncAt,
      metadata: { shutdown: signal },
    });
  } catch {
    /* best-effort */
  }
  await sessions.tearDown(LICENSE_RELEASE_DELAY_MS);
  process.exit(0);
}

process.once("SIGINT", () => {
  void shutdown("SIGINT");
});
process.once("SIGTERM", () => {
  void shutdown("SIGTERM");
});

logStartup();
void runHealthLoop({
  supabase,
  env,
  getLastQuoteSyncAt: () => lastQuoteSyncAt,
  isStopping: () => shuttingDown,
});
void quoteLoop();
void orderLoop();
void timeSeriesLoop();
void ipsLoop();

// Read-only HTTP API — bound unless explicitly disabled. The Vercel BFF
// reverse-proxies /orders, /orders/stream, and /health from these handlers
// so Next.js never holds the IRESS license seat.
if (process.env.WORKER_HTTP_DISABLED !== "1") {
  startHttpApi(
    { env, sessions, supabase },
    () => lastQuoteSyncAt,
  ).catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[iress-ingest] http api failed to start: ${message}`);
  });
}

// Allow env override at runtime (e.g. test scripts swap IRESS_ACCOUNT_CODE).
process.env.IRESS_ACCOUNT_CODE = process.env.IRESS_ACCOUNT_CODE ?? lastAccountCode;
