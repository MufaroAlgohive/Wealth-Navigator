/**
 * `YahooProvider` — thin HTTP client for the public Yahoo Finance
 * endpoints (`query1.finance.yahoo.com`).
 *
 * Maps bare codes to the Yahoo symbol convention (`NPN.JO` for JSE,
 * `AAPL` for NASDAQ) and reshapes the response into the shared
 * `ProviderQuote` / `Bar` types so the rest of the data layer can treat
 * Yahoo identically to IRESS.
 *
 * Network is best-effort: any failure is surfaced as an `error` tag on
 * each row (quotes) or an empty array (intraday / history) — never
 * throws. Yahoo is also rate-limited and unauthenticated, so back off
 * hard from this provider in production paths and prefer the worker
 * (IRESS) or Supabase (worker-ingested) where possible.
 */

import type { Bar, MarketDataProvider, ProviderHealth, ProviderQuote } from "./types";

const YAHOO_HOST = "https://query1.finance.yahoo.com";

/**
 * A7.5 — JSE-listed ETFs that trade under a 5–6 letter root symbol on
 * Yahoo Finance (e.g. `STXNDQ.JO` for Satrix Nasdaq 100, `SYG.JO` for
 * Satrix MSCI World). Phase C's full universe mapping will replace
 * this set with the worker's `securities_c.last_price` discovery
 * table; for now we only need the roots the desk references by name.
 */
const JSE_ETF_ROOTS = new Set<string>([
  "STXNDQ",
  "STX500",
  "STXEMG",
  "STXWDM",
  "STXSAB",
  "STXPRO",
  "STXCHN",
  "SYG",
  "SYGP",
  "SYGWD",
  "SYGEU",
  "SYGJP",
  "SYGEM",
  "SYGUK",
  "SYGCN",
  "STX40",
  "STXFIN",
  "STXIND",
  "STXRES",
  "E500",
  "EJP",
  "EPL",
  "EPRA",
  "GLD",
  "PLT",
  "NEWUSD",
  "ZAPS",
  "ZAPD",
  "PREFTX",
]);

/** Convert a bare security code to a Yahoo symbol. JSE → `.JO`. */
export function toYahooSymbol(symbol: string): string {
  const s = symbol.trim().toUpperCase();
  if (!s) return s;
  if (s.includes(".") || s.includes("/")) return s.replace(/\.JSE$/i, ".JO");
  // Heuristic: 3–4 letter all-caps that we know are JSE codes take .JO.
  // Everything else (NASDAQ tickers like MSFT/AAPL, FX) is left bare —
  // Yahoo accepts them as-is. This keeps the JSE mapping deterministic
  // without trying to enumerate every global exchange.
  if (/^[A-Z]{3,4}$/.test(s)) {
    // Common SA tickers land in the JSE universe (5-letter codes like
    // "AGLJO" already carry a suffix; skip them).
    return `${s}.JO`;
  }
  // A7.5 — known JSE-listed ETF root codes (5–6 letters) that users
  // sometimes enter bare. Yahoo Finance only resolves these with the
  // `.JO` suffix, so we add it defensively. The full universe lands
  // via the worker in Phase C; this list is intentionally short and
  // additive — bare codes that aren't in the list fall through to
  // the bare-string return below and Yahoo will just 404 cleanly.
  if (JSE_ETF_ROOTS.has(s)) return `${s}.JO`;
  return s;
}

/** Convert a Yahoo symbol back to a bare code. */
export function fromYahooSymbol(yahooSymbol: string): string {
  return yahooSymbol.replace(/\.JO$/i, "").toUpperCase();
}

interface YahooChartMeta {
  symbol?: string;
  regularMarketPrice?: number;
  chartPreviousClosePrice?: number;
  previousClose?: number;
  regularMarketVolume?: number;
  postMarketTime?: number;
  regularMarketTime?: number;
  currency?: string;
  exchangeName?: string;
}

interface YahooChartQuote {
  o?: number[];
  h?: number[];
  l?: number[];
  c?: number[];
  v?: number[];
  t?: number[];
}

interface YahooChartResult {
  meta?: YahooChartMeta;
  indicators?: { quote?: YahooChartQuote[] };
}

interface YahooChartResponse {
  chart?: {
    result?: YahooChartResult[];
    error?: unknown;
  };
}

interface YahooQuoteEntry {
  symbol: string;
  regularMarketPrice?: number;
  regularMarketChange?: number;
  regularMarketChangePercent?: number;
  regularMarketVolume?: number;
  regularMarketPreviousClose?: number;
  regularMarketTime?: number;
  currency?: string;
  shortName?: string;
  longName?: string;
  marketState?: string;
}

interface YahooQuoteResponse {
  quoteResponse?: {
    result?: YahooQuoteEntry[];
    error?: unknown;
  };
}

async function chartFetch(symbol: string, range: string, interval: string): Promise<YahooChartResponse> {
  const url = `${YAHOO_HOST}/v8/finance/chart/${encodeURIComponent(symbol)}?range=${encodeURIComponent(range)}&interval=${encodeURIComponent(interval)}&includePrePost=false`;
  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; MintWealthNavigator/1.0)",
      Accept: "application/json",
    },
    cache: "no-store",
  });
  if (!res.ok) {
    throw new Error(`Yahoo chart ${res.status}`);
  }
  return (await res.json()) as YahooChartResponse;
}

async function quoteFetch(symbols: string[]): Promise<YahooQuoteResponse> {
  if (symbols.length === 0) return { quoteResponse: { result: [] } };
  const url = `${YAHOO_HOST}/v7/finance/quote?symbols=${encodeURIComponent(symbols.join(","))}`;
  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; MintWealthNavigator/1.0)",
      Accept: "application/json",
    },
    cache: "no-store",
  });
  if (!res.ok) {
    throw new Error(`Yahoo quote ${res.status}`);
  }
  return (await res.json()) as YahooQuoteResponse;
}

function yahooBarsFromChart(payload: YahooChartResponse, fallbackSymbol: string): Bar[] {
  const result = payload.chart?.result?.[0];
  if (!result) return [];
  const meta = result.meta ?? {};
  const quote = result.indicators?.quote?.[0] ?? {};
  const o = quote.o ?? [];
  const h = quote.h ?? [];
  const l = quote.l ?? [];
  const c = quote.c ?? [];
  const v = quote.v ?? [];
  const t = quote.t ?? [];
  const out: Bar[] = [];
  for (let i = 0; i < t.length; i++) {
    const close = c[i];
    if (!Number.isFinite(close)) continue;
    out.push({
      timestamp: new Date((t[i] ?? 0) * 1000).toISOString(),
      open: Number.isFinite(o[i]) ? Number(o[i]) : Number(close),
      high: Number.isFinite(h[i]) ? Number(h[i]) : Number(close),
      low: Number.isFinite(l[i]) ? Number(l[i]) : Number(close),
      close: Number(close),
      volume: Number.isFinite(v[i]) ? Number(v[i]) : 0,
    });
  }
  // Apply the meta's last/prev as the final bar when the chart is partial
  // (intraday snapshots sometimes end before regularMarketTime).
  if (out.length > 0 && Number.isFinite(meta.regularMarketPrice)) {
    const last = out[out.length - 1]!;
    const lastPrice = Number(meta.regularMarketPrice);
    out[out.length - 1] = {
      timestamp: last.timestamp,
      open: last.open,
      high: Math.max(last.high, lastPrice),
      low: Math.min(last.low, lastPrice),
      close: lastPrice,
      volume: Number.isFinite(meta.regularMarketVolume) ? Number(meta.regularMarketVolume) : last.volume,
    };
  }
  // Make TS happy about unused fallback in non-strict mode.
  void fallbackSymbol;
  return out;
}

const RANGE_TO_INTERVAL: Record<
  "1D" | "5D" | "1M" | "3M" | "6M" | "1Y" | "5Y",
  { range: string; interval: string }
> = {
  "1D": { range: "1d", interval: "5m" },
  "5D": { range: "5d", interval: "15m" },
  "1M": { range: "1mo", interval: "1d" },
  "3M": { range: "3mo", interval: "1d" },
  "6M": { range: "6mo", interval: "1d" },
  "1Y": { range: "1y", interval: "1d" },
  "5Y": { range: "5y", interval: "1wk" },
};

export class YahooProvider implements MarketDataProvider {
  readonly name = "yahoo" as const;

  async fetchQuotes(symbols: string[]): Promise<ProviderQuote[]> {
    if (symbols.length === 0) return [];
    const yahooSyms = symbols.map((s) => toYahooSymbol(s));
    try {
      const data = await quoteFetch(yahooSyms);
      const rows = data.quoteResponse?.result ?? [];
      const byYahoo = new Map<string, YahooQuoteEntry>();
      for (const r of rows) {
        if (r.symbol) byYahoo.set(r.symbol.toUpperCase(), r);
      }
      return symbols.map((raw, i) => {
        const sym = raw.replace(/\.(JO|JSE)$/i, "").toUpperCase();
        const yahooSym = yahooSyms[i]?.toUpperCase() ?? "";
        const r = byYahoo.get(yahooSym) ?? byYahoo.get(fromYahooSymbol(yahooSym));
        if (!r || !Number.isFinite(r.regularMarketPrice)) {
          return {
            symbol: sym,
            last: null,
            prevClose: null,
            bid: null,
            ask: null,
            volume: null,
            timestamp: new Date().toISOString(),
            source: "yahoo" as const,
            error: "no quote",
          };
        }
        return {
          symbol: sym,
          last: r.regularMarketPrice ?? null,
          prevClose: r.regularMarketPreviousClose ?? null,
          bid: r.regularMarketPrice ?? null,
          ask: r.regularMarketPrice ?? null,
          volume: r.regularMarketVolume ?? null,
          timestamp: new Date((r.regularMarketTime ?? Date.now() / 1000) * 1000).toISOString(),
          source: "yahoo" as const,
        };
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return symbols.map((raw) => ({
        symbol: raw.replace(/\.(JO|JSE)$/i, "").toUpperCase(),
        last: null,
        prevClose: null,
        bid: null,
        ask: null,
        volume: null,
        timestamp: new Date().toISOString(),
        source: "yahoo" as const,
        error: msg,
      }));
    }
  }

  async fetchIntraday(symbol: string): Promise<Bar[]> {
    const yahooSym = toYahooSymbol(symbol);
    try {
      const data = await chartFetch(yahooSym, "1d", "5m");
      return yahooBarsFromChart(data, yahooSym);
    } catch {
      return [];
    }
  }

  async fetchHistory(symbol: string, range: "1D" | "5D" | "1M" | "3M" | "6M" | "1Y" | "5Y"): Promise<Bar[]> {
    const yahooSym = toYahooSymbol(symbol);
    const cfg = RANGE_TO_INTERVAL[range] ?? RANGE_TO_INTERVAL["1Y"];
    try {
      const data = await chartFetch(yahooSym, cfg.range, cfg.interval);
      return yahooBarsFromChart(data, yahooSym);
    } catch {
      return [];
    }
  }

  async fetchSnapshot(symbol: string): Promise<ProviderQuote | null> {
    const [q] = await this.fetchQuotes([symbol]);
    if (!q || q.last == null) return null;
    return q;
  }

  async health(): Promise<ProviderHealth> {
    const start = Date.now();
    try {
      // Ping with a stable, low-rate ticker (Apple — Yahoo accepts it
      // with no symbol suffix). Just need any 2xx to confirm reachability.
      const res = await fetch(`${YAHOO_HOST}/v7/finance/quote?symbols=AAPL`, {
        headers: { "User-Agent": "Mozilla/5.0 (compatible; MintWealthNavigator/1.0)" },
        cache: "no-store",
      });
      if (!res.ok) {
        return {
          status: "degraded",
          message: `Yahoo HTTP ${res.status}`,
          latencyMs: Date.now() - start,
          lastChecked: new Date().toISOString(),
        };
      }
      return {
        status: "ok",
        latencyMs: Date.now() - start,
        lastChecked: new Date().toISOString(),
      };
    } catch (err) {
      return {
        status: "error",
        message: err instanceof Error ? err.message : String(err),
        latencyMs: Date.now() - start,
        lastChecked: new Date().toISOString(),
      };
    }
  }
}
