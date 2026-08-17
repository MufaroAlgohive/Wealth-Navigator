/**
 * Railway IRESS ingest worker — owns one IRESS license seat, syncs quotes to Supabase.
 *
 * Run from wealth-navigator root:
 *   bun run workers/iress-ingest/src/main.ts
 */

import { syncBondUniverse } from "./bonds";
import { loadWorkerEnv } from "./env";
import { gracefulStop, runHealthLoop } from "./health";
import { startHttpApi, type HttpApiHandle } from "./http-api";
import { loadIpsConfig, syncIps } from "./ips";
import { pollUatForFills, stampLastUatPollAt } from "./order-poller";
import { pollAccountsForOrders } from "./orders";
import { syncWatchlistQuotes } from "./quotes";
import { syncRetailPrices } from "./retail-ingest";
import { syncNewsHeadlines } from "./news-ingest";
import { evaluateTriggers } from "./alerts";
import { LICENSE_RELEASE_DELAY_MS, WorkerSessionManager } from "./session";
import { tearDownMarketDataSession } from "./market-data";
import { createInstitutionalSupabase, createRetailSupabase, writeHeartbeat } from "./supabase";
import { loadTimeSeriesConfig, syncIndexIntraday, syncTimeSeries } from "./timeseries";

const env = loadWorkerEnv();

if (env.iressMode === "live") {
  const missing = [
    !process.env.IRESS_USERNAME && "IRESS_USERNAME",
    !process.env.IRESS_PASSWORD && "IRESS_PASSWORD",
    !process.env.IRESS_COMPANY_NAME && "IRESS_COMPANY_NAME",
  ].filter(Boolean) as string[];
  if (missing.length > 0) {
    console.error(`[iress-ingest] refusing to start: IRESS_MODE=live but missing ${missing.join(", ")}`);
    process.exit(1);
  }
}

// SECURITY (opt-in enforcement): the worker HTTP surface fails OPEN when
// WORKER_HTTP_TOKEN is unset (see http-api.ts checkAuth) so an auto-deploy that
// forgets the token never takes the order seat down. To CLOSE that hole
// deliberately, set WORKER_HTTP_TOKEN *and* WORKER_REQUIRE_HTTP_TOKEN=1. If
// enforcement is required but the token is missing, refuse to start — loud and
// recoverable, mirroring the IRESS-cred fail-fast above.
if (
  process.env.WORKER_REQUIRE_HTTP_TOKEN === "1" &&
  !process.env.WORKER_HTTP_TOKEN &&
  process.env.WORKER_HTTP_DISABLED !== "1"
) {
  console.error(
    "[iress-ingest] refusing to start: WORKER_REQUIRE_HTTP_TOKEN=1 but WORKER_HTTP_TOKEN is unset (set the token, or clear the require flag)",
  );
  process.exit(1);
}

const sessions = new WorkerSessionManager({
  workerId: env.workerId,
  node: process.env.HOSTNAME ?? process.env.RAILWAY_REPLICA_ID ?? env.workerId,
  applicationLabel: env.applicationLabel,
  supabase: null, // bound after the live client is built
  allowWrites: env.allowWrites,
  dryRun: env.dryRun,
  // Deploy-time seat recovery (2026-08-17). Off by default so a
  // long-running worker does NOT kick live IRESS Chrome/CT/terminal
  // sessions on every restart. Operator flips this on for ONE deploy
  // cycle when the new worker is 25008-looping against an orphan from
  // the prior replica — see `IRESS_RESET_ON_BOOT` doc in env.ts.
  resetOnBoot: env.resetOnBoot,
});
// 3-DB topology (docs/DB_TOPOLOGY_DECISION.md): trading book + analytics +
// worker ops on the INSTITUTIONAL prod (nnwz…); the live retail price feed
// (the Yahoo replacement) lands on the RETAIL prod (mfxng…) via retailIngestLoop().
const supabase = createInstitutionalSupabase(env);
// Retail price-feed target. createRetailSupabase falls back to the legacy pair,
// so we ALSO require an explicit RETAIL_SUPABASE_URL + IRESS_RETAIL_INGEST=1
// before the retail loop runs — guaranteeing no accidental writes to the live
// consumer DB until we deliberately enable it. Writes still honour dryRun/allowWrites.
const retailSupabase = createRetailSupabase(env);
const retailIngestEnabled =
  process.env.IRESS_RETAIL_INGEST === "1" && Boolean(process.env.RETAIL_SUPABASE_URL);
const retailIngestIntervalSec = Math.max(60, Number(process.env.IRESS_RETAIL_INGEST_INTERVAL_SEC ?? "300"));

// Rebind supabase on the session manager now that it exists (worker_session_metadata is institutional).
(sessions as unknown as { deps: { supabase: typeof supabase } }).deps.supabase = supabase;

let shuttingDown = false;
let lastQuoteSyncAt: string | undefined;
let lastQuoteSynced = 0;
let lastQuoteRequested = 0;
let httpApiHandle: HttpApiHandle | null = null;
const lastAccountCode = env.iressAccountCode;
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
      uatMode: env.uatMode,
      uatAccountCode: env.uatAccountCode || null,
      uatOrderPollSec: env.uatOrderPollSec,
    }),
  );
  if (!env.dryRun && env.allowWrites) {
    console.warn(
      "[iress-ingest] WRITES ENABLED — TARGETING LIVE SUPABASE. Press Ctrl+C within 10s to abort.",
    );
  }
  if (env.uatMode && !env.uatAccountCode) {
    console.warn(
      "[iress-ingest] IRESS_UAT_MODE=1 but IRESS_UAT_ACCOUNT_CODE is unset — UAT order routing will return 503. Set the UAT account to enable send-to-market.",
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
      lastQuoteSynced = result.synced;
      lastQuoteRequested = result.requested;
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

async function uatOrderLoop(): Promise<void> {
  // UAT mode is opt-in. When on, polls the worker-configured
  // `IRESS_UAT_ACCOUNT_CODE` (separate broker account) and writes fills back
  // to `oems_order_audit` for the OEMS Order Book UI. Off in production.
  if (!env.uatMode) return;
  if (!env.uatAccountCode) {
    console.warn(
      "[iress-ingest] UAT mode is on but IRESS_UAT_ACCOUNT_CODE is empty — UAT order poll loop disabled",
    );
    return;
  }
  console.info(
    `[iress-ingest] UAT order poll ENABLED → account=${env.uatAccountCode} interval=${env.uatOrderPollSec}s`,
  );
  while (!shuttingDown) {
    try {
      stampLastUatPollAt();
      const r = await pollUatForFills({ env, sessions, supabase });
      if (r.updated > 0 || r.published > 0) {
        console.info(
          `[iress-ingest] uat order poll: updated=${r.updated} published=${r.published} skip=${r.skipReason ?? "—"} elapsedMs=${r.elapsedMs}`,
        );
      } else if (r.skipReason && r.skipReason !== "uat_mode_disabled") {
        console.info(`[iress-ingest] uat order poll: skip=${r.skipReason}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[iress-ingest] uat order poll error: ${msg}`);
    }
    await sleep(env.uatOrderPollSec * 1000);
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

      // Bond universe → bonds_c (priced from the live YTM). Shares the curve's
      // nominal basket + YFX/YFXD feed; runs on the same (slow) cadence.
      const bondRes = await syncBondUniverse({
        env,
        supabase,
        codes: timeSeriesConfig.curveCodes,
        exchange: timeSeriesConfig.curveExchange,
        dataSource: timeSeriesConfig.curveDataSource,
      });
      console.info(
        JSON.stringify({
          level: "info",
          event: "bond_universe_sync_complete",
          source: "iress-worker",
          requested: bondRes.requested,
          priced: bondRes.priced,
          errors: bondRes.errors,
        }),
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[iress-ingest] time series sync error: ${msg}`);
    }
    await sleep(timeSeriesConfig.intervalSec * 1000);
  }
}

/**
 * Tight intraday poll for index codes (J203 / sector basket). Runs in
 * parallel to the daily `timeSeriesLoop` and writes to the same
 * `index_intraday_c` table. Off when `IRESS_WORKER_INDEX_INTRADAY_INTERVAL_SEC<=0`
 * (deliberate disable sentinel, same convention as `orderPollIntervalSec`).
 *
 * Until the JSE index entitlement lands on `DFM@Mint` (Andre/Charles —
 * `IRESS_ISSUES_FOR_ANDRE.md` §1), this loop logs
 * `time_series_entitlement_missing` and writes nothing. When the
 * entitlement flips, the next cycle starts populating without any code
 * change.
 */
async function indexIntradayLoop(): Promise<void> {
  if (timeSeriesConfig.intradayIntervalSec <= 0) return;
  while (!shuttingDown) {
    try {
      const result = await syncIndexIntraday({
        env,
        config: timeSeriesConfig,
        sessions,
        supabase,
      });
      if (result.points > 0 || result.entitlementRequired) {
        console.info(
          JSON.stringify({
            level: "info",
            event: "index_intraday_sync_complete",
            source: "iress-worker",
            requested: result.requested,
            points: result.points,
            errors: result.errors,
            entitlementRequired: result.entitlementRequired,
          }),
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[iress-ingest] index intraday sync error: ${msg}`);
    }
    await sleep(timeSeriesConfig.intradayIntervalSec * 1000);
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

async function alertLoop(): Promise<void> {
  // Research-trigger evaluator. Pure DB read (no IRESS session) — runs
  // independently of the quote loop so an IRESS outage doesn't blind the
  // alert path. Prices come from the RETAIL DB (`stock_intraday_c` /
  // `securities_c`) because the institutional `quote_snapshot_c` schema
  // is keyed by `security_code` and the desk's tick stream reads from
  // retail. The retail client is optional — without it the evaluator
  // falls back to `quote_snapshot_c.last` (cents, IRESS L1).
  if (env.alertEvalSec <= 0) return;
  while (!shuttingDown) {
    try {
      const r = await evaluateTriggers({
        env,
        supabase,
        retailSupabase: retailSupabase ?? null,
      });
      if (r.breached > 0 || r.inserted > 0 || r.errors.length > 0) {
        console.info(
          JSON.stringify({
            level: "info",
            event: "alert_eval_complete",
            notes: r.notes,
            breached: r.breached,
            inserted: r.inserted,
            skipped: r.skipped,
            emailed: r.emailed,
            email_webhooks_tried: r.emailWebhooksTried,
            errors: r.errors,
          }),
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[iress-ingest] alert eval error: ${msg}`);
    }
    await sleep(env.alertEvalSec * 1000);
  }
}

async function retailIngestLoop(): Promise<void> {
  // Dormant unless explicitly enabled (IRESS_RETAIL_INGEST=1 + RETAIL_SUPABASE_URL).
  // This is the only path that writes to the live retail consumer DB, and it
  // still honours dryRun/allowWrites — shadow-only until both are flipped.
  if (!retailIngestEnabled) return;
  while (!shuttingDown) {
    try {
      // `institutional: supabase` → persist the full-universe IRESS L1 snapshot
      // to quote_snapshot_c (OEMS-owned), independent of the retail write gate,
      // so the dashboard's IRESS-first overlay covers every name.
      const r = await syncRetailPrices({ env, sessions, retail: retailSupabase, institutional: supabase });
      console.info(
        `[iress-ingest] retail price ingest ${r.dryRun ? "(shadow)" : "(WRITE)"}: ` +
          `${r.covered}/${r.requested} covered, ${r.written} written, ${r.skipped} skipped`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[iress-ingest] retail ingest error: ${msg}`);
    }
    await sleep(retailIngestIntervalSec * 1000);
  }
}

/**
 * `IRESS_NEWS_INGEST=1` enables this loop; otherwise it stays dormant.
 *
 * Pulls JSE SENS announcements via `NewsHeadlineGet` (vendor `SENSD`,
 * today's UTC window) and upserts them into `public.news_item_c` on the
 * institutional Supabase. Honours the worker-wide `dryRun` /
 * `allowWrites` gates. Default cadence is 6 hours (env
 * `IRESS_NEWS_INGEST_INTERVAL_SEC`, floor 300 s).
 *
 * Rationale: the OEMS News & SENS page reads from the worker probe
 * (live passthrough) AND from `news_item_c` (historical). The passthrough
 * is enough for "what's today"; the persistence leg keeps the panel
 * alive across worker redeploys and lets the desk run queries against
 * yesterday's announcements.
 */
async function newsIngestLoop(): Promise<void> {
  const enabled = process.env.IRESS_NEWS_INGEST === "1";
  if (!enabled) return;
  const intervalSec = Math.max(300, Number(process.env.IRESS_NEWS_INGEST_INTERVAL_SEC ?? "21600"));
  console.warn(
    `[iress-ingest] NEWS INGEST ${env.dryRun || !env.allowWrites ? "(shadow)" : "(WRITE)"} → news_item_c, interval ${intervalSec}s`,
  );
  while (!shuttingDown) {
    try {
      const r = await syncNewsHeadlines({ env, sessions, supabase });
      if (r.error) {
        console.warn(`[iress-ingest] news ingest error: ${r.error}`);
      } else if (r.requested > 0) {
        console.info(
          JSON.stringify({
            level: "info",
            event: "news_loop_tick",
            source: "iress-worker",
            vendorCode: r.vendorCode,
            windowStart: r.windowStart,
            windowEnd: r.windowEnd,
            requested: r.requested,
            upserted: r.upserted,
            dryRun: r.dryRun,
            elapsedMs: r.durationMs,
          }),
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[iress-ingest] news ingest loop error: ${msg}`);
    }
    await sleep(intervalSec * 1000);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.error(`[iress-ingest] ${signal}: releasing IRESS license…`);
  // Audit #2 — on a clean shutdown, write a final heartbeat with
  // `status: "stopped"` (not `"error"`) so the BFF ghost filter
  // recognizes this as a graceful exit. Railway redeploys can
  // leave the prior replica heartbeating if shutdown isn't clean;
  // the BFF filter (see `src/app/api/worker-health/route.ts`) is
  // the safety net for that case. We do both — mark ourselves
  // `stopped` here AND rely on the BFF filter for true ghosts.
  const cleanup = (async () => {
    await gracefulStop({ supabase, env, lastQuoteSyncAt, signal });
    // Stop accepting new HTTP work and give in-flight one-shot order requests
    // (cancel / amend / send-to-market, proxied by the Vercel BFF) a brief
    // window to drain before we drop the IRESS sessions they need. Bounded so
    // long-lived SSE streams (/orders/stream, /uat/execution-stream) cannot
    // wedge shutdown — clients reconnect to the new replica. Previously the
    // startHttpApi handle was discarded, killing these mid-flight on redeploy.
    if (httpApiHandle) {
      await Promise.race([
        httpApiHandle.close().catch((err) => {
          console.warn(`[iress-ingest] http api close failed: ${String(err)}`);
        }),
        sleep(3_000),
      ]);
    }
    // Release BOTH license seats gracefully: the UAT/orders session AND the
    // module-level PROD market-data session (previously leaked on redeploy —
    // getMarketDataSession() caches a wire session and nothing tore it down).
    await tearDownMarketDataSession();
    await sessions.tearDown(LICENSE_RELEASE_DELAY_MS);
  })();
  // Watchdog: never let a hung IRESS logout / socket keep the replica alive.
  // Railway force-kills after its grace window regardless; exiting cleanly at
  // ~8s beats being SIGKILLed mid-teardown.
  await Promise.race([cleanup, sleep(8_000)]);
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
  getLastQuoteStats: () => ({ synced: lastQuoteSynced, requested: lastQuoteRequested }),
  isStopping: () => shuttingDown,
});
void quoteLoop();
void orderLoop();
void uatOrderLoop();
void timeSeriesLoop();
void indexIntradayLoop();
void alertLoop();
// IPS is parked (IRESS scope = market data + IOS+). The loop only errors every
// cycle without an IPS service session — re-enable with IRESS_ENABLE_IPS=1.
if (process.env.IRESS_ENABLE_IPS === "1") void ipsLoop();
void retailIngestLoop();
if (retailIngestEnabled) {
  console.warn(
    `[iress-ingest] RETAIL INGEST ENABLED → ${process.env.RETAIL_SUPABASE_URL} ` +
      `(${process.env.IRESS_RETAIL_DRY_RUN === "0" ? "LIVE WRITES" : "shadow/dry-run"}). Interval ${retailIngestIntervalSec}s.`,
  );
}
// News ingest (SENS) is opt-in via `IRESS_NEWS_INGEST=1`; defaults to dormant
// so the worker doesn't wake the CT seat on the second.
if (process.env.IRESS_NEWS_INGEST === "1") void newsIngestLoop();

// CONFIG DIAGNOSTICS — the full-universe IRESS overlay only reaches the dashboard
// when this loop runs AND the worker is in live mode. These are the two silent
// misconfigs that leave the board showing Yahoo for every non-watchlist symbol
// despite IRESS_MARKET_DATA_PROD/IRESS_PRICE_OVERLAY being set — warn loudly so
// "still all Yahoo" is self-explaining in the logs.
if (process.env.IRESS_RETAIL_INGEST === "1" && !process.env.RETAIL_SUPABASE_URL) {
  console.error(
    "[iress-ingest] CONFIG: IRESS_RETAIL_INGEST=1 but RETAIL_SUPABASE_URL is unset — the full-universe retail loop is OFF, so quote_snapshot_c stays at the ~12-name watchlist and the dashboard shows Yahoo for every other symbol. Set RETAIL_SUPABASE_URL (the mfxng retail URL) to enable it. (The institutional quote_snapshot_c write is independent of IRESS_RETAIL_DRY_RUN, so shadow/dry-run is fine.)",
  );
}
if (
  env.iressMode !== "live" &&
  (process.env.IRESS_MARKET_DATA_PROD === "1" || process.env.IRESS_PRICE_OVERLAY === "1")
) {
  console.error(
    `[iress-ingest] CONFIG: IRESS market-data flags are on (MARKET_DATA_PROD/PRICE_OVERLAY) but IRESS_MODE="${env.iressMode}" (not "live") — the worker never fetches real IRESS prices, so nothing lands in quote_snapshot_c and the whole board stays Yahoo. Set IRESS_MODE=live.`,
  );
}
if (retailIngestEnabled && !(process.env.INSTITUTIONAL_SUPABASE_URL || process.env.SUPABASE_URL)) {
  console.error(
    "[iress-ingest] CONFIG: retail ingest is on but neither INSTITUTIONAL_SUPABASE_URL nor SUPABASE_URL is set — quote_snapshot_c (the table the dashboard overlay reads) cannot be written. Set the institutional (nnwz) URL + service-role key.",
  );
}

// Read-only HTTP API — bound unless explicitly disabled. The Vercel BFF
// reverse-proxies /orders, /orders/stream, and /health from these handlers
// so Next.js never holds the IRESS license seat.
if (process.env.WORKER_HTTP_DISABLED !== "1") {
  if (!process.env.WORKER_HTTP_TOKEN) {
    console.error(
      "[iress-ingest] CRITICAL: worker HTTP API is UNAUTHENTICATED (WORKER_HTTP_TOKEN unset). " +
        "Anyone who can reach this port can cancel/amend/send orders and run /debug/soap-raw. " +
        "Set WORKER_HTTP_TOKEN on the worker + BFF, then WORKER_REQUIRE_HTTP_TOKEN=1 to enforce.",
    );
  }
  startHttpApi({ env, sessions, supabase, retailSupabase: retailSupabase ?? null }, () => lastQuoteSyncAt)
    .then((handle) => {
      httpApiHandle = handle;
      // If a signal landed during bind, shutdown() ran before the handle
      // existed and couldn't close this server — close it now.
      if (shuttingDown) void handle.close().catch(() => {});
    })
    .catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[iress-ingest] http api failed to start: ${message}`);
    });
}

// Allow env override at runtime (e.g. test scripts swap IRESS_ACCOUNT_CODE).
process.env.IRESS_ACCOUNT_CODE = process.env.IRESS_ACCOUNT_CODE ?? lastAccountCode;
