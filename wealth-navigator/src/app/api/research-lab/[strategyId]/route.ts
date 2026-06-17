import { loadResearchLab } from "@/lib/research-lab/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  req: Request,
  ctx: { params: Promise<{ strategyId: string }> },
) {
  const { strategyId } = await ctx.params;
  const url = new URL(req.url);
  const extra = (url.searchParams.get("compare") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  try {
    const payload = await loadResearchLab(strategyId, extra);
    return Response.json(payload);
  } catch (e) {
    return Response.json(
      {
        source: "unavailable",
        error: e instanceof Error ? e.message : "unknown",
        strategy: { id: strategyId, name: "—" },
        current: { holdings: [], totals: { constituent: 0, cash: 0, cashPct: 0, basketMin: 0 }, sectors: [] },
        proposed: null,
        fundamentals: [],
        tickers: [],
        gaps: [],
      },
      { status: 200 },
    );
  }
}
