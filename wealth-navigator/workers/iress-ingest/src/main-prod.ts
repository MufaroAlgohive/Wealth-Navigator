/**
 * Railway IRESS **PROD** worker — owns the IRESS production license seat.
 *
 * Distinct from `main.ts` (the UAT worker). This entrypoint runs ONLY the
 * loops that need the prod seat:
 *
 *   - `newsIngestLoop`     — SENS / SENSD vendor-broadcast → `news_item_c`
 *                            (per-loop pilot-write gate via
 *                             `IRESS_NEWS_DRY_RUN` / `IRESS_NEWS_ALLOW_WRITES`)
 *   - one-shot vendor catalog fetch on startup — `NewsVendorGet` →
 *     synthetic marker row in `news_item_c.payload.scope.vendor_catalog`
 *
 * Loops NOT started here: quotes, orders, UAT order-pad, time-series,
 * IPS, alerts, retail ingest — those stay on `main.ts` (UAT/CT). Seat
 * isolation per `AGENTS.md`.
 *
 * Activation:
 *
 *   1. Set `IRESS_MARKET_DATA_PROD=1` so `market-data.ts::getMarketDataSession()`
 *      opens a SECOND IRESSSession against the prod endpoint (default
 *      `https://webservices.iress.co.za/v4`, overridable via
 *      `IRESS_MARKETDATA_BASE_URL`). The main session is unused on
 *      this entrypoint — news reads the prod market-data session
 *      directly.
 *   2. Set `WORKER_ID=iress-ingest-prod-1` so heartbeats don't collide
 *      with the UAT replica (`iress-ingest-1`).
 *   3. Set `IRESS_USERNAME` / `IRESS_PASSWORD` / `IRESS_COMPANY_NAME`
 *      for the prod credential (Charles-confirmed prod entitlement,
 *      distinct from the CT `DFM@Mint` credential).
 *   4. `IRESS_NEWS_INGEST=1` to enable the news loop (dormant otherwise).
 *   5. Pilot-write gate:
 *      - `IRESS_NEWS_DRY_RUN=1` + `IRESS_NEWS_ALLOW_WRITES=0` (default) →
 *        news loop runs in shadow (records structured events only)
 *      - `IRESS_NEWS_DRY_RUN=0` + `IRESS_NEWS_ALLOW_WRITES=1` (opt-in) →
 *        news loop writes to `news_item_c` (per-loop only; the rest of
 *        the worker stays dry-run exactly as `AGENTS.md` requires)
 *
 * Worker-wide gates stay dry-run on this service:
 *
 *   - `IRESS_WORKER_DRY_RUN=1`
 *   - `SUPABASE_ALLOW_WRITES=0`
 *
 * The per-loop `IRESS_NEWS_ALLOW_WRITES=1` is the ONLY write knob
 * flipped on this service, and only after the dry-run validation
 * below completes successfully.
 *
 * The HTTP API (`/debug/news-vendor-probe`, `/health`, etc.) is bound
 * so the Vercel BFF `/api/iress/news` can reverse-proxy — same shape
 * as `main.ts`. The session manager is constructed but only exercised
 * by routes that need it; the news loop talks to the prod
 * market-data session directly, never to the main session.
 */

import { loadWorkerEnv } from "./env";
import { gracefulStop, runHealthLoop } from "./health";
import { startHttpApi, type HttpApiHandle } from "./http-api";
import {
  syncNewsHeadlines,
  syncNewsVendorCatalog,
  persistVendorCatalogMarker,
} from "./news-ingest";
import { getMarketDataSession, tearDownMarketDataSession } from "./market-data";
import { recordWorkerEvent } from "./events";
import { LICENSE_RELEASE_DELAY_MS, WorkerSessionManager } from "./session";
import { createInstitutionalSupabase, createRetailSupabase, writeHeartbeat } from "./supabase";

const env = loadWorkerEnv();

// PROD worker fail-fast. Same posture as main.ts, with one extra check:
// running the prod worker against the CT endpoint is a misconfig we
// want to scream about at boot, not 30 minutes later.
if (env.iressMode === "live") {
  const missing = [
    !process.env.IRESS_USERNAME && "IRESS_USERNAME",
    !process.env.IRESS_PASSWORD && "IRESS_PASSWORD",
    !process.env.IRESS_COMPANY_NAME && "IRESS_COMPANY_NAME",
  ].filter(Boolean) as string[];
  if (missing.length > 0) {
    console.error(`[iress-prod] refusing to start: IRESS_MODE=live but missing ${missing.join(", ")}`);
    process.exit(1);
  }
  if (!process.env.IRESS_MARKET_DATA_PROD) {
    console.warn(
      "[iress-prod] CONFIG: IRESS_MARKET_DATA_PROD is unset — the prod worker will fall back to the UAT session (no prod seat). Set IRESS_MARKET_DATA_PROD=1 and IRESS_MARKETDATA_BASE_URL=https://webservices.iress.co.za/v4.",
    );
  }
  if (process.env.IRESS_MARKET_DATA_PROD === "1") {
    const endpoint = process.env.IRESS_MARKETDATA_BASE_URL ?? "https://webservices.iress.co.za/v4";
    if (/webservices-ct/.test(endpoint)) {
      console.error(
        `[iress-prod] CONFIG: IRESS_MARKETDATA_BASE_URL=${endpoint} points at the CT (UAT) endpoint, but this is the prod worker. Refusing to start. Set IRESS_MARKETDATA_BASE_URL=https://webservices.iress.co.za/v4.`,
      );
      process.exit(1);
    }
  }
}

// SECURITY (opt-in enforcement): the worker HTTP surface fails OPEN when
// WORKER_HTTP_TOKEN is unset. Same posture as main.ts. The prod worker
// SHOULD run with WORKER_REQUIRE_HTTP_TOKEN=1 because the prod seat
// carries real entitlement — never let an unauthenticated client reach
// /debug/news-vendor-probe or /debug/orders/amend on a prod build.
if (
  process.env.WORKER_REQUIRE_HTTP_TOKEN === "1" &&
  !process.env.WORKER_HTTP_TOKEN &&
  process.env.WORKER_HTTP_DISABLED !== "1"
) {
  console.error(
    "[iress-prod] refusing to start: WORKER_REQUIRE_HTTP_TOKEN=1 but WORKER_HTTP_TOKEN is unset (set the token, or clear the require flag)",
  );
  process.exit(1);
}

const sessions = new WorkerSessionManager({
  workerId: env.workerId,
  node: process.env.HOSTNAME ?? process.env.RAILWAY_REPLICA_ID ?? env.workerId,
  applicationLabel: env.applicationLabel,
  supabase: null, // bound below
  allowWrites: env.allowWrites,
  dryRun: env.dryRun,
});
const supabase = createInstitutionalSupabase(env);
// createRetailSupabase is constructed (and warns if unconfigured) but
// never USED on this entrypoint. The prod worker does NOT write to
// `securities_c` / `stock_intraday_c` — that's a separate decision and
// out of scope for the 2026-07-22 SENS plan.
createRetailSupabase(env);

(sessions as unknown as { deps: { supabase: typeof supabase } }).deps.supabase = supabase;

let shuttingDown = false;
let httpApiHandle: HttpApiHandle | null = null;

function logStartup(): void {
  console.info(
    JSON.stringify({
      level: "info",
      event: "starting_prod_worker",
      workerId: env.workerId,
      iressMode: env.iressMode,
      marketDataProd: process.env.IRESS_MARKET_DATA_PROD === "1",
      marketDataEndpoint:
        process.env.IRESS_MARKETDATA_BASE_URL ?? "https://webservices.iress.co.za/v4",
      dryRun: env.dryRun,
      allowWrites: env.allowWrites,
      newsIngestEnabled: process.env.IRESS_NEWS_INGEST === "1",
      newsDryRun: env.newsDryRun,
      newsAllowWrites: env.newsAllowWrites,
      newsVendorCode: env.newsVendorCode,
      heartbeatSec: env.heartbeatSec,
    }),
  );
  if (!env.newsDryRun && env.newsAllowWrites) {
    console.warn(
      "[iress-prod] NEWS WRITES ENABLED — TARGETING LIVE news_item_c. Verify the dry-run shape before flipping.",
    );
  } else {
    console.info(
      `[iress-prod] NEWS WRITES DISABLED (newsDryRun=${env.newsDryRun}, newsAllowWrites=${env.newsAllowWrites}) — running in shadow.`,
    );
  }
}

/** One-shot vendor catalog fetch + persist. Runs once on startup. */
async function oneShotVendorCatalog(): Promise<void> {
  if (!process.env.IRESS_NEWS_INGEST) {
    return; // Dormant worker — skip even the catalog.
  }
  if (env.iressMode !== "live" && env.iressMode !== "wsdl-stub") {
    return; // Mock mode — nothing to fetch.
  }
  try {
    const catalog = await syncNewsVendorCatalog();
    recordWorkerEvent({
      level: "info",
      event: "news_vendor_catalog",
      msg: `vendor catalog fetched: ${catalog.count} rows (${catalog.error ?? "ok"})`,
      data: {
        count: catalog.count,
        endpoint: catalog.endpoint,
        durationMs: catalog.durationMs,
        error: catalog.error,
        rows: catalog.rows,
      },
    });
    if (catalog.count > 0 && supabase) {
      await persistVendorCatalogMarker({ env, catalog, supabase });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[iress-prod] vendor catalog fetch failed (continuing): ${msg}`);
  }
}

async function newsIngestLoop(): Promise<void> {
  const enabled = process.env.IRESS_NEWS_INGEST === "1";
  if (!enabled) return;
  const intervalSec = Math.max(300, Number(process.env.IRESS_NEWS_INGEST_INTERVAL_SEC ?? "21600"));
  console.warn(
    `[iress-prod] NEWS INGEST ${env.newsDryRun || !env.newsAllowWrites ? "(shadow)" : "(WRITE)"} → news_item_c, interval ${intervalSec}s`,
  );
  while (!shuttingDown) {
    try {
      // Sync call (no separate session manager hop on this path) — the
      // news loop talks to the prod market-data session via
      // `getMarketDataSession()` and falls back to the main session if
      // the prod session is unavailable (matches existing behaviour).
      const r = await syncNewsHeadlines({ env, sessions, supabase });
      if (r.error) {
        console.warn(`[iress-prod] news ingest error: ${r.error}`);
      } else if (r.requested > 0) {
        console.info(
          JSON.stringify({
            level: "info",
            event: "news_loop_tick",
            source: "iress-prod-worker",
            vendorCode: r.vendorCode,
            vendorFallback: r.vendorFallback,
            windowStart: r.windowStart,
            windowEnd: r.windowEnd,
            requested: r.requested,
            upserted: r.upserted,
            pages: r.pages,
            matched: r.matchedCount,
            universeSize: r.universeSize,
            dryRun: r.dryRun,
            elapsedMs: r.durationMs,
          }),
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[iress-prod] news ingest loop error: ${msg}`);
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
  console.error(`[iress-prod] ${signal}: releasing IRESS license…`);
  const cleanup = (async () => {
    await gracefulStop({ supabase, env, lastQuoteSyncAt: undefined, signal });
    if (httpApiHandle) {
      await Promise.race([
        httpApiHandle.close().catch((err) => {
          console.warn(`[iress-prod] http api close failed: ${String(err)}`);
        }),
        sleep(3_000),
      ]);
    }
    await tearDownMarketDataSession();
    await sessions.tearDown(LICENSE_RELEASE_DELAY_MS);
  })();
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
// Heartbeat keeps `integration_worker_health` honest. The prod worker
// has no quote loop, so `lastQuoteSyncAt` stays `undefined` (the
// integration page renders the news vendor catalog + last vendor
// sync instead).
void runHealthLoop({
  supabase,
  env,
  getLastQuoteSyncAt: () => undefined,
  getLastQuoteStats: () => ({ synced: 0, requested: 0 }),
  isStopping: () => shuttingDown,
});
void newsIngestLoop();

if (process.env.IRESS_NEWS_INGEST === "1") {
  // Trigger prod market-data bring-up early so the startup log shows
  // seat status / endpoint. Silent no-op when IRESS_MARKET_DATA_PROD=0.
  void getMarketDataSession()
    .then((md) => {
      if (!md) {
        console.warn(
          "[iress-prod] CONFIG: market-data session unavailable at startup (IRESS_MARKET_DATA_PROD=0 or session bring-up failed) — news loop will fall back to the UAT session.",
        );
      } else {
        console.info(
          `[iress-prod] prod market-data session ready endpoint=${process.env.IRESS_MARKETDATA_BASE_URL ?? "https://webservices.iress.co.za/v4"}`,
        );
      }
    })
    .catch((err) => {
      console.warn(`[iress-prod] prod market-data bring-up threw: ${err instanceof Error ? err.message : String(err)}`);
    });
  void oneShotVendorCatalog();
}

if (process.env.WORKER_HTTP_DISABLED !== "1") {
  if (!process.env.WORKER_HTTP_TOKEN) {
    console.error(
      "[iress-prod] CRITICAL: worker HTTP API is UNAUTHENTICATED (WORKER_HTTP_TOKEN unset). Set WORKER_HTTP_TOKEN on the worker + BFF, then WORKER_REQUIRE_HTTP_TOKEN=1 to enforce.",
    );
  }
  startHttpApi(
    { env, sessions, supabase, retailSupabase: null },
    () => undefined,
  )
    .then((handle) => {
      httpApiHandle = handle;
      if (shuttingDown) void handle.close().catch(() => {});
    })
    .catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[iress-prod] http api failed to start: ${message}`);
    });
}

// Best-effort heartbeat on a 60s cadence to keep
// `integration_worker_health` fresh even though we don't have a quote
// loop on this worker. `runHealthLoop` already writes heartbeats;
// this is a belt-and-braces backstop in case the health loop is wedged.
setInterval(() => {
  void writeHeartbeat(supabase, env, {
    workerId: env.workerId,
    status: shuttingDown ? "stopped" : "healthy",
    iressMode: env.iressMode,
    metadata: {
      role: "iress-prod-worker",
      marketDataProd: process.env.IRESS_MARKET_DATA_PROD === "1",
      newsIngestEnabled: process.env.IRESS_NEWS_INGEST === "1",
      newsVendorCode: env.newsVendorCode,
    },
  }).catch(() => {
    /* best-effort */
  });
}, 60_000).unref();
