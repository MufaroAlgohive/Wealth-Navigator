import { isUseSupabaseQuotesEnabled } from "@/lib/data-policy";
import { callWorker } from "@/lib/iress/worker-api";
import { type SecurityPriceRow, resolveSecurityPrices } from "@/lib/market-prices/fallback";
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
  updated_at: string | null;
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
      lastFault?: {
        frequency: string;
        errorNumber: number | null;
        errorDescription: string | null;
        rawFault: string | null;
      };
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
    const reason =
      lastFault && (lastFault.errorNumber === 25010 || lastFault.errorNumber === 25034)
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
        message:
          body.error ??
          `IRESS returned no points for ${sym} (attempted ${(body.attemptedFrequencies ?? []).join(", ") || "no frequency"})`,
        attemptedFrequencies: body.attemptedFrequencies ?? null,
        lastFault,
      },
      { status: 200 },
    );
  }

  if (!isUseSupabaseQuotesEnabled()) {
    return Response.json(
      {
        symbol: sym,
        securityId: null,
        prevClose: null,
        points: [],
        asOf: null,
        source: "unavailable",
        reason: "supabase_quotes_disabled",
      },
      { status: 200 },
    );
  }
  if (!isRetailSupabaseConfigured()) {
    return Response.json(
      {
        symbol: sym,
        securityId: null,
        prevClose: null,
        points: [],
        asOf: null,
        source: "unavailable",
        reason: "supabase_not_configured",
      },
      { status: 503 },
    );
  }

  const supabase = createRetailServiceRoleClient();
  // Retail securities_c stores JSE tickers with a `.JO` suffix — match both forms.
  const { data: secRows, error: secErr } = await supabase
    .from("securities_c")
    .select("id, symbol, last_price, change_percent, updated_at")
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
  // Stale-or-missing seam: when securities_c is missing or stale past
  // IRESS_STALE_FALLBACK_HOURS, resolve via Yahoo live in-memory so the chart's
  // prevClose reference line still anchors to a real ZAc value. Reads only —
  // never writes back. IRESS-back-online re-sync is automatic: the moment
  // securities_c.updated_at lands inside the freshness window the gate flips
  // the row back to its DB value on the next call.
  const lastR = (Number(security.last_price) || 0) / 100;
  const pct = Number(security.change_percent) || 0;
  let prevCloseRands: number | null = lastR > 0 ? (pct !== 0 ? lastR / (1 + pct / 100) : lastR) : null;
  let priceSource: "supabase" | "yahoo" = "supabase";
  if (prevCloseRands == null || !Number.isFinite(prevCloseRands)) {
    try {
      const resolved = await resolveSecurityPrices({
        rows: [
          {
            id: security.id,
            symbol: security.symbol,
            name: null,
            logo_url: null,
            last_price: security.last_price,
            change_percent: security.change_percent,
            updated_at: security.updated_at ?? null,
          } satisfies SecurityPriceRow,
        ],
        intradayBySecurityId: new Map(),
        maxYahoo: 1,
        concurrency: 1,
      });
      const r = resolved[0];
      if (r && r.price_rands != null) {
        prevCloseRands = r.day_pct != null ? r.price_rands / (1 + r.day_pct / 100) : r.price_rands;
        priceSource = "yahoo";
      }
    } catch {
      /* keep DB-derived prevCloseRands */
    }
  }

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
    // "yahoo" when prevClose came from the live fallback; "supabase" when
    // DB-derived; "unavailable" only when both ticks and the fallback
    // came back empty (truly no data anywhere).
    source: priceSource === "yahoo" ? "yahoo" : points.length > 0 ? "supabase" : "unavailable",
    reason: points.length === 0 && priceSource !== "yahoo" ? "empty" : undefined,
    message:
      points.length === 0 && priceSource !== "yahoo"
        ? `No intraday ticks yet for ${sym} — worker has not polled this symbol, or the row was filtered (BHG hollow-row pattern).`
        : priceSource === "yahoo"
          ? `securities_c was stale or missing — served from Yahoo live fallback.`
          : undefined,
  });
}
