/**
 * GET /api/company-analysis/[sym]/chart?range=5Y
 *
 * Price history for the Analysis chart. Yahoo-sourced and CACHED per
 * (symbol, range) for ~6h (daily/weekly closes barely move intraday) so range
 * switches and revisits do not re-hit Yahoo. Real closes or honest empty.
 */

import { cached, symKey, TTL } from "@/lib/company-analysis/cache";
import { fetchYahooChart } from "@/lib/company-analysis/yahoo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request, ctx: { params: Promise<{ sym: string }> }) {
  const { sym } = await ctx.params;
  const symbol = (sym ?? "").trim();
  const range = (new URL(req.url).searchParams.get("range") ?? "5Y").toUpperCase();
  if (!symbol) return Response.json({ ok: false, error: "Missing symbol" }, { status: 400 });
  try {
    const r = await cached(`chart:${symKey(symbol)}:${range}`, TTL.chart, () => fetchYahooChart(symbol, range), {
      isValid: (v) => v.ok,
    });
    return Response.json(r.value, { headers: { "x-cache": r.hit ? `hit:${r.tier}` : "miss" } });
  } catch (err) {
    return Response.json(
      { ok: false, symbol, range, points: [], error: err instanceof Error ? err.message : "chart failed" },
      { status: 200 },
    );
  }
}
