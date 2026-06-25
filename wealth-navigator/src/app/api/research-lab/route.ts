import { listResearchStrategies, listResearchStrategiesForSymbol } from "@/lib/research-lab/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/research-lab
 *   - no params:    list every strategy in strategies_c (default — preserved).
 *   - ?sym=NPN:     list the strategies that hold NPN (Analysis Research tab).
 *                    Falls back to empty list with reason "no_match" when no
 *                    strategy references the symbol — the page shows the honest
 *                    empty state ("no published basket holds NPN").
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const sym = url.searchParams.get("sym")?.trim().toUpperCase();
  try {
    const result = sym ? await listResearchStrategiesForSymbol(sym) : await listResearchStrategies();
    return Response.json(result);
  } catch (e) {
    return Response.json(
      { strategies: [], source: "unavailable", error: e instanceof Error ? e.message : "unknown" },
      { status: 200 },
    );
  }
}
