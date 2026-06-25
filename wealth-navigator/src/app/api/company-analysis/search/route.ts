/**
 * GET /api/company-analysis/search?q=<query>
 *
 * Typeahead for the Analysis tab. Spans two universes and merges them:
 *   1) SA / JSE — our own securities_c (IRESS-overlaid prices, Yahoo names).
 *      This is the "anything IRESS can provide" tier, matched first.
 *   2) US / global — Yahoo Finance symbol search (the fallback tier), which
 *      also covers any global listing (incl. JSE .JO).
 *
 * Results are deduped by bare code (SA wins) and capped. Real symbols only;
 * never fabricated. Equities + ETFs.
 */

import { cached, TTL } from "@/lib/company-analysis/cache";
import { searchYahooSymbols, type SymbolHit } from "@/lib/company-analysis/yahoo";
import { createRetailServiceRoleClient, isRetailSupabaseConfigured } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bareCode = (sym: string) => sym.replace(/\.(JO|JSE)$/i, "").toUpperCase();

interface SearchResponse {
  ok: boolean;
  query: string;
  results: SymbolHit[];
  saCount: number;
  yahooCount: number;
  error?: string;
}

/** Search our JSE universe (securities_c) by symbol or name. Input is sanitised
 *  to a safe charset before it reaches the PostgREST `.or()` filter. */
async function searchSaUniverse(q: string): Promise<SymbolHit[]> {
  if (!isRetailSupabaseConfigured()) return [];
  // Strip anything that is not a letter, digit, space, dot or dash so the value
  // cannot inject extra PostgREST filter clauses.
  const safe = q.replace(/[^a-zA-Z0-9 .-]/g, "").trim().slice(0, 40);
  if (!safe) return [];
  try {
    const sb = createRetailServiceRoleClient();
    const { data, error } = await sb
      .from("securities_c")
      .select("symbol,name,sector")
      .or(`symbol.ilike.%${safe}%,name.ilike.%${safe}%`)
      .order("market_cap", { ascending: false, nullsFirst: false })
      .limit(8);
    if (error || !data) return [];
    return (data as Array<{ symbol: string; name: string | null }>).map((r) => ({
      symbol: r.symbol,
      display: bareCode(r.symbol),
      name: r.name ?? bareCode(r.symbol),
      exchange: "JSE",
      type: "EQUITY",
      source: "iress" as const,
    }));
  } catch {
    return [];
  }
}

/** Merge the SA (IRESS-backed) and Yahoo global universes, SA first, deduped. */
async function runSearch(q: string): Promise<SearchResponse> {
  const [sa, yahoo] = await Promise.all([searchSaUniverse(q), searchYahooSymbols(q)]);
  const seen = new Set(sa.map((s) => s.display.toUpperCase()));
  const merged: SymbolHit[] = [...sa];
  for (const y of yahoo) {
    const k = y.display.toUpperCase();
    if (seen.has(k)) continue;
    seen.add(k);
    merged.push(y);
  }
  return { ok: true, query: q, results: merged.slice(0, 12), saCount: sa.length, yahooCount: yahoo.length };
}

export async function GET(req: Request) {
  const q = (new URL(req.url).searchParams.get("q") ?? "").trim();
  if (q.length < 1) {
    return Response.json({ ok: true, query: q, results: [], saCount: 0, yahooCount: 0 } satisfies SearchResponse);
  }
  // Cache merged results per query (~24h) so repeated lookups never re-hit the
  // rate-limited Yahoo search; only cache when something matched.
  const r = await cached(`search:${q.toLowerCase()}`, TTL.search, () => runSearch(q), {
    isValid: (v) => v.ok && v.results.length > 0,
  });
  return Response.json(r.value, { headers: { "x-cache": r.hit ? `hit:${r.tier}` : "miss" } });
}
