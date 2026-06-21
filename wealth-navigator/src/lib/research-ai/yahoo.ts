/**
 * Free Yahoo Finance enrichment for AI equity research.
 *
 * The securities_c table only carries shallow fundamentals; for real research we
 * also pull, from Yahoo (the same free source the yahoo-fundamentals cron uses):
 *   • financial statements / ratios  (quoteSummary modules)
 *   • recent per-ticker company news  (the finance search endpoint)
 *
 * Both are best-effort and never throw: each returns a status + human detail for
 * the step-by-step trace, plus the data (or empty). No fabrication — if Yahoo
 * gives nothing, the step is "empty" and the model is told so.
 *
 * These run only on REGENERATION (a cache miss/refresh), never on a cache hit,
 * so a reused answer makes no Yahoo calls. Web freshness is bounded by the cache
 * TTL + the price/fundamentals materiality triggers, or a manual refresh.
 */

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";

type StepStatus = "ok" | "empty" | "error";

export interface YahooNewsItem {
  title: string;
  url: string;
  publisher: string | null;
  publishedAt: string | null;
}

interface YahooSession {
  cookie: string;
  crumb: string;
}

// Module-level session cache (crumb is stable for a while; avoid re-fetching it
// on every research call). new Date() is fine in route/runtime code.
let cachedSession: { session: YahooSession; expires: number } | null = null;

async function getSession(): Promise<YahooSession | null> {
  if (cachedSession && cachedSession.expires > Date.now()) return cachedSession.session;
  try {
    const c = await fetch("https://fc.yahoo.com/", { headers: { "User-Agent": UA } });
    const cookie = c.headers.get("set-cookie")?.split(";")[0] ?? "";
    const cr = await fetch("https://query1.finance.yahoo.com/v1/test/getcrumb", {
      headers: { "User-Agent": UA, cookie, Accept: "text/plain" },
    });
    const crumb = (await cr.text()).trim();
    if (!crumb || crumb.includes("<")) return null;
    const session = { cookie, crumb };
    cachedSession = { session, expires: Date.now() + 25 * 60_000 };
    return session;
  } catch {
    return null;
  }
}

interface RawModule {
  raw?: number;
}
const num = (m: unknown): number | null =>
  m && typeof m === "object" && typeof (m as RawModule).raw === "number" ? (m as RawModule).raw! : null;

/**
 * Yahoo computes JSE (.JO) price RATIOS off the cents-denominated price, so
 * forwardPE / priceToBook come back ~100x inflated (e.g. P/B 928 instead of
 * ~9.3, forward P/E 2,340 instead of ~23). When a ratio exceeds a plausible
 * ceiling, treat it as the cents artifact and divide by 100; otherwise leave it.
 * Per-share Rand metrics and absolute totals are unaffected.
 */
function deCents(v: number | null, plausibleMax: number): number | null {
  if (v == null) return null;
  return v > plausibleMax ? Math.round((v / 100) * 100) / 100 : v;
}

/** Strip null/undefined entries so the prompt only carries real figures. */
function compact(o: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) if (v !== null && v !== undefined) out[k] = v;
  return out;
}

export interface YahooFinancialsResult {
  status: StepStatus;
  detail: string;
  /** Compact dict of real financial figures, or null. */
  financials: Record<string, unknown> | null;
}

/**
 * Pull financial statements + key ratios from Yahoo quoteSummary. Symbol must be
 * the Yahoo ticker (JSE shares use the `.JO` suffix, e.g. "SOL.JO").
 */
export async function fetchYahooFinancials(yahooSymbol: string): Promise<YahooFinancialsResult> {
  const session = await getSession();
  if (!session) return { status: "error", detail: "Could not establish a Yahoo session", financials: null };
  try {
    const modules = "financialData,defaultKeyStatistics,incomeStatementHistory,balanceSheetHistory,cashflowStatementHistory,earnings";
    const url = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(yahooSymbol)}?modules=${modules}&crumb=${encodeURIComponent(session.crumb)}`;
    const r = await fetch(url, { headers: { "User-Agent": UA, cookie: session.cookie, Accept: "application/json" }, cache: "no-store" });
    if (!r.ok) return { status: "error", detail: `Yahoo financials ${r.status}`, financials: null };
    const j = (await r.json()) as { quoteSummary?: { result?: Array<Record<string, unknown>> } };
    const res = j?.quoteSummary?.result?.[0];
    if (!res) return { status: "empty", detail: "No Yahoo financials for this symbol", financials: null };

    const fd = (res.financialData ?? {}) as Record<string, unknown>;
    const ks = (res.defaultKeyStatistics ?? {}) as Record<string, unknown>;
    const inc = ((res.incomeStatementHistory as { incomeStatementHistory?: Array<Record<string, unknown>> })?.incomeStatementHistory?.[0] ?? {}) as Record<string, unknown>;
    const bs = ((res.balanceSheetHistory as { balanceSheetStatements?: Array<Record<string, unknown>> })?.balanceSheetStatements?.[0] ?? {}) as Record<string, unknown>;
    const cf = ((res.cashflowStatementHistory as { cashflowStatements?: Array<Record<string, unknown>> })?.cashflowStatements?.[0] ?? {}) as Record<string, unknown>;

    const financials = compact({
      totalRevenue: num(fd.totalRevenue),
      revenueGrowth: num(fd.revenueGrowth),
      grossMargins: num(fd.grossMargins),
      operatingMargins: num(fd.operatingMargins),
      profitMargins: num(fd.profitMargins),
      returnOnEquity: num(fd.returnOnEquity),
      returnOnAssets: num(fd.returnOnAssets),
      totalCash: num(fd.totalCash),
      totalDebt: num(fd.totalDebt),
      debtToEquity: num(fd.debtToEquity),
      currentRatio: num(fd.currentRatio),
      freeCashflow: num(fd.freeCashflow),
      ebitda: num(fd.ebitda),
      earningsGrowth: num(fd.earningsGrowth),
      recommendationKey: typeof fd.recommendationKey === "string" ? fd.recommendationKey : null,
      // Yahoo quotes JSE (.JO) per-share prices in cents (ZAc) → ÷100 to Rands,
      // matching the Rands `last` price elsewhere. (Totals/ratios below are not
      // per-share prices and are left as-is.)
      targetMeanPriceRands: ((v) => (v != null ? Math.round((v / 100) * 100) / 100 : null))(num(fd.targetMeanPrice)),
      numberOfAnalystOpinions: num(fd.numberOfAnalystOpinions),
      forwardPE: deCents(num(ks.forwardPE), 150),
      priceToBook: deCents(num(ks.priceToBook), 50),
      enterpriseValue: num(ks.enterpriseValue),
      netIncome: num(inc.netIncome),
      grossProfit: num(inc.grossProfit),
      totalAssets: num(bs.totalAssets),
      totalLiabilities: num(bs.totalLiab),
      totalStockholderEquity: num(bs.totalStockholderEquity),
      operatingCashflow: num(cf.totalCashFromOperatingActivities),
      capitalExpenditures: num(cf.capitalExpenditures),
    });

    if (Object.keys(financials).length === 0) {
      return { status: "empty", detail: "Yahoo returned no usable financial figures", financials: null };
    }
    return { status: "ok", detail: `${Object.keys(financials).length} financial field(s) from Yahoo`, financials };
  } catch (err) {
    return { status: "error", detail: err instanceof Error ? err.message : "Yahoo financials failed", financials: null };
  }
}

export interface YahooNewsResult {
  status: StepStatus;
  detail: string;
  items: YahooNewsItem[];
}

/**
 * Recent per-ticker company news via Yahoo's finance search endpoint. `query`
 * should be the company name or ticker. Best-effort; never throws.
 */
export async function fetchYahooNews(query: string): Promise<YahooNewsResult> {
  const session = await getSession();
  const headers: Record<string, string> = { "User-Agent": UA, Accept: "application/json" };
  if (session) headers.cookie = session.cookie;
  // Yahoo news search matches the core brand, not the full legal name — the long
  // form ("Capitec Bank Holdings Limited") returns nothing, "Capitec Bank" hits.
  const cleaned =
    query
      .replace(/\b(Limited|Ltd\.?|Holdings|Group|PLC|Inc\.?|Corporation|Corp\.?|Company|N\.?V\.?|SA)\b/gi, "")
      .replace(/[-–—]/g, " ")
      .replace(/\s+/g, " ")
      .trim() || query;
  try {
    const url = `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(cleaned)}&newsCount=10&quotesCount=0&enableFuzzyQuery=false`;
    const r = await fetch(url, { headers, cache: "no-store" });
    if (!r.ok) return { status: "error", detail: `Yahoo news ${r.status}`, items: [] };
    const j = (await r.json()) as {
      news?: Array<{ title?: string; link?: string; publisher?: string; providerPublishTime?: number }>;
    };
    const items: YahooNewsItem[] = (j.news ?? [])
      .filter((n): n is { title: string; link: string; publisher?: string; providerPublishTime?: number } => Boolean(n.title && n.link))
      .map((n) => ({
        title: n.title.trim(),
        url: n.link,
        publisher: n.publisher ?? null,
        publishedAt:
          typeof n.providerPublishTime === "number"
            ? new Date(n.providerPublishTime * 1000).toISOString()
            : null,
      }));
    if (!items.length) return { status: "empty", detail: "No recent Yahoo news for this security", items: [] };
    return { status: "ok", detail: `${items.length} recent article(s) from Yahoo`, items };
  } catch (err) {
    return { status: "error", detail: err instanceof Error ? err.message : "Yahoo news failed", items: [] };
  }
}
