/**
 * GET /api/company-analysis/[sym]
 *
 * Deep company fundamentals for the Analysis tab Overview. Yahoo-sourced (free)
 * fundamentals are CACHED (shared, ~1h) so the same symbol does not re-hit Yahoo
 * on every view. For JSE symbols a fresh IRESS quote is overlaid on top of the
 * cached fundamentals on each request, so the price stays live (we pay for IRESS)
 * while statements/ratios are reused. Real values or honest null; never fabricated.
 */

import { cached, symKey, TTL } from "@/lib/company-analysis/cache";
import { overlayIressPrice } from "@/lib/company-analysis/iress";
import { fetchCompanyAnalysis } from "@/lib/company-analysis/yahoo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request, ctx: { params: Promise<{ sym: string }> }) {
  const { sym } = await ctx.params;
  const symbol = (sym ?? "").trim();
  if (!symbol) return Response.json({ ok: false, error: "Missing symbol" }, { status: 400 });
  const refresh = new URL(req.url).searchParams.get("refresh") === "1";
  try {
    const r = await cached(`analysis:${symKey(symbol)}`, TTL.analysis, () => fetchCompanyAnalysis(symbol), {
      isValid: (v) => v.ok,
      bypass: refresh,
    });
    // Live IRESS price overlay (JSE only) — runs outside the cache so the price
    // is current even when the fundamentals are reused.
    const analysis = await overlayIressPrice(r.value);
    return Response.json(analysis, { headers: { "x-cache": r.hit ? `hit:${r.tier}` : "miss" } });
  } catch (err) {
    return Response.json(
      { ok: false, symbol, error: err instanceof Error ? err.message : "analysis failed" },
      { status: 200 },
    );
  }
}
