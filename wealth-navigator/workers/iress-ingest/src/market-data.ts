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
import { createLiveIressClient, iressConfig } from "../../../src/lib/iress/index";

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
 * SAFETY (single-seat protection): opening a prod market-data session on the
 * SAME IRESS login as the UAT orders session (DFM@Mint) pulls that login's data
 * server (IDS) to production and knocks out the CT/UAT session with "No IDS is
 * online" - which kills order placement. IRESS confirmed one login cannot hold
 * an IDS in prod and CT at once. So the split activates ONLY when a DISTINCT
 * prod market-data login (its own seat) is configured via IRESS_PROD_USERNAME.
 * With a single shared seat, leave IRESS_PROD_USERNAME unset and the seat stays
 * on orders. To force the shared-login behaviour anyway (knowing it takes UAT
 * orders offline), set IRESS_MARKET_DATA_PROD_ALLOW_SHARED_SEAT=1.
 */
export function marketDataProdEnabled(): boolean {
  const v = (process.env.IRESS_MARKET_DATA_PROD ?? "").trim().toLowerCase();
  if (v !== "1" && v !== "true") return false;
  if ((process.env.IRESS_MARKET_DATA_PROD_ALLOW_SHARED_SEAT ?? "").trim() === "1") return true;
  const prodUser = (process.env.IRESS_PROD_USERNAME ?? "").trim();
  const ordersUser = (process.env.IRESS_USERNAME ?? "").trim();
  // Needs its own login (second seat), distinct from the orders login.
  return prodUser.length > 0 && prodUser.toLowerCase() !== ordersUser.toLowerCase();
}

/** Prod market-data endpoint (defaults to iressConfig.prodUrl = webservices.iress.co.za). */
export function marketDataBaseUrl(): string {
  return (process.env.IRESS_MARKETDATA_BASE_URL ?? "").trim() || iressConfig.prodUrl;
}

/** Drop the cached prod session (call after a session-dead error so it rebuilds). */
export function invalidateMarketDataSession(): void {
  cache = null;
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
