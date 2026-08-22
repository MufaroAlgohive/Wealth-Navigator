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
 * Rotating cache PERSISTED in `equities_period_returns_cache_c` (RETAIL DB) —
 * not in-process memory. An earlier version of this cache lived in a
 * module-scope Map + rotation cursor, but Vercel serverless functions don't
 * keep that memory across cold starts, and concurrent requests can land on
 * separate instances that never share it — in production the "rotation" kept
 * restarting at the same ~56 names instead of ever progressing. Ordering by
 * `computed_at` in the DB fixes that: it IS the rotation state, and it
 * survives cold starts/redeploys/concurrent instances by construction.
 *
 * On each request:
 *   1. Read the cache row for every candidate symbol. Anything younger than
 *      RETURNS_CACHE_TTL_MS is served straight from the cache row — zero
 *      Yahoo calls for it.
 *   2. Whatever's left (never cached, or stale) gets ordered oldest-first —
 *      rows with no cache entry sort first via `computed_at IS NULL` — and
 *      only a bounded slice (RETURNS_BATCH_SIZE) is fetched from Yahoo this
 *      request, then upserted back into the cache table.
 *   3. A transient Yahoo failure for a symbol falls back to its last good
 *      cached value (if any) rather than nulling out a previously-working
 *      row; a symbol that has never resolved renders an honest "—".
 * Across enough page loads this eventually covers the whole board instead
 * of permanently favouring the same top-N. Returns how many rows carry a
 * value + the freshest as-of, so the UI can label coverage truthfully.
 */
const RETURNS_BATCH_SIZE = Number.parseInt(process.env.EQUITIES_RETURNS_BATCH ?? "60", 10) || 60;
const RETURNS_CACHE_TTL_MS = 15 * 60 * 1000;
const EQUITIES_RETURNS_CONCURRENCY = 6;
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
  const { data: cacheRows } = await db
    .from(RETURNS_CACHE_TABLE)
    .select("symbol,return_1m,return_6m,bars_as_of,computed_at")
    .in("symbol", [...byKey.keys()]);

  const now = Date.now();
  let coverage = 0;
  let asOf: string | null = null;
  const cacheByKey = new Map((cacheRows ?? []).map((c) => [c.symbol as string, c as ReturnsCacheRow]));

  const stale: SecurityRow[] = [];
  for (const [key, r] of byKey) {
    const cached = cacheByKey.get(key);
    const cachedAgeMs = cached ? now - new Date(cached.computed_at).getTime() : Infinity;
    if (cached && cachedAgeMs < RETURNS_CACHE_TTL_MS) {
      r.return_1m = cached.return_1m;
      r.return_6m = cached.return_6m;
      coverage += 1;
      if (cached.bars_as_of) asOf = cached.bars_as_of;
    } else {
      stale.push(r);
    }
  }
  if (stale.length === 0) return { coverage, asOf };

  // Oldest cache entry first; never-cached (no row at all) sorts first of all.
  stale.sort((a, b) => {
    const ca = cacheByKey.get(bareCode(a.symbol))?.computed_at;
    const cb = cacheByKey.get(bareCode(b.symbol))?.computed_at;
    if (!ca && !cb) return 0;
    if (!ca) return -1;
    if (!cb) return 1;
    return new Date(ca).getTime() - new Date(cb).getTime();
  });
  const batch = stale.slice(0, RETURNS_BATCH_SIZE);

  const upserts: ReturnsCacheRow[] = [];
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
          const prev = cacheByKey.get(key);
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
        const barsAsOf = res.asOf ? new Date(res.asOf).toISOString() : null;
        upserts.push({ symbol: key, return_1m: v, return_6m: v6, bars_as_of: barsAsOf, computed_at: new Date(now).toISOString() });
        if (v != null || v6 != null) coverage += 1;
        if (barsAsOf) asOf = barsAsOf;
      }
    }
    if (upserts.length > 0) {
      await db.from(RETURNS_CACHE_TABLE).upsert(upserts, { onConflict: "symbol" });
    }
  } catch {
    // Board must never break because Yahoo (or the cache write) is slow/down
    // — rows keep whatever they already had (cache value or null).
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
  const { coverage: returnsCoverage, asOf: returnsAsOf } = await attachPeriodReturns(securities);
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
