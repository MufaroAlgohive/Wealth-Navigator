/**
 * Railway IRESS **PROD** worker — owns the IRESS production license seat.
 *
 * Distinct from `main.ts` (the UAT worker). This entrypoint runs ONLY the
 * loops that need the prod seat:
 *
 *   - `newsIngestLoop`     — SENS / SENSD vendor-broadcast → `news_item_c`
 *                            (per-loop pilot-write gate via
 *                             `IRESS_NEWS_DRY_RUN` / `IRESS_NEWS_ALLOW_WRITES`)
 *   - `orderFillLoop`      — OrderPadGetByAccount → fills stamped onto
 *                            `oems_order_audit` (IRESS_PRODUCTION_ORDERS)
 *   - `retailIngestLoop`   — PricingQuoteGet → `quote_snapshot_c` + the
 *                            IRESS-vs-Yahoo validation scoreboard. The client
 *                            money track stays gated by IRESS_RETAIL_DRY_RUN
 *                            and per-symbol approval.
 *   - one-shot vendor catalog fetch on startup — `NewsVendorGet` →
 *     synthetic marker row in `news_item_c.payload.scope.vendor_catalog`
 *
 * Loops NOT started here: watchlist quotes, UAT order-pad, time-series,
 * IPS, alerts — those stay on `main.ts` (UAT/CT). Seat isolation per
 * `AGENTS.md`.
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

import { loadWorkerEnv, productionOrdersEnabled } from "./env";
import { pollUatForFills, stampLastUatPollAt } from "./order-poller";
import { gracefulStop, runHealthLoop } from "./health";
import { runOrdersEntitlementProbe, startHttpApi, type HttpApiHandle } from "./http-api";
import {
  syncNewsHeadlines,
  syncNewsVendorCatalog,
  persistVendorCatalogMarker,
} from "./news-ingest";
import { getMarketDataSession, tearDownMarketDataSession } from "./market-data";
import { loadHotSymbols, syncRetailPrices } from "./retail-ingest";
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
// The prod worker still does NOT write `securities_c` / `stock_intraday_c` —
// that remains gated by IRESS_RETAIL_DRY_RUN and is a separate decision.
//
// But the client READ path needs this handle. The per-client pre-trade guard
// checks a client's own holdings + wallet in the RETAIL database, and it fails
// CLOSED: with IRESS_PER_CLIENT_GUARD=1 and no retail client, every client order
// is refused 503. This entrypoint passed `retailSupabase: null` to startHttpApi,
// so on the prod worker the guard could never run and no client order could
// succeed. Read-only use — nothing here writes to retail.
const retailSupabase = createRetailSupabase(env);

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
/**
 * Fill poller for the PRODUCTION order lane.
 *
 * Without this the worker can SEND a real order and never learn what happened
 * to it: the audit row stays on `working`, the order book shows nothing, and
 * the desk is blind to an execution that has already traded. Sending orders you
 * cannot track is worse than not sending them.
 *
 * Only runs when IRESS_PRODUCTION_ORDERS is on, so a SENS-only deployment is
 * unaffected. `pollUatForFills` picks the account by lane — the real MINT
 * account here, the test book under IRESS_UAT_MODE.
 */
async function orderFillLoop(): Promise<void> {
  if (!productionOrdersEnabled()) {
    console.info(
      "[iress-prod] order fill poller not started (IRESS_PRODUCTION_ORDERS is off).",
    );
    return;
  }
  const everySec = Math.max(5, env.uatOrderPollSec || 15);
  console.info(
    `[iress-prod] ORDER FILL POLLER on — account ${env.iressAccountCode || "(unset)"} every ${everySec}s`,
  );
  while (!shuttingDown) {
    try {
      stampLastUatPollAt();
      const r = await pollUatForFills({ env, sessions, supabase, retailSupabase });
      if (r.updated > 0 || r.published > 0) {
        console.info(
          `[iress-prod] order fill poll: updated=${r.updated} published=${r.published} elapsedMs=${r.elapsedMs}`,
        );
      } else if (r.skipReason && r.skipReason !== "no_order_lane_enabled") {
        console.info(`[iress-prod] order fill poll: skip=${r.skipReason}`);
      }
    } catch (err) {
      console.warn(
        `[iress-prod] order fill poll error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    await sleep(everySec * 1000);
  }
}

/**
 * IRESS price ingest for the PROD seat.
 *
 * This is what actually makes Wealth Navigator show IRESS prices. Until now the
 * loop only ran on `main.ts` (the CT/UAT entrypoint), so on production
 * `quote_snapshot_c` had not been written since 2026-07-23 — 97 hours, well past
 * the 48h freshness window — and every WN surface silently fell back to Yahoo.
 * The IRESS-aware read paths were fine; nothing was feeding them.
 *
 * What it writes, and what it does NOT:
 *
 *   quote_snapshot_c (institutional)  — full-universe IRESS L1. Gated by
 *       IRESS_PRICE_OVERLAY, now 1. This is the unlock.
 *   iress_price_validation_c          — the IRESS-vs-Yahoo scoreboard that has
 *       been stuck at 0/20 because it never received a single IRESS price.
 *   securities_c / stock_intraday_c   — the CLIENT MONEY track. Still gated by
 *       IRESS_RETAIL_DRY_RUN (=1) AND per-symbol approval (0 approved). Both
 *       must change deliberately; starting this loop does not move client money.
 *
 * Verified 2026-07-27 before enabling: PricingQuoteGet on the prod seat returned
 * FSR PreviousClosePrice=9587, matching securities_c.scale_ref_cents and the
 * Yahoo close to the cent. Real exchange data, correctly scaled in cents — not
 * the CT test prices the overlay flag was originally guarding against. Note the
 * feed is DataSource=JSED, roughly 15 minutes delayed.
 */
async function retailIngestLoop(): Promise<void> {
  const enabled =
    process.env.IRESS_RETAIL_INGEST === "1" && Boolean(process.env.RETAIL_SUPABASE_URL);
  if (!enabled) {
    console.info(
      "[iress-prod] retail/quote ingest not started (needs IRESS_RETAIL_INGEST=1 + RETAIL_SUPABASE_URL).",
    );
    return;
  }
  if (!retailSupabase) {
    console.error("[iress-prod] retail ingest enabled but no RETAIL Supabase client — skipping.");
    return;
  }
  const intervalSec = Math.max(60, Number(process.env.IRESS_RETAIL_INGEST_INTERVAL_SEC ?? "300"));
  console.warn(
    `[iress-prod] IRESS PRICE INGEST on — money track ${
      process.env.IRESS_RETAIL_DRY_RUN === "0" ? "LIVE WRITES" : "shadow (IRESS_RETAIL_DRY_RUN=1)"
    }, quote_snapshot_c ${process.env.IRESS_PRICE_OVERLAY === "0" ? "suppressed" : "writing"}, interval ${intervalSec}s`,
  );
  while (!shuttingDown) {
    try {
      const r = await syncRetailPrices({
        env,
        sessions,
        retail: retailSupabase,
        institutional: supabase,
      });
      console.info(
        `[iress-prod] price ingest ${r.dryRun ? "(shadow)" : "(WRITE)"}: ` +
          `${r.covered}/${r.requested} covered, ${r.written} written, ${r.skipped} skipped`,
      );
    } catch (err) {
      console.warn(
        `[iress-prod] price ingest error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    await sleep(intervalSec * 1000);
  }
}

/**
 * FAST LANE. The full-universe sweep walks ~197 symbols and lands every ~374s
 * measured against the live DB, so any price a client is looking at is minutes
 * old and every freshness badge reads STALE — honestly. This loop sweeps only
 * the symbols someone actually holds or a strategy tracks, which is a fraction
 * of the universe and can run on a much tighter cadence.
 *
 * It runs ALONGSIDE the full sweep, never instead of it: the slow walk still
 * covers everything, and if the hot-symbol query fails this loop skips the
 * cycle rather than falling back to sweeping the universe twice.
 *
 * Off by default. IRESS_HOT_PRICE_INTERVAL_SEC=30 turns it on.
 */
async function hotPriceLoop(): Promise<void> {
  const intervalSec = Number(process.env.IRESS_HOT_PRICE_INTERVAL_SEC ?? "0");
  if (!(intervalSec > 0)) return;
  if (process.env.IRESS_RETAIL_INGEST !== "1" || !retailSupabase) {
    console.info("[iress-prod] hot price lane not started (needs IRESS_RETAIL_INGEST=1 + RETAIL Supabase).");
    return;
  }
  const everySec = Math.max(15, intervalSec);
  console.warn(`[iress-prod] HOT PRICE LANE on — held + strategy symbols every ${everySec}s`);
  while (!shuttingDown) {
    try {
      const symbols = await loadHotSymbols(retailSupabase);
      if (symbols.length === 0) {
        // Empty means the query failed or nothing is held. Either way, do NOT
        // fall through to a full sweep — that would double the load on the seat
        // and is exactly what the slow loop is already doing.
        console.info("[iress-prod] hot price lane: no hot symbols this cycle, skipping.");
      } else {
        const r = await syncRetailPrices({
          env,
          sessions,
          retail: retailSupabase,
          institutional: supabase,
          symbols,
        });
        console.info(
          `[iress-prod] hot price ${r.dryRun ? "(shadow)" : "(WRITE)"}: ` +
            `${r.covered}/${r.requested} covered, ${r.written} written`,
        );
      }
    } catch (err) {
      console.warn(
        `[iress-prod] hot price lane error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    await sleep(everySec * 1000);
  }
}

void runHealthLoop({
  supabase,
  env,
  getLastQuoteSyncAt: () => undefined,
  getLastQuoteStats: () => ({ synced: 0, requested: 0 }),
  isStopping: () => shuttingDown,
});
void newsIngestLoop();
void orderFillLoop();
void retailIngestLoop();
void hotPriceLoop();

if (process.env.IRESS_NEWS_INGEST === "1") {
  // Trigger prod market-data bring-up early so the startup log shows
  // seat status / endpoint. Wait for the session BEFORE running the
  // vendor catalog fetch — they're not allowed to race, otherwise
  // `syncNewsVendorCatalog()` opens its own login and evicts the
  // market-data session (single-seat license).
  void getMarketDataSession()
    .then(async (md) => {
      if (!md) {
        console.warn(
          "[iress-prod] CONFIG: market-data session unavailable at startup (IRESS_MARKET_DATA_PROD=0 or session bring-up failed) — news loop will fall back to the UAT session.",
        );
        return;
      }
      console.info(
        `[iress-prod] prod market-data session ready endpoint=${process.env.IRESS_MARKETDATA_BASE_URL ?? "https://webservices.iress.co.za/v4"}`,
      );
      await oneShotVendorCatalog();
    })
    .catch((err) => {
      console.warn(`[iress-prod] prod market-data bring-up threw: ${err instanceof Error ? err.message : String(err)}`);
    });
}

/**
 * One-shot orders-entitlement probe on startup. Enabled with
 * `IRESS_DEBUG_ORDERS_PROBE=1` so it's a deliberate operator action,
 * not a default. The result lands in the structured log + the
 * heartbeat's `recent_events`, so we can read the prod seat's
 * orders entitlement (IOSPlus / IPS / FIXPlus) without needing an
 * external HTTP call to the worker (the Railway public proxy 502s
 * intermittently — see `ISSUES_LOG.md`).
 *
 * IMPORTANT (prod worker): the probe opens its OWN IRESSSession
 * (`probeClient.iressSessionStart`) on the prod seat, which the
 * server treats as a second concurrent login and ends the
 * market-data session that the news loop needs. Disable the boot
 * probe on the prod worker by leaving `IRESS_DEBUG_ORDERS_PROBE=1`
 * UNSET there. The probe stays reachable via the HTTP debug
 * endpoint (`/debug/orders-entitlement-probe`) for one-off checks;
 * that path runs the probe on demand without breaking news ingest.
 */
async function oneShotOrdersEntitlementProbe(): Promise<void> {
  if (process.env.IRESS_DEBUG_ORDERS_PROBE !== "1") return;
  // Don't auto-run on the prod worker — the boot probe evicts the
  // market-data session the news loop needs (single-seat license).
  // Reach for the HTTP `/debug/orders-entitlement-probe` endpoint
  // for an on-demand probe that won't break news ingest.
  if (process.env.IRESS_NEWS_INGEST === "1" && process.env.IRESS_MARKET_DATA_PROD === "1") {
    console.warn(
      "[iress-prod] SKIPPING boot orders-entitlement probe on the prod worker — opening a second IRESSSession evicts the prod market-data session that news ingest needs (single-seat license). Use the HTTP /debug/orders-entitlement-probe endpoint for on-demand probing.",
    );
    return;
  }
  if (env.iressMode !== "live" && env.iressMode !== "wsdl-stub") return;
  try {
    const result = await runOrdersEntitlementProbe({
      deps: {
        env,
        sessions,
        supabase,
      },
      probePad: false,
    });
    const summary = result.body.probeSummary as
      | {
          iosplusEntitled?: boolean;
          ipsEntitled?: boolean;
          fixplusEntitled?: boolean;
          allOrdersEntitled?: boolean;
        }
      | undefined;
    const ok = result.body.ok === true;
    recordWorkerEvent({
      level: ok ? "info" : "warn",
      event: "orders_entitlement_probe",
      msg: ok
        ? `Orders entitlement probe OK — IOSPlus=${summary?.iosplusEntitled} IPS=${summary?.ipsEntitled} FIX+=${summary?.fixplusEntitled}`
        : `Orders entitlement probe FAILED: ${(result.body.error as { message?: string } | undefined)?.message ?? "unknown"}`,
      data: result.body as Record<string, unknown>,
    });
    console.info(
      JSON.stringify({
        level: ok ? "info" : "warn",
        event: "orders_entitlement_probe",
        build: result.body.build,
        probedAt: result.body.probedAt,
        elapsedMs: result.body.elapsedMs,
        probeSummary: result.body.probeSummary,
        services: result.body.services,
        error: result.body.error ?? null,
      }),
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    recordWorkerEvent({
      level: "warn",
      event: "orders_entitlement_probe_threw",
      msg: `orders entitlement probe threw: ${msg}`,
      data: { error: msg },
    });
  }
}

if (process.env.IRESS_DEBUG_ORDERS_PROBE === "1") {
  void oneShotOrdersEntitlementProbe();
}

if (process.env.WORKER_HTTP_DISABLED !== "1") {
  if (!process.env.WORKER_HTTP_TOKEN) {
    console.error(
      "[iress-prod] CRITICAL: worker HTTP API is UNAUTHENTICATED (WORKER_HTTP_TOKEN unset). Set WORKER_HTTP_TOKEN on the worker + BFF, then WORKER_REQUIRE_HTTP_TOKEN=1 to enforce.",
    );
  }
  if (!retailSupabase) {
    console.error(
      "[iress-prod] CRITICAL: no RETAIL Supabase client (set RETAIL_SUPABASE_URL + RETAIL_SUPABASE_SERVICE_ROLE_KEY). " +
        "With IRESS_PER_CLIENT_GUARD=1 every client order will be refused 503 — the guard cannot read the client's holdings or wallet.",
    );
  }
  startHttpApi(
    { env, sessions, supabase, retailSupabase: retailSupabase ?? null },
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

// 2026-07-28 — gift-authorization sweepers. The new authorize-then-fill
// lifecycle has two background flows that need a tick:
//   1. PARKED authorizations that the operator never released. After
//      `expires_at` they transition to EXPIRED and the wallet
//      reservation is released so the funds come back to the gifter.
//   2. PENDING_GIFTER_APPROVAL authorizations past the 30-min grace
//      window. These auto-cancel and the reservation is released.
// Both run on 5-min cadences. They're idempotent (the conditional
// UPDATE prevents double-transition) and best-effort (a failure logs
// loudly but does not stop the worker).
// Importing as side-effect-free so the modules stay tree-shakeable.
import {
  sweepExpiredParkedAuthorizations,
  sweepApprovalGraceExpired,
} from "./giftAuthorizationSettlement";

const SWEEP_INTERVAL_MS = 5 * 60 * 1000; // 5 min
// Sweepers read/write gift tables which live on RETAIL. Only run them when
// the retail client is configured — running them with `retail=null` would
// throw inside the sweepers, since they read gift_authorizations directly.
if (retailSupabase) {
  const sweepDeps = {
    retail: retailSupabase,
    dryRun: process.env.GIFT_AUTH_SWEEP_DRY_RUN === "1",
  };
  setInterval(() => {
    if (shuttingDown) return;
    void sweepExpiredParkedAuthorizations(sweepDeps).catch((err) => {
      console.error(
        JSON.stringify({
          level: "error",
          event: "gift_auth_parked_sweep_threw",
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    });
    void sweepApprovalGraceExpired(sweepDeps).catch((err) => {
      console.error(
        JSON.stringify({
          level: "error",
          event: "gift_auth_grace_sweep_threw",
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    });
  }, SWEEP_INTERVAL_MS).unref();
} else {
  console.warn("[iress-prod] gift-auth sweepers disabled: no RETAIL Supabase client configured.");
}
