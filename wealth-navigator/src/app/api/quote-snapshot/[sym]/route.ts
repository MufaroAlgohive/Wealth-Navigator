/**
 * GET /api/quote-snapshot/[sym]
 *
 * Latest IRESS L1 quote snapshot for a security — Previous Close, Open, Bid,
 * Ask, Day's Range (Low/High), Volume, Last (+ optional 52-week range / avg
 * volume). Backed by `quote_snapshot_c` (institutional), which the Railway
 * worker populates from `PricingQuoteGet` every cycle.
 *
 * Prices are stored in integer cents (same scale as securities_c.last_price);
 * this route divides by 100 to Rands so the Security page can render them
 * directly. This is the IRESS-sourced half of the Security page's data — the
 * analyst fundamentals (PE / EPS / dividends / earnings / target) are NOT on
 * the IRESS V4 surface and stay on the Yahoo-fed /api/equities grid.
 */
import { createServiceRoleClient, isSupabaseConfigured } from "@/lib/supabase/server";
import { isSupabaseSchemaMissing } from "@/lib/bff-reasons";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface SnapshotRow {
  security_code: string;
  exchange: string | null;
  last: number | string | null;
  open: number | string | null;
  high: number | string | null;
  low: number | string | null;
  bid: number | string | null;
  ask: number | string | null;
  prev_close: number | string | null;
  volume: number | string | null;
  vwap: number | string | null;
  week52_high: number | string | null;
  week52_low: number | string | null;
  avg_volume: number | string | null;
  currency: string | null;
  market_state: string | null;
  as_of: string | null;
  updated_at: string;
}

/** cents → Rands (null-safe). */
function rands(v: number | string | null | undefined): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n / 100 : null;
}
function num(v: number | string | null | undefined): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export async function GET(_req: Request, { params }: { params: Promise<{ sym: string }> }) {
  const { sym: rawSym } = await params;
  const sym = rawSym.replace(/\.(JO|JSE)$/i, "").toUpperCase();
  if (!sym) return Response.json({ error: "sym path param required" }, { status: 400 });

  if (!isSupabaseConfigured()) {
    return Response.json({ symbol: sym, snapshot: null, source: "unavailable", reason: "supabase_not_configured" }, { status: 503 });
  }

  const supabase = createServiceRoleClient();
  const { data, error } = await supabase
    .from("quote_snapshot_c")
    .select("*")
    .eq("security_code", sym)
    .order("updated_at", { ascending: false })
    .limit(1);

  if (error) {
    return Response.json(
      {
        symbol: sym,
        snapshot: null,
        source: "unavailable",
        error: error.message,
        migration: isSupabaseSchemaMissing(error) ? "supabase/migrations/20260616000001_quote_snapshot_c.sql" : undefined,
        message: isSupabaseSchemaMissing(error)
          ? "Apply the quote_snapshot_c migration; the worker then populates it from IRESS PricingQuoteGet each cycle."
          : undefined,
      },
      { status: 200 },
    );
  }

  const row = (data ?? [])[0] as SnapshotRow | undefined;
  if (!row) {
    return Response.json({
      symbol: sym,
      snapshot: null,
      source: "pending-first-write",
      message: `No IRESS L1 snapshot for ${sym} yet — the worker writes it once the symbol is in the quote watchlist and the table is migrated.`,
    });
  }

  return Response.json({
    symbol: sym,
    snapshot: {
      last: rands(row.last),
      open: rands(row.open),
      high: rands(row.high),
      low: rands(row.low),
      bid: rands(row.bid),
      ask: rands(row.ask),
      prevClose: rands(row.prev_close),
      volume: num(row.volume),
      vwap: rands(row.vwap),
      week52High: rands(row.week52_high),
      week52Low: rands(row.week52_low),
      avgVolume: num(row.avg_volume),
      currency: row.currency,
      marketState: row.market_state,
      asOf: row.as_of ?? row.updated_at,
      exchange: row.exchange,
    },
    source: "supabase",
  });
}
