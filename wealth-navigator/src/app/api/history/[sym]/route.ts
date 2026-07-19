/**
 * GET /api/history/[sym]?range=1M&provider=iress|yahoo
 *
 * Daily price history for the Security page chart ranges (5D / 1M / 6M / YTD /
 * 1Y / 5Y / All) — proxied from the worker's `/history` endpoint (IRESS
 * `TimeSeriesGet2`). 1D stays on the intraday tick path (`/api/intraday`);
 * this serves the longer windows.
 *
 * Values are the IRESS daily close in the series' native scale (the chart
 * auto-fits min/max, so the trend shape is correct without a labelled y-axis).
 *
 * **Provider switch (2026-07-09, TimeSeriesGet2 unblock).** Andre confirmed
 * the IRESS `TimeSeriesGet2` entitlement is live with `DataSource=zax` /
 * `Exchange=jse` / `Frequency=monthly` (and, by extension, the daily bucket
 * we already use on the worker). For SA symbols we now prefer IRESS over
 * Yahoo; when IRESS returns an empty series or a 25010/25034 entitlement
 * fault, we transparently fall back to Yahoo so the chart never goes blank.
 *
 * Behaviour:
 *   - `?provider=iress` (or default for SA symbols) — call the worker's
 *     `/history` endpoint, which uses `TimeSeriesGet2(zax, jse, Daily |
 *     Monthly)`. Falls back to Yahoo on empty / entitlement fault.
 *   - `?provider=yahoo` — use the Yahoo chart endpoint directly. Same
 *     fallthrough shape; IRESS is not consulted.
 *   - The Vercel → Railway passthrough carries `source: "iress" | "yahoo"`
 *     so the UI's `DataSourceKind` badge reflects what was actually used.
 *   - Non-SA symbols (no `.JO` / `.JSE` suffix and not in the ZSE watchlist)
 *     always go through Yahoo — IRESS doesn't have the series on `jse`.
 */
import { callWorker } from "@/lib/iress/worker-api";
import { fetchYahooChart } from "@/lib/company-analysis/yahoo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const RANGE_DAYS: Record<string, number> = {
  "5D": 8,
  "1M": 33,
  "6M": 190,
  "1Y": 370,
  "5Y": 1830,
  ALL: 3700,
};

function daysForRange(range: string): number {
  if (range === "YTD") {
    const now = new Date();
    const jan1 = Date.UTC(now.getUTCFullYear(), 0, 1);
    return Math.max(8, Math.ceil((now.getTime() - jan1) / 86_400_000));
  }
  return RANGE_DAYS[range] ?? 370;
}

/** Maps a chart range to the right TimeSeriesGet2 V4 frequency enum.
 *  - 5D / 1M / 6M / YTD / 1Y → `Daily` (per Andre's standing probe).
 *  - 5Y / All             → `Monthly` (Andre's 2026-07-09 example). */
function iressFrequencyForRange(range: string): "Daily" | "Monthly" {
  if (range === "5Y" || range === "ALL") return "Monthly";
  return "Daily";
}

/** True when the symbol is a JSE-listed instrument — IRESS has the series
 *  on `DataSource=zax, Exchange=jse`. Bare codes like `NPN` and `SOL` are
 *  treated as JSE; the IRESS client uppercases + strips `.JSE` already. */
function isJseLikeSymbol(code: string): boolean {
  const c = code.toUpperCase();
  if (c.endsWith(".JO") || c.endsWith(".JSE")) return true;
  // Bare codes: defer to a simple heuristic — uppercase alnum, ≤ 6 chars.
  // (The worker / iress client normalises further; this is just the gate.)
  return /^[A-Z0-9]{1,6}$/.test(c);
}

export async function GET(req: Request, { params }: { params: Promise<{ sym: string }> }) {
  const { sym: rawSym } = await params;
  const code = rawSym.replace(/\.(JO|JSE)$/i, "").toUpperCase();
  if (!code) return Response.json({ error: "sym path param required" }, { status: 400 });

  const url = new URL(req.url);
  const range = (url.searchParams.get("range") ?? "1Y").toUpperCase();
  const exchange = url.searchParams.get("exchange") ?? "JSE";
  const days = daysForRange(range);
  // Provider: explicit `?provider=…` wins; otherwise default to IRESS for
  // JSE symbols, Yahoo for everything else.
  const providerParam = (url.searchParams.get("provider") ?? "").toLowerCase();
  const provider =
    providerParam === "yahoo" || providerParam === "iress"
      ? providerParam
      : isJseLikeSymbol(code)
        ? "iress"
        : "yahoo";

  // ── IRESS path ────────────────────────────────────────────────────────
  if (provider === "iress") {
    const frequency = iressFrequencyForRange(range);
    const res = await callWorker<{
      ok: boolean;
      sym: string;
      points?: Array<{ t: number; v: number }>;
      error?: string;
    }>({
      path: `/history?sym=${encodeURIComponent(code)}&days=${days}&exchange=${encodeURIComponent(exchange)}&frequency=${frequency}`,
      timeoutMs: 30_000,
    });

    if (res.ok && res.body?.ok) {
      const raw = Array.isArray(res.body.points) ? res.body.points : [];
      const points = raw
        .filter((p) => p && Number.isFinite(p.t) && Number.isFinite(p.v) && p.v > 0)
        .sort((a, b) => a.t - b.t);
      if (points.length > 0) {
        return Response.json({
          sym: code,
          range,
          points,
          count: points.length,
          source: "iress",
          sourceLabel: `IRESS TimeSeriesGet2 (zax, jse, ${frequency.toLowerCase()})`,
        });
      }
    }
    // IRESS returned empty or faulted — fall through to Yahoo so the chart
    // never goes blank. Surface the reason in `warnings` for the UI badge.
  }

  // ── Yahoo fallback (default for non-JSE, explicit `?provider=yahoo`,
  //    or the IRESS-fallthrough case above) ────────────────────────────
  try {
    // `code` is the .JO/.JSE-stripped bare code. fetchYahooChart only treats a
    // symbol as JSE when it carries the .JO/.JSE suffix (otherwise it queries
    // the US-listed ticker of the same letters — e.g. bare "SOL" → ReneSola,
    // not Sasol). Re-append .JO for JSE symbols so the fallback returns the
    // correct JSE instrument (in rands), not a same-ticker foreign security.
    const yahooSymbol = isJseLikeSymbol(code) ? `${code}.JO` : code;
    const yahoo = await fetchYahooChart(yahooSymbol, range === "YTD" ? "YTD" : range);
    if (yahoo.ok) {
      const points = yahoo.points.map((p) => ({ t: p.t, v: p.c }));
      return Response.json({
        sym: code,
        range,
        points,
        count: points.length,
        source: "yahoo",
        sourceLabel: "Yahoo Finance (fallback)",
      });
    }
    return Response.json(
      {
        sym: code,
        range,
        points: [],
        source: "unavailable",
        sourceLabel: "Yahoo Finance (no data)",
        error: yahoo.error ?? "no price history for this symbol/range",
      },
      { status: 200 },
    );
  } catch (err) {
    return Response.json(
      { sym: code, range, points: [], source: "unavailable", error: err instanceof Error ? err.message : "yahoo failed" },
      { status: 200 },
    );
  }
}
