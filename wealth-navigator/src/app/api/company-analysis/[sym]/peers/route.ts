/**
 * GET /api/company-analysis/[sym]/peers
 *
 * Related/peer tickers (Yahoo), cached ~24h. Real symbols or honest empty.
 */

import { cached, symKey, TTL } from "@/lib/company-analysis/cache";
import { fetchYahooPeers } from "@/lib/company-analysis/yahoo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ sym: string }> }) {
  const { sym } = await ctx.params;
  const symbol = (sym ?? "").trim();
  if (!symbol) return Response.json({ ok: false, error: "Missing symbol" }, { status: 400 });
  try {
    const r = await cached(`peers:${symKey(symbol)}`, TTL.search, () => fetchYahooPeers(symbol), {
      isValid: (v) => v.ok,
    });
    return Response.json(r.value, { headers: { "x-cache": r.hit ? `hit:${r.tier}` : "miss" } });
  } catch (err) {
    return Response.json(
      { ok: false, symbol, peers: [], error: err instanceof Error ? err.message : "peers failed" },
      { status: 200 },
    );
  }
}
