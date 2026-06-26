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
  isRetailSupabaseConfigured,
  createServiceRoleClient,
  isSupabaseConfigured,
} from "@/lib/supabase/server";
import { isSupabaseSchemaMissing, type BffUnavailableReason } from "@/lib/bff-reasons";

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
  /** "iress" when last+change were overlaid from quote_snapshot_c, else "yahoo". */
  price_source?: "iress" | "yahoo";
}

const bareCode = (sym: string) => sym.replace(/\.(JO|JSE)$/i, "").toUpperCase();

/** IRESS snapshot is considered live only within this window (else stale). */
function iressMaxAgeMs(): number {
  const h = Number(process.env.IRESS_QUOTE_MAX_AGE_HOURS);
  return (Number.isFinite(h) && h > 0 ? h : 48) * 3_600_000;
}

/** A snapshot diverging more than this from the Yahoo reference is rejected. */
const IRESS_DIVERGENCE = 0.25;

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
  if (!isSupabaseConfigured()) {
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
    const maxAge = iressMaxAgeMs();
    let n = 0;
    for (const r of rows) {
      // Default to Yahoo; only flip to IRESS once a snapshot clears the guards.
      r.price_source = "yahoo";
      const m = snap.get(bareCode(r.symbol));
      if (!m || m.last == null || !(m.last > 0)) continue;

      // Freshness gate: a stale snapshot (e.g. a weekend-old CT row) must not
      // override the live board.
      const ts = m.ts ? Date.parse(m.ts) : NaN;
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
  source: "retail-supabase" | "unavailable";
  count: number;
  /** How many board rows had their price/change overlaid from live IRESS. */
  iressOverlay?: number;
  securities: SecurityRow[];
  sectors: SectorAgg[];
  reason?: BffUnavailableReason;
  migration?: string;
  error?: string;
}

const SELECT =
  "symbol,name,sector,industry,last_price,change_price,change_percent,pe,eps,dividend_yield,beta,market_cap,isin,ytd_performance,is_active";

/** Market-cap-weighted average day change per sector (falls back to simple mean). */
function buildSectorHeatmap(rows: SecurityRow[]): SectorAgg[] {
  const bySector = new Map<string, SecurityRow[]>();
  for (const r of rows) {
    const s = (r.sector ?? "").trim();
    if (!s) continue;
    (bySector.get(s) ?? bySector.set(s, []).get(s)!).push(r);
  }
  const out: SectorAgg[] = [];
  for (const [sector, list] of bySector) {
    const withChange = list.filter((r) => Number.isFinite(r.change_percent));
    const totalMarketCap = list.reduce((acc, r) => acc + (Number(r.market_cap) || 0), 0);
    const weightedDen = withChange.reduce((acc, r) => acc + (Number(r.market_cap) || 0), 0);
    let avgChangePct: number;
    if (weightedDen > 0) {
      avgChangePct =
        withChange.reduce((acc, r) => acc + (Number(r.change_percent) || 0) * (Number(r.market_cap) || 0), 0) /
        weightedDen;
    } else if (withChange.length > 0) {
      avgChangePct = withChange.reduce((acc, r) => acc + (Number(r.change_percent) || 0), 0) / withChange.length;
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
        migration: isSupabaseSchemaMissing(error) ? "securities_c (retail): table/columns missing" : undefined,
        error: error.message,
      } satisfies EquitiesResponse,
      { status: 200 },
    );
  }

  const securities = (data ?? []) as SecurityRow[];
  // IRESS-first: overlay live IRESS last + change% before computing the sector
  // heatmap, so movers / heatmaps / board all reflect IRESS where available.
  const iressOverlay = await overlayIressQuotes(securities);
  return Response.json({
    source: securities.length > 0 ? "retail-supabase" : "unavailable",
    count: securities.length,
    iressOverlay,
    securities,
    sectors: buildSectorHeatmap(securities),
    reason: securities.length === 0 ? "empty" : undefined,
  } satisfies EquitiesResponse);
}
