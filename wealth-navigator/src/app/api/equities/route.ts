import { type BffUnavailableReason, isSupabaseSchemaMissing } from "@/lib/bff-reasons";
import { IRESS_DIVERGENCE, iressPriceOverlayEnabled, iressQuoteMaxAgeMs } from "@/lib/iress/overlay-policy";
/**
 * GET /api/equities
 *
 * Retail-backed JSE equities universe: the data that does NOT need IRESS or a
 * vendor. Reads the existing `securities_c` (Yahoo-fed today, IRESS once the
 * price cut-over lands) from the RETAIL prod DB and returns:
 *   - securities: the full board with fundamentals + day change
 *   - sectors:    a computed sector heatmap (market-cap-weighted avg change %)
 *
 * Powers the Equities table, Top Movers, Sector Heatmap, and the Security
 * fundamentals panel. Read-only; no IRESS dependency.
 *
 * NOTE: prices are integer cents (securities_c convention). The UI divides by
 * 100 for Rands. `source: "retail-supabase"` lets the UI badge it honestly.
 */
import {
  createRetailServiceRoleClient,
  createServiceRoleClient,
  isRetailSupabaseConfigured,
  isSupabaseConfigured,
} from "@/lib/supabase/server";
import { computePeriodReturns, fetchYahooHistory } from "@/lib/yahoo/returns";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface SecurityRow {
  symbol: string;
  name: string | null;
  sector: string | null;
  industry: string | null;
  last_price: number | null;
  change_price: number | null;
  change_percent: number | null;
  pe: number | null;
  eps: number | null;
  dividend_yield: number | null;
  beta: number | null;
  market_cap: number | null;
  isin: string | null;
  ytd_performance: number | null;
  is_active: boolean | null;
  /** Trailing 1M / 6M returns — Yahoo daily closes (see `attachPeriodReturns`). */
  return_1m?: number | null;
  return_6m?: number | null;
  /** "iress" when last+change were overlaid from quote_snapshot_c, else "yahoo". */
  price_source?: "iress" | "yahoo";
}

const bareCode = (sym: string) => sym.replace(/\.(JO|JSE)$/i, "").toUpperCase();

/**
 * IRESS-first overlay, GUARDED. Prefer the live IRESS `last` + change% (derived
 * from `prev_close`, scale-invariant) from the institutional `quote_snapshot_c`
 * over Yahoo's securities_c values, per symbol, BUT only when the snapshot is
 * fresh and agrees with the Yahoo reference. Fundamentals / market cap / sector
 * stay Yahoo (IRESS has no source for them).
 *
 * The guards matter: the IRESS worker can run against the CT (Customer Test)
 * sandbox, which returns simulated prices that do not match the real market. An
 * unguarded overlay would silently paint those test values onto the board and
 * the Top Movers. So we reject a snapshot when:
 *   - it is stale (no fresh as_of / updated_at within the max-age window), or
 *   - it diverges more than IRESS_DIVERGENCE from the Yahoo last (same cents
 *     scale), the signature of a test / wrong / stale value.
 * This mirrors the Analysis-tab overlay. Today (CT feed) almost everything is
 * rejected, so the board stays on accurate Yahoo; once production IRESS is
 * connected and prices agree with the market, the overlay takes over
 * automatically with no code change.
 *
 * Best-effort + read-only: any failure leaves the Yahoo values untouched, so
 * this can never break the board. Mutates `rows` in place; returns the count of
 * symbols actually overlaid (after the guards).
 */
async function overlayIressQuotes(rows: SecurityRow[]): Promise<number> {
  // IRESS_PRICE_OVERLAY=0 (UAT phase): ignore IRESS quotes, keep Yahoo prices.
  if (!isSupabaseConfigured() || !iressPriceOverlayEnabled()) {
    for (const r of rows) r.price_source = "yahoo";
    return 0;
  }
  try {
    const inst = createServiceRoleClient();
    const { data, error } = await inst
      .from("quote_snapshot_c")
      .select("security_code,exchange,last,prev_close,as_of,updated_at");
    if (error || !data) {
      for (const r of rows) r.price_source = "yahoo";
      return 0;
    }
    const snap = new Map<string, { last: number | null; prev: number | null; ts: string | null }>();
    for (const s of data as Array<{
      security_code: string;
      last: number | null;
      prev_close: number | null;
      as_of: string | null;
      updated_at: string | null;
    }>) {
      snap.set(String(s.security_code).toUpperCase(), {
        last: s.last,
        prev: s.prev_close,
        ts: s.as_of ?? s.updated_at,
      });
    }
    const now = Date.now();
    const maxAge = iressQuoteMaxAgeMs();
    let n = 0;
    for (const r of rows) {
      // Default to Yahoo; only flip to IRESS once a snapshot clears the guards.
      r.price_source = "yahoo";
      const m = snap.get(bareCode(r.symbol));
      if (!m || m.last == null || !(m.last > 0)) continue;

      // Freshness gate: a stale snapshot (e.g. a weekend-old CT row) must not
      // override the live board.
      const ts = m.ts ? Date.parse(m.ts) : Number.NaN;
      if (!Number.isFinite(ts) || now - ts > maxAge) continue;

      // Divergence guard: quote_snapshot_c.last and securities_c.last_price are
      // both integer cents, so they are directly comparable. A snapshot that is
      // wildly off the Yahoo reference is almost certainly CT/test/stale data.
      const yLast = r.last_price;
      const iLast = Math.round(m.last);
      if (yLast != null && yLast > 0 && Math.abs(iLast - yLast) / yLast > IRESS_DIVERGENCE) continue;

      // Accept IRESS. change% is scale-invariant (derived from prev_close).
      r.last_price = iLast;
      r.price_source = "iress";
      if (m.prev != null && m.prev > 0) {
        r.change_percent = Math.round(((m.last - m.prev) / m.prev) * 10000) / 100;
        r.change_price = Math.round(m.last - m.prev);
      }
      n += 1;
    }
    return n;
  } catch {
    for (const r of rows) r.price_source = "yahoo";
    return 0;
  }
}

interface SectorAgg {
  sector: string;
  count: number;
  avgChangePct: number;
  totalMarketCap: number;
}

interface EquitiesResponse {
  // Data-driven origin: the board is Yahoo (securities_c) with a per-row IRESS-PROD
  // overlay (quote_snapshot_c). "hybrid" when any row was overlaid, else "yahoo".
  source: "hybrid" | "yahoo" | "unavailable";
  count: number;
  /** How many board rows had their price/change overlaid from live IRESS. */
  iressOverlay?: number;
  /** How many board rows carry Yahoo-derived 1M/6M returns. */
  returnsCoverage?: number;
  /** Latest daily close used for the period returns. */
  returnsAsOf?: string | null;
  securities: SecurityRow[];
  sectors: SectorAgg[];
  reason?: BffUnavailableReason;
  migration?: string;
  error?: string;
}

const SELECT =
  "symbol,name,sector,industry,last_price,change_price,change_percent,pe,eps,dividend_yield,beta,market_cap,isin,ytd_performance,is_active";

/**
 * Trailing 1M / 6M returns for the board. `securities_c` carries no period
 * returns, so we derive them from a single daily Yahoo history fetch per
 * symbol (range=1y — ~250 bars, a fraction of the 10y payload the admin
 * dashboard fetches) and reuse the same outlier-clamped computation as
 * `lib/yahoo/returns.ts`.
 *
 * Rotating in-process cache, NOT a fixed top-N: a module-scope Map keyed by
 * bare symbol holds the last computed 1M/6M + timestamp for the lifetime of
 * the warm serverless instance. On each request:
 *   1. Every row with a cache entry younger than RETURNS_CACHE_TTL_MS is
 *      served straight from memory — zero Yahoo calls, zero DB calls.
 *   2. Whatever is left (never fetched, or stale) is the "stale queue". We
 *      only fetch a bounded slice of it (RETURNS_BATCH_SIZE) per request,
 *      picked via a rotating cursor so a *different* slice of the stale
 *      queue gets covered each time the page is hit — the queue only
 *      advances because someone is actually looking at /oems/equities.
 *   3. A transient Yahoo failure for a symbol falls back to its last good
 *      cached value (if any) rather than nulling out a previously-working
 *      row; a symbol that has never resolved renders an honest "—".
 * Across enough page loads this eventually covers the whole board instead
 * of permanently favouring the same top-N by market cap. Returns how many
 * rows carry a value + the freshest as-of, so the UI can label coverage
 * truthfully.
 */
const RETURNS_BATCH_SIZE = Number.parseInt(process.env.EQUITIES_RETURNS_BATCH ?? "60", 10) || 60;
const RETURNS_CACHE_TTL_MS = 15 * 60 * 1000;
const EQUITIES_RETURNS_CONCURRENCY = 6;

type ReturnsCacheEntry = { return_1m: number | null; return_6m: number | null; computedAt: number };
const returnsCache = new Map<string, ReturnsCacheEntry>();
let returnsRotationCursor = 0;

async function attachPeriodReturns(rows: SecurityRow[]): Promise<{
  coverage: number;
  asOf: string | null;
}> {
  // Ranked by market cap purely so the rotation covers the most-watched
  // names first on a cold cache; it no longer gates who's eligible.
  const ranked = rows
    .filter((r) => Number(r.market_cap) > 0)
    .sort((a, b) => (Number(b.market_cap) || 0) - (Number(a.market_cap) || 0));
  if (ranked.length === 0) return { coverage: 0, asOf: null };

  const now = Date.now();
  let coverage = 0;
  let asOf: string | null = null;

  const stale: SecurityRow[] = [];
  for (const r of ranked) {
    const cached = returnsCache.get(bareCode(r.symbol));
    if (cached && now - cached.computedAt < RETURNS_CACHE_TTL_MS) {
      r.return_1m = cached.return_1m;
      r.return_6m = cached.return_6m;
      coverage += 1;
    } else {
      stale.push(r);
    }
  }
  if (stale.length === 0) return { coverage, asOf };

  const start = returnsRotationCursor % stale.length;
  const batch =
    stale.length <= RETURNS_BATCH_SIZE
      ? stale
      : [...stale.slice(start), ...stale.slice(0, start)].slice(0, RETURNS_BATCH_SIZE);
  returnsRotationCursor = (start + batch.length) % stale.length;

  try {
    for (let i = 0; i < batch.length; i += EQUITIES_RETURNS_CONCURRENCY) {
      const slice = batch.slice(i, i + EQUITIES_RETURNS_CONCURRENCY);
      const results = await Promise.all(
        slice.map(async (r) => {
          const {
            bars,
            asOf: barAsOf,
            error,
          } = await fetchYahooHistory(bareCode(r.symbol), {
            range: "1y",
            interval: "1d",
          });
          if (error || bars.length < 2) return { row: r, value: null, asOf: null, ok: false };
          const { period } = computePeriodReturns(bars);
          return { row: r, value: period, asOf: barAsOf, ok: true };
        }),
      );
      for (const res of results) {
        const key = bareCode(res.row.symbol);
        if (!res.ok) {
          const prev = returnsCache.get(key);
          if (prev) {
            res.row.return_1m = prev.return_1m;
            res.row.return_6m = prev.return_6m;
            coverage += 1;
          }
          continue;
        }
        const v = res.value?.["1m_pct"] ?? null;
        const v6 = res.value?.["6m_pct"] ?? null;
        res.row.return_1m = v;
        res.row.return_6m = v6;
        returnsCache.set(key, { return_1m: v, return_6m: v6, computedAt: now });
        if (v != null || v6 != null) coverage += 1;
        if (res.asOf) asOf = new Date(res.asOf).toISOString();
      }
    }
  } catch {
    // Board must never break because Yahoo is slow/down — rows keep nulls.
  }
  return { coverage, asOf };
}

/** Market-cap-weighted average day change per sector (falls back to simple mean). */
function buildSectorHeatmap(rows: SecurityRow[]): SectorAgg[] {
  const bySector = new Map<string, SecurityRow[]>();
  for (const r of rows) {
    const s = (r.sector ?? "").trim();
    if (!s) continue;
    let list = bySector.get(s);
    if (!list) {
      list = [];
      bySector.set(s, list);
    }
    list.push(r);
  }
  const out: SectorAgg[] = [];
  for (const [sector, list] of bySector) {
    const withChange = list.filter((r) => Number.isFinite(r.change_percent));
    const totalMarketCap = list.reduce((acc, r) => acc + (Number(r.market_cap) || 0), 0);
    const weightedDen = withChange.reduce((acc, r) => acc + (Number(r.market_cap) || 0), 0);
    let avgChangePct: number;
    if (weightedDen > 0) {
      avgChangePct =
        withChange.reduce(
          (acc, r) => acc + (Number(r.change_percent) || 0) * (Number(r.market_cap) || 0),
          0,
        ) / weightedDen;
    } else if (withChange.length > 0) {
      avgChangePct =
        withChange.reduce((acc, r) => acc + (Number(r.change_percent) || 0), 0) / withChange.length;
    } else {
      avgChangePct = 0;
    }
    out.push({
      sector,
      count: list.length,
      avgChangePct: Math.round(avgChangePct * 100) / 100,
      totalMarketCap,
    });
  }
  return out.sort((a, b) => b.avgChangePct - a.avgChangePct);
}

export async function GET() {
  if (!isRetailSupabaseConfigured()) {
    return Response.json(
      {
        source: "unavailable",
        count: 0,
        securities: [],
        sectors: [],
        reason: "supabase_not_configured",
        error: "Retail Supabase not configured (RETAIL_SUPABASE_URL / RETAIL_SUPABASE_SERVICE_ROLE_KEY)",
      } satisfies EquitiesResponse,
      { status: 503 },
    );
  }

  const supabase = createRetailServiceRoleClient();
  const { data, error } = await supabase.from("securities_c").select(SELECT).order("symbol");

  if (error) {
    return Response.json(
      {
        source: "unavailable",
        count: 0,
        securities: [],
        sectors: [],
        reason: "supabase_query_failed",
        migration: isSupabaseSchemaMissing(error)
          ? "securities_c (retail): table/columns missing"
          : undefined,
        error: error.message,
      } satisfies EquitiesResponse,
      { status: 200 },
    );
  }

  const securities = (data ?? []) as SecurityRow[];
  // IRESS-first: overlay live IRESS last + change% before computing the sector
  // heatmap, so movers / heatmaps / board all reflect IRESS where available.
  const iressOverlay = await overlayIressQuotes(securities);
  // 1M / 6M trailing returns from Yahoo daily closes (bounded, best-effort).
  const { coverage: returnsCoverage, asOf: returnsAsOf } = await attachPeriodReturns(securities);
  return Response.json({
    source: securities.length === 0 ? "unavailable" : iressOverlay > 0 ? "hybrid" : "yahoo",
    count: securities.length,
    iressOverlay,
    returnsCoverage,
    returnsAsOf,
    securities,
    sectors: buildSectorHeatmap(securities),
    reason: securities.length === 0 ? "empty" : undefined,
  } satisfies EquitiesResponse);
}
