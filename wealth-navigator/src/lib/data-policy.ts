/**
 * Real-data policy — when Supabase quotes mode is on, the UI must never
 * display seed/mock prices or synthetic KPIs. Empty/honest states only.
 */

import type { Quote } from "@/types/iress";

/** Server-side: `USE_SUPABASE_QUOTES=true` (or unset → default true for prod).
 *
 * Default-on matches the AGENTS.md mandate: "DB-first reads; UI reads Supabase;
 * worker-ingested data". Setting `USE_SUPABASE_QUOTES=0`/`false` opts the BFF
 * out (e.g. for a smoke test that needs a direct IRESS hit without the worker
 * round-trip). Production deploys MUST leave the env unset or `true`. */
export function isUseSupabaseQuotesEnabled(): boolean {
  const raw = process.env.USE_SUPABASE_QUOTES;
  if (raw === "0" || raw?.toLowerCase() === "false") return false;
  return true;
}

/** Client-side mirror of `NEXT_PUBLIC_USE_SUPABASE_QUOTES`. */
export function isRealDataOnlyClient(): boolean {
  // Yellow #24 — dev-only override. `?mock=1` (or `?mock=true`) in the
  // URL forces the mock path even when the production flag is set.
  // The override is browser-only and is *never* honoured on the
  // server (Vercel BFFs read `USE_SUPABASE_QUOTES` directly). The
  // mock path renders a yellow "DEV · MOCK" banner in dev mode so
  // a dev visiting the page on production Vercel can still poke at
  // the seed UI without flipping the env. The same flag also
  // accepts `?mock=0` to force the real path off the env.
  if (typeof window !== "undefined") {
    const params = new URLSearchParams(window.location.search);
    const flag = params.get("mock");
    if (flag === "1" || flag?.toLowerCase() === "true") return false;
    if (flag === "0" || flag?.toLowerCase() === "false") return true;
  }
  // Default to REAL-DATA-ONLY when the flag is unset. Mock/seed must be opted
  // into explicitly (NEXT_PUBLIC_USE_SUPABASE_QUOTES=0/false, or ?mock=1) so a
  // default/unset config never renders seed or fixture data as if it were real
  // — e.g. the persona portals' demo branch only shows under an explicit mock
  // opt-in (and the ?mock=1 path carries the DEV·MOCK banner). Server and client
  // resolve identically to avoid a hydration mismatch.
  const raw = process.env.NEXT_PUBLIC_USE_SUPABASE_QUOTES;
  if (raw === "0" || raw?.toLowerCase() === "false") return false;
  return true;
}

/**
 * Yellow #24 — the visual "DEV · MOCK" banner. The Banner is only
 * rendered when the URL carries `?mock=1` AND we're not in a
 * production build (`process.env.NODE_ENV !== "production"`). On
 * production Vercel the override is honoured but the banner is
 * suppressed so visitors don't see dev chrome.
 */
export function isMockOverrideActive(): boolean {
  if (typeof window === "undefined") return false;
  const params = new URLSearchParams(window.location.search);
  return params.get("mock") === "1" || params.get("mock")?.toLowerCase() === "true";
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
