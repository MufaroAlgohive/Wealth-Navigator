import { type BffUnavailableReason, isSupabaseSchemaMissing } from "@/lib/bff-reasons";
import { IRESS_DIVERGENCE, iressPriceOverlayEnabled, iressQuoteMaxAgeMs } from "@/lib/iress/overlay-policy";
import {
  type SecurityPriceRow,
  resolveSecurityPrices,
  summariseResolvedPrices,
} from "@/lib/market-prices/fallback";
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
  /** Worker / cron updated_at — feeds the Yahoo fallback freshness gate. */
  updated_at: string | null;
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
  /** How many board rows had their price/change served by the Yahoo live
   *  fallback (DB row was missing or stale past `IRESS_STALE_FALLBACK_HOURS`). */
  yahooFallback?: number;
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
  "symbol,name,sector,industry,last_price,change_price,change_percent,pe,eps,dividend_yield,beta,market_cap,isin,ytd_performance,is_active,updated_at";

/**
 * Trailing 1M / 6M returns for the board. `securities_c` carries no period
 * returns, so we derive them from a single daily Yahoo history fetch per
 * symbol (range=1y — ~250 bars, a fraction of the 10y payload the admin
 * dashboard fetches) and reuse the same outlier-clamped computation as
 * `lib/yahoo/returns.ts`.
 *
 * The interactive request is deliberately READ-ONLY against
 * `equities_period_returns_cache_c`. The after-market
 * `/api/cron/yahoo-period-returns` job owns Yahoo history calls and persists
 * successful values. This prevents a page load from competing with its own
 * 60-name live-price fallback for Yahoo's per-IP allowance.
 */
const RETURNS_CACHE_TABLE = "equities_period_returns_cache_c";

interface ReturnsCacheRow {
  symbol: string;
  return_1m: number | null;
  return_6m: number | null;
  bars_as_of: string | null;
  computed_at: string;
}

async function attachPeriodReturns(
  rows: SecurityRow[],
  db: ReturnType<typeof createRetailServiceRoleClient>,
): Promise<{
  coverage: number;
  asOf: string | null;
}> {
  // Ranked by market cap purely so a COLD cache (empty table) covers the
  // most-watched names first — NOT a filter. Some JSE-listed instruments
  // (e.g. the FNB international feeder ETFs) have no market cap at all
  // because Yahoo genuinely doesn't publish one for them (marketCap,
  // nonDilutedMarketCap, and totalAssets all come back empty — verified
  // live, not a symbol-resolution issue), but they still have valid daily
  // history and deserve 1M/6M. Excluding market_cap-less rows here would
  // permanently starve them. `Number(null) || 0` sorts them last.
  const ranked = rows
    .filter((r) => typeof r.symbol === "string" && r.symbol.trim().length > 0)
    .sort((a, b) => (Number(b.market_cap) || 0) - (Number(a.market_cap) || 0));
  if (ranked.length === 0) return { coverage: 0, asOf: null };

  const byKey = new Map(ranked.map((r) => [bareCode(r.symbol), r]));
  const { data: cacheRows, error: cacheError } = await db
    .from(RETURNS_CACHE_TABLE)
    .select("symbol,return_1m,return_6m,bars_as_of,computed_at")
    .in("symbol", [...byKey.keys()]);
  if (cacheError) {
    console.warn(`[api/equities] period-return cache unavailable: ${cacheError.message}`);
    return { coverage: 0, asOf: null };
  }

  let coverage = 0;
  let asOf: string | null = null;
  for (const cached of (cacheRows ?? []) as ReturnsCacheRow[]) {
    const row = byKey.get(bareCode(cached.symbol));
    if (!row) continue;
    row.return_1m = cached.return_1m;
    row.return_6m = cached.return_6m;
    if (cached.return_1m != null || cached.return_6m != null) coverage += 1;
    if (cached.bars_as_of && (!asOf || cached.bars_as_of > asOf)) asOf = cached.bars_as_of;
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
  // Yahoo live fallback: for any row the IRESS overlay didn't flip (still on
  // the retail securities_c value) and that is missing or stale past
  // IRESS_STALE_FALLBACK_HOURS, resolve a fresh price from Yahoo in-memory.
  // Reads only — never writes back. The IRESS-back-online seam is automatic:
  // once securities_c.updated_at lands inside the freshness window, the
  // freshness gate flips the row back to its DB value on the next call.
  const priceRows: SecurityPriceRow[] = securities.map((r) => ({
    id: r.symbol,
    symbol: r.symbol,
    name: r.name,
    logo_url: null,
    last_price: r.last_price,
    change_percent: r.change_percent,
    updated_at: r.updated_at ?? null,
  }));
  const resolved = await resolveSecurityPrices({
    rows: priceRows,
    intradayBySecurityId: new Map(),
    maxYahoo: 60,
    concurrency: 4,
  });
  const fallbackBySymbol = new Map(resolved.map((row) => [String(row.symbol).toUpperCase(), row] as const));
  let yahooFallback = 0;
  for (const row of securities) {
    const r = fallbackBySymbol.get(String(row.symbol).toUpperCase());
    if (!r || r.price_source !== "yahoo") continue;
    if (r.price_rands == null) continue;
    row.last_price = Math.round(r.price_rands * 100);
    row.change_percent = r.day_pct == null ? row.change_percent : r.day_pct;
    row.price_source = "yahoo";
    yahooFallback += 1;
  }
  const fallbackSummary = summariseResolvedPrices(resolved);
  // 1M / 6M trailing returns from Yahoo daily closes (bounded, best-effort).
  const { coverage: returnsCoverage, asOf: returnsAsOf } = await attachPeriodReturns(securities, supabase);
  const source: EquitiesResponse["source"] =
    securities.length === 0 ? "unavailable" : iressOverlay > 0 || yahooFallback > 0 ? "hybrid" : "yahoo";
  return Response.json({
    source,
    count: securities.length,
    iressOverlay,
    yahooFallback,
    returnsCoverage,
    returnsAsOf,
    securities,
    sectors: buildSectorHeatmap(securities),
    reason: securities.length === 0 ? "empty" : undefined,
  } satisfies EquitiesResponse);
}
