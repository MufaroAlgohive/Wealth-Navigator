/**
 * Shared contract for the AI equity-research BFF (GET /api/research-ai).
 *
 * The route GROUNDs over real `securities_c` fundamentals + recent news, then
 * SYNTHESIZEs a calibrated outlook via a provider-agnostic Anthropic-Messages
 * client (MiniMax-M3 exposes an Anthropic-compatible endpoint, so one adapter
 * serves both MiniMax and Claude).
 *
 * Data is REAL or honestly absent (null) — never fabricated. When no provider
 * API key is set, the route returns `configured: false` with the gathered
 * evidence still attached and `outlook: null` (an honest deferred state).
 */

export type Call = "bullish" | "neutral" | "bearish";
export type Confidence = "low" | "medium" | "high";
export type ResearchAiProvider = "minimax" | "claude";

/** One horizon's calibrated view. */
export interface OutlookHorizon {
  /** Fixed window label — e.g. "0–3 months". */
  horizon: string;
  call: Call;
  confidence: Confidence;
  rationale: string;
}

/** The synthesized analyst outlook. Null when deferred / unavailable / error. */
export interface ResearchOutlook {
  summary: string;
  shortTerm: OutlookHorizon;
  mediumTerm: OutlookHorizon;
  longTerm: OutlookHorizon;
  risks: string[];
}

/** Real evidence the model is allowed to reason over (or honest nulls). */
export interface GatheredEvidence {
  /** From securities_c (PE, EPS, div yield, beta, market cap, sector...). */
  fundamentals: Record<string, unknown> | null;
  priceSummary: { last: number | null; changePct: number | null } | null;
  newsCount: number;
}

export interface ResearchSource {
  title: string;
  url: string | null;
}

/**
 * One step in the research pipeline, surfaced so the user can see — step by
 * step — exactly what the system did: which data it gathered, what it found,
 * and what is missing or deferred (no black box).
 *   ok       did the step and got data
 *   empty    did the step but found nothing (e.g. no ticker-tagged news)
 *   skipped  not run this request (e.g. synthesis skipped on a cache hit)
 *   deferred capability not wired yet (e.g. web search, Iress financials)
 *   error    the step failed
 */
export type ResearchStepStatus = "ok" | "empty" | "skipped" | "deferred" | "error";
export interface ResearchStep {
  label: string;
  status: ResearchStepStatus;
  detail: string;
  /** Where the data came from / would come from — e.g. "securities_c", "MiniMax-M3". */
  source?: string;
}

/** A single web-search result fed to the model as recent online context. */
export interface WebResult {
  title: string;
  url: string;
  snippet: string;
}
export type WebSearchStatus = "ok" | "empty" | "deferred" | "error";
export interface WebResearchOutcome {
  status: WebSearchStatus;
  provider: "tavily" | "brave" | null;
  query: string | null;
  results: WebResult[];
  /** Human detail for the step-by-step trace. */
  detail: string;
}

/**
 * Cache outcome for a request:
 *  - "hit"       reused a stored answer, nothing material changed (NO model call, 0 tokens)
 *  - "refreshed" a stored answer existed but was stale/changed → regenerated
 *  - "miss"      no stored answer yet → generated the first one
 *  - "uncached"  research store unavailable (table/DB not provisioned) → generated, not stored
 */
export type CacheStatus = "hit" | "refreshed" | "miss" | "uncached";

/**
 * Materiality signal computed from REAL gathered evidence. Persisted with each
 * cache entry and compared on the next request to decide hit vs refreshed.
 */
export interface ResearchSignal {
  latestNewsTs: string | null;
  newsCount: number;
  lastPrice: number | null;
  /** Stable hash of the key fundamentals fields. */
  fundamentalsHash: string;
}

export interface AiResearchResponse {
  ok: boolean;
  symbol: string;
  name: string | null;
  /** false when no provider API key is set → honest "not configured" deferred. */
  configured: boolean;
  provider: ResearchAiProvider | null;
  model: string | null;
  /** ISO timestamp of the outlook actually shown (cached OR fresh); null when deferred. */
  generatedAt: string | null;
  // ── caching ──────────────────────────────────────────────
  cacheStatus: CacheStatus;
  /** true only when cacheStatus === "hit". */
  cached: boolean;
  /** Human sentence: why reused or why refreshed; null when N/A. */
  cacheReason: string | null;
  // ── content ──────────────────────────────────────────────
  gathered: GatheredEvidence;
  /** null when not configured / model unavailable / error. */
  outlook: ResearchOutlook | null;
  sources: ResearchSource[];
  /** Step-by-step trace of the pipeline (resolve → gather → web → synthesize → cache). */
  trace: ResearchStep[];
  disclaimer: string;
  error?: string;
}
