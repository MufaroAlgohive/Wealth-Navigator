/**
 * GET /api/company-analysis/[sym]/chart?range=5Y
 *
 * Price history for the Analysis chart. IRESS-PROD first for JSE daily/monthly
 * ranges (via the worker /history endpoint, TimeSeriesGet2), Yahoo for intraday
 * ranges, non-JSE symbols, and as the fallback. Cached per (symbol, range) for
 * ~6h (daily/weekly closes barely move intraday). Real closes or honest empty.
 *
 * SCALE (load-bearing — this chart LABELS absolute Rand prices): the IRESS feed
 * returns JSE prices in an ambiguous rands|cents scale, so its series is anchored
 * to securities_c.last_price (cents) via anchorHistoryToRands and returned in
 * RANDS. When there is no reference to anchor against, IRESS is skipped and Yahoo
 * (which already de-cents JSE to rands for .JO/.JSE symbols) serves instead — so
 * a client-facing price can never be rendered 100x off.
 */

import { cached, symKey, TTL } from "@/lib/company-analysis/cache";
import { type CompanyChart, fetchYahooChart } from "@/lib/company-analysis/yahoo";
import { anchorHistoryToRands } from "@/lib/iress/price-scale";
import { callWorker } from "@/lib/iress/worker-api";
import { createRetailServiceRoleClient, isRetailSupabaseConfigured } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// IRESS TimeSeriesGet2 serves Daily/Monthly only — intraday ranges stay Yahoo.
const IRESS_INTRADAY_RANGES = new Set(["1D", "1W"]);
const IRESS_RANGE_DAYS: Record<string, number> = {
  "1M": 33,
  "3M": 100,
  "6M": 190,
  "1Y": 370,
  "3Y": 1100,
  "5Y": 1830,
  MAX: 3700,
};

function iressDaysForRange(range: string): number {
  if (range === "YTD") {
    const jan1 = Date.UTC(new Date().getUTCFullYear(), 0, 1);
    return Math.max(8, Math.ceil((Date.now() - jan1) / 86_400_000));
  }
  return IRESS_RANGE_DAYS[range] ?? 370;
}

function iressFrequency(range: string): "Daily" | "Monthly" {
  return range === "5Y" || range === "MAX" ? "Monthly" : "Daily";
}

function isJseSymbol(s: string): boolean {
  const c = s.toUpperCase();
  return c.endsWith(".JO") || c.endsWith(".JSE");
}

/** securities_c.last_price (cents) — the anchor that resolves the IRESS series' rands/cents scale. */
async function referenceCents(bareCode: string): Promise<number> {
  if (!isRetailSupabaseConfigured()) return 0;
  try {
    const sb = createRetailServiceRoleClient();
    const { data } = await sb
      .from("securities_c")
      .select("last_price")
      .in("symbol", [bareCode, `${bareCode}.JO`])
      .not("last_price", "is", null)
      .limit(1);
    const lp = Number((data?.[0] as { last_price?: number | string } | undefined)?.last_price ?? 0);
    return Number.isFinite(lp) && lp > 0 ? lp : 0;
  } catch {
    return 0;
  }
}

/** IRESS-PROD daily/monthly history for a JSE symbol, anchored to RANDS. Returns
 *  null when there is no anchor or IRESS can't serve it, so the caller uses Yahoo. */
async function fetchIressChart(symbol: string, range: string): Promise<CompanyChart | null> {
  const bare = symbol.replace(/\.(JO|JSE)$/i, "").toUpperCase();
  const ref = await referenceCents(bare);
  if (ref <= 0) return null; // no anchor → don't trust the IRESS scale on a labelled chart
  const res = await callWorker<{ ok: boolean; points?: Array<{ t: number; v: number }>; error?: string }>({
    path: `/history?sym=${encodeURIComponent(bare)}&days=${iressDaysForRange(range)}&exchange=JSE&frequency=${iressFrequency(range)}`,
    timeoutMs: 30_000,
  });
  if (!res.ok || !res.body?.ok) return null;
  const raw = Array.isArray(res.body.points) ? res.body.points : [];
  const anchored = anchorHistoryToRands(raw, ref);
  if (!anchored.anchored || anchored.points.length < 2) return null;
  const pts = anchored.points;
  const firstClose = pts[0]!.c;
  const lastClose = pts[pts.length - 1]!.c;
  const changePct = firstClose > 0 ? ((lastClose - firstClose) / firstClose) * 100 : null;
  const years = (pts[pts.length - 1]!.t - pts[0]!.t) / (365 * 24 * 3600 * 1000);
  const cagrPct = years >= 1 && firstClose > 0 ? (Math.pow(lastClose / firstClose, 1 / years) - 1) * 100 : null;
  return {
    ok: true,
    symbol: symbol.toUpperCase(),
    currency: "ZAR",
    range,
    points: pts,
    firstClose,
    lastClose,
    changePct,
    cagrPct,
    source: "iress",
  };
}

export async function GET(req: Request, ctx: { params: Promise<{ sym: string }> }) {
  const { sym } = await ctx.params;
  const symbol = (sym ?? "").trim();
  const url = new URL(req.url);
  const range = (url.searchParams.get("range") ?? "5Y").toUpperCase();
  const refresh = url.searchParams.get("refresh") === "1";
  if (!symbol) return Response.json({ ok: false, error: "Missing symbol" }, { status: 400 });
  // Intraday ranges (1D/1W) need a short TTL so the latest price is current;
  // daily/weekly ranges change slowly, so reuse the longer chart TTL.
  const ttl = range === "1D" || range === "1W" ? 5 * 60_000 : TTL.chart;
  const iressEligible = isJseSymbol(symbol) && !IRESS_INTRADAY_RANGES.has(range);
  try {
    const r = await cached(
      `chart:${symKey(symbol)}:${range}`,
      ttl,
      async (): Promise<CompanyChart> => {
        if (iressEligible) {
          const iress = await fetchIressChart(symbol, range);
          if (iress) return iress;
        }
        // Yahoo fallback: `symbol` carries the .JO/.JSE suffix for JSE names, so
        // fetchYahooChart de-cents to rands + currency ZAR; non-JSE stay USD.
        return { ...(await fetchYahooChart(symbol, range)), source: "yahoo" as const };
      },
      { isValid: (v) => v.ok, bypass: refresh },
    );
    return Response.json(r.value, { headers: { "x-cache": r.hit ? `hit:${r.tier}` : "miss" } });
  } catch (err) {
    return Response.json(
      { ok: false, symbol, range, points: [], error: err instanceof Error ? err.message : "chart failed" },
      { status: 200 },
    );
  }
}
