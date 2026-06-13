/**
 * GET /api/money-market
 *
 * DB-first read of the eligible ZAR money-market universe
 * (`money_market_instrument_c`) and the latest JIBAR fixings
 * (`jibar_fixing_c`). The tables are empty in v1; the page renders an
 * empty state until a vendor or IRESS entitlement is wired in.
 */
import { createServiceRoleClient, isSupabaseConfigured } from "@/lib/supabase/server";
import { isUseSupabaseQuotesEnabled } from "@/lib/data-policy";
import { isSupabaseSchemaMissing, type BffUnavailableReason } from "@/lib/bff-reasons";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface InstrumentRow {
  ticker: string;
  name: string;
  instrument_type: string;
  issuer: string;
  tenor_label: string;
  yield_pct: number | string;
  duration_years: number | string;
  rating: string | null;
  notional_cents: number | string | null;
  maturity_date: string | null;
  updated_at: string;
}

interface JibarRow {
  tenor: string;
  rate_date: string;
  rate_pct: number | string;
  prev_rate_pct: number | string | null;
  change_bp: number | string | null;
}

function n(v: number | string | null | undefined): number {
  if (v == null) return 0;
  if (typeof v === "number") return v;
  const parsed = Number(v);
  return Number.isFinite(parsed) ? parsed : 0;
}

function mapInstrument(r: InstrumentRow) {
  return {
    ticker: r.ticker,
    name: r.name,
    type: r.instrument_type.toUpperCase(),
    issuer: r.issuer,
    tenor: r.tenor_label,
    rating: r.rating ?? "—",
    yield: n(r.yield_pct),
    duration: n(r.duration_years),
    notional: n(r.notional_cents) / 100,
    maturity: r.maturity_date ?? "—",
  };
}

function mapJibar(r: JibarRow) {
  return {
    tenor: r.tenor,
    rate: n(r.rate_pct),
    change: n(r.change_bp) / 100, // back to pct-point shape for the UI
    rateDate: r.rate_date,
  };
}

export async function GET() {
  if (!isUseSupabaseQuotesEnabled()) {
    return Response.json({
      instruments: [],
      jibar: [],
      source: "unavailable",
      reason: "supabase_quotes_disabled",
    });
  }
  if (!isSupabaseConfigured()) {
    return Response.json(
      { instruments: [], jibar: [], source: "unavailable", reason: "supabase_not_configured" },
      { status: 503 },
    );
  }
  const supabase = createServiceRoleClient();
  const [instRes, jibarRes] = await Promise.all([
    supabase
      .from("money_market_instrument_c")
      .select("*")
      .order("yield_pct", { ascending: false }),
    supabase
      .from("jibar_fixing_c")
      .select("*")
      .order("rate_date", { ascending: false })
      .limit(60),
  ]);
  if (instRes.error || jibarRes.error) {
    const firstErr = instRes.error ?? jibarRes.error;
    return Response.json(
      {
        instruments: [],
        jibar: [],
        source: "unavailable",
        reason: "supabase_query_failed" as BffUnavailableReason,
        error: firstErr?.message,
        migration: isSupabaseSchemaMissing(firstErr)
          ? "supabase/migrations/20260613000005_money_market_universe.sql"
          : undefined,
      },
      { status: 200 },
    );
  }
  const instruments = ((instRes.data ?? []) as InstrumentRow[]).map(mapInstrument);
  const jibar = ((jibarRes.data ?? []) as JibarRow[]).map(mapJibar);
  return Response.json({
    instruments,
    jibar,
    source: instruments.length > 0 || jibar.length > 0 ? "supabase" : "unavailable",
    reason: instruments.length === 0 && jibar.length === 0 ? "empty" : undefined,
    message:
      instruments.length === 0 && jibar.length === 0
        ? "MM instruments + JIBAR fixings require the IRESS rate entitlement or a vendor contract (e.g. SARB daily feed)."
        : undefined,
  });
}
