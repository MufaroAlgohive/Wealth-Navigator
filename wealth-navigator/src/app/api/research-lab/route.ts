import { listResearchStrategies } from "@/lib/research-lab/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const result = await listResearchStrategies();
    return Response.json(result);
  } catch (e) {
    return Response.json(
      { strategies: [], source: "unavailable", error: e instanceof Error ? e.message : "unknown" },
      { status: 200 },
    );
  }
}
