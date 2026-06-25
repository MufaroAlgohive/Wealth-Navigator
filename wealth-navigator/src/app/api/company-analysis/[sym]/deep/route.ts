/**
 * GET /api/company-analysis/[sym]/deep
 *
 * Deep company data for the Analysis sub-tabs: financial statements
 * (income/balance/cash flow, annual + quarterly), analyst estimates, sell-side
 * research (consensus + targets + up/downgrades), ownership (insiders +
 * institutions) and dividends. Yahoo-sourced, real values or honest null.
 * One call powers every sub-tab (the client shares it via one query key).
 */

import { fetchCompanyDeep } from "@/lib/company-analysis/yahoo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ sym: string }> }) {
  const { sym } = await ctx.params;
  const symbol = (sym ?? "").trim();
  if (!symbol) return Response.json({ ok: false, error: "Missing symbol" }, { status: 400 });
  try {
    return Response.json(await fetchCompanyDeep(symbol));
  } catch (err) {
    return Response.json(
      { ok: false, symbol, error: err instanceof Error ? err.message : "deep fetch failed" },
      { status: 200 },
    );
  }
}
