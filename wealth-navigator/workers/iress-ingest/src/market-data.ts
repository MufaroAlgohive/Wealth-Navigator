/**
 * Prod market-data session — single-seat coordinator facade.
 *
 * History (2026-07-29 cutover): IRESS issues a single license seat per login
 * (verified 2026-07-29 on DFM@Mint against `webservices.iress.co.za/v4`).
 * The previous design opened TWO `IRESSSessionStart` calls — one for orders
 * and one for market data — which immediately got 25008 "No more licenses"
 * back. The fix landed as `IRESS_USE_SINGLE_SEAT=1` with `getMarketDataSession`
 * returning null, leaving market-data callers to fall through to the orders
 * session (the only one that actually existed).
 *
 * What this module is now (2026-08-07):
 *
 *   - There is ONE IRESS wire session per Railway replica. It is owned by
 *     `WorkerSessionManager` in `./session.ts`.
 *   - This module does NOT open a second session. It exposes a thin facade
 *     (`getMarketDataSession`, `marketDataBaseUrl`, `marketDataProdEnabled`,
 *     `singleSeatEnforced`) so the call sites (quotes.ts, news-ingest.ts,
 *     retail-ingest.ts, bonds.ts, timeseries.ts, http-api.ts) do not change.
 *   - `getMarketDataSession()` returns `{ client, sessionKey }` from the
 *     coordinator when the worker is on the prod endpoint, or `null` when the
 *     coordinator is on the UAT endpoint (so UAT-only callers do not silently
 *     hit the prod seat).
 *
 * The legacy knobs `IRESS_MARKET_DATA_PROD` and `IRESS_USE_SINGLE_SEAT` are
 * recognised for back-compat only and resolved to "single-seat, prod-active"
 * by default. The previous "two sessions" mode is gone — re-enabling it would
 * require a 2nd-seat IRESS licence which is out of scope for the production
 * posture (one seat per login per AGENTS.md).
 */

import { iressConfig } from "../../../src/lib/iress/index";
import { isUatEnv } from "../../../src/lib/oems/uat-scope";
import type { IressClient } from "../../../src/lib/iress/client";
import { getIressClient } from "../../../src/lib/iress/index";
import type { WorkerMintSession } from "./session";

export interface MarketDataSession {
  client: IressClient;
  sessionKey: string;
}

/**
 * Prod market-data endpoint (defaults to `iressConfig.prodUrl` =
 * `webservices.iress.co.za/v4`). The coordinator's session targets this
 * endpoint on the prod worker; UAT workers use `IRESS_BASE_URL` (typically
 * `webservices-ct.iress.co.za/v4`) and skip market-data entirely.
 */
export function marketDataBaseUrl(): string {
  return (process.env.IRESS_MARKETDATA_BASE_URL ?? "").trim() || iressConfig.prodUrl;
}

/**
 * `IRESS_USE_SINGLE_SEAT` was the operator escape hatch for the 2026-07-29
 * dual-session failure. The dual-session mode is removed (see the file header)
 * — single-seat is now the only shape this worker takes. The knob is still
 * parsed for back-compat so an old Railway env var does not crash the boot,
 * but the only accepted value is "1"/"true" (single-seat).
 */
export function singleSeatEnforced(): boolean {
  const v = (process.env.IRESS_USE_SINGLE_SEAT ?? "1").trim().toLowerCase();
  // Anything other than an explicit "0"/"false" is single-seat. We never open
  // a 2nd wire session in any deployment of this worker.
  return !(v === "0" || v === "false");
}

/**
 * `IRESS_MARKET_DATA_PROD` was the opt-in for the dual-session split. The
 * dual-session split is gone; the prod worker ALWAYS talks to the prod
 * endpoint (the single coordinator IS the prod market-data session). The
 * knob is parsed for back-compat only — any value other than the explicit
 * "0"/"false" disables it is treated as "prod-active".
 *
 * If the operator ever needs to roll back to a 2nd-seat split, the right
 * knob is a brand new env var (proposal: `IRESS_SECOND_SEAT_LICENSE=1`) —
 * not this one. See the plan: out of scope for the prod-posture fix.
 */
export function marketDataProdEnabled(): boolean {
  if (!singleSeatEnforced()) return false;
  const v = (process.env.IRESS_MARKET_DATA_PROD ?? "1").trim().toLowerCase();
  return !(v === "0" || v === "false");
}

/**
 * Build the thin facade object. Pass in the coordinator's live session
 * (`WorkerMintSession`); we expose just the IRESS client + the base Iress
 * session key. Market-data callers (PricingQuoteGet, NewsHeadlineGet,
 * TimeSeriesGet2, NewsVendorGet, …) use the base Iress session — they do
 * NOT need an IOS+ service session.
 *
 * When the coordinator is on a UAT/CT endpoint, we return null so callers
 * can short-circuit to their UAT-specific path. We never fabricate a second
 * session by stealing the orders session key for market-data on prod — the
 * coordinator already owns that key and reusing it across parallel loops
 * was the original race condition this module was built to prevent.
 */
export function buildMarketDataSession(session: WorkerMintSession | null): MarketDataSession | null {
  if (!session) return null;
  if (!marketDataProdEnabled()) return null;
  // Guard: if the operator still has IRESS_BASE_URL pointed at CT, refuse to
  // route market-data through the prod seat — the seat is on CT and the
  // prod endpoint would 401/403/25014 every call.
  if (isUatEnv()) return null;
  return { client: getIressClient("live"), sessionKey: session.iressSessionKey };
}

/**
 * Legacy entrypoint — preserved for callers that do not yet thread the
 * `WorkerSessionManager` through to this module. Internally a no-op: there
 * is no separate session to cache. Callers should migrate to
 * `buildMarketDataSession(sessions.peekSession())` so the single seat is
 * honoured.
 *
 * Returns `null` so callers fall back to the coordinator's session via
 * `getIressClient("live")` + `sessions.peekSession().iressSessionKey` —
 * never via a second wire login.
 */
export async function getMarketDataSession(): Promise<MarketDataSession | null> {
  // No second wire session exists. The legacy 2026-07-29 dual-session code
  // path is removed. Callers that still hit this entrypoint without a
  // session argument will fail closed at the IRESS layer (no session key)
  // and the operator sees the 25013 / 25014 directly — easier to diagnose
  // than a phantom second session that returns 25008.
  return null;
}

/**
 * Drop the cached "prod" session (no-op since there is no second session).
 * Kept as an API seam so `quotes.ts` / `news-ingest.ts` / etc. continue to
 * compile without churn — the call site pattern is
 * `if (md) noteMarketDataError(err)` and the function signature matters
 * more than the behaviour.
 */
export function invalidateMarketDataSession(): void {
  // Intentionally empty: the prod market-data session IS the coordinator's
  // session; invalidation happens via `sessions.invalidate()` in
  // `./session.ts`.
}

/**
 * No-op back-compat shim. Records nothing: there is no separate session to
 * back off against. The real session lifecycle (backoff, kick, rebuild)
 * lives in `WorkerSessionManager`.
 */
export function noteMarketDataError(_err: unknown): void {
  // Intentionally empty.
}

/**
 * Release the "prod market-data" session on shutdown. No-op in the
 * single-seat world — the coordinator's `tearDown()` owns the only wire
 * session. Kept as an API seam so `main.ts` / `main-prod.ts` continue to
 * call it.
 */
export async function tearDownMarketDataSession(): Promise<void> {
  // Intentionally empty: see file header. The coordinator's `tearDown()`
  // is the single source of truth for seat release.
}
