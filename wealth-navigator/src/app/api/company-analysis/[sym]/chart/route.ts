/**
 * GET /api/company-analysis/[sym]/chart?range=5Y
 *
 * Price history for the standalone Analysis tab chart — Yahoo chart endpoint,
 * works for any ticker (MSFT, AAPL, CPI.JO, …). Real closes or honest empty.
 * JSE cents are divided out upstream.
 */

import { fetchYahooChart } from "@/lib/company-analysis/yahoo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request, ctx: { params: Promise<{ sym: string }> }) {
  const { sym } = await ctx.params;
  const symbol = (sym ?? "").trim();
  const range = new URL(req.url).searchParams.get("range") ?? "5Y";
  if (!symbol) return Response.json({ ok: false, error: "Missing symbol" }, { status: 400 });
  try {
    return Response.json(await fetchYahooChart(symbol, range));
  } catch (err) {
    return Response.json(
      { ok: false, symbol, range, points: [], error: err instanceof Error ? err.message : "chart failed" },
      { status: 200 },
    );
  }
}
