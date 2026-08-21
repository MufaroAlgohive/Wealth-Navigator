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
 *
 * Provenance vs recency (the "switch back to IRESS" problem):
 *  - `isPriceStale()` alone answers "was this row touched recently?" — it
 *    cannot answer "did IRESS itself produce this value?". The Yahoo
 *    fallback writer (`/api/cron/yahoo-fundamentals`) refreshes
 *    `securities_c.updated_at` on every write it makes for a symbol it
 *    owns, so a purely recency-based check can stay "fresh" forever from
 *    Yahoo's own upkeep — with IRESS down for weeks — and never signal a
 *    clean handover back.
 *  - `securities_c.price_source` (additive column, `supabase/retail/
 *    20260614_add_price_source.sql`, already stamped by the real IRESS
 *    writer at `workers/iress-ingest/src/retail-ingest.ts` when
 *    `RETAIL_PRICE_SOURCE_COL=1`) records WHO last wrote the price.
 *    `isIressConfirmedFresh()` below is the actual switch-back condition:
 *    fresh AND `price_source !== 'yahoo'`. A fresh row stamped 'yahoo' is
 *    Yahoo's own maintenance write and must never be read as "IRESS is
 *    back", however recent it is.
 *  - Rows with no `price_source` (column not selected because
 *    `RETAIL_PRICE_SOURCE_COL` isn't set yet, or a pre-provenance write)
 *    fall back to plain recency — the pre-existing behaviour — so this is
 *    additive and never breaks an unmigrated DB.
 */

export const IRESS_STALE_FALLBACK_MS = (Number(process.env.IRESS_STALE_FALLBACK_HOURS) || 3) * 3_600_000;

/** Who last wrote `securities_c.last_price` for a symbol, per `price_source`. */
export type PriceSourceFeed = "iress" | "yahoo" | null | undefined;

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
  /** Feed that last wrote `last_price` ('iress' | 'yahoo' | null). Only
   *  present when the caller selected it (gated by `RETAIL_PRICE_SOURCE_COL`
   *  — see isIressConfirmedFresh). */
  price_source?: PriceSourceFeed;
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

/**
 * THE switch-back condition. True only when a row's freshness is genuine
 * evidence that IRESS itself produced the value — not just that some writer
 * (possibly the Yahoo fallback cron doing its normal upkeep) touched the row
 * recently.
 *
 * `isPriceStale()` alone cannot tell these apart: `/api/cron/yahoo-fundamentals`
 * refreshes `securities_c.updated_at` on every write it makes for a symbol it
 * owns, so a purely recency-based check can read "fresh" forever purely from
 * Yahoo's own upkeep, even with IRESS down for weeks — the switch never
 * cleanly hands back. A fresh row stamped `price_source: 'yahoo'` must NOT be
 * read as "IRESS is back", however recent it is; only a fresh 'iress'-sourced
 * row counts.
 *
 * Rows with no `price_source` (column not selected — gated by
 * `RETAIL_PRICE_SOURCE_COL` until the additive migration is applied and the
 * flag flipped — or a pre-provenance write) fall back to plain recency, the
 * pre-existing behaviour, so this is additive and never breaks an unmigrated
 * DB or regresses current behaviour before the flag is on.
 */
export function isIressConfirmedFresh(
  asOf: string | null | undefined,
  priceSource: PriceSourceFeed,
  now: number = Date.now(),
): boolean {
  if (isPriceStale(asOf, now)) return false;
  return priceSource !== "yahoo";
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
      // Provenance-aware label: a live intraday tick has no per-tick
      // provenance today (both writers upsert stock_intraday_c the same
      // shape), so it keeps the old "stock_intraday_c" label. For the
      // securities_c-only path, honestly distinguish a fresh IRESS write
      // from a fresh Yahoo upkeep write — see isIressConfirmedFresh.
      const source: ResolvedPriceSource = live
        ? "stock_intraday_c"
        : isIressConfirmedFresh(asOf, row.price_source, now)
          ? "securities_c"
          : "yahoo";
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
        price_source: source,
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
