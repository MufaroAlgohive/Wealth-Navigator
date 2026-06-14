/**
 * GET /api/intraday/[sym]
 *
 * Per-symbol intraday tick history for the security detail chart.
 * DB-first — reads `stock_intraday_c` (worker-upserted) and
 * `securities_c` (worker-instrument-sync'd) directly so the chart
 * populates even when the worker is rate-limiting PricingQuoteGet.
 *
 * Response shape:
 *   {
 *     symbol: string,
 *     securityId: string,
 *     prevClose: number | null,
 *     points: Array<{ t: number; v: number }>,   // ts ms, price in Rands
 *     asOf: string | null,
 *     source: "supabase" | "unavailable",
 *     reason?: "supabase_not_configured" | "supabase_query_failed" | "empty" | "no_security",
 *     message?: string
 *   }
 *
 * The UI's `changePct` is computed client-side from `points[last].v`
 * vs `prevClose`. Points are returned newest-first then re-sorted
 * oldest-first by the chart wrapper for the line series.
 */
import { createRetailServiceRoleClient, isRetailSupabaseConfigured } from "@/lib/supabase/server";
import { isUseSupabaseQuotesEnabled } from "@/lib/data-policy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEFAULT_LIMIT = 90;

interface IntradayRow {
  security_id: string;
  current_price: number;
  timestamp: string;
}

interface SecurityRow {
  id: string;
  symbol: string;
  // Retail securities_c has last_price + change_percent (Yahoo), not prev_close.
  last_price: number | null;
  change_percent: number | null;
}

export async function GET(req: Request, { params }: { params: Promise<{ sym: string }> }) {
  const { sym: rawSym } = await params;
  const sym = (rawSym ?? "").toUpperCase();
  if (!sym) {
    return Response.json({ error: "sym path param required" }, { status: 400 });
  }

  const url = new URL(req.url);
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? DEFAULT_LIMIT), 1), 500);

  if (!isUseSupabaseQuotesEnabled()) {
    return Response.json(
      { symbol: sym, securityId: null, prevClose: null, points: [], asOf: null, source: "unavailable", reason: "supabase_quotes_disabled" },
      { status: 200 },
    );
  }
  if (!isRetailSupabaseConfigured()) {
    return Response.json(
      { symbol: sym, securityId: null, prevClose: null, points: [], asOf: null, source: "unavailable", reason: "supabase_not_configured" },
      { status: 503 },
    );
  }

  const supabase = createRetailServiceRoleClient();
  // Retail securities_c stores JSE tickers with a `.JO` suffix — match both forms.
  const { data: secRows, error: secErr } = await supabase
    .from("securities_c")
    .select("id, symbol, last_price, change_percent")
    .in("symbol", [sym, `${sym}.JO`])
    .limit(1);
  if (secErr) {
    return Response.json(
      {
        symbol: sym,
        securityId: null,
        prevClose: null,
        points: [],
        asOf: null,
        source: "unavailable",
        reason: "supabase_query_failed",
        error: secErr.message,
      },
      { status: 500 },
    );
  }
  const security = (secRows ?? [])[0] as SecurityRow | undefined;
  if (!security) {
    return Response.json({
      symbol: sym,
      securityId: null,
      prevClose: null,
      points: [],
      asOf: null,
      source: "unavailable",
      reason: "no_security",
      message: `securities_c has no row for ${sym} — enable IRESS_WORKER_INSTRUMENT_SYNC=1 on Railway.`,
    });
  }

  // Retail has no prev_close column — derive the prior close from change_percent.
  const lastR = (Number(security.last_price) || 0) / 100;
  const pct = Number(security.change_percent) || 0;
  const prevCloseRands = lastR > 0 ? (pct !== 0 ? lastR / (1 + pct / 100) : lastR) : null;

  const { data: tickRows, error: tickErr } = await supabase
    .from("stock_intraday_c")
    .select("security_id, current_price, timestamp")
    .eq("security_id", security.id)
    .order("timestamp", { ascending: false })
    .limit(limit);
  if (tickErr) {
    return Response.json(
      {
        symbol: sym,
        securityId: security.id,
        prevClose: prevCloseRands,
        points: [],
        asOf: null,
        source: "unavailable",
        reason: "supabase_query_failed",
        error: tickErr.message,
      },
      { status: 500 },
    );
  }
  const rows = (tickRows ?? []) as IntradayRow[];
  // stock_intraday_c.current_price is cents; chart wants Rands.
  const points = rows
    .map((r) => ({ t: new Date(r.timestamp).getTime(), v: Number(r.current_price) / 100 }))
    .filter((p) => Number.isFinite(p.t) && Number.isFinite(p.v));
  // Re-sort oldest-first for the line chart's x-axis monotonicity.
  points.sort((a, b) => a.t - b.t);

  return Response.json({
    symbol: sym,
    securityId: security.id,
    prevClose: prevCloseRands,
    points,
    asOf: rows.length > 0 ? new Date(rows[0]!.timestamp).toISOString() : null,
    source: points.length > 0 ? "supabase" : "unavailable",
    reason: points.length === 0 ? "empty" : undefined,
    message:
      points.length === 0
        ? `No intraday ticks yet for ${sym} — worker has not polled this symbol, or the row was filtered (BHG hollow-row pattern).`
        : undefined,
  });
}
