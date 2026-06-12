/**
 * Real-data policy — when Supabase quotes mode is on, the UI must never
 * display seed/mock prices or synthetic KPIs. Empty/honest states only.
 */

import type { Quote } from "@/types/iress";

/** Server-side: `USE_SUPABASE_QUOTES=true` */
export function isUseSupabaseQuotesEnabled(): boolean {
  const raw = process.env.USE_SUPABASE_QUOTES;
  if (!raw) return false;
  return raw === "1" || raw.toLowerCase() === "true";
}

/** Client-side mirror of `NEXT_PUBLIC_USE_SUPABASE_QUOTES`. */
export function isRealDataOnlyClient(): boolean {
  if (typeof window === "undefined") {
    const raw = process.env.NEXT_PUBLIC_USE_SUPABASE_QUOTES;
    return raw === "1" || raw?.toLowerCase() === "true";
  }
  const raw = process.env.NEXT_PUBLIC_USE_SUPABASE_QUOTES;
  if (!raw) return false;
  return raw === "1" || raw.toLowerCase() === "true";
}

/** Zero quote — safe to render as "—" in NumberCell (ts === 0). */
export function emptyQuote(symbol: string, exchange = "JSE"): Quote {
  return {
    symbol,
    last: 0,
    bid: 0,
    ask: 0,
    bidSize: 0,
    askSize: 0,
    open: 0,
    high: 0,
    low: 0,
    close: 0,
    prevClose: 0,
    change: 0,
    changePct: 0,
    volume: 0,
    vwap: 0,
    currency: "ZAR",
    marketState: "CLOSED",
    ts: 0,
  };
}

export const FEED_NOT_CONFIGURED = "Data feed not configured";

/** Alias for production mandate checks in UI and API routes. */
export function isProductionRealDataMode(): boolean {
  return isRealDataOnlyClient();
}

/**
 * True when the Vercel BFF should reverse-proxy live data to the Railway
 * `iress-ingest` worker instead of falling back to seed/mock. Path B routes
 * (live orders, integration health) consult this before they reach for
 * `IRESS_WORKER_URL`; Path A routes (snapshots, audit, watchlist) read
 * Supabase via `isUseSupabaseQuotesEnabled()` and never look at the worker.
 *
 * Distinct from `isProductionRealDataMode()` because:
 * - `isProductionRealDataMode` controls *UI rendering* — the chrome must
 *   show SUPABASE / unavailable, never seed.
 * - `isWorkerLiveMode` controls *route choice* — Path B should hit the
 *   worker; Path A still goes through Supabase.
 *
 * Both are set together in production today, but they encode different
 * invariants and may diverge (e.g. a staging env with the worker enabled
 * but the UI flag off while we test the new BFF in isolation).
 */
export function isWorkerLiveMode(): boolean {
  return isUseSupabaseQuotesEnabled();
}

/**
 * The configured URL of the Railway `iress-ingest` worker (server-side only).
 * Used by Path B BFF passthroughs to reverse-proxy live orders, integration
 * health, and SSE streams — see `WorkerReadOnlyApi` in `@/lib/iress/worker-api`.
 *
 * Precedence:
 * 1. `IRESS_WORKER_URL` — explicit override (e.g. staging pointing at a
 *    non-Railway preview).
 * 2. `RAILWAY_SERVICE_URL` — Railway's default env var for the worker's
 *    public service URL (set automatically when services are linked).
 * 3. Empty string — the BFF treats the worker as unreachable and the
 *    passthroughs return 503 "Worker not configured" instead of 500.
 */
export function getIressWorkerUrl(): string {
  const explicit = process.env.IRESS_WORKER_URL;
  if (explicit && explicit.trim()) return explicit.trim().replace(/\/+$/, "");
  const railway = process.env.RAILWAY_SERVICE_URL;
  if (railway && railway.trim()) return railway.trim().replace(/\/+$/, "");
  return "";
}

/** True when the worker URL is configured — needed for any Path B route. */
export function isIressWorkerConfigured(): boolean {
  return getIressWorkerUrl().length > 0;
}
