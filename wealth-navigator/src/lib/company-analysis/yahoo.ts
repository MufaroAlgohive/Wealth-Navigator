/**
 * Company analysis — deep fundamentals from Yahoo Finance (free), mapped to the
 * fiscal.ai metric groups, for ANY ticker (US like MSFT, or JSE `.JO`).
 *
 * Powers the Analysis tab Overview. Everything is REAL Yahoo data or an honest
 * `null` (the UI renders "—"); `notes` records anything computed or unavailable.
 * No fabrication. Yahoo `quoteSummary` gives ~4 years of annual statements, so
 * 3-year CAGRs are exact, 5/10-year are marked unavailable (needs a paid vendor).
 *
 * JSE (.JO) prices come back in cents; per-share price fields (last, target) are
 * converted to major units. Ratios/margins are unitless and left as-is.
 */

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";

let cachedSession: { cookie: string; crumb: string; expires: number } | null = null;

async function getSession(): Promise<{ cookie: string; crumb: string } | null> {
  if (cachedSession && cachedSession.expires > Date.now()) return cachedSession;
  try {
    const c = await fetch("https://fc.yahoo.com/", { headers: { "User-Agent": UA } });
    const cookie = c.headers.get("set-cookie")?.split(";")[0] ?? "";
    const cr = await fetch("https://query1.finance.yahoo.com/v1/test/getcrumb", {
      headers: { "User-Agent": UA, cookie, Accept: "text/plain" },
    });
    const crumb = (await cr.text()).trim();
    if (!crumb || crumb.includes("<")) return null;
    cachedSession = { cookie, crumb, expires: Date.now() + 25 * 60_000 };
    return cachedSession;
  } catch {
    return null;
  }
}

interface Raw { raw?: number }
const num = (m: unknown): number | null =>
  typeof m === "number" && Number.isFinite(m)
    ? m
    : m && typeof m === "object" && typeof (m as Raw).raw === "number" && Number.isFinite((m as Raw).raw)
      ? (m as Raw).raw!
      : null;
const str = (m: unknown): string | null => (typeof m === "string" && m.trim() ? m.trim() : null);
/** CAGR from first→last over `years`; null if not computable. */
function cagr(latest: number | null, earliest: number | null, years: number): number | null {
  if (latest == null || earliest == null || earliest <= 0 || latest <= 0 || years <= 0) return null;
  return (Math.pow(latest / earliest, 1 / years) - 1) * 100;
}
function div(a: number | null, b: number | null): number | null {
  return a != null && b != null && b !== 0 ? a / b : null;
}

export interface AnalysisMetric {
  /** Raw value. For "pct" the value is a FRACTION (UI ×100); for "pct100" it's
   *  already a percent (display as-is). */
  value: number | null;
  /**
   * How the UI formats it:
   *  pct    — fraction → ×100 + "%"  (Yahoo margins/yield/growth)
   *  pct100 — already a percent → "%" (our computed CAGRs)
   *  x      — multiple, "21.0x"
   *  ratio  — plain ratio, "1.1"
   *  money  — abbreviated currency, "$2.62T"
   *  int    — abbreviated count, "228,000" / "7.4B"
   *  price  — per-share price in the security's currency
   */
  fmt: "pct" | "pct100" | "x" | "money" | "ratio" | "int" | "price";
}

export interface CompanyAnalysis {
  ok: boolean;
  symbol: string;
  yahooSymbol: string;
  currency: string;
  asOf: string;
  error?: string;
  price: {
    last: number | null;
    change: number | null;
    changePct: number | null;
    marketState: string | null;
    exchange: string | null;
  };
  overview: {
    name: string | null;
    description: string | null;
    ceo: string | null;
    website: string | null;
    sector: string | null;
    industry: string | null;
    country: string | null;
    employees: number | null;
  };
  /** Metric groups, keyed exactly like fiscal.ai. */
  groups: Record<string, Record<string, AnalysisMetric>>;
  earnings: {
    revenue: number | null;
    estimate: number | null;
    quarter: string | null;
    surprisePct: number | null;
    revBeatRate: { beats: number; total: number } | null;
    epsBeatRate: { beats: number; total: number } | null;
  };
  /** Annual series (most recent first) for charts + CAGRs. */
  series: {
    years: number[];
    revenue: (number | null)[];
    netIncome: (number | null)[];
    eps: (number | null)[];
    fcf: (number | null)[];
  };
  notes: string[];
}

const M = (value: number | null, fmt: AnalysisMetric["fmt"]): AnalysisMetric => ({ value, fmt });

/**
 * Fetch the full fiscal.ai-style analysis for a ticker. `symbol` may be a bare
 * US ticker (MSFT), a Yahoo symbol (CPI.JO), or a JSE code we suffix with .JO.
 */
export async function fetchCompanyAnalysis(symbol: string): Promise<CompanyAnalysis> {
  const clean = symbol.trim().toUpperCase();
  const isJse = clean.endsWith(".JO") || clean.endsWith(".JSE");
  const yahooSymbol = clean.replace(/\.JSE$/i, ".JO");
  const notes: string[] = [];
  const asOf = new Date().toISOString();

  const empty = (err: string): CompanyAnalysis => ({
    ok: false, symbol: clean, yahooSymbol, currency: "USD", asOf, error: err,
    price: { last: null, change: null, changePct: null, marketState: null, exchange: null },
    overview: { name: null, description: null, ceo: null, website: null, sector: null, industry: null, country: null, employees: null },
    groups: {}, earnings: { revenue: null, estimate: null, quarter: null, surprisePct: null, revBeatRate: null, epsBeatRate: null },
    series: { years: [], revenue: [], netIncome: [], eps: [], fcf: [] }, notes: [err],
  });

  const session = await getSession();
  if (!session) return empty("Could not establish a Yahoo session");

  const modules = [
    "assetProfile", "price", "summaryDetail", "defaultKeyStatistics", "financialData",
    "incomeStatementHistory", "balanceSheetHistory", "cashflowStatementHistory",
    "earnings", "earningsHistory", "earningsTrend", "calendarEvents",
  ].join(",");

  let res: Record<string, unknown>;
  try {
    const url = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(yahooSymbol)}?modules=${modules}&crumb=${encodeURIComponent(session.crumb)}`;
    const r = await fetch(url, { headers: { "User-Agent": UA, cookie: session.cookie, Accept: "application/json" }, cache: "no-store" });
    if (!r.ok) return empty(`Yahoo quoteSummary ${r.status}`);
    const j = (await r.json()) as { quoteSummary?: { result?: Array<Record<string, unknown>> } };
    const first = j?.quoteSummary?.result?.[0];
    if (!first) return empty("No Yahoo data for this symbol");
    res = first;
  } catch (e) {
    return empty(e instanceof Error ? e.message : "Yahoo fetch failed");
  }

  const profileM = (res.assetProfile ?? {}) as Record<string, unknown>;
  const priceM = (res.price ?? {}) as Record<string, unknown>;
  const detail = (res.summaryDetail ?? {}) as Record<string, unknown>;
  const ks = (res.defaultKeyStatistics ?? {}) as Record<string, unknown>;
  const fd = (res.financialData ?? {}) as Record<string, unknown>;
  const inc = ((res.incomeStatementHistory as { incomeStatementHistory?: Array<Record<string, unknown>> })?.incomeStatementHistory ?? []);
  const bs = ((res.balanceSheetHistory as { balanceSheetStatements?: Array<Record<string, unknown>> })?.balanceSheetStatements ?? []);
  const cf = ((res.cashflowStatementHistory as { cashflowStatements?: Array<Record<string, unknown>> })?.cashflowStatements ?? []);
  const earningsM = (res.earnings ?? {}) as Record<string, unknown>;
  const earnHist = ((res.earningsHistory as { history?: Array<Record<string, unknown>> })?.history ?? []);
  const earnTrend = ((res.earningsTrend as { trend?: Array<Record<string, unknown>> })?.trend ?? []);

  const currency = str(priceM.currency) ?? str(fd.financialCurrency) ?? (isJse ? "ZAR" : "USD");
  const centDiv = isJse ? 100 : 1; // JSE per-share prices come back in cents

  // ── price ──
  const last = num(priceM.regularMarketPrice);
  const price = {
    last: last != null ? last / centDiv : null,
    change: num(priceM.regularMarketChange) != null ? num(priceM.regularMarketChange)! / centDiv : null,
    changePct: num(priceM.regularMarketChangePercent) != null ? num(priceM.regularMarketChangePercent)! * 100 : null,
    marketState: str(priceM.marketState),
    exchange: str(priceM.exchangeName) ?? str(priceM.fullExchangeName),
  };

  // ── overview ──
  const officers = (profileM.companyOfficers as Array<Record<string, unknown>>) ?? [];
  const ceo = officers.find((o) => /chief executive|ceo/i.test(str(o.title) ?? ""))?.name as string | undefined;
  const overview = {
    name: str(priceM.longName) ?? str(priceM.shortName),
    description: str(profileM.longBusinessSummary),
    ceo: ceo ?? null,
    website: str(profileM.website),
    sector: str(profileM.sector),
    industry: str(profileM.industry),
    country: str(profileM.country),
    employees: num(profileM.fullTimeEmployees),
  };

  // ── core figures ──
  const revenue = num(fd.totalRevenue) ?? num((inc[0] ?? {}).totalRevenue);
  const ebitda = num(fd.ebitda);
  const grossMarginRaw = num(fd.grossMargins);
  const grossProfit = num((inc[0] ?? {}).grossProfit) ?? (revenue != null && grossMarginRaw != null ? revenue * grossMarginRaw : null);
  const marketCap = num(priceM.marketCap) ?? num(detail.marketCap);
  const ev = num(ks.enterpriseValue);
  const totalCash = num(fd.totalCash);
  const totalDebt = num(fd.totalDebt);
  const fcf = num(fd.freeCashflow);
  const opCash = num((cf[0] ?? {}).totalCashFromOperatingActivities);
  const capex = num((cf[0] ?? {}).capitalExpenditures);
  const fcfComputed = fcf ?? (opCash != null && capex != null ? opCash + capex : null);

  // ── margins (Yahoo fractions) ──
  const groups: Record<string, Record<string, AnalysisMetric>> = {};
  groups.Profile = {
    "Market Cap": M(marketCap, "money"),
    EV: M(ev, "money"),
    "Shares Out": M(num(ks.sharesOutstanding) ?? num(priceM.sharesOutstanding), "int"),
    Revenue: M(revenue, "money"),
    Employees: M(overview.employees, "int"),
  };
  groups.Margins = {
    Gross: M(num(fd.grossMargins) ?? div(grossProfit, revenue), "pct"),
    EBITDA: M(num(fd.ebitdaMargins) ?? div(ebitda, revenue), "pct"),
    Operating: M(num(fd.operatingMargins) ?? div(num((inc[0] ?? {}).operatingIncome), revenue), "pct"),
    "Pre-Tax": M(div(num((inc[0] ?? {}).incomeBeforeTax), revenue), "pct"),
    Net: M(num(fd.profitMargins) ?? num(ks.profitMargins) ?? div(num((inc[0] ?? {}).netIncome), revenue), "pct"),
    FCF: M(div(fcfComputed, revenue), "pct"),
  };
  groups.Returns = {
    ROA: M(num(fd.returnOnAssets), "pct"),
    ROE: M(num(fd.returnOnEquity), "pct"),
    ROIC: M(null, "pct"),
    ROCE: M(null, "pct"),
    ROTA: M(null, "pct"),
  };
  notes.push("ROIC/ROCE/ROTA need NOPAT + invested-capital from full statements — not derivable from Yahoo free; shown as —.");

  const trailingPE = num(detail.trailingPE) ?? num(ks.trailingPE);
  const pb = num(ks.priceToBook);
  groups["Valuation (TTM)"] = {
    "P/E": M(trailingPE, "x"),
    "P/B": M(pb, "x"),
    "EV/Sales": M(num(ks.enterpriseToRevenue) ?? div(ev, revenue), "x"),
    "EV/EBITDA": M(num(ks.enterpriseToEbitda) ?? div(ev, ebitda), "x"),
    "P/FCF": M(div(marketCap, fcfComputed), "x"),
    "EV/Gross Profit": M(div(ev, grossProfit), "x"),
  };
  const targetRaw = num(fd.targetMeanPrice);
  const target = targetRaw != null ? targetRaw / centDiv : null;
  const fwdEps = num(ks.forwardEps);
  groups["Valuation (NTM)"] = {
    "Price Target": M(target, "price"),
    "P/E": M(num(ks.forwardPE) ?? num(detail.forwardPE) ?? div(price.last, fwdEps), "x"),
    PEG: M(num(ks.pegRatio), "ratio"),
    "EV/Sales": M(null, "x"),
    "EV/EBITDA": M(null, "x"),
    "P/FCF": M(null, "x"),
  };

  const ebit = num((inc[0] ?? {}).ebit) ?? num((inc[0] ?? {}).operatingIncome);
  const interest = num((inc[0] ?? {}).interestExpense);
  groups["Financial Health"] = {
    Cash: M(totalCash, "money"),
    "Net Debt": M(totalDebt != null && totalCash != null ? totalDebt - totalCash : null, "money"),
    "Debt/Equity": M(num(fd.debtToEquity) != null ? num(fd.debtToEquity)! / 100 : null, "ratio"),
    "EBIT/Interest": M(interest != null && interest !== 0 && ebit != null ? Math.abs(ebit / interest) : null, "x"),
  };

  // ── annual series (most-recent-first) for CAGRs + charts ──
  const years = inc.map((r) => new Date(num((r as Record<string, unknown>).endDate)! * 1000).getFullYear()).filter((y) => Number.isFinite(y));
  const revSeries = inc.map((r) => num((r as Record<string, unknown>).totalRevenue));
  const niSeries = inc.map((r) => num((r as Record<string, unknown>).netIncome));
  const epsSeries = earnHist.length ? earnHist.map((r) => num((r as Record<string, unknown>).epsActual)) : [];
  const n = inc.length;
  // Yahoo gives ~4 annual statements → 3yr CAGR exact; 5/10yr unavailable.
  const rev3 = n >= 4 ? cagr(revSeries[0] ?? null, revSeries[3] ?? null, 3) : null;
  const epsLatest = num(ks.trailingEps);
  const eps3 = n >= 4 ? cagr(niSeries[0] ?? null, niSeries[3] ?? null, 3) : null;
  const trend1y = earnTrend.find((t) => str((t as Record<string, unknown>).period) === "+1y") as Record<string, unknown> | undefined;
  const trend5y = earnTrend.find((t) => str((t as Record<string, unknown>).period) === "+5y") as Record<string, unknown> | undefined;
  groups["Growth (CAGR)"] = {
    "Rev 3Yr": M(rev3, "pct100"),
    "Rev 5Yr": M(null, "pct100"),
    "Rev 10Yr": M(null, "pct100"),
    "EPS 3Yr": M(eps3, "pct100"),
    "Rev Fwd": M(num(fd.revenueGrowth), "pct"),
    "EPS Fwd": M(num((trend1y?.growth)) , "pct"),
    "EPS LT Est": M(num(trend5y?.growth), "pct"),
  } as Record<string, AnalysisMetric>;
  if (n < 4) notes.push("Yahoo returned <4 annual statements — multi-year CAGRs limited.");
  notes.push("5Yr/10Yr CAGRs require >4yr history (paid vendor) — shown as —.");

  const divYield = num(detail.dividendYield) ?? num(detail.trailingAnnualDividendYield);
  const dpsRate = num(detail.dividendRate);
  groups.Dividends = {
    Yield: M(divYield, "pct"),
    Payout: M(num(detail.payoutRatio), "pct"),
    DPS: M(dpsRate != null ? dpsRate / centDiv : num(detail.trailingAnnualDividendRate), "price"),
  };
  if (divYield == null) notes.push("No dividend (or yield not reported) for this security.");

  // ── earnings beat track record ──
  const eChart = (earningsM.earningsChart as Record<string, unknown>) ?? {};
  const curQ = (eChart.currentQuarterEstimate != null)
    ? { est: num(eChart.currentQuarterEstimate), q: `${str(eChart.currentQuarterEstimateDate) ?? ""} ${num(eChart.currentQuarterEstimateYear) ?? ""}`.trim() }
    : null;
  const finChart = ((earningsM.financialsChart as { quarterly?: Array<Record<string, unknown>> })?.quarterly ?? []);
  const lastQ = finChart[finChart.length - 1];
  const lastQRev = lastQ ? num(lastQ.revenue) : null;
  const epsBeats = earnHist.filter((h) => { const a = num(h.epsActual), e = num(h.epsEstimate); return a != null && e != null && a >= e; }).length;
  const earnings = {
    revenue: lastQRev,
    estimate: null as number | null,
    quarter: lastQ ? str(lastQ.date) : (curQ?.q ?? null),
    surprisePct: null as number | null,
    revBeatRate: null,
    epsBeatRate: earnHist.length ? { beats: epsBeats, total: earnHist.length } : null,
  };

  return {
    ok: true, symbol: clean, yahooSymbol, currency, asOf, price, overview, groups, earnings,
    series: {
      years,
      revenue: revSeries,
      netIncome: niSeries,
      eps: epsSeries.length ? epsSeries : [epsLatest],
      fcf: cf.map((r) => { const o = num((r as Record<string, unknown>).totalCashFromOperatingActivities), c = num((r as Record<string, unknown>).capitalExpenditures); return o != null && c != null ? o + c : null; }),
    },
    notes,
  };
}

// ── price history (for the standalone Analysis chart) ───────────────────

export interface ChartPoint {
  t: number; // epoch ms
  c: number; // close (major units; JSE cents divided out)
}
export interface CompanyChart {
  ok: boolean;
  symbol: string;
  currency: string;
  range: string;
  points: ChartPoint[];
  firstClose: number | null;
  lastClose: number | null;
  /** Simple total return over the window, %. */
  changePct: number | null;
  /** Annualised CAGR over the window, % (null for <1y windows). */
  cagrPct: number | null;
  error?: string;
}

const RANGE_INTERVAL: Record<string, string> = {
  "1M": "1d", "6M": "1d", YTD: "1d", "1Y": "1d", "3Y": "1wk", "5Y": "1wk", MAX: "1mo",
};
const RANGE_YEARS: Record<string, number> = {
  "1M": 1 / 12, "6M": 0.5, YTD: 0.5, "1Y": 1, "3Y": 3, "5Y": 5, MAX: 10,
};

/** Daily/weekly close history from Yahoo's chart endpoint. Works globally. */
export async function fetchYahooChart(symbol: string, rangeIn = "5Y"): Promise<CompanyChart> {
  const clean = symbol.trim().toUpperCase();
  const isJse = clean.endsWith(".JO") || clean.endsWith(".JSE");
  const yahooSymbol = clean.replace(/\.JSE$/i, ".JO");
  const range = RANGE_INTERVAL[rangeIn] ? rangeIn : "5Y";
  const interval = RANGE_INTERVAL[range] ?? "1wk";
  const yahooRange = range === "YTD" ? "ytd" : range.toLowerCase();
  const centDiv = isJse ? 100 : 1;

  const fail = (error: string): CompanyChart => ({
    ok: false, symbol: clean, currency: isJse ? "ZAR" : "USD", range, points: [],
    firstClose: null, lastClose: null, changePct: null, cagrPct: null, error,
  });

  try {
    const session = await getSession();
    const headers: Record<string, string> = { "User-Agent": UA, Accept: "application/json" };
    if (session?.cookie) headers.cookie = session.cookie;
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}?range=${yahooRange}&interval=${interval}`;
    const r = await fetch(url, { headers, cache: "no-store" });
    if (!r.ok) return fail(`Yahoo chart ${r.status}`);
    const j = (await r.json()) as {
      chart?: { result?: Array<{ timestamp?: number[]; meta?: { currency?: string }; indicators?: { quote?: Array<{ close?: Array<number | null> }> } }> };
    };
    const res = j?.chart?.result?.[0];
    const ts = res?.timestamp ?? [];
    const closes = res?.indicators?.quote?.[0]?.close ?? [];
    const points: ChartPoint[] = [];
    for (let i = 0; i < ts.length; i++) {
      const c = closes[i];
      const t = ts[i];
      if (typeof c === "number" && Number.isFinite(c) && c > 0 && typeof t === "number") {
        points.push({ t: t * 1000, c: c / centDiv });
      }
    }
    if (points.length < 2) return fail("No price history for this symbol/range");
    const firstClose = points[0]!.c;
    const lastClose = points[points.length - 1]!.c;
    const changePct = ((lastClose - firstClose) / firstClose) * 100;
    const years = RANGE_YEARS[range] ?? 5;
    const cagrPct = years >= 1 && firstClose > 0 ? (Math.pow(lastClose / firstClose, 1 / years) - 1) * 100 : null;
    return {
      ok: true, symbol: clean, currency: res?.meta?.currency ?? (isJse ? "ZAR" : "USD"), range,
      points, firstClose, lastClose, changePct, cagrPct,
    };
  } catch (e) {
    return fail(e instanceof Error ? e.message : "Yahoo chart failed");
  }
}

// ── symbol search (typeahead) ───────────────────────────────────────────

export interface SymbolHit {
  /** Pass to ?sym= (e.g. "TSLA" or "NPN.JO"). */
  symbol: string;
  /** Bare code for display (e.g. "TSLA", "NPN"). */
  display: string;
  name: string;
  /** Friendly exchange (e.g. "NasdaqGS", "Johannesburg", "JSE"). */
  exchange: string;
  /** "EQUITY" | "ETF". */
  type: string;
  source: "iress" | "yahoo";
}

/**
 * Global symbol search via Yahoo (any US / SA / global ticker). Equities + ETFs
 * only. Best-effort — returns [] on any failure (the SA universe still covers
 * JSE names from our own DB in the search route).
 */
export async function searchYahooSymbols(query: string): Promise<SymbolHit[]> {
  const q = query.trim();
  if (!q) return [];
  try {
    const session = await getSession();
    const headers: Record<string, string> = { "User-Agent": UA, Accept: "application/json" };
    if (session?.cookie) headers.cookie = session.cookie;
    const url = `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=12&newsCount=0&listsCount=0&enableFuzzyQuery=false`;
    const r = await fetch(url, { headers, cache: "no-store" });
    if (!r.ok) return [];
    const j = (await r.json()) as { quotes?: Array<Record<string, unknown>> };
    const out: SymbolHit[] = [];
    for (const qt of j.quotes ?? []) {
      const symbol = str(qt.symbol);
      if (!symbol) continue;
      const type = (str(qt.quoteType) ?? "").toUpperCase();
      if (type !== "EQUITY" && type !== "ETF") continue;
      const name = str(qt.shortname) ?? str(qt.longname) ?? symbol;
      const exchange = str(qt.exchDisp) ?? str(qt.exchange) ?? "";
      out.push({ symbol, display: symbol.replace(/\.(JO|JSE)$/i, ""), name, exchange, type, source: "yahoo" });
    }
    return out;
  } catch {
    return [];
  }
}

// ── deep data (financials / estimates / research / ownership / dividends) ──

export interface StatementTable {
  periods: string[];
  rows: { key: string; label: string; values: (number | null)[] }[];
}
export interface EstimateRow {
  period: string;
  avg: number | null;
  low: number | null;
  high: number | null;
  yearAgo: number | null;
  growth: number | null; // fraction
  numAnalysts: number | null;
}
export interface CompanyDeep {
  ok: boolean;
  symbol: string;
  currency: string;
  asOf: string;
  error?: string;
  statements: {
    income: { annual: StatementTable; quarterly: StatementTable };
    balance: { annual: StatementTable; quarterly: StatementTable };
    cashflow: { annual: StatementTable; quarterly: StatementTable };
  };
  estimates: { revenue: EstimateRow[]; earnings: EstimateRow[]; ltGrowth: number | null };
  research: {
    recommendationKey: string | null;
    recommendationMean: number | null;
    numAnalysts: number | null;
    targetMean: number | null;
    targetHigh: number | null;
    targetLow: number | null;
    currentPrice: number | null;
    trend: { strongBuy: number; buy: number; hold: number; sell: number; strongSell: number } | null;
    actions: { date: string | null; firm: string | null; toGrade: string | null; fromGrade: string | null; action: string | null }[];
  };
  ownership: {
    insiderPct: number | null;
    institutionPct: number | null;
    floatPct: number | null;
    institutionsCount: number | null;
    topInstitutions: { name: string; pct: number | null; value: number | null; shares: number | null; date: string | null }[];
    insiderTx: { name: string; relation: string | null; text: string | null; shares: number | null; value: number | null; date: string | null }[];
  };
  dividends: {
    rate: number | null;
    yield: number | null; // fraction
    payout: number | null; // fraction
    exDate: string | null;
    fiveYrAvgYield: number | null; // percent
  };
  notes: string[];
}

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function periodLabel(tsSec: number | null, quarterly: boolean): string {
  if (tsSec == null) return "";
  const d = new Date(tsSec * 1000);
  return quarterly ? `${MON[d.getUTCMonth()]} ${d.getUTCFullYear()}` : String(d.getUTCFullYear());
}
function mapStatement(rows: Array<Record<string, unknown>>, items: Array<[string, string]>, quarterly: boolean): StatementTable {
  const periods = rows.map((r) => periodLabel(num(r.endDate), quarterly));
  return { periods, rows: items.map(([key, label]) => ({ key, label, values: rows.map((r) => num(r[key])) })) };
}
const ISTMT: Array<[string, string]> = [
  ["totalRevenue", "Revenue"], ["costOfRevenue", "Cost of revenue"], ["grossProfit", "Gross profit"],
  ["researchDevelopment", "R&D"], ["sellingGeneralAdministrative", "SG&A"], ["totalOperatingExpenses", "Operating expenses"],
  ["operatingIncome", "Operating income"], ["ebit", "EBIT"], ["interestExpense", "Interest expense"],
  ["incomeBeforeTax", "Pre-tax income"], ["incomeTaxExpense", "Income tax"], ["netIncome", "Net income"],
];
const BSTMT: Array<[string, string]> = [
  ["cash", "Cash & equivalents"], ["shortTermInvestments", "Short-term investments"], ["netReceivables", "Receivables"],
  ["inventory", "Inventory"], ["totalCurrentAssets", "Total current assets"], ["propertyPlantEquipment", "PP&E"],
  ["goodWill", "Goodwill"], ["totalAssets", "Total assets"], ["accountsPayable", "Accounts payable"],
  ["totalCurrentLiabilities", "Total current liabilities"], ["longTermDebt", "Long-term debt"], ["totalLiab", "Total liabilities"],
  ["totalStockholderEquity", "Shareholders' equity"], ["retainedEarnings", "Retained earnings"],
];
const CSTMT: Array<[string, string]> = [
  ["netIncome", "Net income"], ["depreciation", "Depreciation & amortisation"], ["totalCashFromOperatingActivities", "Operating cash flow"],
  ["capitalExpenditures", "Capital expenditure"], ["totalCashflowsFromInvestingActivities", "Investing cash flow"],
  ["dividendsPaid", "Dividends paid"], ["repurchaseOfStock", "Share buybacks"], ["totalCashFromFinancingActivities", "Financing cash flow"],
];

/** Append a computed Free cash flow row (operating CF + capex) to a cash-flow table. */
function withFcf(t: StatementTable): StatementTable {
  const op = t.rows.find((r) => r.key === "totalCashFromOperatingActivities");
  const cx = t.rows.find((r) => r.key === "capitalExpenditures");
  if (!op || !cx) return t;
  const values = op.values.map((v, i) => (v != null && cx.values[i] != null ? v + (cx.values[i] as number) : null));
  return { ...t, rows: [...t.rows, { key: "freeCashFlow", label: "Free cash flow", values }] };
}

/**
 * Deep company data for the Analysis sub-tabs (Financials, Estimates, Research,
 * Ownership/Insiders, Dividends). One Yahoo quoteSummary call, all real data or
 * honest null. JSE per-share fields (targets, EPS estimates, dividend rate) are
 * de-cented; statement totals and ownership values are absolute and left as-is.
 */
export async function fetchCompanyDeep(symbol: string): Promise<CompanyDeep> {
  const clean = symbol.trim().toUpperCase();
  const isJse = clean.endsWith(".JO") || clean.endsWith(".JSE");
  const yahooSymbol = clean.replace(/\.JSE$/i, ".JO");
  const centDiv = isJse ? 100 : 1;
  const asOf = new Date().toISOString();
  const notes: string[] = [];

  const empty = (error: string): CompanyDeep => ({
    ok: false, symbol: clean, currency: isJse ? "ZAR" : "USD", asOf, error,
    statements: {
      income: { annual: { periods: [], rows: [] }, quarterly: { periods: [], rows: [] } },
      balance: { annual: { periods: [], rows: [] }, quarterly: { periods: [], rows: [] } },
      cashflow: { annual: { periods: [], rows: [] }, quarterly: { periods: [], rows: [] } },
    },
    estimates: { revenue: [], earnings: [], ltGrowth: null },
    research: { recommendationKey: null, recommendationMean: null, numAnalysts: null, targetMean: null, targetHigh: null, targetLow: null, currentPrice: null, trend: null, actions: [] },
    ownership: { insiderPct: null, institutionPct: null, floatPct: null, institutionsCount: null, topInstitutions: [], insiderTx: [] },
    dividends: { rate: null, yield: null, payout: null, exDate: null, fiveYrAvgYield: null },
    notes: [error],
  });

  const session = await getSession();
  if (!session) return empty("Could not establish a data session");

  const modules = [
    "price", "summaryDetail", "financialData", "defaultKeyStatistics",
    "incomeStatementHistory", "incomeStatementHistoryQuarterly",
    "balanceSheetHistory", "balanceSheetHistoryQuarterly",
    "cashflowStatementHistory", "cashflowStatementHistoryQuarterly",
    "earningsTrend", "recommendationTrend", "upgradeDowngradeHistory",
    "institutionOwnership", "insiderTransactions", "majorHoldersBreakdown", "calendarEvents",
  ].join(",");

  let res: Record<string, unknown>;
  try {
    const url = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(yahooSymbol)}?modules=${modules}&crumb=${encodeURIComponent(session.crumb)}`;
    const r = await fetch(url, { headers: { "User-Agent": UA, cookie: session.cookie, Accept: "application/json" }, cache: "no-store" });
    if (!r.ok) return empty(`Data provider returned ${r.status}`);
    const j = (await r.json()) as { quoteSummary?: { result?: Array<Record<string, unknown>> } };
    const first = j?.quoteSummary?.result?.[0];
    if (!first) return empty("No data for this symbol");
    res = first;
  } catch (e) {
    return empty(e instanceof Error ? e.message : "Data fetch failed");
  }

  const arr = (mod: unknown, key: string): Array<Record<string, unknown>> =>
    (((mod as Record<string, unknown>)?.[key]) as Array<Record<string, unknown>>) ?? [];
  const priceM = (res.price ?? {}) as Record<string, unknown>;
  const detail = (res.summaryDetail ?? {}) as Record<string, unknown>;
  const fd = (res.financialData ?? {}) as Record<string, unknown>;
  const currency = str(priceM.currency) ?? str(fd.financialCurrency) ?? (isJse ? "ZAR" : "USD");

  // statements
  const statements = {
    income: {
      annual: mapStatement(arr(res.incomeStatementHistory, "incomeStatementHistory"), ISTMT, false),
      quarterly: mapStatement(arr(res.incomeStatementHistoryQuarterly, "incomeStatementHistory"), ISTMT, true),
    },
    balance: {
      annual: mapStatement(arr(res.balanceSheetHistory, "balanceSheetStatements"), BSTMT, false),
      quarterly: mapStatement(arr(res.balanceSheetHistoryQuarterly, "balanceSheetStatements"), BSTMT, true),
    },
    cashflow: {
      annual: withFcf(mapStatement(arr(res.cashflowStatementHistory, "cashflowStatements"), CSTMT, false)),
      quarterly: withFcf(mapStatement(arr(res.cashflowStatementHistoryQuarterly, "cashflowStatements"), CSTMT, true)),
    },
  };
  if (statements.income.annual.periods.length <= 4) notes.push("Statements cover ~4 years (provider limit); deeper history needs a paid vendor.");

  // estimates (earningsTrend)
  const trend = arr(res.earningsTrend, "trend");
  const periodName: Record<string, string> = { "0q": "Current Qtr", "+1q": "Next Qtr", "0y": "Current Year", "+1y": "Next Year" };
  const estRows = (kind: "revenueEstimate" | "earningsEstimate", perShare: boolean): EstimateRow[] =>
    trend
      .filter((t) => periodName[str(t.period) ?? ""])
      .map((t) => {
        const e = (t[kind] ?? {}) as Record<string, unknown>;
        const d = perShare ? centDiv : 1;
        const yearAgoKey = kind === "revenueEstimate" ? "yearAgoRevenue" : "yearAgoEps";
        const sc = (v: number | null) => (v == null ? null : v / d);
        return {
          period: periodName[str(t.period) ?? ""] ?? (str(t.period) ?? ""),
          avg: sc(num(e.avg)), low: sc(num(e.low)), high: sc(num(e.high)),
          yearAgo: sc(num(e[yearAgoKey])), growth: num(e.growth), numAnalysts: num(e.numberOfAnalysts),
        };
      });
  const lt = trend.find((t) => str(t.period) === "+5y");
  const estimates = { revenue: estRows("revenueEstimate", false), earnings: estRows("earningsEstimate", true), ltGrowth: lt ? num(lt.growth) : null };
  if (!estimates.revenue.length && !estimates.earnings.length) notes.push("No analyst estimates published for this security.");

  // research (consensus + targets + up/downgrades)
  const recTrend = arr(res.recommendationTrend, "trend").find((t) => str(t.period) === "0m") ?? arr(res.recommendationTrend, "trend")[0];
  const upgrades = arr(res.upgradeDowngradeHistory, "history").slice(0, 10).map((h) => ({
    date: num(h.epochGradeDate) != null ? new Date(num(h.epochGradeDate)! * 1000).toISOString() : null,
    firm: str(h.firm), toGrade: str(h.toGrade), fromGrade: str(h.fromGrade), action: str(h.action),
  }));
  const research = {
    recommendationKey: str(fd.recommendationKey),
    recommendationMean: num(fd.recommendationMean),
    numAnalysts: num(fd.numberOfAnalystOpinions),
    targetMean: num(fd.targetMeanPrice) != null ? num(fd.targetMeanPrice)! / centDiv : null,
    targetHigh: num(fd.targetHighPrice) != null ? num(fd.targetHighPrice)! / centDiv : null,
    targetLow: num(fd.targetLowPrice) != null ? num(fd.targetLowPrice)! / centDiv : null,
    currentPrice: num(fd.currentPrice) != null ? num(fd.currentPrice)! / centDiv : null,
    trend: recTrend
      ? { strongBuy: num(recTrend.strongBuy) ?? 0, buy: num(recTrend.buy) ?? 0, hold: num(recTrend.hold) ?? 0, sell: num(recTrend.sell) ?? 0, strongSell: num(recTrend.strongSell) ?? 0 }
      : null,
    actions: upgrades,
  };
  if (research.numAnalysts == null && !research.trend) notes.push("No sell-side analyst coverage on the free feed for this security.");

  // ownership (insiders + institutions)
  const mhb = (res.majorHoldersBreakdown ?? {}) as Record<string, unknown>;
  const topInstitutions = arr(res.institutionOwnership, "ownershipList").slice(0, 12).map((o) => ({
    name: str(o.organization) ?? "—",
    pct: num(o.pctHeld), shares: num(o.position), value: num(o.value),
    date: num(o.reportDate) != null ? new Date(num(o.reportDate)! * 1000).toISOString() : null,
  }));
  const insiderTx = arr(res.insiderTransactions, "transactions").slice(0, 12).map((t) => ({
    name: str(t.filerName) ?? "—", relation: str(t.filerRelation), text: str(t.transactionText),
    shares: num(t.shares), value: num(t.value),
    date: num(t.startDate) != null ? new Date(num(t.startDate)! * 1000).toISOString() : null,
  }));
  const ownership = {
    insiderPct: num(mhb.insidersPercentHeld), institutionPct: num(mhb.institutionsPercentHeld),
    floatPct: num(mhb.institutionsFloatPercentHeld), institutionsCount: num(mhb.institutionsCount),
    topInstitutions, insiderTx,
  };

  // dividends
  const dividends = {
    rate: num(detail.dividendRate) != null ? num(detail.dividendRate)! / centDiv : (num(detail.trailingAnnualDividendRate) != null ? num(detail.trailingAnnualDividendRate)! / centDiv : null),
    yield: num(detail.dividendYield) ?? num(detail.trailingAnnualDividendYield),
    payout: num(detail.payoutRatio),
    exDate: num(detail.exDividendDate) != null ? new Date(num(detail.exDividendDate)! * 1000).toISOString() : null,
    fiveYrAvgYield: num(detail.fiveYearAvgDividendYield),
  };
  if (dividends.yield == null) notes.push("No dividend reported for this security.");

  return { ok: true, symbol: clean, currency, asOf, statements, estimates, research, ownership, dividends, notes };
}
