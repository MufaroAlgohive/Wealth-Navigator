/**
 * Yahoo Finance history fetcher used by the admin Dashboard "Return Insights"
 * panel. Reads raw `v8/finance/chart` data from Yahoo, applies the bare-code
 * `.JO` suffix rule already centralised in `lib/data/providers/yahoo.ts`, and
 * turns the resulting series into the per-period return map the BFF consumes
 * (`{ "1d_pct": …, "5d_pct": …, "mtd_pct": …, "1m_pct": …, "6m_pct": …, "ytd_pct": …,
 *   "1y_pct": …, "5y_pct": …, "all_pct": … }`).
 *
 * The DB-driven implementation that previously lived in
 * `/api/admin/dashboard` (`stock_returns_c` / `strategies_returns_c` /
 * certified `strategy_canonical_daily_ledger_c` overlay) has been retired —
 * the panel now reflects Yahoo's view of the world directly. A single
 * `range=10y&interval=1d` request per symbol gives us daily bars for up
 * to ten years (Yahoo clips to actual ticker history), which covers every
 * period the UI renders: 1D / 5D / MTD / 1M / 6M / YTD / 1Y / 5Y / All.
 *
 * Why `range=10y&interval=1d` and not `range=max`:
 *   `range=max` makes Yahoo auto-degrade to *monthly* granularity
 *   (`dataGranularity=1mo` — verified for MTN, NED, NPN, etc.), which
 *   collapses every daily return into the latest monthly bar. That is
 *   why an earlier version of this file came back showing `1D=0%` for
 *   every ticker: a monthly bar covers ~21 trading days, so the
 *   "yesterday-vs-today" baseline is literally the same bar as the
 *   "today" close. `range=10y&interval=1d` guarantees daily granularity
 *   (verified: ~2500 daily bars for MTN over 10y), at the cost of a
 *   larger payload than the 5y alternative.
 *
 * Why the period resolver walks *backwards* from `last.t`:
 *   During the trading day or on weekends, `nowMs` is fresher than
 *   `last.t` (the latest close Yahoo has returned). Computing
 *   `nowMs - 2*DAY` for the "1D" baseline and asking "what's the
 *   first bar >= that timestamp" lands on the very latest bar itself,
 *   producing `pct = (last - last) / last = 0%`. Walking backwards
 *   from `last.t - lookbackMs` and picking the most recent bar at or
 *   before that target gives a real previous-trading-day close — even
 *   if `nowMs` is hours after the market closed.
 *
 * Outlier guard:
 *   Yahoo occasionally returns a 0.001-style "first bar" for stocks
 *   that had a reverse-split or post-restructuring relisting, and
 *   `(today / 0.001) - 1` produces five-digit "All" figures that are
 *   truthful arithmetic over nonsense inputs. We reject any pct whose
 *   absolute value exceeds the `OUTLIER_PCT_CAP` and surface an
 *   honest `null` so the UI renders "—" instead.
 *
 * Rate-limiting posture:
 *   Yahoo's public endpoint is unauthenticated and applies an
 *   aggressive per-IP cap. We respect it by:
 *   - sending one request per symbol (not one per period),
 *   - bounding concurrency (default 4),
 *   - short-circuiting per-symbol on HTTP 429 / hard failures,
 *   - caching successful series in-process for `CACHE_TTL_MS` so
 *     repeated page-loads / Vercel warm hits don't re-hit Yahoo.
 *
 * Symbol normalisation (`NPN` → `NPN.JO`) is delegated to
 * `toYahooSymbol()` so we never diverge from the rest of the data layer.
 */
import { toYahooSymbol } from "@/lib/data/providers/yahoo";

const YAHOO_HOST = "https://query1.finance.yahoo.com";

export const YAHOO_RETURN_PERIODS = [
  "1d_pct",
  "5d_pct",
  "mtd_pct",
  "1m_pct",
  "6m_pct",
  "ytd_pct",
  "1y_pct",
  "5y_pct",
  "all_pct",
] as const;

export type YahooReturnPeriodKey = (typeof YAHOO_RETURN_PERIODS)[number];

export type YahooReturnRow = {
  symbol: string;
  lastPrice: number | null;
  asOf: string | null;
} & Partial<Record<YahooReturnPeriodKey, number | null>> & {
    error?: string;
  };

export interface YahooBar {
  t: number;
  close: number;
}

interface YahooChartQuote {
  close?: Array<number | null | undefined>;
}
interface YahooChartResult {
  timestamp?: number[];
  indicators?: { quote?: YahooChartQuote[] };
  meta?: {
    regularMarketPrice?: number;
    regularMarketTime?: number;
    currency?: string;
    dataGranularity?: string;
    range?: string;
  };
}
interface YahooChartResponse {
  chart?: {
    result?: YahooChartResult[];
    error?: { code?: string; description?: string };
  };
}

const YAHOO_HEADERS: HeadersInit = {
  "User-Agent": "Mozilla/5.0 (compatible; MintWealthNavigator/1.0)",
  Accept: "application/json",
};

/** Yahoo range that gives daily bars for up to 10y. Yahoo clips to the
 * ticker's actual history (newer IPOs return less than 10y). */
const YAHOO_RANGE = "10y";
/** Daily interval — `range=max` would auto-degrade to monthly. */
const YAHOO_INTERVAL = "1d";

/**
 * Any pct figure whose absolute value exceeds this threshold is treated
 * as an outlier (a near-zero baseline, a corporate action on the first
 * bar in the series, etc.) and surfaced to the UI as `null` so the bar
 * renders an honest "—" instead of a five-digit number with no signal.
 */
const OUTLIER_PCT_CAP = 1000;

/**
 * In-process LRU-ish cache so repeated dashboard reloads don't re-hit
 * Yahoo for the same ticker within the same Vercel invocation.
 */
const CACHE_TTL_MS = 5 * 60 * 1000;
type CacheRecord = { bars: YahooBar[]; lastPrice: number | null; asOf: number; expiresAt: number };
const historyCache = new Map<string, CacheRecord>();

function remember(symbol: string, rec: CacheRecord) {
  historyCache.set(symbol, rec);
  if (historyCache.size > 500) {
    const firstKey = historyCache.keys().next().value;
    if (firstKey) historyCache.delete(firstKey);
  }
}

async function fetchYahooChart(
  symbol: string,
  range: string,
  interval: string,
  signal?: AbortSignal,
): Promise<YahooChartResponse> {
  const url = `${YAHOO_HOST}/v8/finance/chart/${encodeURIComponent(symbol)}?range=${encodeURIComponent(range)}&interval=${encodeURIComponent(interval)}&includePrePost=false&events=history`;
  const res = await fetch(url, { headers: YAHOO_HEADERS, cache: "no-store", signal });
  if (!res.ok) throw new Error(`Yahoo ${symbol} HTTP ${res.status}`);
  return (await res.json()) as YahooChartResponse;
}

function yahooBarsFromChart(payload: YahooChartResponse): { bars: YahooBar[]; lastPrice: number | null } {
  const r = payload.chart?.result?.[0];
  if (!r) return { bars: [], lastPrice: null };
  const ts = r.timestamp ?? [];
  const closes = r.indicators?.quote?.[0]?.close ?? [];
  const bars: YahooBar[] = [];
  for (let i = 0; i < ts.length; i += 1) {
    const t = ts[i];
    const c = closes[i];
    if (t == null || c == null || !Number.isFinite(c)) continue;
    bars.push({ t: t * 1000, close: Number(c) });
  }
  bars.sort((a, b) => a.t - b.t);
  const meta = r.meta ?? {};
  const last = bars.length > 0 ? bars[bars.length - 1] : undefined;
  const lastPrice = Number.isFinite(meta.regularMarketPrice)
    ? Number(meta.regularMarketPrice)
    : (last?.close ?? null);
  return { bars, lastPrice };
}

/**
 * Fetch a single ticker. `range=10y&interval=1d` is guaranteed daily by
 * Yahoo and covers every period the panel needs in one HTTP call. The
 * result is cached for 5 min so subsequent reloads / warm Vercel hits
 * don't re-hit Yahoo.
 *
 * `range` is overridable: a "6mo" fetch (~130 daily bars) is a fraction
 * of the payload and plenty when only the short periods (1M/6M) are
 * wanted — used by the equities board. Cache is keyed per range so the
 * two consumers never poison each other's cache.
 */
export async function fetchYahooHistory(
  rawSymbol: string,
  options: { range?: string; interval?: string } = {},
): Promise<{
  bars: YahooBar[];
  lastPrice: number | null;
  asOf: number | null;
  error?: string;
}> {
  const bare = String(rawSymbol || "")
    .replace(/\.(JO|JSE)$/i, "")
    .toUpperCase()
    .trim();
  if (!bare) return { bars: [], lastPrice: null, asOf: null, error: "empty-symbol" };
  const yahooSym = toYahooSymbol(bare);
  const range = options.range ?? YAHOO_RANGE;
  const interval = options.interval ?? YAHOO_INTERVAL;
  const cacheKey = `${range}:${bare}`;
  const cached = historyCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return { bars: cached.bars, lastPrice: cached.lastPrice, asOf: cached.asOf, error: undefined };
  }
  try {
    const payload = await fetchYahooChart(yahooSym, range, interval);
    const errDesc = payload.chart?.error?.description;
    if (errDesc) return { bars: [], lastPrice: null, asOf: null, error: errDesc };
    const { bars, lastPrice } = yahooBarsFromChart(payload);
    if (bars.length === 0) return { bars: [], lastPrice: null, asOf: null, error: "no-data" };
    const lastBar = bars[bars.length - 1];
    const asOf = lastBar?.t ?? null;
    if (asOf != null) {
      remember(cacheKey, { bars, lastPrice, asOf, expiresAt: Date.now() + CACHE_TTL_MS });
    }
    return { bars, lastPrice, asOf };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { bars: [], lastPrice: null, asOf: null, error: message };
  }
}

function pct(latest: number, baseline: number): number {
  if (!Number.isFinite(latest) || !Number.isFinite(baseline) || baseline === 0) return Number.NaN;
  return ((latest - baseline) / baseline) * 100;
}

/**
 * Walk BACKWARDS from `bars[len-2]` to find the most-recent bar whose
 * `t` is at or before `targetMs`. Anchored to the latest bar's
 * timestamp, not `nowMs`, so a weekend / mid-session fetch still
 * returns the previous trading day's close as the 1D / 5D / 1M / 6M /
 * 1Y / 5Y baseline. Skipping the very last bar (`len-2`) means we
 * never resolve to the same bar we're comparing against.
 */
function resolveLookbackBaseline(bars: YahooBar[], targetMs: number): number | null {
  for (let i = bars.length - 2; i >= 0; i -= 1) {
    const bar = bars[i] as YahooBar;
    if (bar.t <= targetMs) return bar.close;
  }
  return null;
}

/** Final close before a calendar period starts (prior month/year end). */
function resolvePriorPeriodClose(bars: YahooBar[], periodStartMs: number): number | null {
  for (let index = bars.length - 2; index >= 0; index -= 1) {
    const bar = bars[index] as YahooBar;
    if (bar.t < periodStartMs) return bar.close;
  }
  return null;
}

function safePct(value: number): number | null {
  if (!Number.isFinite(value)) return null;
  if (Math.abs(value) > OUTLIER_PCT_CAP) return null;
  return Number(value.toFixed(2));
}

/**
 * Compute every period pct for a single ticker from a single daily
 * Yahoo history slice. The `nowMs` parameter is kept for API back-compat
 * but only used to anchor a few sanity helpers; period resolution is
 * anchored to the latest bar's own `t` so it stays correct on
 * weekends / mid-session.
 *
 * Any period whose computed pct falls outside `±OUTLIER_PCT_CAP` lands
 * as `null` (the UI renders "—") rather than as a five-digit garbage
 * number. Periods without enough history to compute a baseline also
 * land as `null`.
 */
export function computePeriodReturns(bars: YahooBar[]): {
  lastPrice: number | null;
  period: Partial<Record<YahooReturnPeriodKey, number | null>>;
  asOf: number | null;
} {
  if (bars.length < 2) {
    const tail = bars.at(-1);
    return { lastPrice: tail?.close ?? null, period: {}, asOf: tail?.t ?? null };
  }
  const last = bars[bars.length - 1] as YahooBar;
  const lastPrice = last.close;
  const lastMs = last.t;
  const lastDate = new Date(lastMs);

  const DAY = 86_400_000;
  const yearStartMs = Date.UTC(lastDate.getUTCFullYear(), 0, 1);
  const monthStartMs = Date.UTC(lastDate.getUTCFullYear(), lastDate.getUTCMonth(), 1);

  // 1D is the only period that maps to a *specific* bar (the bar before
  // the latest), not a window — its baseline is "yesterday's close".
  const previousClose = (bars[bars.length - 2] as YahooBar).close;
  const period: Partial<Record<YahooReturnPeriodKey, number | null>> = {};

  period["1d_pct"] = safePct(pct(lastPrice, previousClose));

  // Calendar windows anchored on `lastMs` (NOT `Date.now()` — see header).
  const lookbacks: { key: YahooReturnPeriodKey; ms: number }[] = [
    { key: "5d_pct", ms: 7 * DAY },
    { key: "1m_pct", ms: 31 * DAY },
    { key: "6m_pct", ms: 186 * DAY },
    { key: "1y_pct", ms: 366 * DAY },
    { key: "5y_pct", ms: 5 * 366 * DAY },
  ];
  for (const { key, ms } of lookbacks) {
    const baseline = resolveLookbackBaseline(bars, lastMs - ms);
    period[key] = safePct(pct(lastPrice, baseline ?? Number.NaN));
  }

  // Calendar-period returns start from the final close BEFORE the period.
  // Using the first close inside January/month omits the first trading day's
  // move and is not the conventional YTD/MTD definition.
  period.mtd_pct = safePct(pct(lastPrice, resolvePriorPeriodClose(bars, monthStartMs) ?? Number.NaN));
  period.ytd_pct = safePct(pct(lastPrice, resolvePriorPeriodClose(bars, yearStartMs) ?? Number.NaN));

  // "All" = full available history in this Yahoo fetch. Anchored on the
  // first bar (the earliest in-series close) and outlier-clamped
  // alongside the rest.
  const first = bars[0] as YahooBar;
  period.all_pct = safePct(pct(lastPrice, first.close));

  return { lastPrice, period, asOf: last.t };
}

/**
 * Process tickers in bounded-parallel batches so we don't hammer Yahoo
 * with N concurrent connections from a single dashboard render.
 */
export async function computeYahooReturnsForUniverse(
  symbols: string[],
  options: { concurrency?: number } = {},
): Promise<YahooReturnRow[]> {
  const concurrency = Math.max(1, Math.min(8, options.concurrency ?? 4));
  const unique = Array.from(
    new Set(
      symbols
        .map((s) =>
          String(s || "")
            .replace(/\.(JO|JSE)$/i, "")
            .toUpperCase()
            .trim(),
        )
        .filter(Boolean),
    ),
  );
  const out: YahooReturnRow[] = [];
  for (let i = 0; i < unique.length; i += concurrency) {
    const slice = unique.slice(i, i + concurrency);
    const rows = await Promise.all(
      slice.map(async (sym) => {
        const { bars, lastPrice, asOf, error } = await fetchYahooHistory(sym);
        const label = sym;
        if (error || bars.length === 0) {
          return {
            symbol: label,
            lastPrice,
            asOf: asOf ? new Date(asOf).toISOString() : null,
            error,
          } as YahooReturnRow;
        }
        const { period } = computePeriodReturns(bars);
        return {
          symbol: label,
          lastPrice,
          asOf: asOf ? new Date(asOf).toISOString() : null,
          ...period,
        } as YahooReturnRow;
      }),
    );
    out.push(...rows);
  }
  return out;
}

/**
 * Weighted strategy return: composes each model's per-period figure as
 * a holdings-weighted average of its constituent ticker pcts. Each row
 * in `holdings` may declare `shares` / `quantity` / `units` (the legacy
 * shape `loadRetailStrategies` reads) — missing unit counts fall back
 * to equal-weight so a single dimensionless holding does not silently
 * drop the strategy out of the panel. Returns the strategy-level pct
 * for every Yahoo period, weighted by the share weights only when both
 * numerator and denominator have a real pct (so a strategy with no 5D
 * bar in any constituent stays absent rather than synthesising 0%).
 */
export async function computeYahooStrategyReturns(
  strategies: Array<{ id: string; name: string; holdings: unknown }>,
  options: { concurrency?: number } = {},
): Promise<
  Array<
    { strategy_id: string; name: string; lastPrice: number | null; asOf: string | null } & Partial<
      Record<YahooReturnPeriodKey, number | null>
    >
  >
> {
  const concurrency = Math.max(1, Math.min(8, options.concurrency ?? 4));

  type Holding = { symbol: string; weight: number };
  function extractHoldings(raw: unknown): Holding[] {
    if (!Array.isArray(raw)) return [];
    const rows: Holding[] = [];
    for (const h of raw) {
      if (typeof h === "string") {
        const sym = h
          .replace(/\.(JO|JSE)$/i, "")
          .toUpperCase()
          .trim();
        if (sym) rows.push({ symbol: sym, weight: 1 });
        continue;
      }
      if (!h || typeof h !== "object") continue;
      const r = h as Record<string, unknown>;
      const symRaw = String(r.ticker ?? r.symbol ?? "")
        .replace(/\.(JO|JSE)$/i, "")
        .toUpperCase()
        .trim();
      if (!symRaw) continue;
      const units = Number(r.shares ?? r.quantity ?? r.units ?? r.weight ?? 1);
      const w = Number.isFinite(units) && units > 0 ? units : 1;
      rows.push({ symbol: symRaw, weight: w });
    }
    const total = rows.reduce((sum, x) => sum + x.weight, 0);
    if (total <= 0 || rows.length === 0) return [];
    return rows.map((x) => ({ symbol: x.symbol, weight: x.weight / total }));
  }

  const out: Array<
    { strategy_id: string; name: string; lastPrice: number | null; asOf: string | null } & Partial<
      Record<YahooReturnPeriodKey, number | null>
    >
  > = [];
  for (let i = 0; i < strategies.length; i += concurrency) {
    const slice = strategies.slice(i, i + concurrency);
    const rows = await Promise.all(
      slice.map(async (s) => {
        const holdings = extractHoldings(s.holdings);
        const symbols = Array.from(new Set(holdings.map((h) => h.symbol)));
        const fetched = await computeYahooReturnsForUniverse(symbols, { concurrency });
        const bySym = new Map(fetched.map((r) => [r.symbol, r] as const));
        const base: {
          strategy_id: string;
          name: string;
          lastPrice: number | null;
          asOf: string | null;
        } & Partial<Record<YahooReturnPeriodKey, number | null>> = {
          strategy_id: s.id,
          name: s.name,
          lastPrice: null,
          asOf: null,
        };
        for (const period of YAHOO_RETURN_PERIODS) {
          let weightedSum = 0;
          let weightSum = 0;
          for (const h of holdings) {
            const r = bySym.get(h.symbol);
            const v = r?.[period];
            if (typeof v === "number" && Number.isFinite(v)) {
              weightedSum += v * h.weight;
              weightSum += h.weight;
            }
          }
          // Use the same outlier guard as the asset rows; clamping at
          // the strategy level catches cases where one constituent's
          // 5-digit outlier would otherwise dominate the basket.
          const value = weightSum > 0 ? weightedSum / weightSum : Number.NaN;
          base[period] =
            Number.isFinite(value) && Math.abs(value) <= OUTLIER_PCT_CAP ? Number(value.toFixed(2)) : null;
        }
        // "lastPrice" for a strategy is intentionally null — strategies
        // are baskets, not tickers, so we don't synthesise a value.
        return base;
      }),
    );
    out.push(...rows);
  }
  return out;
}
