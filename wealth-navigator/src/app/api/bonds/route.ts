/**
 * GET /api/bonds
 *
 * DB-first read of the ZAR fixed-income universe from `bonds_c`.
 * Today the table is empty (no IRESS bond entitlement on production),
 * so the response is `{ bonds: [], source: "unavailable" }` and the
 * /oems/fixed-income page renders the "IRESS bond entitlement
 * required" empty state.
 */
import { createServiceRoleClient, isSupabaseConfigured } from "@/lib/supabase/server";
import { isUseSupabaseQuotesEnabled } from "@/lib/data-policy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface BondRow {
  isin: string;
  bond_code: string;
  name: string;
  issuer: string;
  coupon_pct: number | string;
  maturity_date: string | null;
  ytm_pct: number | string | null;
  clean_price: number | string | null;
  dirty_price: number | string | null;
  mod_duration: number | string | null;
  dv01_cents: number | string | null;
  convexity: number | string | null;
  spread_bp: number | string | null;
  rating: string | null;
  liquidity: string | null;
  updated_at: string;
}

function n(v: number | string | null | undefined): number {
  if (v == null) return 0;
  if (typeof v === "number") return v;
  const parsed = Number(v);
  return Number.isFinite(parsed) ? parsed : 0;
}

function centsToRands(v: number | string | null | undefined): number {
  return n(v) / 100;
}

function mapRow(r: BondRow) {
  return {
    isin: r.isin,
    code: r.bond_code,
    name: r.name,
    issuer: r.issuer,
    coupon: n(r.coupon_pct),
    maturity: r.maturity_date ?? "—",
    ytm: n(r.ytm_pct),
    clean: n(r.clean_price),
    dirty: n(r.dirty_price),
    modDur: n(r.mod_duration),
    dv01: centsToRands(r.dv01_cents),
    convexity: n(r.convexity),
    spread: n(r.spread_bp),
    rating: r.rating ?? "—",
    liquidity: r.liquidity ?? "—",
    asOf: r.updated_at,
  };
}

export async function GET() {
  if (!isUseSupabaseQuotesEnabled()) {
    return Response.json({ bonds: [], source: "unavailable", reason: "supabase_quotes_disabled" });
  }
  if (!isSupabaseConfigured()) {
    return Response.json(
      { bonds: [], source: "unavailable", reason: "supabase_not_configured" },
      { status: 503 },
    );
  }
  const supabase = createServiceRoleClient();
  const { data, error } = await supabase
    .from("bonds_c")
    .select("*")
    .order("ytm_pct", { ascending: false });
  if (error) {
    return Response.json(
      { bonds: [], source: "unavailable", error: error.message },
      { status: 500 },
    );
  }
  const rows = (data ?? []) as BondRow[];
  return Response.json({
    bonds: rows.map(mapRow),
    source: rows.length > 0 ? "supabase" : "unavailable",
    count: rows.length,
    reason: rows.length === 0 ? "no_bond_rows" : undefined,
    message:
      rows.length === 0
        ? "Bond universe requires the IRESS bond entitlement (or an upstream bond vendor). Paste supabase/migrations/20260613000004_oems_instrument_universe.sql and ask Charles to enable bond prices on the production profile."
        : undefined,
  });
}
