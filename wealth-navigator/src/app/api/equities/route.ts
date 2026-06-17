/**
 * GET /api/equities
 *
 * Retail-backed JSE equities universe — the data that does NOT need IRESS or a
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

/**
 * IRESS-first overlay. Prefer the live IRESS `last` + change% (derived from
 * `prev_close`, scale-invariant) from the institutional `quote_snapshot_c`
 * over Yahoo's securities_c values, per symbol. Fundamentals / market cap /
 * sector stay Yahoo (IRESS has no source for them). Best-effort + read-only:
 * any failure leaves the Yahoo values untouched, so this can never break the
 * board. Mutates `rows` in place; returns the count of symbols overlaid.
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
      .select("security_code,exchange,last,prev_close");
    if (error || !data) {
      for (const r of rows) r.price_source = "yahoo";
      return 0;
    }
    const snap = new Map<string, { last: number | null; prev: number | null }>();
    for (const s of data as Array<{ security_code: string; last: number | null; prev_close: number | null }>) {
      snap.set(String(s.security_code).toUpperCase(), { last: s.last, prev: s.prev_close });
    }
    let n = 0;
    for (const r of rows) {
      const m = snap.get(bareCode(r.symbol));
      if (!m || m.last == null || !(m.last > 0)) {
        r.price_source = "yahoo";
        continue;
      }
      // quote_snapshot_c.last / prev_close are integer cents (same scale as
      // securities_c.last_price), so the overlay is drop-in and change% is
      // scale-invariant.
      r.last_price = Math.round(m.last);
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
        migration: isSupabaseSchemaMissing(error) ? "securities_c (retail) — table/columns missing" : undefined,
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
