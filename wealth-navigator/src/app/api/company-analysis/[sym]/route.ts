/**
 * GET /api/company-analysis/[sym]
 *
 * Deep company fundamentals for the Analysis tab Overview — Yahoo-sourced
 * (free), works for any ticker (MSFT, CPI.JO, …). Real data or honest null;
 * never fabricated. The AI narrative (bulls/bears, what's-happening) is a
 * separate call to /api/research-ai so this route stays fast + cacheable.
 */

import { fetchCompanyAnalysis } from "@/lib/company-analysis/yahoo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request, ctx: { params: Promise<{ sym: string }> }) {
  const { sym } = await ctx.params;
  const symbol = (sym ?? "").trim();
  if (!symbol) {
    return Response.json({ ok: false, error: "Missing symbol" }, { status: 400 });
  }
  try {
    const analysis = await fetchCompanyAnalysis(symbol);
    return Response.json(analysis);
  } catch (err) {
    return Response.json(
      { ok: false, symbol, error: err instanceof Error ? err.message : "analysis failed" },
      { status: 200 },
    );
  }
}
