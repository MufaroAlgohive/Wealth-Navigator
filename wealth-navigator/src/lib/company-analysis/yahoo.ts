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
    /** Which feed the live last/change came from. JSE prices prefer IRESS. */
    priceSource?: "iress" | "yahoo";
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
    /** Next scheduled earnings date (ISO), from the calendar. */
    nextEarnings: string | null;
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

const FUND_TYPES = [
  "annualTotalRevenue", "annualNetIncome", "annualOperatingIncome", "annualEBIT", "annualPretaxIncome",
  "annualTaxProvision", "annualTotalAssets", "annualCurrentLiabilities", "annualStockholdersEquity",
  "annualTotalDebt", "annualGrossProfit", "annualDilutedEPS", "annualFreeCashFlow",
];

/**
 * Yahoo modern fundamentals-timeseries — reliable annual statement line items.
 * The legacy quoteSummary statement modules are now sparse (many fields null/0),
 * so returns/ratios and CAGRs are derived from this endpoint instead. Returns a
 * map of type → points, most-recent-FIRST. Best-effort: {} on any failure.
 */
async function fetchYahooFundamentals(yahooSymbol: string): Promise<Record<string, Array<{ date: string; value: number }>>> {
  try {
    const session = await getSession();
    const now = Math.floor(Date.now() / 1000);
    const p1 = now - 60 * 60 * 24 * 365 * 11;
    const headers: Record<string, string> = { "User-Agent": UA, Accept: "application/json" };
    if (session?.cookie) headers.cookie = session.cookie;
    const url = `https://query2.finance.yahoo.com/ws/fundamentals-timeseries/v1/finance/timeseries/${encodeURIComponent(yahooSymbol)}?symbol=${encodeURIComponent(yahooSymbol)}&type=${FUND_TYPES.join(",")}&period1=${p1}&period2=${now}&merge=false`;
    const r = await fetch(url, { headers, cache: "no-store" });
    if (!r.ok) return {};
    const j = (await r.json()) as { timeseries?: { result?: Array<Record<string, unknown>> } };
    const out: Record<string, Array<{ date: string; value: number }>> = {};
    for (const res of j?.timeseries?.result ?? []) {
      const type = ((res.meta as { type?: string[] })?.type ?? [])[0];
      if (!type) continue;
      const series = res[type];
      if (!Array.isArray(series)) continue;
      const pts: Array<{ date: string; value: number }> = [];
      for (const s of series) {
        const v = num((s as Record<string, unknown>)?.reportedValue);
        const date = str((s as Record<string, unknown>)?.asOfDate);
        if (v != null && date) pts.push({ date, value: v });
      }
      out[type] = pts.reverse(); // API is oldest-first; expose newest-first
    }
    return out;
  } catch {
    return {};
  }
}

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
    overview: { name: null, description: null, ceo: null, website: null, sector: null, industry: null, country: null, employees: null, nextEarnings: null },
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

  // Reliable annual statement line items (the legacy statement modules above are
  // sparse). Used for returns, pre-tax margin and CAGRs.
  const F = await fetchYahooFundamentals(yahooSymbol);
  const fLatest = (t: string): number | null => F[t]?.[0]?.value ?? null;
  const fSeries = (t: string): Array<number | null> => (F[t] ?? []).map((p) => p.value);

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

  const currency = isJse ? "ZAR" : (str(priceM.currency) ?? str(fd.financialCurrency) ?? "USD");
  const centDiv = isJse ? 100 : 1; // JSE per-share prices come back in cents

  // ── price ──
  const last = num(priceM.regularMarketPrice);
  const price = {
    last: last != null ? last / centDiv : null,
    change: num(priceM.regularMarketChange) != null ? num(priceM.regularMarketChange)! / centDiv : null,
    changePct: num(priceM.regularMarketChangePercent) != null ? num(priceM.regularMarketChangePercent)! * 100 : null,
    marketState: str(priceM.marketState),
    exchange: str(priceM.exchangeName) ?? str(priceM.fullExchangeName),
    priceSource: "yahoo" as const,
  };

  // ── overview ──
  const officers = (profileM.companyOfficers as Array<Record<string, unknown>>) ?? [];
  const ceo = officers.find((o) => /chief executive|ceo/i.test(str(o.title) ?? ""))?.name as string | undefined;
  const calEarningsDates = ((res.calendarEvents as { earnings?: { earningsDate?: unknown[] } })?.earnings?.earningsDate) ?? [];
  const nextEarnings = calEarningsDates.length && num(calEarningsDates[0]) != null
    ? new Date(num(calEarningsDates[0])! * 1000).toISOString()
    : null;
  const overview = {
    name: str(priceM.longName) ?? str(priceM.shortName),
    description: str(profileM.longBusinessSummary),
    ceo: ceo ?? null,
    website: str(profileM.website),
    sector: str(profileM.sector),
    industry: str(profileM.industry),
    country: str(profileM.country),
    employees: num(profileM.fullTimeEmployees),
    nextEarnings,
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
    "Pre-Tax": M(div(fLatest("annualPretaxIncome"), fLatest("annualTotalRevenue")) ?? div(num((inc[0] ?? {}).incomeBeforeTax), revenue), "pct"),
    Net: M(num(fd.profitMargins) ?? num(ks.profitMargins) ?? div(num((inc[0] ?? {}).netIncome), revenue), "pct"),
    FCF: M(div(fcfComputed, revenue), "pct"),
  };
  // Returns computed from the latest reported statements (income + balance):
  //   ROTA = net income / total assets
  //   ROCE = EBIT / (total assets - current liabilities)
  //   ROIC = NOPAT / (total debt + equity), NOPAT = EBIT x (1 - effective tax rate)
  const ni0 = fLatest("annualNetIncome") ?? num((inc[0] ?? {}).netIncome);
  const tax0 = fLatest("annualTaxProvision") ?? num((inc[0] ?? {}).incomeTaxExpense);
  const pretax0 = fLatest("annualPretaxIncome") ?? num((inc[0] ?? {}).incomeBeforeTax) ?? (ni0 != null && tax0 != null ? ni0 + tax0 : null);
  const ebit0 = fLatest("annualEBIT") ?? fLatest("annualOperatingIncome") ?? num((inc[0] ?? {}).ebit) ?? num((inc[0] ?? {}).operatingIncome);
  const totalAssets0 = fLatest("annualTotalAssets") ?? num((bs[0] ?? {}).totalAssets);
  const currLiab0 = fLatest("annualCurrentLiabilities") ?? num((bs[0] ?? {}).totalCurrentLiabilities);
  const equity0 = fLatest("annualStockholdersEquity") ?? num((bs[0] ?? {}).totalStockholderEquity);
  const debt0 = fLatest("annualTotalDebt") ?? totalDebt;
  const taxRate = pretax0 != null && pretax0 > 0 && tax0 != null ? Math.min(Math.max(tax0 / pretax0, 0), 0.5) : 0.21;
  const nopat = ebit0 != null ? ebit0 * (1 - taxRate) : null;
  const investedCapital = (debt0 ?? 0) + (equity0 ?? 0);
  const capitalEmployed = totalAssets0 != null && currLiab0 != null ? totalAssets0 - currLiab0 : null;
  const roicVal = nopat != null && investedCapital > 0 ? nopat / investedCapital : null;
  const roceVal = ebit0 != null && capitalEmployed != null && capitalEmployed > 0 ? ebit0 / capitalEmployed : null;
  const rotaVal = ni0 != null && totalAssets0 != null && totalAssets0 > 0 ? ni0 / totalAssets0 : null;
  groups.Returns = {
    ROA: M(num(fd.returnOnAssets), "pct"),
    ROE: M(num(fd.returnOnEquity) ?? (ni0 != null && equity0 != null && equity0 > 0 ? ni0 / equity0 : null), "pct"),
    ROIC: M(roicVal, "pct"),
    ROCE: M(roceVal, "pct"),
    ROTA: M(rotaVal, "pct"),
  };
  notes.push("Returns are computed from the latest reported statements (not a multi-year average).");
  if (roicVal == null && roceVal == null && rotaVal == null) {
    notes.push("Returns need full statements not available on the free feed for this security.");
  }

  const trailingPE = num(detail.trailingPE) ?? num(ks.trailingPE);
  const pb = num(ks.priceToBook);
  groups["Valuation (TTM)"] = {
    "P/E": M(trailingPE, "x"),
    "P/B": M(pb != null && isJse && pb > 40 ? pb / 100 : pb, "x"),
    "EV/Sales": M(num(ks.enterpriseToRevenue) ?? div(ev, revenue), "x"),
    "EV/EBITDA": M(num(ks.enterpriseToEbitda) ?? div(ev, ebitda), "x"),
    "P/FCF": M(div(marketCap, fcfComputed), "x"),
    "EV/Gross Profit": M(div(ev, grossProfit), "x"),
  };
  const targetRaw = num(fd.targetMeanPrice);
  const target = targetRaw != null ? targetRaw / centDiv : null;
  const fwdEps = num(ks.forwardEps);
  // Yahoo computes JSE per-share ratios on the cents-quoted price, so they come
  // back ~100x inflated; de-cent when implausibly large (trailing P/E is fine).
  const fwdPE = num(ks.forwardPE) ?? num(detail.forwardPE) ?? div(price.last, fwdEps);
  const pegRaw = num(ks.pegRatio);
  groups["Valuation (NTM)"] = {
    "Price Target": M(target, "price"),
    "P/E": M(fwdPE != null && isJse && fwdPE > 80 ? fwdPE / 100 : fwdPE, "x"),
    PEG: M(pegRaw != null && isJse && pegRaw > 15 ? pegRaw / 100 : pegRaw, "ratio"),
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
  const revTs = fSeries("annualTotalRevenue");
  const epsTs = fSeries("annualDilutedEPS");
  const at = (arr: Array<number | null>, i: number): number | null => arr[i] ?? null;
  const cagrRev = (yrs: number) => cagr(at(revTs, 0) ?? at(revSeries, 0), at(revTs, yrs) ?? at(revSeries, yrs), yrs);
  const rev3 = cagrRev(3);
  const rev5 = cagrRev(5);
  const rev10 = cagrRev(10);
  const eps3v = cagr(at(epsTs, 0), at(epsTs, 3), 3) ?? (n >= 4 ? cagr(at(niSeries, 0), at(niSeries, 3), 3) : null);
  const eps5v = cagr(at(epsTs, 0), at(epsTs, 5), 5);
  const eps10v = cagr(at(epsTs, 0), at(epsTs, 10), 10);
  const epsLatest = num(ks.trailingEps);
  const trend1y = earnTrend.find((t) => str((t as Record<string, unknown>).period) === "+1y") as Record<string, unknown> | undefined;
  const trend5y = earnTrend.find((t) => str((t as Record<string, unknown>).period) === "+5y") as Record<string, unknown> | undefined;
  groups["Growth (CAGR)"] = {
    "Rev 3Yr": M(rev3, "pct100"),
    "Rev 5Yr": M(rev5, "pct100"),
    "Rev 10Yr": M(rev10, "pct100"),
    "Dil EPS 3Yr": M(eps3v, "pct100"),
    "Dil EPS 5Yr": M(eps5v, "pct100"),
    "Dil EPS 10Yr": M(eps10v, "pct100"),
    "Rev Fwd 2Yr": M(num(fd.revenueGrowth), "pct"),
    "EPS Fwd 2Yr": M(num(trend1y?.growth), "pct"),
    "EPS LT Est": M(num(trend5y?.growth), "pct"),
  } as Record<string, AnalysisMetric>;
  if (rev5 == null && rev10 == null) {
    notes.push("5-year and 10-year CAGRs need more history than the free feed returns; shown as a dash.");
  }

  const divYield = num(detail.dividendYield) ?? num(detail.trailingAnnualDividendYield);
  const dpsRate = num(detail.dividendRate);
  groups.Dividends = {
    Yield: M(divYield, "pct"),
    Payout: M(num(detail.payoutRatio), "pct"),
    DPS: M(dpsRate ?? num(detail.trailingAnnualDividendRate), "price"),
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
  /** Which feed served this series — "iress" (PROD, anchored) or "yahoo". */
  source?: "iress" | "yahoo";
  error?: string;
}

// Each UI range maps to a VALID Yahoo chart range + interval. 1D/1W are
// intraday; 3Y has no native Yahoo range so we fetch 5y weekly and slice to 3y.
const RANGE_CFG: Record<string, { yr: string; interval: string; years: number; slice?: number }> = {
  "1D": { yr: "1d", interval: "5m", years: 0 },
  "1W": { yr: "5d", interval: "30m", years: 0 },
  "1M": { yr: "1mo", interval: "1d", years: 1 / 12 },
  "3M": { yr: "3mo", interval: "1d", years: 0.25 },
  "6M": { yr: "6mo", interval: "1d", years: 0.5 },
  YTD: { yr: "ytd", interval: "1d", years: 0.5 },
  "1Y": { yr: "1y", interval: "1d", years: 1 },
  "3Y": { yr: "5y", interval: "1wk", years: 3, slice: 3 },
  "5Y": { yr: "5y", interval: "1wk", years: 5 },
  MAX: { yr: "max", interval: "1mo", years: 10 },
};

/** Daily/weekly close history from Yahoo's chart endpoint. Works globally. */
export async function fetchYahooChart(symbol: string, rangeIn = "5Y"): Promise<CompanyChart> {
  const clean = symbol.trim().toUpperCase();
  const isJse = clean.endsWith(".JO") || clean.endsWith(".JSE");
  const yahooSymbol = clean.replace(/\.JSE$/i, ".JO");
  const range = RANGE_CFG[rangeIn] ? rangeIn : "5Y";
  const cfg = RANGE_CFG[range]!;
  const centDiv = isJse ? 100 : 1;

  const fail = (error: string): CompanyChart => ({
    ok: false, symbol: clean, currency: isJse ? "ZAR" : "USD", range, points: [],
    firstClose: null, lastClose: null, changePct: null, cagrPct: null, error,
  });

  try {
    const session = await getSession();
    const headers: Record<string, string> = { "User-Agent": UA, Accept: "application/json" };
    if (session?.cookie) headers.cookie = session.cookie;
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}?range=${cfg.yr}&interval=${cfg.interval}`;
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
    const sliced = cfg.slice ? points.filter((p) => p.t >= Date.now() - cfg.slice! * 365 * 24 * 3600 * 1000) : points;
    if (sliced.length < 2) return fail("No price history for this symbol/range");
    const firstClose = sliced[0]!.c;
    const lastClose = sliced[sliced.length - 1]!.c;
    const changePct = ((lastClose - firstClose) / firstClose) * 100;
    const years = cfg.years;
    const cagrPct = years >= 1 && firstClose > 0 ? (Math.pow(lastClose / firstClose, 1 / years) - 1) * 100 : null;
    return {
      ok: true, symbol: clean, currency: isJse ? "ZAR" : (res?.meta?.currency ?? "USD"), range,
      points: sliced, firstClose, lastClose, changePct, cagrPct,
    };
  } catch (e) {
    return fail(e instanceof Error ? e.message : "Yahoo chart failed");
  }
}

// ── dividend history ─────────────────────────────────────────────────────

export interface DividendPayment {
  date: string;
  amount: number;
  changePct: number | null;
}
export interface CompanyDividends {
  ok: boolean;
  symbol: string;
  currency: string;
  payments: DividendPayment[];
  error?: string;
}

/** Per-payment dividend history (Yahoo chart dividend events). JSE cents ÷100. */
export async function fetchYahooDividends(symbol: string): Promise<CompanyDividends> {
  const clean = symbol.trim().toUpperCase();
  const isJse = clean.endsWith(".JO") || clean.endsWith(".JSE");
  const yahooSymbol = clean.replace(/\.JSE$/i, ".JO");
  const centDiv = isJse ? 100 : 1;
  const fail = (error: string): CompanyDividends => ({ ok: false, symbol: clean, currency: isJse ? "ZAR" : "USD", payments: [], error });
  try {
    const session = await getSession();
    const headers: Record<string, string> = { "User-Agent": UA, Accept: "application/json" };
    if (session?.cookie) headers.cookie = session.cookie;
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}?range=10y&interval=1mo&events=div`;
    const r = await fetch(url, { headers, cache: "no-store" });
    if (!r.ok) return fail(`Yahoo dividends ${r.status}`);
    const j = (await r.json()) as { chart?: { result?: Array<{ meta?: { currency?: string }; events?: { dividends?: Record<string, { amount?: number; date?: number }> } }> } };
    const res = j?.chart?.result?.[0];
    const currency = isJse ? "ZAR" : (res?.meta?.currency ?? "USD");
    const divs = res?.events?.dividends ?? {};
    const sorted = Object.values(divs)
      .filter((d): d is { amount: number; date: number } => typeof d.amount === "number" && typeof d.date === "number")
      .map((d) => ({ ts: d.date, amount: d.amount / centDiv }))
      .sort((a, b) => b.ts - a.ts);
    const payments: DividendPayment[] = sorted.map((d, i) => {
      const prev = sorted[i + 1]; // older payment
      const changePct = prev && prev.amount > 0 ? ((d.amount - prev.amount) / prev.amount) * 100 : null;
      return { date: new Date(d.ts * 1000).toISOString(), amount: d.amount, changePct };
    });
    if (!payments.length) return fail("No dividend history for this security");
    return { ok: true, symbol: clean, currency, payments };
  } catch (e) {
    return fail(e instanceof Error ? e.message : "dividends failed");
  }
}

// ── peers ────────────────────────────────────────────────────────────────

/** Related/peer tickers from Yahoo (free). Best-effort; [] on failure. */
export async function fetchYahooPeers(symbol: string): Promise<{ ok: boolean; symbol: string; peers: string[] }> {
  const clean = symbol.trim().toUpperCase();
  const yahooSymbol = clean.replace(/\.JSE$/i, ".JO");
  try {
    const session = await getSession();
    const headers: Record<string, string> = { "User-Agent": UA, Accept: "application/json" };
    if (session?.cookie) headers.cookie = session.cookie;
    const url = `https://query2.finance.yahoo.com/v6/finance/recommendationsbysymbol/${encodeURIComponent(yahooSymbol)}`;
    const r = await fetch(url, { headers, cache: "no-store" });
    if (!r.ok) return { ok: false, symbol: clean, peers: [] };
    const j = (await r.json()) as { finance?: { result?: Array<{ recommendedSymbols?: Array<{ symbol?: string }> }> } };
    const rec = j?.finance?.result?.[0]?.recommendedSymbols ?? [];
    const peers = rec.map((x) => str(x.symbol)).filter((s): s is string => Boolean(s)).slice(0, 8);
    return { ok: peers.length > 0, symbol: clean, peers };
  } catch {
    return { ok: false, symbol: clean, peers: [] };
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
  /** Present when the hit came from securities_c (SA universe). */
  sector?: string | null;
  isin?: string | null;
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
    insiders: { name: string; title: string | null; shares: number | null; date: string | null }[];
    sharesOutstanding: number | null;
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
    ownership: { insiderPct: null, institutionPct: null, floatPct: null, institutionsCount: null, topInstitutions: [], insiderTx: [], insiders: [], sharesOutstanding: null },
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
    "institutionOwnership", "insiderTransactions", "insiderHolders", "majorHoldersBreakdown", "calendarEvents",
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
  const currency = isJse ? "ZAR" : (str(priceM.currency) ?? str(fd.financialCurrency) ?? "USD");

  // statements — annual from SEC EDGAR (US, 10+ years) where available, else the
  // fundamentals-timeseries feed (~5 years); quarterly from the timeseries feed.
  // Legacy quoteSummary modules are the last-resort fallback.
  const [tsStmts, edgar] = await Promise.all([fetchYahooStatements(yahooSymbol), fetchEdgarStatements(clean)]);
  const base: CompanyDeep["statements"] = tsStmts.ok
    ? tsStmts.statements
    : {
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
  // Use EDGAR annual only when its revenue series is clean (latest year present
  // and good coverage); otherwise keep the clean ~5yr timeseries so gappy data
  // never ships. Concept coverage across older filings is still being hardened.
  const edgarRev = edgar?.income.rows.find((r) => r.key === "TotalRevenue");
  const edgarClean = Boolean(edgar && edgarRev && edgarRev.values[0] != null && edgarRev.values.filter((v) => v != null).length >= 6);
  const statements: CompanyDeep["statements"] = {
    income: { annual: edgarClean ? edgar!.income : base.income.annual, quarterly: base.income.quarterly },
    balance: { annual: edgarClean ? edgar!.balance : base.balance.annual, quarterly: base.balance.quarterly },
    cashflow: { annual: edgarClean ? edgar!.cashflow : base.cashflow.annual, quarterly: base.cashflow.quarterly },
  };
  if (edgarClean) notes.push("Annual statements sourced from SEC filings (10-K).");
  else if (statements.income.annual.periods.length <= 5) notes.push("Statements cover ~5 years; deeper history needs a paid vendor.");

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
  const ksDeep = (res.defaultKeyStatistics ?? {}) as Record<string, unknown>;
  const insiders = arr(res.insiderHolders, "holders").slice(0, 25).map((h) => ({
    name: str(h.name) ?? "—",
    title: str(h.relation),
    shares: num(h.positionDirect),
    date: num(h.positionDirectDate) != null ? new Date(num(h.positionDirectDate)! * 1000).toISOString() : (num(h.latestTransDate) != null ? new Date(num(h.latestTransDate)! * 1000).toISOString() : null),
  }));
  const ownership = {
    insiderPct: num(mhb.insidersPercentHeld), institutionPct: num(mhb.institutionsPercentHeld),
    floatPct: num(mhb.institutionsFloatPercentHeld), institutionsCount: num(mhb.institutionsCount),
    topInstitutions, insiderTx, insiders,
    sharesOutstanding: num(ksDeep.sharesOutstanding) ?? num(priceM.sharesOutstanding),
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

// ── statements from fundamentals-timeseries (real, multi-year) ───────────

const STMT_SPECS: Record<"income" | "balance" | "cashflow", Array<[string, string]>> = {
  income: [
    ["TotalRevenue", "Revenue"], ["CostOfRevenue", "Cost of revenue"], ["GrossProfit", "Gross profit"],
    ["SellingGeneralAndAdministration", "SG&A"], ["ResearchAndDevelopment", "R&D"],
    ["OperatingIncome", "Operating income"], ["PretaxIncome", "Pre-tax income"],
    ["TaxProvision", "Income tax"], ["NetIncome", "Net income"], ["EBITDA", "EBITDA"],
  ],
  balance: [
    ["CashAndCashEquivalents", "Cash & equivalents"], ["OtherShortTermInvestments", "Short-term investments"],
    ["AccountsReceivable", "Receivables"], ["Inventory", "Inventory"], ["CurrentAssets", "Total current assets"],
    ["NetPPE", "Net PP&E"], ["Goodwill", "Goodwill"], ["TotalAssets", "Total assets"],
    ["AccountsPayable", "Accounts payable"], ["CurrentLiabilities", "Total current liabilities"],
    ["LongTermDebt", "Long-term debt"], ["TotalLiabilitiesNetMinorityInterest", "Total liabilities"],
    ["RetainedEarnings", "Retained earnings"], ["StockholdersEquity", "Shareholders' equity"],
  ],
  cashflow: [
    ["OperatingCashFlow", "Operating cash flow"], ["CapitalExpenditure", "Capital expenditure"],
    ["FreeCashFlow", "Free cash flow"], ["InvestingCashFlow", "Investing cash flow"],
    ["FinancingCashFlow", "Financing cash flow"], ["CashDividendsPaid", "Dividends paid"],
    ["RepurchaseOfCapitalStock", "Share buybacks"],
  ],
};

function fyLabel(dateStr: string): string {
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return dateStr;
  return `${MON[d.getUTCMonth()]} '${String(d.getUTCFullYear()).slice(2)}`;
}

/**
 * Build real income / balance / cash-flow statements (annual + quarterly) from
 * Yahoo's fundamentals-timeseries — the modern feed that actually carries the
 * line items (the legacy quoteSummary statement modules return null/0). Returns
 * { ok, statements } where each statement is { annual, quarterly } StatementTable.
 */
export async function fetchYahooStatements(yahooSymbol: string): Promise<{ ok: boolean; statements: CompanyDeep["statements"] }> {
  const bases = Array.from(new Set(Object.values(STMT_SPECS).flat().map(([b]) => b)));
  const types: string[] = [];
  for (const b of bases) types.push(`annual${b}`, `quarterly${b}`);
  const empty: StatementTable = { periods: [], rows: [] };
  const blank: CompanyDeep["statements"] = {
    income: { annual: empty, quarterly: empty }, balance: { annual: empty, quarterly: empty }, cashflow: { annual: empty, quarterly: empty },
  };
  try {
    const session = await getSession();
    const now = Math.floor(Date.now() / 1000);
    const p1 = now - 60 * 60 * 24 * 365 * 7;
    const headers: Record<string, string> = { "User-Agent": UA, Accept: "application/json" };
    if (session?.cookie) headers.cookie = session.cookie;
    const url = `https://query2.finance.yahoo.com/ws/fundamentals-timeseries/v1/finance/timeseries/${encodeURIComponent(yahooSymbol)}?symbol=${encodeURIComponent(yahooSymbol)}&type=${types.join(",")}&period1=${p1}&period2=${now}&merge=false`;
    const r = await fetch(url, { headers, cache: "no-store" });
    if (!r.ok) return { ok: false, statements: blank };
    const j = (await r.json()) as { timeseries?: { result?: Array<Record<string, unknown>> } };
    const F: Record<string, Array<{ date: string; value: number }>> = {};
    for (const res of j?.timeseries?.result ?? []) {
      const type = ((res.meta as { type?: string[] })?.type ?? [])[0];
      if (!type || !Array.isArray(res[type])) continue;
      const pts: Array<{ date: string; value: number }> = [];
      for (const s of res[type] as unknown[]) {
        const v = num((s as Record<string, unknown>)?.reportedValue);
        const date = str((s as Record<string, unknown>)?.asOfDate);
        if (v != null && date) pts.push({ date, value: v });
      }
      F[type] = pts;
    }
    const build = (specs: Array<[string, string]>, prefix: "annual" | "quarterly"): StatementTable => {
      const dateSet = new Set<string>();
      for (const [b] of specs) for (const p of F[`${prefix}${b}`] ?? []) dateSet.add(p.date);
      const dates = Array.from(dateSet).sort().reverse().slice(0, prefix === "quarterly" ? 8 : 6);
      const rows = specs.map(([b, label]) => {
        const byDate = new Map((F[`${prefix}${b}`] ?? []).map((p) => [p.date, p.value]));
        return { key: b, label, values: dates.map((d) => byDate.get(d) ?? null) };
      });
      return { periods: dates.map(fyLabel), rows };
    };
    const statements: CompanyDeep["statements"] = {
      income: { annual: build(STMT_SPECS.income, "annual"), quarterly: build(STMT_SPECS.income, "quarterly") },
      balance: { annual: build(STMT_SPECS.balance, "annual"), quarterly: build(STMT_SPECS.balance, "quarterly") },
      cashflow: { annual: build(STMT_SPECS.cashflow, "annual"), quarterly: build(STMT_SPECS.cashflow, "quarterly") },
    };
    const ok = statements.income.annual.periods.length > 0 || statements.balance.annual.periods.length > 0;
    return { ok, statements };
  } catch {
    return { ok: false, statements: blank };
  }
}

// ── SEC EDGAR XBRL statements (US, 10+ years, free) ──────────────────────

const EDGAR_UA = "Mint Wealth Navigator research (admin@stratosphere.vip)";
let _cikMap: Record<string, string> | null = null;
let _cikExp = 0;

/** Ticker -> 10-digit CIK from the SEC map (cached 24h). */
async function edgarCik(ticker: string): Promise<string | null> {
  const t = ticker.toUpperCase();
  if (!_cikMap || _cikExp < Date.now()) {
    try {
      const r = await fetch("https://www.sec.gov/files/company_tickers.json", { headers: { "User-Agent": EDGAR_UA, Accept: "application/json" }, cache: "no-store" });
      if (r.ok) {
        const j = (await r.json()) as Record<string, { ticker?: string; cik_str?: number }>;
        const m: Record<string, string> = {};
        for (const k of Object.keys(j)) {
          const e = j[k];
          if (e?.ticker && e.cik_str != null) m[String(e.ticker).toUpperCase()] = String(e.cik_str).padStart(10, "0");
        }
        _cikMap = m;
        _cikExp = Date.now() + 24 * 3600 * 1000;
      }
    } catch {
      /* ignore */
    }
  }
  return _cikMap?.[t] ?? null;
}

interface EdgarSpec { key: string; label: string; concepts: string[]; negate?: boolean }
const E_INCOME: EdgarSpec[] = [
  { key: "TotalRevenue", label: "Revenue", concepts: ["RevenueFromContractWithCustomerExcludingAssessedTax", "Revenues", "SalesRevenueNet", "RevenueFromContractWithCustomerIncludingAssessedTax"] },
  { key: "CostOfRevenue", label: "Cost of revenue", concepts: ["CostOfRevenue", "CostOfGoodsAndServicesSold", "CostOfGoodsSold"] },
  { key: "GrossProfit", label: "Gross profit", concepts: ["GrossProfit"] },
  { key: "SellingGeneralAndAdministration", label: "SG&A", concepts: ["SellingGeneralAndAdministrativeExpense"] },
  { key: "ResearchAndDevelopment", label: "R&D", concepts: ["ResearchAndDevelopmentExpense"] },
  { key: "OperatingIncome", label: "Operating income", concepts: ["OperatingIncomeLoss"] },
  { key: "PretaxIncome", label: "Pre-tax income", concepts: ["IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest", "IncomeLossFromContinuingOperationsBeforeIncomeTaxesMinorityInterestAndIncomeLossFromEquityMethodInvestments"] },
  { key: "TaxProvision", label: "Income tax", concepts: ["IncomeTaxExpenseBenefit"] },
  { key: "NetIncome", label: "Net income", concepts: ["NetIncomeLoss"] },
];
const E_BALANCE: EdgarSpec[] = [
  { key: "CashAndCashEquivalents", label: "Cash & equivalents", concepts: ["CashAndCashEquivalentsAtCarryingValue"] },
  { key: "OtherShortTermInvestments", label: "Short-term investments", concepts: ["ShortTermInvestments"] },
  { key: "AccountsReceivable", label: "Receivables", concepts: ["AccountsReceivableNetCurrent"] },
  { key: "Inventory", label: "Inventory", concepts: ["InventoryNet"] },
  { key: "CurrentAssets", label: "Total current assets", concepts: ["AssetsCurrent"] },
  { key: "NetPPE", label: "Net PP&E", concepts: ["PropertyPlantAndEquipmentNet"] },
  { key: "Goodwill", label: "Goodwill", concepts: ["Goodwill"] },
  { key: "TotalAssets", label: "Total assets", concepts: ["Assets"] },
  { key: "AccountsPayable", label: "Accounts payable", concepts: ["AccountsPayableCurrent"] },
  { key: "CurrentLiabilities", label: "Total current liabilities", concepts: ["LiabilitiesCurrent"] },
  { key: "LongTermDebt", label: "Long-term debt", concepts: ["LongTermDebtNoncurrent", "LongTermDebt"] },
  { key: "TotalLiabilitiesNetMinorityInterest", label: "Total liabilities", concepts: ["Liabilities"] },
  { key: "RetainedEarnings", label: "Retained earnings", concepts: ["RetainedEarningsAccumulatedDeficit"] },
  { key: "StockholdersEquity", label: "Shareholders' equity", concepts: ["StockholdersEquity", "StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest"] },
];
const E_CASHFLOW: EdgarSpec[] = [
  { key: "OperatingCashFlow", label: "Operating cash flow", concepts: ["NetCashProvidedByUsedInOperatingActivities", "NetCashProvidedByUsedInOperatingActivitiesContinuingOperations"] },
  { key: "CapitalExpenditure", label: "Capital expenditure", concepts: ["PaymentsToAcquirePropertyPlantAndEquipment"], negate: true },
  { key: "InvestingCashFlow", label: "Investing cash flow", concepts: ["NetCashProvidedByUsedInInvestingActivities"] },
  { key: "FinancingCashFlow", label: "Financing cash flow", concepts: ["NetCashProvidedByUsedInFinancingActivities"] },
  { key: "CashDividendsPaid", label: "Dividends paid", concepts: ["PaymentsOfDividendsCommonStock", "PaymentsOfDividends"], negate: true },
  { key: "RepurchaseOfCapitalStock", label: "Share buybacks", concepts: ["PaymentsForRepurchaseOfCommonStock"], negate: true },
];

/**
 * Annual income / balance / cash-flow statements from SEC EDGAR XBRL company
 * facts (10-K, FY) for US tickers, 10+ years free. Returns null for non-US
 * symbols or on any failure (caller falls back to Yahoo). Keys match the Yahoo
 * statement keys so the UI / DCF are source-agnostic.
 */
export async function fetchEdgarStatements(symbol: string): Promise<{ income: StatementTable; balance: StatementTable; cashflow: StatementTable } | null> {
  const clean = symbol.trim().toUpperCase();
  if (clean.includes(".")) return null; // US tickers only
  try {
    const cik = await edgarCik(clean);
    if (!cik) return null;
    const r = await fetch(`https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`, { headers: { "User-Agent": EDGAR_UA, Accept: "application/json" }, cache: "no-store" });
    if (!r.ok) return null;
    const j = (await r.json()) as { facts?: { "us-gaap"?: Record<string, { units?: Record<string, Array<Record<string, unknown>>> }> } };
    const gaap = j?.facts?.["us-gaap"];
    if (!gaap) return null;

    // Merge across candidate concepts (a company can switch us-gaap tags over the
    // years); earlier candidates take priority per fiscal year, later ones fill
    // gaps. Within a concept, the latest filing wins (restatements).
    const fyMap = (spec: EdgarSpec): Map<number, { val: number; end: string }> => {
      const merged = new Map<number, { val: number; end: string }>();
      for (const c of spec.concepts) {
        const units = gaap[c]?.units?.USD;
        if (!Array.isArray(units)) continue;
        const cm = new Map<number, { val: number; end: string }>();
        for (const u of units) {
          const form = typeof u.form === "string" ? u.form : "";
          const val = typeof u.val === "number" ? u.val : null;
          const end = typeof u.end === "string" ? u.end : "";
          if (!form.startsWith("10-K") || val == null || !end) continue;
          // Duration concepts carry `start`; keep only full-year (~365d) periods so
          // quarter/partial spans never count. Key by the value's own period-end
          // year (NOT u.fy, which is the filing's fiscal year and collides across
          // the 10-K's comparative years). Latest filing wins (array is ordered).
          const start = typeof u.start === "string" ? u.start : null;
          if (start) {
            const days = (Date.parse(end) - Date.parse(start)) / 86_400_000;
            if (!(days >= 330 && days <= 400)) continue;
          }
          const yr = Number(end.slice(0, 4));
          if (Number.isFinite(yr)) cm.set(yr, { val: spec.negate ? -val : val, end });
        }
        for (const [yr, v] of cm) if (!merged.has(yr)) merged.set(yr, v);
      }
      return merged;
    };

    const incMaps = E_INCOME.map((s) => ({ s, m: fyMap(s) }));
    const balMaps = E_BALANCE.map((s) => ({ s, m: fyMap(s) }));
    const cfMaps = E_CASHFLOW.map((s) => ({ s, m: fyMap(s) }));

    const yearSet = new Set<number>();
    for (const { m } of [...incMaps, ...balMaps]) for (const y of m.keys()) yearSet.add(y);
    const years = Array.from(yearSet).sort((a, b) => b - a).slice(0, 12);
    if (years.length < 2) return null;
    const revMap = incMaps[0]?.m ?? new Map<number, { val: number; end: string }>();
    const periods = years.map((y) => {
      const e = revMap.get(y)?.end;
      return e ? fyLabel(e) : `FY${y}`;
    });
    const build = (maps: Array<{ s: EdgarSpec; m: Map<number, { val: number; end: string }> }>): StatementTable => ({
      periods,
      rows: maps.map(({ s, m }) => ({ key: s.key, label: s.label, values: years.map((y) => m.get(y)?.val ?? null) })),
    });

    const income = build(incMaps);
    const balance = build(balMaps);
    const cashflow = build(cfMaps);

    const opRow = income.rows.find((r) => r.key === "OperatingIncome");
    const daMap = fyMap({ key: "DA", label: "DA", concepts: ["DepreciationDepletionAndAmortization", "DepreciationAmortizationAndAccretionNet", "DepreciationAndAmortization"] });
    if (opRow) {
      income.rows.push({ key: "EBITDA", label: "EBITDA", values: years.map((y, i) => { const op = opRow.values[i]; return op != null ? op + (daMap.get(y)?.val ?? 0) : null; }) });
    }
    const ocf = cashflow.rows.find((r) => r.key === "OperatingCashFlow");
    const capex = cashflow.rows.find((r) => r.key === "CapitalExpenditure");
    if (ocf && capex) cashflow.rows.push({ key: "FreeCashFlow", label: "Free cash flow", values: years.map((_, i) => { const o = ocf.values[i], c = capex.values[i]; return o != null && c != null ? o + c : null; }) });

    const ok = income.rows.some((r) => r.values.some((v) => v != null));
    return ok ? { income, balance, cashflow } : null;
  } catch {
    return null;
  }
}

// ── SEC filings (US) ─────────────────────────────────────────────────────

export interface Filing {
  form: string;
  date: string | null;
  title: string;
  url: string | null;
}
export interface CompanyFilings {
  ok: boolean;
  symbol: string;
  source: "sec-edgar" | "none";
  filings: Filing[];
  note?: string;
  error?: string;
}

/**
 * Recent SEC EDGAR filings for a US-listed ticker (free, real). JSE issuers do
 * not file with the SEC, so those return an honest empty with a note pointing to
 * JSE SENS. Best-effort Atom parse; any failure returns ok:false honestly.
 */
export async function fetchSecFilings(symbol: string): Promise<CompanyFilings> {
  const clean = symbol.trim().toUpperCase();
  if (clean.endsWith(".JO") || clean.endsWith(".JSE")) {
    return { ok: true, symbol: clean, source: "none", filings: [], note: "SEC EDGAR covers US-listed filings. JSE issuers file via JSE SENS." };
  }
  const ticker = clean.replace(/\..*$/, "");
  try {
    const url = `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&ticker=${encodeURIComponent(ticker)}&type=&dateb=&owner=include&count=30&output=atom`;
    const r = await fetch(url, {
      headers: { "User-Agent": "Mint Wealth Navigator research (admin@stratosphere.vip)", Accept: "application/atom+xml" },
      cache: "no-store",
    });
    if (!r.ok) return { ok: false, symbol: clean, source: "sec-edgar", filings: [], error: `EDGAR ${r.status}` };
    const xml = await r.text();
    const entries = xml.split("<entry>").slice(1);
    const grab = (block: string, re: RegExp): string | null => {
      const m = block.match(re);
      return m && m[1] != null ? m[1].trim() : null;
    };
    const filings: Filing[] = [];
    for (const e of entries) {
      const block = e.split("</entry>")[0] ?? "";
      const form = grab(block, /<filing-type>([^<]+)<\/filing-type>/) ?? grab(block, /term="([^"]+)"/);
      const date = grab(block, /<filing-date>([^<]+)<\/filing-date>/) ?? grab(block, /<updated>([^<]+)<\/updated>/);
      const href = grab(block, /<filing-href>([^<]+)<\/filing-href>/) ?? grab(block, /<link[^>]*href="([^"]+)"/);
      const title = grab(block, /<title>([^<]+)<\/title>/) ?? form ?? "Filing";
      if (form || title) filings.push({ form: form ?? "—", date: date ? date.slice(0, 10) : null, title, url: href });
    }
    return { ok: true, symbol: clean, source: "sec-edgar", filings: filings.slice(0, 30) };
  } catch (e) {
    return { ok: false, symbol: clean, source: "sec-edgar", filings: [], error: e instanceof Error ? e.message : "EDGAR fetch failed" };
  }
}
