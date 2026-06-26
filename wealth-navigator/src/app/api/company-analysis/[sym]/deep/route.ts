/**
 * GET /api/company-analysis/[sym]/deep
 *
 * Deep company data for the Analysis sub-tabs: financial statements, analyst
 * estimates, sell-side research, ownership and dividends. Yahoo-sourced and
 * CACHED (shared, ~6h) so opening these tabs does not re-hit Yahoo each time.
 * Real values or honest null.
 */

import { cached, symKey, TTL } from "@/lib/company-analysis/cache";
import { fetchCompanyDeep } from "@/lib/company-analysis/yahoo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request, ctx: { params: Promise<{ sym: string }> }) {
  const { sym } = await ctx.params;
  const symbol = (sym ?? "").trim();
  if (!symbol) return Response.json({ ok: false, error: "Missing symbol" }, { status: 400 });
  const refresh = new URL(req.url).searchParams.get("refresh") === "1";
  try {
    const r = await cached(`deep:${symKey(symbol)}`, TTL.deep, () => fetchCompanyDeep(symbol), {
      isValid: (v) => v.ok,
      bypass: refresh,
    });
    return Response.json(r.value, { headers: { "x-cache": r.hit ? `hit:${r.tier}` : "miss" } });
  } catch (err) {
    return Response.json(
      { ok: false, symbol, error: err instanceof Error ? err.message : "deep fetch failed" },
      { status: 200 },
    );
  }
}
