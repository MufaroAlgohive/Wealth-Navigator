/**
 * GET /api/company-analysis/[sym]/filings
 *
 * Recent SEC EDGAR filings for US tickers (free, real), cached ~6h. JSE issuers
 * return an honest empty (they file via JSE SENS, not the SEC).
 */

import { cached, symKey, TTL } from "@/lib/company-analysis/cache";
import { fetchSecFilings } from "@/lib/company-analysis/yahoo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ sym: string }> }) {
  const { sym } = await ctx.params;
  const symbol = (sym ?? "").trim();
  if (!symbol) return Response.json({ ok: false, error: "Missing symbol" }, { status: 400 });
  try {
    const r = await cached(`filings:${symKey(symbol)}`, TTL.deep, () => fetchSecFilings(symbol), {
      isValid: (v) => v.ok,
    });
    return Response.json(r.value, { headers: { "x-cache": r.hit ? `hit:${r.tier}` : "miss" } });
  } catch (err) {
    return Response.json(
      { ok: false, symbol, filings: [], error: err instanceof Error ? err.message : "filings failed" },
      { status: 200 },
    );
  }
}
