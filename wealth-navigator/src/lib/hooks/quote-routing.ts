import type { DataSourceKind } from "@/components/oems/primitives/data-source-badge";

/** Client-side flag mirror of server `USE_SUPABASE_QUOTES`. */
export function isUseSupabaseQuotesClientEnabled(): boolean {
  const raw = process.env.NEXT_PUBLIC_USE_SUPABASE_QUOTES;
  if (!raw) return false;
  return raw === "1" || raw.toLowerCase() === "true";
}

export type QuoteApiMode = "supabase" | "iress";

export function resolveQuoteApiMode(opts: {
  useSupabaseFlag?: boolean;
  iressMode: string;
}): QuoteApiMode {
  if (opts.useSupabaseFlag ?? isUseSupabaseQuotesClientEnabled()) return "supabase";
  if (opts.iressMode === "live" || opts.iressMode === "wsdl-stub") return "iress";
  // Default mock dev/prod to the BFF; server `USE_SUPABASE_QUOTES` decides DB vs seed.
  return "supabase";
}

export interface NormalisedQuoteRow {
  sym: string;
  last: number;
  prev?: number;
  bid?: number;
  ask?: number;
  change?: number;
  changePct?: number;
  volume?: number;
  vwap?: number;
  source: "live" | "iress" | "seed-fallback" | "mock" | "supabase" | "yahoo" | "unavailable";
}

/** BFF `/api/quotes` response (subset). */
export interface BffQuotesResponse {
  mode: string;
  useSupabase: boolean;
  quotes: Array<{
    symbol: string;
    last_price: number;
    prev_close?: number;
    bid?: number;
    ask?: number;
    change?: number;
    change_pct?: number;
    ts?: number;
    source: "live" | "iress" | "seed-fallback" | "mock" | "supabase" | "yahoo" | "unavailable";
  }>;
  liveCount: number;
  fallbackCount: number;
  /** Count of quotes served by the live Yahoo fallback this call. */
  yahooCount?: number;
  mockCount?: number;
  supabaseCount?: number;
  unavailableCount?: number;
  /** Count of quotes served by the retail DB (supabase) this call. */
  dbCount?: number;
}

/** Legacy `/api/iress/quotes` response (subset). */
export interface IressQuotesResponse {
  mode: string;
  quotes: Array<{
    symbol: string;
    source: "live" | "seed-fallback" | "mock";
    quote: {
      last: number;
      bid: number;
      ask: number;
      change: number;
      changePct: number;
      volume: number;
      vwap: number;
    };
  }>;
  liveCount: number;
  fallbackCount: number;
}

export function normaliseBffQuotes(data: BffQuotesResponse): NormalisedQuoteRow[] {
  return data.quotes.map((r) => ({
    sym: r.symbol,
    last: r.last_price,
    prev: r.prev_close,
    bid: r.bid,
    ask: r.ask,
    change: r.change,
    changePct: r.change_pct,
    source: r.source,
  }));
}

export function normaliseIressQuotes(data: IressQuotesResponse): NormalisedQuoteRow[] {
  return data.quotes.map((r) => ({
    sym: r.symbol,
    last: r.quote.last,
    bid: r.quote.bid,
    ask: r.quote.ask,
    change: r.quote.change,
    changePct: r.quote.changePct,
    volume: r.quote.volume,
    vwap: r.quote.vwap,
    source: r.source,
  }));
}

export function deriveDataSource(
  rows: NormalisedQuoteRow[],
  counts: {
    liveCount: number;
    fallbackCount: number;
    supabaseCount?: number;
    mockCount?: number;
    unavailableCount?: number;
  },
  /**
   * Optional override: when the primary worker is in `iress_mode = "live"`
   * AND the response has at least one row with a tick fresher than 30s,
   * we treat the whole response as LIVE. Audit #3. UI passes the worker's
   * `iress_mode` here; the routing layer is the only place this
   * decision is made so the Cockpit and Integration pages agree.
   */
  opts?: {
    workerIrEssMode?: string | null;
    freshTickMs?: number;
  },
): DataSourceKind {
  const supabase = counts.supabaseCount ?? rows.filter((r) => r.source === "supabase").length;
  const live = counts.liveCount;
  const fallback = counts.fallbackCount;
  const mock = counts.mockCount ?? rows.filter((r) => r.source === "mock").length;
  const unavailable = counts.unavailableCount ?? rows.filter((r) => r.source === "unavailable").length;

  // Audit #3 — when the worker is live (Railway), prefer the LIVE label
  // even though the BFF response shape is `supabase` (it reads from
  // `stock_intraday_c` either way). The `hybrid` case is reserved for
  // responses that actually mix live and mock ticks in the same call —
  // the production app never does.
  const workerLive = (opts?.workerIrEssMode ?? "").toLowerCase() === "live";
  const freshCutoff = opts?.freshTickMs ?? 30_000;
  const now = Date.now();
  const hasFreshTick = rows.some(
    (r) =>
      typeof (r as { ts?: number }).ts === "number" && now - ((r as { ts?: number }).ts ?? 0) < freshCutoff,
  );
  if (workerLive && hasFreshTick && (supabase > 0 || live > 0)) return "live";
  if (workerLive && (supabase > 0 || live > 0)) return "supabase";

  if (unavailable > 0 && supabase === 0 && live === 0 && fallback === 0 && mock === 0) return "mock";
  if (supabase > 0 && live === 0 && fallback === 0 && mock === 0 && unavailable === 0) return "supabase";
  if (supabase > 0 && (fallback > 0 || mock > 0 || live > 0 || unavailable > 0)) return "hybrid";
  if (live > 0 && fallback === 0) return "live";
  if (live > 0 && fallback > 0) return "hybrid";
  if (fallback > 0) return "seed";
  return "mock";
}

/** Ticker chrome label — honest, coarse-grained feed kind. */
export type TickerFeedKind = "supabase" | "stream" | "mock";

export function tickerFeedFromDataSource(source: DataSourceKind): TickerFeedKind {
  if (source === "supabase" || source === "live" || source === "hybrid") return "supabase";
  if (source === "seed") return "mock";
  return "mock";
}

export const QUOTE_POLL_INTERVAL_MS = 15_000;
