/**
 * GET /api/intraday/[sym]
 *
 * Per-symbol intraday tick history for the security detail chart.
 * DB-first — reads `stock_intraday_c` (worker-upserted) and
 * `securities_c` (worker-instrument-sync'd) directly so the chart
 * populates even when the worker is rate-limiting PricingQuoteGet.
 *
 * **Provider switch (2026-07-09, TimeSeriesGet2 unblock).** When the
 * caller passes `?provider=iress`, this route calls the worker's
 * `/intraday` endpoint (IRESS `TimeSeriesGet2(zax, jse, IntraDay|1-Minute|Tick)`)
 * to fetch an authoritative time series straight from the IRESS feed.
 * Falls back to the Supabase `stock_intraday_c` source when IRESS is
 * unconfigured, returns 25010/25034 entitlement faults, or returns an
 * empty series for the symbol.
 *
 * Response shape:
 *   {
 *     symbol: string,
 *     securityId: string | null,
 *     prevClose: number | null,
 *     points: Array<{ t: number; v: number }>,   // ts ms, price in Rands
 *     asOf: string | null,
 *     source: "supabase" | "iress" | "unavailable",
 *     reason?: "supabase_not_configured" | "supabase_query_failed" | "empty" | "no_security" | "iress_unavailable" | "iress_no_data" | "iress_entitlement_blocked",
 *     message?: string,
 *     attemptedFrequencies?: string[],   // for ?provider=iress
 *     lastFault?: { frequency, errorNumber, errorDescription, rawFault },
 *   }
 *
 * The UI's `changePct` is computed client-side from `points[last].v`
 * vs `prevClose`. Points are returned newest-first then re-sorted
 * oldest-first by the chart wrapper for the line series.
 */
import { createRetailServiceRoleClient, isRetailSupabaseConfigured } from "@/lib/supabase/server";
import { callWorker } from "@/lib/iress/worker-api";
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
  const provider = (url.searchParams.get("provider") ?? "supabase").toLowerCase();

  // ── IRESS path (2026-07-09 unblock) ────────────────────────────────────
  // Caller asks for IRESS explicitly. Worker tries `IntraDay` → `1-Minute`
  // → `Tick`; we forward the worker response, surfacing entitlement faults
  // (25010/25034) as a typed `reason: "iress_entitlement_blocked"` so the
  // integration page can show the right next-step empty state.
  if (provider === "iress") {
    const days = Math.max(1, Math.ceil(limit / 80)); // ~80 ticks per trading day
    const res = await callWorker<{
      ok: boolean;
      sym: string;
      exchange: string;
      dataSource: string;
      frequency?: string;
      points?: Array<{ t: number; v: number }>;
      count?: number;
      attemptedFrequencies?: string[];
      lastFault?: { frequency: string; errorNumber: number | null; errorDescription: string | null; rawFault: string | null };
      error?: string;
    }>({
      path: `/intraday?sym=${encodeURIComponent(sym)}&days=${days}&limit=${limit}&exchange=JSE`,
      timeoutMs: 30_000,
    });
    if (!res.ok) {
      return Response.json(
        {
          symbol: sym,
          securityId: null,
          prevClose: null,
          points: [],
          asOf: null,
          source: "unavailable",
          reason: "iress_unavailable",
          error: res.error ?? "iress worker call failed",
        },
        { status: 200 },
      );
    }
    const body = res.body ?? {};
    const raw = Array.isArray(body.points) ? body.points : [];
    const points = raw
      .filter((p) => p && Number.isFinite(p.t) && Number.isFinite(p.v) && p.v > 0)
      .sort((a, b) => a.t - b.t);
    if (points.length > 0) {
      return Response.json({
        symbol: sym,
        securityId: null,
        prevClose: null,
        points,
        asOf: points.length > 0 ? new Date(points[points.length - 1]!.t).toISOString() : null,
        source: "iress",
        frequency: body.frequency ?? null,
        attemptedFrequencies: body.attemptedFrequencies ?? null,
      });
    }
    // IRESS returned empty — surface the reason so the UI can show it.
    const lastFault = body.lastFault ?? null;
    const reason = lastFault && (lastFault.errorNumber === 25010 || lastFault.errorNumber === 25034)
      ? "iress_entitlement_blocked"
      : "iress_no_data";
    return Response.json(
      {
        symbol: sym,
        securityId: null,
        prevClose: null,
        points: [],
        asOf: null,
        source: "unavailable",
        reason,
        message: body.error ?? `IRESS returned no points for ${sym} (attempted ${(body.attemptedFrequencies ?? []).join(", ") || "no frequency"})`,
        attemptedFrequencies: body.attemptedFrequencies ?? null,
        lastFault,
      },
      { status: 200 },
    );
  }

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
