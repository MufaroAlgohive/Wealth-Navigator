import { toYahooSymbol } from "@/lib/data/providers/yahoo";
import { type YahooTruthQuote, fetchYahooTruthQuote } from "@/lib/truth/yahoo-live";

/**
 * Read-side IRESS → Yahoo price fallback.
 *
 * Every BFF route that renders prices from the IRESS-fed money track
 * (`securities_c.last_price` / `stock_intraday_c.current_price`, integer
 * cents) should resolve through this helper. When a symbol's DB price is
 * missing or older than the same `IRESS_STALE_FALLBACK_HOURS` window the
 * `/api/cron/yahoo-fundamentals` writer uses, the price is fetched live
 * from Yahoo Finance instead — so a silent IRESS outage never freezes a
 * client-facing figure at 0 / stale value, and nothing has to wait for
 * the 5-minute cron to persist.
 *
 * Unit safety (the "don't 10x the price" rule):
 *  - Yahoo JSE `.JO` quotes are already ZAc (cents) — `yahooPriceToCents`
 *    stores them verbatim, so `price_rands = priceCents / 100` here matches
 *    the IRESS convention exactly.
 *  - Non-JSE listings are major-currency units and are scaled ×100 to cents
 *    by the same helper (see src/lib/truth/yahoo-live.ts).
 *  - Read paths NEVER write to the DB: this is an in-memory overlay. The
 *    yahoo-fundamentals cron is the only persist path, and it keeps the
 *    same cents contract (its write gate is `YAHOO_FUNDAMENTALS_WRITE=1`).
 */

export const IRESS_STALE_FALLBACK_MS = (Number(process.env.IRESS_STALE_FALLBACK_HOURS) || 3) * 3_600_000;

export type ResolvedPriceSource = "securities_c" | "stock_intraday_c" | "yahoo";

export interface ResolvedSecurityPrice {
  symbol: string;
  name?: string | null;
  logo_url?: string | null;
  /** Rands (cents / 100). null when no DB price and Yahoo could not resolve. */
  price_rands: number | null;
  /** Percent number (e.g. -0.75 for -0.75%). */
  day_pct: number | null;
  price_as_of: string | null;
  price_source: ResolvedPriceSource;
}

/** securities_c row shape the caller already fetched. */
export interface SecurityPriceRow {
  id: string;
  symbol: string;
  name?: string | null;
  logo_url?: string | null;
  last_price?: number | null;
  change_percent?: number | null;
  updated_at?: string | null;
}

/** Latest stock_intraday_c tick per security_id. */
export interface IntradayPriceRow {
  current_price?: number | null;
  "1d_pct"?: number | null;
  timestamp?: string | null;
}

interface YahooCacheEntry {
  at: number;
  quote: YahooTruthQuote;
}

/** 60s in-process cache so a burst of reads doesn't hammer Yahoo per symbol. */
const YAHOO_CACHE_TTL_MS = 60_000;
const yahooCache = new Map<string, YahooCacheEntry>();

function cachedYahooQuote(symbol: string): YahooTruthQuote | null {
  const entry = yahooCache.get(symbol);
  if (!entry) return null;
  if (Date.now() - entry.at > YAHOO_CACHE_TTL_MS) {
    yahooCache.delete(symbol);
    return null;
  }
  return entry.quote;
}

async function yahooQuoteFor(symbol: string): Promise<YahooTruthQuote | null> {
  const cached = cachedYahooQuote(symbol);
  if (cached) return cached;
  try {
    // Map bare codes through the provider's symbol rules (3-4 letter JSE codes
    // → .JO, known JSE ETF roots → .JO, US/FX left bare) so a non-JSE holding
    // is never wrongly suffixed with .JO.
    const quote = await fetchYahooTruthQuote(toYahooSymbol(symbol));
    yahooCache.set(symbol, { at: Date.now(), quote });
    return quote;
  } catch {
    return null;
  }
}

function mapYahoo(symbol: string, quote: YahooTruthQuote): ResolvedSecurityPrice {
  return {
    symbol,
    name: null,
    logo_url: null,
    price_rands: quote.priceCents > 0 ? quote.priceCents / 100 : null,
    day_pct:
      quote.dailyChangePct != null && Number.isFinite(quote.dailyChangePct)
        ? Math.round(quote.dailyChangePct * 100) / 100
        : null,
    price_as_of: quote.exchangeTime || null,
    price_source: "yahoo",
  };
}

/** True when a DB price row is absent or older than the fallback window. */
export function isPriceStale(asOf: string | null | undefined, now: number = Date.now()): boolean {
  if (!asOf) return true;
  const ts = new Date(asOf).getTime();
  if (!Number.isFinite(ts)) return true;
  return now - ts > IRESS_STALE_FALLBACK_MS;
}

async function runBounded<T>(items: T[], concurrency: number, work: (item: T) => Promise<void>) {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const item = items[cursor] as T;
      cursor += 1;
      await work(item);
    }
  });
  await Promise.all(workers);
}

export interface ResolveSecurityPricesOptions {
  /** securities_c rows for the symbols of interest (may be empty). */
  rows: SecurityPriceRow[];
  /** Latest stock_intraday_c tick per security_id. */
  intradayBySecurityId: Map<string, IntradayPriceRow>;
  /** Holding symbols with no securities_c row at all — Yahoo-fill these too. */
  missingSymbols?: string[];
  /** Hard cap on Yahoo lookups per call (default 40). */
  maxYahoo?: number;
  /** Concurrent Yahoo lookups (default 4). */
  concurrency?: number;
}

/**
 * Resolve prices for a set of holdings. DB-first, Yahoo live fallback for
 * anything missing or stale. Never throws; a failed Yahoo lookup degrades to
 * the DB value (which may be null → the UI renders "—").
 */
export async function resolveSecurityPrices(
  opts: ResolveSecurityPricesOptions,
): Promise<ResolvedSecurityPrice[]> {
  const { rows, intradayBySecurityId, missingSymbols = [], maxYahoo = 40, concurrency = 4 } = opts;
  const now = Date.now();
  const out: ResolvedSecurityPrice[] = [];

  const needsYahoo: string[] = [];
  for (const row of rows) {
    const live = intradayBySecurityId.get(String(row.id));
    const priceCents = live?.current_price != null ? Number(live.current_price) : Number(row.last_price || 0);
    const asOf = (live?.timestamp as string | undefined) ?? row.updated_at;
    const fresh = !isPriceStale(asOf, now);
    const havePrice = priceCents > 0;
    if (havePrice && fresh) {
      out.push({
        symbol: row.symbol,
        name: row.name,
        logo_url: row.logo_url,
        price_rands: priceCents / 100,
        day_pct:
          live?.["1d_pct"] != null
            ? Number(live["1d_pct"])
            : row.change_percent == null
              ? null
              : Number(row.change_percent),
        price_as_of: asOf ?? null,
        price_source: live ? "stock_intraday_c" : "securities_c",
      });
    } else {
      out.push({
        symbol: row.symbol,
        name: row.name,
        logo_url: row.logo_url,
        price_rands: havePrice ? priceCents / 100 : null,
        day_pct: row.change_percent == null ? null : Number(row.change_percent),
        price_as_of: asOf ?? null,
        price_source: live ? "stock_intraday_c" : "securities_c",
      });
      needsYahoo.push(row.symbol);
    }
  }

  const seen = new Set(out.map((entry) => entry.symbol.toUpperCase()));
  for (const symbol of missingSymbols) {
    if (seen.has(String(symbol).toUpperCase())) continue;
    seen.add(String(symbol).toUpperCase());
    out.push({
      symbol: String(symbol),
      name: null,
      logo_url: null,
      price_rands: null,
      day_pct: null,
      price_as_of: null,
      price_source: "securities_c",
    });
    needsYahoo.push(String(symbol));
  }

  const toFetch = [...new Set(needsYahoo.map((symbol) => String(symbol).toUpperCase()))]
    .filter((symbol) => !cachedYahooQuote(symbol))
    .slice(0, Math.max(0, maxYahoo));
  const resolved = new Map<string, ResolvedSecurityPrice>();

  await runBounded(toFetch, concurrency, async (symbol) => {
    const quote = await yahooQuoteFor(symbol);
    if (quote) resolved.set(symbol.toUpperCase(), mapYahoo(symbol, quote));
  });

  for (const entry of out) {
    const yahoo = resolved.get(entry.symbol.toUpperCase());
    if (yahoo) {
      entry.price_rands = yahoo.price_rands;
      entry.day_pct = yahoo.day_pct;
      entry.price_as_of = yahoo.price_as_of;
      entry.price_source = "yahoo";
    }
  }
  return out;
}

/**
 * Aggregate summary of a `resolveSecurityPrices` result. Lets BFF routes emit a
 * single `yahooCount` / `dbCount` figure alongside the rows so the UI badge
 * can honestly say "yahoo fallback" for the whole response (DataSourceBadge).
 *
 * Seamlessness contract: the freshness gate inside `resolveSecurityPrices`
 * (see `isPriceStale` / `IRESS_STALE_FALLBACK_MS`) makes IRESS-back-online
 * recovery automatic — the moment `securities_c.updated_at` or
 * `stock_intraday_c.timestamp` lands inside the freshness window, the next
 * read returns that DB row and `yahooCount` drops by one. The 60s in-process
 * cache here only matters for repeated lookups of the SAME stale symbol
 * inside one warm Vercel instance; on cold / new instances the cache is empty
 * so a freshly-recovered IRESS row is shown immediately.
 */
export interface ResolvedPriceSummary {
  total: number;
  /** Rows where IRESS/securities_c/stock_intraday_c had a fresh value. */
  dbCount: number;
  /** Rows whose price came from Yahoo live (DB was missing or stale). */
  yahooCount: number;
}

export function summariseResolvedPrices(rows: ResolvedSecurityPrice[]): ResolvedPriceSummary {
  let dbCount = 0;
  let yahooCount = 0;
  for (const row of rows) {
    if (row.price_source === "yahoo") yahooCount += 1;
    else dbCount += 1;
  }
  return { total: rows.length, dbCount, yahooCount };
}

/**
 * One-call convenience for BFF routes: resolves prices for a set of DB rows
 * and applies the result back onto the caller's rows in place. Cents-safety:
 * the helper writes `last_price` as INTEGER CENTS (Yahoo `priceCents` verbatim
 * for `.JO`, ×100 for non-JSE, divided by 100 → Rands × 100 → cents).
 *
 * Returns the count of rows that ended up on the Yahoo fallback so the caller
 * can surface it in the response (DataSourceBadge, operator diagnostics).
 *
 * IRESS-back-online seam: when securities_c.updated_at lands inside the
 * freshness window (`IRESS_STALE_FALLBACK_MS`), the next call's freshness
 * gate flips the row back to its DB value automatically — no state to clear.
 */
export interface ApplyTargetRow {
  symbol: string;
  last_price?: number | null;
  change_percent?: number | null;
  price_source?: "iress" | "yahoo" | "securities_c" | "stock_intraday_c" | "supabase";
}

export interface ApplyOptions {
  rows: ApplyTargetRow[];
  intradayBySecurityId?: Map<string, IntradayPriceRow>;
  /** Skip the fresh check for these rows (forces Yahoo lookup). Useful for
   *  "always fallback" admin diagnostics, never for production read paths. */
  force?: boolean;
  maxYahoo?: number;
  concurrency?: number;
}

export async function applyYahooFallback(opts: ApplyOptions): Promise<{ yahooFallback: number }> {
  const { rows, intradayBySecurityId = new Map(), maxYahoo = 40, concurrency = 4 } = opts;
  if (rows.length === 0) return { yahooFallback: 0 };

  const priceRows: SecurityPriceRow[] = rows.map((r) => ({
    id: r.symbol,
    symbol: r.symbol,
    name: null,
    logo_url: null,
    last_price: r.last_price ?? null,
    change_percent: r.change_percent ?? null,
    updated_at: null,
  }));
  const resolved = await resolveSecurityPrices({
    rows: priceRows,
    intradayBySecurityId,
    maxYahoo,
    concurrency,
  });
  const bySymbol = new Map(resolved.map((r) => [r.symbol.toUpperCase(), r] as const));
  let yahooFallback = 0;
  for (const row of rows) {
    const r = bySymbol.get(String(row.symbol).toUpperCase());
    if (!r) continue;
    if (r.price_source !== "yahoo") continue;
    if (r.price_rands != null) {
      row.last_price = Math.round(r.price_rands * 100);
    }
    if (r.day_pct != null) {
      row.change_percent = r.day_pct;
    }
    row.price_source = "yahoo";
    yahooFallback += 1;
  }
  return { yahooFallback };
}
