/**
 * GET /api/company-analysis/[sym]/news?q=<name>
 *
 * Recent company news (Yahoo Finance), cached ~30m so the same symbol does not
 * re-hit the news endpoint on each view. The client passes the company name as
 * `q` for better matches; falls back to the symbol. Real items or honest empty.
 */

import { cached, symKey, TTL } from "@/lib/company-analysis/cache";
import { fetchYahooNews } from "@/lib/research-ai/yahoo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request, ctx: { params: Promise<{ sym: string }> }) {
  const { sym } = await ctx.params;
  const symbol = (sym ?? "").trim();
  if (!symbol) return Response.json({ ok: false, error: "Missing symbol" }, { status: 400 });
  const q = (new URL(req.url).searchParams.get("q") ?? "").trim() || symbol;
  try {
    const r = await cached(
      `news:${symKey(symbol)}`,
      TTL.news,
      async () => {
        const res = await fetchYahooNews(q);
        return { ok: true, symbol, items: res.items, status: res.status, detail: res.detail };
      },
      { isValid: (v) => v.ok && v.items.length > 0 },
    );
    return Response.json(r.value, { headers: { "x-cache": r.hit ? `hit:${r.tier}` : "miss" } });
  } catch (err) {
    return Response.json(
      { ok: false, symbol, items: [], error: err instanceof Error ? err.message : "news failed" },
      { status: 200 },
    );
  }
}
