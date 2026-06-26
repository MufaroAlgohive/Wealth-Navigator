/**
 * GET /api/company-analysis/[sym]/dividends
 *
 * Per-payment dividend history (Yahoo), cached ~6h. Real payments or honest empty.
 */

import { cached, symKey, TTL } from "@/lib/company-analysis/cache";
import { fetchYahooDividends } from "@/lib/company-analysis/yahoo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ sym: string }> }) {
  const { sym } = await ctx.params;
  const symbol = (sym ?? "").trim();
  if (!symbol) return Response.json({ ok: false, error: "Missing symbol" }, { status: 400 });
  try {
    const r = await cached(`divs:${symKey(symbol)}`, TTL.deep, () => fetchYahooDividends(symbol), {
      isValid: (v) => v.ok,
    });
    return Response.json(r.value, { headers: { "x-cache": r.hit ? `hit:${r.tier}` : "miss" } });
  } catch (err) {
    return Response.json(
      { ok: false, symbol, payments: [], error: err instanceof Error ? err.message : "dividends failed" },
      { status: 200 },
    );
  }
}
