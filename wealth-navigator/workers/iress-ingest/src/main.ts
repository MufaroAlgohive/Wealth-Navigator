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
      if (result.synced > 0) {
        lastQuoteSyncAt = new Date().toISOString();
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

// Allow env override at runtime (e.g. test scripts swap IRESS_ACCOUNT_CODE).
process.env.IRESS_ACCOUNT_CODE = process.env.IRESS_ACCOUNT_CODE ?? lastAccountCode;
