/**
 * GET /api/research-ai?symbol=<TICKER>[&refresh=1]
 *
 * AI equity-research BFF, GROUND-THEN-SYNTHESIZE + a research cache:
 *   1) GATHER real evidence — fundamentals + last price/change from the RETAIL
 *      `securities_c` table, and recent wire news that references the symbol.
 *      If the DB/keys are unavailable (preview), gather degrades to nulls/0 —
 *      never fabricated.
 *   2) If NOT configured → honest `configured:false` deferred (outlook null),
 *      gathered evidence still attached. cacheStatus "uncached".
 *   3) CACHE CHECK — compute a materiality signal from the fresh evidence and
 *      look up the stored answer. If a non-stale, materially-unchanged entry
 *      exists and there is no ?refresh=1, return it VERBATIM (cacheStatus "hit",
 *      NO model call, 0 tokens). Otherwise call the provider, parse, store, and
 *      return ("refreshed" if an entry existed, "miss" first time, "uncached"
 *      when the store is unavailable).
 *
 * Always returns 200 with a typed AiResearchResponse (never an unhandled 500).
 */

import {
  createRetailServiceRoleClient,
  isRetailSupabaseConfigured,
} from "@/lib/supabase/server";
import {
  RESEARCH_DISCLAIMER,
  getResearchAiProvider,
  isResearchAiConfigured,
  synthesizeOutlook,
  type AiResearchResponse,
  type CacheStatus,
  type GatheredEvidence,
  type ResearchSignal,
  type ResearchSource,
} from "@/lib/research-ai/provider";
import {
  assessMateriality,
  computeSignal,
  getCachedResearch,
  isResearchStoreConfigured,
  putCachedResearch,
} from "@/lib/research-ai/cache";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bareCode = (sym: string) => sym.replace(/\.(JO|JSE)$/i, "").toUpperCase();

const FUNDAMENTALS_SELECT =
  "symbol,name,sector,industry,last_price,change_price,change_percent,pe,eps,dividend_yield,beta,market_cap,isin,ytd_performance";

interface SecurityRow {
  symbol: string;
  name: string | null;
  sector: string | null;
  industry: string | null;
  last_price: number | null;
  change_price: number | null;
  change_percent: number | null;
  pe: number | null;
  eps: number | null;
  dividend_yield: number | null;
  beta: number | null;
  market_cap: number | null;
  isin: string | null;
  ytd_performance: number | null;
}

interface NewsRow {
  id: string;
  source: string | null;
  title: string;
  published_at: string;
  companies: string[] | null;
}

interface GatherResult {
  name: string | null;
  gathered: GatheredEvidence;
  sources: ResearchSource[];
  /** Publish timestamps of the news items used — drives the materiality signal. */
  newsTimestamps: Array<string | null>;
}

/**
 * Pull real fundamentals + price for the symbol and recent wire news that
 * references it. Best-effort: any failure degrades to nulls/0 (honest deferred),
 * never fabricated values.
 */
async function gather(symbol: string): Promise<GatherResult> {
  const empty: GatherResult = {
    name: null,
    gathered: { fundamentals: null, priceSummary: null, newsCount: 0 },
    sources: [],
    newsTimestamps: [],
  };

  if (!isRetailSupabaseConfigured()) return empty;

  const code = bareCode(symbol);

  try {
    const supabase = createRetailServiceRoleClient();

    // Exact symbol match. securities_c stores JSE tickers with the .JO suffix
    // (the equities universe strips it client-side), so bind on `${code}.JO`
    // rather than a prefix ilike — a prefix `${code}%` would also match
    // unrelated tickers (e.g. SOL → SOLBE1) and silently take the first row by
    // unspecified order. Case-insensitive equality keeps it robust to casing.
    const { data: secData } = await supabase
      .from("securities_c")
      .select(FUNDAMENTALS_SELECT)
      .ilike("symbol", `${code}.JO`)
      .limit(1);

    const row = ((secData ?? []) as SecurityRow[])[0] ?? null;

    let fundamentals: Record<string, unknown> | null = null;
    let priceSummary: GatheredEvidence["priceSummary"] = null;
    let name: string | null = null;

    if (row) {
      name = row.name;
      fundamentals = {
        sector: row.sector,
        industry: row.industry,
        pe: row.pe,
        eps: row.eps,
        dividendYield: row.dividend_yield,
        beta: row.beta,
        marketCap: row.market_cap,
        isin: row.isin,
        ytdPerformance: row.ytd_performance,
      };
      // last_price is integer cents (securities_c convention) → Rands.
      const last = typeof row.last_price === "number" ? row.last_price / 100 : null;
      priceSummary = { last, changePct: row.change_percent };
    }

    // Recent wire news that references the symbol (best-effort; table optional).
    let newsCount = 0;
    const sources: ResearchSource[] = [];
    const newsTimestamps: Array<string | null> = [];
    try {
      const { data: newsData } = await supabase
        .from("News_articles")
        .select("id, source, title, published_at, companies")
        .contains("companies", [code])
        .order("published_at", { ascending: false })
        .limit(10);
      const rows = (newsData ?? []) as NewsRow[];
      newsCount = rows.length;
      for (const n of rows) {
        if (n.title) sources.push({ title: n.title, url: null });
        newsTimestamps.push(n.published_at ?? null);
      }
    } catch {
      /* news optional — outlook can still synthesize over fundamentals */
    }

    return {
      name,
      gathered: { fundamentals, priceSummary, newsCount },
      sources,
      newsTimestamps,
    };
  } catch {
    return empty;
  }
}

/** Build the missing-symbol / error envelope with the cache fields set. */
function deferred(
  fields: Partial<AiResearchResponse> & {
    ok: boolean;
    symbol: string;
    gathered: GatheredEvidence;
    cacheStatus: CacheStatus;
  },
): AiResearchResponse {
  return {
    name: null,
    configured: isResearchAiConfigured(),
    provider: null,
    model: null,
    generatedAt: null,
    cached: false,
    cacheReason: null,
    outlook: null,
    sources: [],
    disclaimer: RESEARCH_DISCLAIMER,
    ...fields,
  };
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const symbolRaw = (url.searchParams.get("symbol") ?? "").trim();
  const forceRefresh = url.searchParams.get("refresh") === "1";

  if (!symbolRaw) {
    return Response.json(
      deferred({
        ok: false,
        symbol: "",
        gathered: { fundamentals: null, priceSummary: null, newsCount: 0 },
        cacheStatus: "uncached",
        error: "Missing required query parameter: symbol",
      }),
    );
  }

  const symbol = symbolRaw.toUpperCase();
  const { name, gathered, sources, newsTimestamps } = await gather(symbol);

  // 2) Not configured → honest deferred response (200) with gathered evidence.
  if (!isResearchAiConfigured()) {
    const { provider } = getResearchAiProvider();
    const envVar = provider === "claude" ? "ANTHROPIC_API_KEY" : "MINIMAX_API_KEY";
    return Response.json(
      deferred({
        ok: true,
        symbol,
        name,
        gathered,
        cacheStatus: "uncached",
        error: `AI research provider not configured — set ${envVar} (provider: ${provider}). Returning gathered evidence only.`,
      }),
    );
  }

  // 3) CACHE CHECK — compute fresh materiality signal, look up stored answer.
  const freshSignal: ResearchSignal = computeSignal(gathered, newsTimestamps);
  const storeConfigured = isResearchStoreConfigured();
  const cached = storeConfigured ? await getCachedResearch(symbol) : null;
  const decision = cached ? assessMateriality(freshSignal, cached, forceRefresh) : null;

  if (cached && decision?.reuse) {
    // HIT — reuse the stored outlook verbatim, NO model call, 0 tokens.
    // The materiality baseline stays FROZEN at the generation that produced this
    // answer (we do NOT re-anchor to the fresh signal): we regenerate once the
    // world has drifted materially from the point the answer was based on, which
    // also catches slow cumulative drift. The gathered chips below are live;
    // only the outlook + generatedAt are intentionally "as of" the cache.
    return Response.json({
      ok: true,
      symbol,
      name: cached.name ?? name,
      configured: true,
      provider: cached.provider,
      model: cached.model,
      generatedAt: cached.generatedAt,
      cacheStatus: "hit",
      cached: true,
      cacheReason: decision.reason,
      gathered,
      outlook: cached.outlook,
      sources: cached.sources.length ? cached.sources : sources,
      disclaimer: RESEARCH_DISCLAIMER,
    } satisfies AiResearchResponse);
  }

  // Regenerate via the model.
  try {
    const { outlook, provider, model } = await synthesizeOutlook(symbol, name, gathered);
    const generatedAt = new Date().toISOString();

    // Persist (best-effort). The write returns false when the store is
    // unavailable OR the ai_research_cache_c table is not provisioned yet — in
    // that case we report "uncached" honestly rather than implying the answer
    // was stored for reuse. Only a row that actually lands counts as "miss"
    // (first answer for this symbol) or "refreshed" (replaced a stale one).
    const persisted = storeConfigured
      ? await putCachedResearch(symbol, {
          name,
          provider,
          model,
          generatedAt,
          outlook,
          sources,
          gathered,
          signal: freshSignal,
        })
      : false;

    const cacheStatus: CacheStatus = persisted ? (cached ? "refreshed" : "miss") : "uncached";
    const cacheReason: string | null = persisted
      ? decision
        ? decision.reason
        : forceRefresh
          ? "Manual refresh"
          : null
      : null;

    return Response.json({
      ok: true,
      symbol,
      name,
      configured: true,
      provider,
      model,
      generatedAt,
      cacheStatus,
      cached: false,
      cacheReason,
      gathered,
      outlook,
      sources,
      disclaimer: RESEARCH_DISCLAIMER,
    } satisfies AiResearchResponse);
  } catch (err) {
    // Synthesis failed → nothing was stored. Report "uncached" (the UI also
    // suppresses the cache pill when there is no outlook).
    const { provider, model } = getResearchAiProvider();
    return Response.json({
      ok: false,
      symbol,
      name,
      configured: true,
      provider,
      model,
      generatedAt: null,
      cacheStatus: "uncached",
      cached: false,
      cacheReason: null,
      gathered,
      outlook: null,
      sources,
      disclaimer: RESEARCH_DISCLAIMER,
      error: err instanceof Error ? err.message : "AI research synthesis failed",
    } satisfies AiResearchResponse);
  }
}
