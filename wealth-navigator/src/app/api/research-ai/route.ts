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
  type ResearchStep,
  type WebResearchOutcome,
} from "@/lib/research-ai/provider";
import {
  assessMateriality,
  computeSignal,
  getCachedResearch,
  putCachedResearch,
} from "@/lib/research-ai/cache";
import { runWebSearch } from "@/lib/research-ai/websearch";
import {
  fetchYahooFinancials,
  fetchYahooNews,
  type YahooFinancialsResult,
  type YahooNewsResult,
} from "@/lib/research-ai/yahoo";

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
  /** Whether a securities_c row matched the ticker. */
  matched: boolean;
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
    matched: false,
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
      matched: Boolean(row),
      gathered: { fundamentals, priceSummary, newsCount },
      sources,
      newsTimestamps,
    };
  } catch {
    return empty;
  }
}

/**
 * Build the data-gathering portion of the step-by-step trace from the gather
 * result — what was found, what was empty, and what is deferred. Honest: it
 * shows the user exactly which sources ran and which are not wired yet.
 */
function dataSteps(matched: boolean, g: GatheredEvidence): ResearchStep[] {
  const fundCount = g.fundamentals
    ? Object.values(g.fundamentals).filter((v) => v !== null && v !== undefined).length
    : 0;
  const px = g.priceSummary;
  return [
    matched
      ? { label: "Resolve security", status: "ok", detail: "Matched a row in securities_c", source: "securities_c" }
      : { label: "Resolve security", status: "empty", detail: "No securities_c row matched this ticker", source: "securities_c" },
    g.fundamentals
      ? { label: "Fundamentals", status: "ok", detail: `${fundCount} field(s): sector, P/E, EPS, dividend yield, beta, market cap, YTD`, source: "securities_c (Yahoo-sourced)" }
      : { label: "Fundamentals", status: "empty", detail: "No fundamentals on file", source: "securities_c" },
    px && px.last !== null
      ? { label: "Price", status: "ok", detail: `Last ${px.last}${px.changePct != null ? ` (${px.changePct >= 0 ? "+" : ""}${px.changePct.toFixed(2)}%)` : ""}`, source: "securities_c" }
      : { label: "Price", status: "empty", detail: "No price on file", source: "securities_c" },
  ];
}

// The richer steps (company news, financial statements, web research) run only
// on regeneration — these helpers turn each live outcome into a trace step, and
// a "skipped" variant covers the cache-hit / not-configured paths.
function newsStep(r: YahooNewsResult): ResearchStep {
  return { label: "Company news", status: r.status, detail: r.detail, source: "Yahoo Finance" };
}
function financialsStep(r: YahooFinancialsResult): ResearchStep {
  return { label: "Financial statements", status: r.status, detail: r.detail, source: "Yahoo Finance" };
}
function webStepFrom(o: WebResearchOutcome): ResearchStep {
  return { label: "Online / web research", status: o.status, detail: o.detail, source: o.provider ?? undefined };
}
function stepSkipped(label: string, detail: string): ResearchStep {
  return { label, status: "skipped", detail };
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
    trace: [],
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
  const { name, matched, gathered, sources, newsTimestamps } = await gather(symbol);
  const steps = dataSteps(matched, gathered);

  // 2) Not configured → honest deferred response (200) with gathered evidence.
  if (!isResearchAiConfigured()) {
    const { provider, model } = getResearchAiProvider();
    const envVar = provider === "claude" ? "ANTHROPIC_API_KEY" : "MINIMAX_API_KEY";
    return Response.json(
      deferred({
        ok: true,
        symbol,
        name,
        gathered,
        cacheStatus: "uncached",
        trace: [
          ...steps,
          stepSkipped("Company news", "Skipped — AI provider not configured"),
          stepSkipped("Financial statements", "Skipped — AI provider not configured"),
          stepSkipped("Online / web research", "Skipped — AI provider not configured"),
          { label: "Synthesis", status: "skipped", detail: `Skipped — set ${envVar} to enable`, source: `${provider} · ${model}` },
        ],
        error: `AI research provider not configured — set ${envVar} (provider: ${provider}). Returning gathered evidence only.`,
      }),
    );
  }

  // 3) CACHE CHECK — compute fresh materiality signal, look up the stored answer
  // (durable institutional-DB tier first, hot in-process tier as the bridge).
  const freshSignal: ResearchSignal = computeSignal(gathered, newsTimestamps);
  const cached = await getCachedResearch(symbol);
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
      trace: [
        ...steps,
        stepSkipped("Company news", "Skipped — reused cached answer"),
        stepSkipped("Financial statements", "Skipped — reused cached answer"),
        stepSkipped("Online / web research", "Skipped — reused cached answer (0 tokens)"),
        { label: "Synthesis", status: "skipped", detail: "Skipped — reused the cached answer (0 tokens)", source: cached.model ?? undefined },
        { label: "Cache", status: "ok", detail: decision.reason, source: "research cache" },
      ],
      disclaimer: RESEARCH_DISCLAIMER,
    } satisfies AiResearchResponse);
  }

  // Regenerate via the model. Run the three live enrichment sources in PARALLEL
  // (all free): Tavily web research, Yahoo financial statements, Yahoo company
  // news. These run ONLY here (never on a cache hit), so a reused answer incurs
  // no external calls. Then synthesize over the enriched evidence.
  const yahooSymbol = `${bareCode(symbol)}.JO`;
  const [web, fin, ynews] = await Promise.all([
    runWebSearch(symbol, name),
    fetchYahooFinancials(yahooSymbol),
    fetchYahooNews(name ?? symbol),
  ]);
  const enrichedGathered: GatheredEvidence = { ...gathered, newsCount: ynews.items.length };
  const allSources: ResearchSource[] = [
    ...sources,
    ...ynews.items.map((n) => ({ title: n.title, url: n.url })),
    ...web.results.map((r) => ({ title: r.title, url: r.url })),
  ];

  try {
    const { outlook, provider, model } = await synthesizeOutlook(symbol, name, enrichedGathered, {
      webResults: web.results,
      financials: fin.financials,
      news: ynews.items.map((n) => ({ title: n.title, publishedAt: n.publishedAt })),
    });
    const generatedAt = new Date().toISOString();

    // Cache the fresh answer. It is ALWAYS kept in a hot in-process tier (so it
    // is immediately reusable on this instance); `durable` is true only when the
    // shared institutional-DB row also landed (ai_research_cache_c provisioned),
    // which is what makes reuse global across users/instances. Since the answer
    // is always cached at least in-process, this is "miss"/"refreshed".
    const durable = await putCachedResearch(symbol, {
      name,
      provider,
      model,
      generatedAt,
      outlook,
      sources: allSources,
      gathered: enrichedGathered,
      signal: freshSignal,
    });

    const cacheStatus: CacheStatus = cached ? "refreshed" : "miss";
    const baseReason = decision ? decision.reason : forceRefresh ? "Manual refresh" : null;
    const cacheReason: string | null = durable
      ? baseReason
      : baseReason
        ? `${baseReason} · cached in-memory on this instance (provision ai_research_cache_c for shared, persistent reuse)`
        : "Cached in-memory on this server instance — provision ai_research_cache_c for shared, persistent reuse";

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
      gathered: enrichedGathered,
      outlook,
      sources: allSources,
      trace: [
        ...steps,
        newsStep(ynews),
        financialsStep(fin),
        webStepFrom(web),
        { label: "Synthesis", status: "ok", detail: "Outlook generated from the gathered evidence", source: `${provider} · ${model}` },
        {
          label: "Cache",
          status: "ok",
          detail: durable ? "Stored in the shared research cache" : "Stored in-memory (this server instance)",
          source: durable ? "institutional DB" : "in-memory",
        },
      ],
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
      gathered: enrichedGathered,
      outlook: null,
      sources: allSources,
      trace: [
        ...steps,
        newsStep(ynews),
        financialsStep(fin),
        webStepFrom(web),
        {
          label: "Synthesis",
          status: "error",
          detail: err instanceof Error ? err.message : "synthesis failed",
          source: `${provider} · ${model}`,
        },
      ],
      disclaimer: RESEARCH_DISCLAIMER,
      error: err instanceof Error ? err.message : "AI research synthesis failed",
    } satisfies AiResearchResponse);
  }
}
