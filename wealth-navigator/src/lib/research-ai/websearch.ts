/**
 * Web research step for AI equity research — the "research online" layer.
 *
 * Fetches recent web context (news, results, events, commentary) for a security
 * via a configurable search API so the model reasons over UP-TO-DATE online
 * information, not just static securities_c fundamentals. Provider is env-driven
 * (Tavily or Brave). When no key is set the step reports "deferred" and the
 * pipeline continues on fundamentals only — never fabricated.
 *
 * IMPORTANT: web results are GENERATION evidence only — they are deliberately
 * NOT part of the cache materiality signal (which would otherwise change on
 * every request and defeat caching). Web freshness is bounded by the cache TTL
 * + the price/news/fundamentals triggers, or a manual refresh.
 */

import type { WebResearchOutcome, WebResult } from "@/lib/research-ai/types";

type SearchProvider = "tavily" | "brave";

function resolveSearch(): { provider: SearchProvider; apiKey: string | null; max: number } {
  const sel = (process.env.RESEARCH_AI_SEARCH_PROVIDER ?? "tavily").trim().toLowerCase();
  const provider: SearchProvider = sel === "brave" ? "brave" : "tavily";
  const maxRaw = Number(process.env.RESEARCH_AI_SEARCH_MAX);
  const max = Number.isFinite(maxRaw) && maxRaw > 0 ? Math.min(Math.round(maxRaw), 10) : 6;
  const apiKey = (provider === "brave" ? process.env.BRAVE_API_KEY : process.env.TAVILY_API_KEY) ?? null;
  return { provider, apiKey, max };
}

/** True when the selected search provider has an API key in env. */
export function isWebSearchConfigured(): boolean {
  return Boolean(resolveSearch().apiKey);
}

function buildQuery(symbol: string, name: string | null): string {
  const code = symbol.replace(/\.(JO|JSE)$/i, "").toUpperCase();
  const subject = name ? `${name} (${code})` : code;
  return `${subject} JSE share — latest news, earnings/results and analyst outlook`;
}

async function tavily(apiKey: string, query: string, max: number): Promise<WebResult[]> {
  const res = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      api_key: apiKey,
      query,
      max_results: max,
      search_depth: "basic",
      include_answer: false,
    }),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`tavily ${res.status}`);
  const j = (await res.json()) as {
    results?: Array<{ title?: string; url?: string; content?: string }>;
  };
  return (j.results ?? [])
    .filter((r): r is { title?: string; url: string; content?: string } => Boolean(r.url))
    .map((r) => ({
      title: (r.title ?? r.url).trim(),
      url: r.url,
      snippet: (r.content ?? "").trim().slice(0, 500),
    }));
}

async function brave(apiKey: string, query: string, max: number): Promise<WebResult[]> {
  const u = new URL("https://api.search.brave.com/res/v1/web/search");
  u.searchParams.set("q", query);
  u.searchParams.set("count", String(max));
  const res = await fetch(u.toString(), {
    headers: { Accept: "application/json", "X-Subscription-Token": apiKey },
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`brave ${res.status}`);
  const j = (await res.json()) as {
    web?: { results?: Array<{ title?: string; url?: string; description?: string }> };
  };
  return (j.web?.results ?? [])
    .filter((r): r is { title?: string; url: string; description?: string } => Boolean(r.url))
    .map((r) => ({
      title: (r.title ?? r.url).trim(),
      url: r.url,
      snippet: (r.description ?? "").trim().slice(0, 500),
    }));
}

/**
 * Run a live web search for the security. Best-effort + never throws: no key →
 * "deferred"; provider error → "error"; no hits → "empty". The pipeline always
 * continues on whatever it returns.
 */
export async function runWebSearch(symbol: string, name: string | null): Promise<WebResearchOutcome> {
  const { provider, apiKey, max } = resolveSearch();
  const query = buildQuery(symbol, name);
  if (!apiKey) {
    const envVar = provider === "brave" ? "BRAVE_API_KEY" : "TAVILY_API_KEY";
    return {
      status: "deferred",
      provider: null,
      query: null,
      results: [],
      detail: `Not wired — set ${envVar} to enable live web research`,
    };
  }
  try {
    const results = provider === "brave" ? await brave(apiKey, query, max) : await tavily(apiKey, query, max);
    if (!results.length) {
      return { status: "empty", provider, query, results: [], detail: `No web results (${provider})` };
    }
    return { status: "ok", provider, query, results, detail: `${results.length} web result(s) via ${provider}` };
  } catch (err) {
    return {
      status: "error",
      provider,
      query,
      results: [],
      detail: err instanceof Error ? err.message : "web search failed",
    };
  }
}
