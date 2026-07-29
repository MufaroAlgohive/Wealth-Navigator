/**
 * Isolated PRODUCTION market-data IRESS session.
 *
 * The worker runs ORDERS on the UAT endpoint (MINT_CT) through the main
 * `WorkerSessionManager`, which this module NEVER touches. When
 * `IRESS_MARKET_DATA_PROD=1` and `IRESS_USE_SINGLE_SEAT` is NOT "1",
 * market-data reads (quotes / timeseries / news) instead use a SECOND
 * IRESSSession opened against the PRODUCTION endpoint, with its OWN client,
 * its OWN stable ApplicationID (distinct from the orders seat so the two
 * never kick each other), and graceful failure: on any error (no seat / not
 * entitled / network) it returns null and callers fall back to their
 * existing Yahoo / UAT behaviour. Orders are never affected.
 *
 * 2026-07-29: IRESS-issued a single licence seat per login. The 2-session
 * split only works when the account has 2+ concurrent session quota. To
 * enforce the single-seat contract, set `IRESS_USE_SINGLE_SEAT=1` (this is
 * the new default — `IRESS_MARKET_DATA_PROD=1` is now ignored unless
 * `IRESS_USE_SINGLE_SEAT=0` is explicitly set). When single-seat is on,
 * every market-data caller falls through to the orders session via
 * `getIressClient("live")` + the OrderSessionManager's sessionKey (the same
 * path the orders side already uses). That guarantees the worker holds at
 * most ONE wire session at a time.
 *
 * Market data runs on the base Iress-service session only, so this does NO
 * ServiceSessionStart and needs no IOS server value.
 */

import type { IressClient } from "../../../src/lib/iress/client";
import { getIressProdCredentialsFromEnv } from "../../../src/lib/iress/config";
import { isIressSessionDeadError } from "../../../src/lib/iress/errors";
import { createLiveIressClient, iressConfig, tearDownIressWireSession } from "../../../src/lib/iress/index";

export interface MarketDataSession {
  client: IressClient;
  sessionKey: string;
}

const EXPIRY_BUFFER_MS = 5 * 60_000;
const FAILURE_BACKOFF_MS = 5 * 60_000;

let cache: { session: MarketDataSession; expiresAt: number } | null = null;
let inflight: Promise<MarketDataSession | null> | null = null;
let backoffUntil = 0;

/**
 * True when the prod market-data split is switched on AND safe to run.
 *
 * ACTIVATION (IRESS setup per Andre Pietersen, 2026-07-15): the 2nd license is
 * TWO logins on the SAME user (DFM Services) — "the only thing that's changing
 * is your endpoint": CT (`webservices-ct`) for orders, production
 * (`webservices.iress.co.za`, no `-ct`) for market data. So the split uses the
 * SHARED IRESS_USERNAME/PASSWORD/COMPANY_NAME (IRESS_PROD_* are OPTIONAL, only
 * needed if IRESS ever issues a distinct market-data login) — the distinct
 * endpoint + the 2nd license (two concurrent sessions on one user) are what make
 * it safe. It activates on the explicit opt-in IRESS_MARKET_DATA_PROD=1.
 *
 * HISTORY: under a SINGLE license, one login could not hold an IDS in prod and
 * CT at once, so enabling this stole the IDS from CT and killed UAT orders. That
 * is resolved by the 2nd license (two concurrent logins). It stays OPT-IN +
 * graceful (a failed prod login returns null and market data falls back to
 * Yahoo/UAT; orders unaffected) + reversible (set the flag back to 0), and the
 * ApplicationID is distinct (`Mint-OEMS-MarketData-<node>`) so the two sessions
 * never kick each other. Verify after enabling: /debug/market-data + orders up.
 *
 * 2026-07-29: see the new `marketDataProdEnabled()` declaration below for the
 * single-seat override that turns this opt-in OFF automatically when the prod
 * account has only one licence seat.
 */

/** Prod market-data endpoint (defaults to iressConfig.prodUrl = webservices.iress.co.za). */
export function marketDataBaseUrl(): string {
  return (process.env.IRESS_MARKETDATA_BASE_URL ?? "").trim() || iressConfig.prodUrl;
}

/** Drop the cached prod session (call after a session-dead error so it rebuilds). */
export function invalidateMarketDataSession(): void {
  cache = null;
}

/**
 * Release the prod market-data seat on shutdown. Best-effort + idempotent:
 * awaits any in-flight bring-up so we don't leak the seat it is about to cache,
 * ends the IRESS wire session (no service sessions — market data runs on the
 * base Iress session), and parks `backoffUntil` so a late caller can't re-mint
 * mid-shutdown. Never throws. No-op when nothing was established (e.g. the split
 * is disabled — IRESS_MARKET_DATA_PROD unset — which is the case today).
 *
 * 2026-07-29: single-seat mode (default since the IRESS prod account has
 * exactly one seat) makes this a no-op — there is no 2nd session to tear
 * down.
 */
export async function tearDownMarketDataSession(): Promise<void> {
  if (singleSeatEnforced()) return;
  if (inflight) {
    try {
      await inflight;
    } catch {
      /* bring-up failed; nothing to tear down */
    }
  }
  const session = cache?.session;
  cache = null;
  backoffUntil = Number.MAX_SAFE_INTEGER;
  if (!session) return;
  try {
    await tearDownIressWireSession({
      iressSessionKey: session.sessionKey,
      client: session.client,
      releaseDelayMs: 0,
    });
    console.info("[market-data-prod] session released on shutdown");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[market-data-prod] shutdown teardown failed (continuing): ${msg}`);
  }
}

/** Invalidate + rethrow only when the error means the prod session died. */
export function noteMarketDataError(err: unknown): void {
  if (isIressSessionDeadError(err)) invalidateMarketDataSession();
}

/**
 * Single-seat enforcement. 2026-07-29: the IRESS prod account has exactly
 * one licence seat. Opening a 2nd wire session (the original prod
 * market-data split) gets a "No more licenses available" error and
 * orphans the seat. To prevent re-introducing the leak, default
 * `IRESS_USE_SINGLE_SEAT` to "1" — operators only get the split back by
 * explicitly setting `IRESS_USE_SINGLE_SEAT=0`. When single-seat is on,
 * this function never opens a 2nd session and simply returns null;
 * callers fall through to the orders session.
 *
 * The check is sync and cheap (one env read + one log) so the
 * background loops pay no extra roundtrip.
 */
export function singleSeatEnforced(): boolean {
  const v = (process.env.IRESS_USE_SINGLE_SEAT ?? "1").trim().toLowerCase();
  return v !== "0" && v !== "false";
}

/**
 * `true` when market-data calls should be routed to the prod endpoint via
 * a dedicated 2nd wire session. Returns `false` (i.e. fall through to the
 * orders session) in three cases:
 *   1. `IRESS_MARKET_DATA_PROD` is unset / "0" — operator has opted out.
 *   2. `IRESS_USE_SINGLE_SEAT=1` (the new default since the IRESS prod
 *      account has one licence seat) — no 2nd session is allowed.
 *   3. Bring-up already failed and we're inside the failure backoff.
 *
 * Callers use this to decide whether to use the dedicated prod session
 * (`md.client`) or fall through to `getIressClient("live")` + the orders
 * session key. Under single-seat, `marketDataProdEnabled()` is always
 * `false`, so the fall-through path is the only path.
 */
export function marketDataProdEnabled(): boolean {
  if (singleSeatEnforced()) return false;
  const v = (process.env.IRESS_MARKET_DATA_PROD ?? "0").trim().toLowerCase();
  return v === "1" || v === "true";
}

/**
 * Prod market-data client + session key, or `null` when the split is disabled
 * or the prod session cannot be established (callers then keep their fallback).
 * Never throws.
 */
export async function getMarketDataSession(): Promise<MarketDataSession | null> {
  if (singleSeatEnforced()) {
    // Single-seat mode: NEVER open a 2nd wire session. Callers fall through
    // to the orders session (via getIressClient("live") + session.iressSessionKey).
    return null;
  }
  if (!marketDataProdEnabled()) return null;
  if (Date.now() < backoffUntil) return null;
  if (cache && Date.now() < cache.expiresAt - EXPIRY_BUFFER_MS) return cache.session;
  if (inflight) return inflight;
  inflight = bringUp();
  try {
    return await inflight;
  } finally {
    inflight = null;
  }
}

async function bringUp(): Promise<MarketDataSession | null> {
  try {
    const baseUrl = marketDataBaseUrl();
    const creds = getIressProdCredentialsFromEnv();
    if (!creds.userName || !creds.password) {
      backoffUntil = Date.now() + FAILURE_BACKOFF_MS;
      return null;
    }
    const client = createLiveIressClient({ baseUrl });
    // Stable, DISTINCT ApplicationID: IRESS reconnects to the same prod
    // market-data seat across restarts, and it never collides with the orders
    // seat (which uses its own sticky per-worker ApplicationID).
    const node =
      (process.env.WORKER_ID ?? process.env.RAILWAY_SERVICE_NAME ?? "railway").trim() || "railway";
    const applicationId = `Mint-OEMS-MarketData-${node}`;
    const res = await client.iressSessionStart({
      UserName: creds.userName,
      CompanyName: creds.company,
      Password: creds.password,
      ApplicationID: applicationId,
      ApplicationLabel: "Mint-OEMS-MarketData",
      SessionTimeout: 120,
      Locale: "en-ZA",
    });
    const timeoutMin = res.SessionTimeout ?? 120;
    cache = {
      session: { client, sessionKey: res.IRESSSessionKey },
      expiresAt: Date.now() + timeoutMin * 60_000,
    };
    console.info(
      `[market-data-prod] session ready endpoint=${baseUrl} applicationId=${applicationId} timeoutMin=${timeoutMin}`,
    );
    return cache.session;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(
      `[market-data-prod] bring-up failed; market data stays on the Yahoo/UAT fallback (orders unaffected): ${msg}`,
    );
    backoffUntil = Date.now() + FAILURE_BACKOFF_MS;
    cache = null;
    return null;
  }
}
