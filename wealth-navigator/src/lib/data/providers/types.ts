/**
 * Market data provider abstraction.
 *
 * The data layer routes through one of these providers so the rest of the
 * system can switch between IRESS, Yahoo, Mock, or (future) IRIS without
 * callers having to know. Each provider exposes a common surface
 * (fetchQuotes / fetchIntraday / fetchHistory / fetchSnapshot / health) so
 * BFFs can pick the active one via `getActiveProvider()` and the rest of
 * the stack stays untouched.
 *
 * Selectors live in `./index.ts`. Implementations live in their own files.
 */

export interface ProviderQuote {
  symbol: string;
  last: number | null;
  prevClose: number | null;
  bid: number | null;
  ask: number | null;
  volume: number | null;
  /** ISO 8601 timestamp from the source (worker tick, Yahoo ts, or seed). */
  timestamp: string;
  /**
   * Coarse source tag — the upstream that produced this row.
   * `supabase` marks a worker-ingested DB read, even when the BFF happens
   * to surface it through the IRESS provider.
   */
  source: "iress" | "yahoo" | "mock" | "iris" | "supabase";
  /** Optional error string when the row is a partial / unavailable response. */
  error?: string;
}

export interface Bar {
  /** ISO 8601 timestamp for the bar. */
  timestamp: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface ProviderHealth {
  status: "ok" | "degraded" | "unconfigured" | "error";
  message?: string;
  latencyMs?: number;
  lastChecked: string;
}

export type ProviderName = "iress" | "yahoo" | "mock" | "iris";

export interface MarketDataProvider {
  readonly name: ProviderName;
  /**
   * Batch fetch snapshots for the given symbols. Implementations are
   * best-effort: missing or unentitled symbols are returned with
   * `last: null` and an `error` tag — never throw.
   */
  fetchQuotes(symbols: string[]): Promise<ProviderQuote[]>;
  /** Intraday OHLCV bars for one symbol, oldest-first. */
  fetchIntraday(symbol: string): Promise<Bar[]>;
  /** Daily OHLCV bars for one symbol over a labelled range. */
  fetchHistory(symbol: string, range: "1D" | "5D" | "1M" | "3M" | "6M" | "1Y" | "5Y"): Promise<Bar[]>;
  /**
   * Single-symbol snapshot. Returns null when the symbol is unknown to
   * the provider (e.g. mock universe) or the upstream is unreachable.
   */
  fetchSnapshot(symbol: string): Promise<ProviderQuote | null>;
  /** Cheap health probe. Never throws. */
  health(): Promise<ProviderHealth>;
}
