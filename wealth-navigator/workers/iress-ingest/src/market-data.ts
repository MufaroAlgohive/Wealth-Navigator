/**
 * Isolated PRODUCTION market-data IRESS session.
 *
 * The worker runs ORDERS on the UAT endpoint (MINT_CT) through the main
 * `WorkerSessionManager`, which this module NEVER touches. When
 * `IRESS_MARKET_DATA_PROD=1`, market-data reads (quotes / timeseries / news)
 * instead use a SECOND IRESSSession opened against the PRODUCTION endpoint,
 * with its OWN client, its OWN stable ApplicationID (distinct from the orders
 * seat so the two never kick each other), and graceful failure: on any error
 * (no seat / not entitled / network) it returns null and callers fall back to
 * their existing Yahoo / UAT behaviour. Orders are never affected.
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
 */
export function marketDataProdEnabled(): boolean {
  const v = (process.env.IRESS_MARKET_DATA_PROD ?? "").trim().toLowerCase();
  return v === "1" || v === "true";
}

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
 */
export async function tearDownMarketDataSession(): Promise<void> {
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
 * Prod market-data client + session key, or `null` when the split is disabled
 * or the prod session cannot be established (callers then keep their fallback).
 * Never throws.
 */
export async function getMarketDataSession(): Promise<MarketDataSession | null> {
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
