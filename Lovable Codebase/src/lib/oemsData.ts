// ============================================================================
// MINT OEMS — Order & Execution Management System mock data layer
// ----------------------------------------------------------------------------
// All market, instrument, news, and strategy data shown in the OEMS dashboard
// is shaped to mirror the IRIS Markets API (https://iris.iress.com.au and the
// JSE/Iress Africa feed) so the integration is a 1:1 swap from mock → live.
//
// IRIS coverage at a glance (used to scope what we surface in the UI):
//   • 240+ global exchanges (JSE, NSX, ZAR money market, LSE, NYSE, NASDAQ,
//     EUREX, HKEX, SGX, ASX, JPX, CME, ICE…)
//   • ~1.4M live instruments (equities, ETFs, bonds, money market, FX,
//     commodities, indices, futures, options, warrants, structured notes)
//   • Level 1 + Level 2 depth, intraday tick, EOD, 25y history, corp actions
//   • Reference data: ISIN/SEDOL/RIC/Bloomberg ticker cross-walk
//   • News: Reuters, Dow Jones, Moneyweb, RNS, SENS (JSE), Bloomberg headlines
//   • Macro: SARB, StatsSA, Fed, ECB, IMF, World Bank releases & calendars
//   • Fundamentals: 10y financials, consensus estimates, ratios, ESG scores
//   • Yield curves, swap curves, FRA, JIBAR fixings, money market rates
//
// Each export below tags the IRIS endpoint a developer should call to replace
// the mock — see `IRIS_INTEGRATION_MAP` at the bottom of this file.
// ============================================================================

export type AssetClass = "equity" | "money_market" | "fixed_income" | "fx" | "commodity";
export type StrategyKind = "equity" | "money_market";

// ---------------------------------------------------------------------------
// Instruments — IRIS: GET /v1/securities/{exchange}/{symbol}
// ---------------------------------------------------------------------------
export interface Instrument {
  symbol: string;          // JSE: "NPN", US: "AAPL"
  isin: string;
  ric: string;             // Reuters Instrument Code
  name: string;
  exchange: string;
  sector: string;
  last: number;
  change: number;
  changePct: number;
  bid: number;
  ask: number;
  volume: number;
  vwap: number;
  marketCap?: number;
  currency: string;
  assetClass: AssetClass;
}

export const jseTopMovers: Instrument[] = [
  { symbol: "NPN", isin: "ZAE000015889", ric: "NPNJ.J", name: "Naspers", exchange: "JSE", sector: "Technology", last: 4180.55, change: 62.30, changePct: 1.51, bid: 4180.10, ask: 4181.00, volume: 1_245_300, vwap: 4172.84, marketCap: 1_812_400_000_000, currency: "ZAR", assetClass: "equity" },
  { symbol: "PRX", isin: "NL0013654783", ric: "PRXJn.J", name: "Prosus", exchange: "JSE", sector: "Technology", last: 2295.10, change: 38.50, changePct: 1.71, bid: 2294.80, ask: 2295.40, volume: 2_103_500, vwap: 2289.20, marketCap: 5_614_000_000_000, currency: "ZAR", assetClass: "equity" },
  { symbol: "FSR", isin: "ZAE000066304", ric: "FSRJ.J", name: "FirstRand", exchange: "JSE", sector: "Banks", last: 78.42, change: -0.55, changePct: -0.70, bid: 78.40, ask: 78.44, volume: 8_932_100, vwap: 78.50, marketCap: 440_120_000_000, currency: "ZAR", assetClass: "equity" },
  { symbol: "SBK", isin: "ZAE000109815", ric: "SBKJ.J", name: "Standard Bank", exchange: "JSE", sector: "Banks", last: 226.75, change: 1.85, changePct: 0.82, bid: 226.70, ask: 226.80, volume: 1_882_400, vwap: 225.90, marketCap: 378_220_000_000, currency: "ZAR", assetClass: "equity" },
  { symbol: "AGL", isin: "GB00B1XZS820", ric: "AGLJ.J", name: "Anglo American", exchange: "JSE", sector: "Mining", last: 552.10, change: 12.40, changePct: 2.30, bid: 552.05, ask: 552.20, volume: 3_421_100, vwap: 548.92, marketCap: 720_440_000_000, currency: "ZAR", assetClass: "equity" },
  { symbol: "BHG", isin: "GB00BH0P3Z91", ric: "BHGJ.J", name: "BHP Group", exchange: "JSE", sector: "Mining", last: 528.40, change: -4.20, changePct: -0.79, bid: 528.30, ask: 528.50, volume: 1_120_400, vwap: 530.10, marketCap: 1_120_400_000_000, currency: "ZAR", assetClass: "equity" },
  { symbol: "MTN", isin: "ZAE000042164", ric: "MTNJ.J", name: "MTN Group", exchange: "JSE", sector: "Telco", last: 108.65, change: -1.40, changePct: -1.27, bid: 108.60, ask: 108.70, volume: 4_551_200, vwap: 109.12, marketCap: 200_310_000_000, currency: "ZAR", assetClass: "equity" },
  { symbol: "SOL", isin: "ZAE000006896", ric: "SOLJ.J", name: "Sasol", exchange: "JSE", sector: "Energy", last: 162.80, change: 4.95, changePct: 3.13, bid: 162.75, ask: 162.85, volume: 6_201_800, vwap: 161.10, marketCap: 106_220_000_000, currency: "ZAR", assetClass: "equity" },
  { symbol: "SHP", isin: "ZAE000012084", ric: "SHPJ.J", name: "Shoprite", exchange: "JSE", sector: "Retail", last: 281.30, change: 2.10, changePct: 0.75, bid: 281.25, ask: 281.35, volume: 982_400, vwap: 280.40, marketCap: 158_440_000_000, currency: "ZAR", assetClass: "equity" },
  { symbol: "CPI", isin: "ZAE000064676", ric: "CPIJ.J", name: "Capitec Bank", exchange: "JSE", sector: "Banks", last: 2840.25, change: 18.30, changePct: 0.65, bid: 2840.10, ask: 2840.40, volume: 412_900, vwap: 2832.15, marketCap: 328_440_000_000, currency: "ZAR", assetClass: "equity" },
];

// ---------------------------------------------------------------------------
// Indices — IRIS: GET /v1/indices/{code}
// ---------------------------------------------------------------------------
export interface IndexQuote {
  code: string;
  name: string;
  last: number;
  change: number;
  changePct: number;
  region: string;
}

export const globalIndices: IndexQuote[] = [
  { code: "J203", name: "JSE All Share", last: 87_412.18, change: 421.30, changePct: 0.48, region: "ZA" },
  { code: "J200", name: "FTSE/JSE Top 40", last: 80_115.40, change: 388.10, changePct: 0.49, region: "ZA" },
  { code: "J257", name: "JSE SA Financials 15", last: 18_245.62, change: -54.12, changePct: -0.30, region: "ZA" },
  { code: "J433", name: "JSE Resources 10", last: 64_220.15, change: 812.40, changePct: 1.28, region: "ZA" },
  { code: "SPX", name: "S&P 500", last: 5_812.45, change: 24.18, changePct: 0.42, region: "US" },
  { code: "NDX", name: "Nasdaq 100", last: 20_445.20, change: 142.55, changePct: 0.70, region: "US" },
  { code: "DJI", name: "Dow Jones", last: 42_118.30, change: -38.20, changePct: -0.09, region: "US" },
  { code: "UKX", name: "FTSE 100", last: 8_245.18, change: 12.40, changePct: 0.15, region: "UK" },
  { code: "DAX", name: "DAX 40", last: 19_512.40, change: 88.10, changePct: 0.45, region: "DE" },
  { code: "N225", name: "Nikkei 225", last: 38_924.55, change: -212.30, changePct: -0.54, region: "JP" },
  { code: "HSI", name: "Hang Seng", last: 19_842.18, change: 312.40, changePct: 1.60, region: "HK" },
];

// ---------------------------------------------------------------------------
// FX & Commodities — IRIS: GET /v1/fx, GET /v1/commodities
// ---------------------------------------------------------------------------
export const fxQuotes = [
  { pair: "USD/ZAR", last: 18.4520, change: -0.0420, changePct: -0.23 },
  { pair: "EUR/ZAR", last: 19.8810, change: 0.0210, changePct: 0.11 },
  { pair: "GBP/ZAR", last: 23.4180, change: 0.0540, changePct: 0.23 },
  { pair: "EUR/USD", last: 1.0775, change: 0.0035, changePct: 0.33 },
  { pair: "USD/JPY", last: 152.40, change: -0.42, changePct: -0.27 },
];

export const commodityQuotes = [
  { name: "Gold (USD/oz)", last: 2_682.40, change: 18.30, changePct: 0.69 },
  { name: "Brent (USD/bbl)", last: 78.12, change: -0.45, changePct: -0.57 },
  { name: "Platinum (USD/oz)", last: 992.55, change: 8.40, changePct: 0.85 },
  { name: "Iron Ore (USD/t)", last: 102.40, change: 1.20, changePct: 1.18 },
  { name: "Copper (USD/t)", last: 9_245.50, change: 42.10, changePct: 0.46 },
];

// ---------------------------------------------------------------------------
// Money Market — IRIS: GET /v1/rates/jibar, /v1/yieldcurve/zar
// ---------------------------------------------------------------------------
export interface MoneyMarketInstrument {
  ticker: string;
  name: string;
  type: "NCD" | "TB" | "Repo" | "Call" | "FRN" | "Corp Paper";
  issuer: string;
  tenor: string;
  yield: number;       // % p.a.
  duration: number;    // years
  rating: string;
  notional: number;    // ZAR
  maturity: string;    // ISO date
}

export const mmInstruments: MoneyMarketInstrument[] = [
  { ticker: "SARB-TB91",  name: "RSA T-Bill 91d",       type: "TB",         issuer: "National Treasury", tenor: "91d",  yield: 8.12, duration: 0.25, rating: "BB", notional: 250_000_000, maturity: "2026-02-28" },
  { ticker: "SARB-TB182", name: "RSA T-Bill 182d",      type: "TB",         issuer: "National Treasury", tenor: "182d", yield: 8.34, duration: 0.50, rating: "BB", notional: 180_000_000, maturity: "2026-05-29" },
  { ticker: "SARB-TB364", name: "RSA T-Bill 364d",      type: "TB",         issuer: "National Treasury", tenor: "364d", yield: 8.58, duration: 1.00, rating: "BB", notional: 320_000_000, maturity: "2026-11-29" },
  { ticker: "FSR-NCD90",  name: "FirstRand NCD 90d",    type: "NCD",        issuer: "FirstRand Bank",    tenor: "90d",  yield: 8.45, duration: 0.25, rating: "AA+", notional: 120_000_000, maturity: "2026-02-27" },
  { ticker: "SBK-NCD180", name: "Standard Bank NCD 180d", type: "NCD",      issuer: "Standard Bank",     tenor: "180d", yield: 8.62, duration: 0.50, rating: "AA+", notional: 200_000_000, maturity: "2026-05-29" },
  { ticker: "NED-NCD365", name: "Nedbank NCD 365d",     type: "NCD",        issuer: "Nedbank",           tenor: "365d", yield: 8.88, duration: 1.00, rating: "AA",  notional: 150_000_000, maturity: "2026-11-29" },
  { ticker: "ABSA-FRN3Y", name: "Absa Floating Rate Note 3y", type: "FRN", issuer: "Absa",              tenor: "3y",   yield: 9.15, duration: 2.85, rating: "AA",  notional: 90_000_000,  maturity: "2028-11-29" },
  { ticker: "ESKM-CP12",  name: "Eskom CP 12m (Gov Gtd)", type: "Corp Paper", issuer: "Eskom",          tenor: "12m",  yield: 9.42, duration: 1.00, rating: "BB-", notional: 75_000_000,  maturity: "2026-11-29" },
  { ticker: "REPO-7D",    name: "SARB Repo 7d",         type: "Repo",       issuer: "SARB",              tenor: "7d",   yield: 7.75, duration: 0.02, rating: "BB", notional: 500_000_000, maturity: "2025-12-08" },
  { ticker: "CALL-OD",    name: "Call Deposit (Overnight)", type: "Call",   issuer: "ABSA Treasury",     tenor: "O/N",  yield: 7.50, duration: 0.003, rating: "AA+", notional: 80_000_000,  maturity: "2025-12-01" },
];

// JIBAR fixings — IRIS: GET /v1/rates/jibar/history
export const jibarFixings = [
  { tenor: "Overnight", rate: 7.50, prev: 7.50, change: 0.00 },
  { tenor: "1 Month",   rate: 7.83, prev: 7.85, change: -0.02 },
  { tenor: "3 Month",   rate: 8.11, prev: 8.14, change: -0.03 },
  { tenor: "6 Month",   rate: 8.42, prev: 8.40, change: 0.02 },
  { tenor: "9 Month",   rate: 8.61, prev: 8.59, change: 0.02 },
  { tenor: "12 Month",  rate: 8.84, prev: 8.81, change: 0.03 },
];

// ZAR Government Yield Curve — IRIS: GET /v1/yieldcurve/zar
export const zarYieldCurve = [
  { tenor: "1M", yield: 7.83 }, { tenor: "3M", yield: 8.11 }, { tenor: "6M", yield: 8.42 },
  { tenor: "1Y", yield: 8.84 }, { tenor: "2Y", yield: 9.21 }, { tenor: "3Y", yield: 9.62 },
  { tenor: "5Y", yield: 10.18 }, { tenor: "7Y", yield: 10.74 }, { tenor: "10Y", yield: 11.42 },
  { tenor: "15Y", yield: 12.05 }, { tenor: "20Y", yield: 12.38 }, { tenor: "25Y", yield: 12.51 },
];

// ---------------------------------------------------------------------------
// OEMS Strategies — internal model with `canRebalance` flag derived from
// presence of underlying investors. UI MUST disable rebalance when 0 investors.
// ---------------------------------------------------------------------------
export interface OEMSStrategy {
  id: string;
  name: string;
  kind: StrategyKind;
  manager: string;
  aum: number;
  ytd: number;
  dayPnl: number;        // ZAR P&L today
  sharpe: number;
  maxDD: number;
  benchmark: string;
  benchmarkYtd: number;
  investorCount: number; // ← gate for rebalance button
  holdingsCount: number;
  cashWeight: number;    // %
  status: "live" | "paper" | "halted";
  lastRebalanced: string;
  trackingError?: number;
  weightedAvgYield?: number; // money-market only
  weightedAvgDuration?: number; // money-market only
}

export const oemsStrategies: OEMSStrategy[] = [
  // Equities
  { id: "eq-001", name: "MINT SA Equity Alpha",     kind: "equity", manager: "Andile Khumalo", aum: 482_000_000, ytd: 18.42, dayPnl: 2_140_000,  sharpe: 1.42, maxDD: -8.20, benchmark: "JSE Top 40", benchmarkYtd: 14.20, investorCount: 38, holdingsCount: 42, cashWeight: 3.2, status: "live", lastRebalanced: "2025-11-24", trackingError: 4.2 },
  { id: "eq-002", name: "MINT Global Quality",      kind: "equity", manager: "Sipho Dlamini",  aum: 318_000_000, ytd: 22.18, dayPnl: 1_840_000,  sharpe: 1.61, maxDD: -6.40, benchmark: "MSCI ACWI",   benchmarkYtd: 19.80, investorCount: 24, holdingsCount: 55, cashWeight: 2.1, status: "live", lastRebalanced: "2025-11-26", trackingError: 3.1 },
  { id: "eq-003", name: "MINT Resources Tilt",      kind: "equity", manager: "Andile Khumalo", aum: 142_000_000, ytd: 12.85, dayPnl: -420_000,   sharpe: 0.94, maxDD: -14.30, benchmark: "JSE Resources 10", benchmarkYtd: 9.40, investorCount: 12, holdingsCount: 18, cashWeight: 4.8, status: "live", lastRebalanced: "2025-11-20", trackingError: 6.8 },
  { id: "eq-004", name: "MINT Smart Beta Low Vol",  kind: "equity", manager: "Karabo Mokoena", aum: 0,           ytd: 11.40, dayPnl: 0,          sharpe: 1.18, maxDD: -5.10, benchmark: "JSE Top 40",   benchmarkYtd: 14.20, investorCount: 0, holdingsCount: 35, cashWeight: 1.5, status: "paper", lastRebalanced: "2025-11-15", trackingError: 5.2 },
  // Money market
  { id: "mm-001", name: "MINT Institutional Money Market", kind: "money_market", manager: "Nomvula Sithole", aum: 850_000_000, ytd: 8.62, dayPnl: 190_000, sharpe: 3.21, maxDD: -0.12, benchmark: "STeFI Composite", benchmarkYtd: 8.41, investorCount: 1, holdingsCount: 14, cashWeight: 12.4, status: "live", lastRebalanced: "2025-11-28", weightedAvgYield: 8.74, weightedAvgDuration: 0.42 },
  { id: "mm-002", name: "MINT Enhanced Yield",            kind: "money_market", manager: "Nomvula Sithole", aum: 0,           ytd: 9.04, dayPnl: 0,       sharpe: 2.85, maxDD: -0.31, benchmark: "STeFI Plus 1%",   benchmarkYtd: 9.41, investorCount: 0, holdingsCount: 22, cashWeight: 8.2, status: "paper", lastRebalanced: "2025-11-25", weightedAvgYield: 9.18, weightedAvgDuration: 0.85 },
];

export const canRebalance = (s: OEMSStrategy) => s.investorCount > 0 && s.status !== "halted";

// ---------------------------------------------------------------------------
// News flow — IRIS: GET /v1/news?sources=reuters,sens,moneyweb&limit=50
// ---------------------------------------------------------------------------
export interface NewsItem {
  id: string;
  headline: string;
  source: "Reuters" | "Bloomberg" | "Moneyweb" | "SENS" | "Dow Jones" | "Business Day";
  time: string;        // HH:mm SAST
  tickers: string[];   // related symbols
  category: "company" | "macro" | "rates" | "fx" | "commodity" | "politics";
  priority: "high" | "normal";
}

export const newsFeed: NewsItem[] = [
  { id: "n1", headline: "SARB holds repo rate at 7.75%, signals data-dependent path into 2026", source: "Reuters",   time: "14:12", tickers: ["J203","USD/ZAR"], category: "rates", priority: "high" },
  { id: "n2", headline: "Naspers reports interim earnings beat on Tencent uplift, raises buyback", source: "SENS",     time: "13:48", tickers: ["NPN","PRX"], category: "company", priority: "high" },
  { id: "n3", headline: "Anglo American formalises De Beers separation timeline for H2 2026",    source: "Bloomberg", time: "13:22", tickers: ["AGL"], category: "company", priority: "normal" },
  { id: "n4", headline: "US PCE inflation prints 2.3% YoY, in line — DXY softens, gold to 2 680", source: "Dow Jones", time: "13:05", tickers: ["SPX","Gold"], category: "macro", priority: "high" },
  { id: "n5", headline: "Treasury sells R3.9bn fixed bond auction at 11.42% (10y), bid-cover 2.8x", source: "Moneyweb", time: "12:40", tickers: ["R2035","JIBAR"], category: "rates", priority: "normal" },
  { id: "n6", headline: "Eskom load-shedding suspended for 12th consecutive week", source: "Business Day", time: "12:18", tickers: ["SOL","ESKM"], category: "politics", priority: "normal" },
  { id: "n7", headline: "MTN Nigeria FX backlog cleared, repatriation resumes Q1 2026", source: "Reuters", time: "11:52", tickers: ["MTN"], category: "company", priority: "normal" },
  { id: "n8", headline: "OPEC+ extends voluntary cuts into Q1 2026, Brent +0.6% intraday", source: "Bloomberg", time: "11:30", tickers: ["Brent","SOL"], category: "commodity", priority: "normal" },
  { id: "n9", headline: "JPY strengthens past 152 as BoJ Ueda flags Dec hike risk", source: "Dow Jones", time: "10:58", tickers: ["USD/JPY","N225"], category: "fx", priority: "normal" },
  { id: "n10", headline: "Capitec Q3 trading update: active clients +11.2% YoY", source: "SENS", time: "10:30", tickers: ["CPI"], category: "company", priority: "normal" },
];

// ---------------------------------------------------------------------------
// Macro calendar & releases — IRIS: GET /v1/macro/calendar?country=ZA,US
// ---------------------------------------------------------------------------
export interface MacroRelease {
  id: string;
  date: string;   // ISO
  time: string;   // HH:mm
  country: string;
  indicator: string;
  period: string;
  actual?: string;
  forecast: string;
  previous: string;
  importance: "high" | "med" | "low";
}

export const macroCalendar: MacroRelease[] = [
  { id: "m1", date: "2025-12-02", time: "10:00", country: "ZA", indicator: "ABSA Manufacturing PMI", period: "Nov", forecast: "51.2", previous: "50.6", importance: "med" },
  { id: "m2", date: "2025-12-03", time: "11:30", country: "ZA", indicator: "GDP QoQ", period: "Q3",  forecast: "0.4%", previous: "-0.1%", importance: "high" },
  { id: "m3", date: "2025-12-04", time: "08:00", country: "ZA", indicator: "Current Account",     period: "Q3",  forecast: "-1.8%", previous: "-1.2%", importance: "med" },
  { id: "m4", date: "2025-12-05", time: "11:00", country: "ZA", indicator: "SARB Quarterly Bulletin", period: "Q3", forecast: "-", previous: "-", importance: "low" },
  { id: "m5", date: "2025-12-06", time: "15:30", country: "US", indicator: "Non-Farm Payrolls",   period: "Nov", forecast: "+182k", previous: "+12k",  importance: "high" },
  { id: "m6", date: "2025-12-10", time: "10:00", country: "ZA", indicator: "Mining Production YoY", period: "Oct", forecast: "1.2%", previous: "-0.5%", importance: "med" },
  { id: "m7", date: "2025-12-11", time: "15:30", country: "US", indicator: "CPI YoY",             period: "Nov", forecast: "2.6%", previous: "2.6%",  importance: "high" },
  { id: "m8", date: "2025-12-18", time: "15:00", country: "ZA", indicator: "SARB MPC Rate Decision", period: "Dec", forecast: "7.50%", previous: "7.75%", importance: "high" },
];

export const macroIndicators = [
  { name: "SA CPI YoY",        value: 3.8,   prior: 3.9,   unit: "%",   trend: "down" as const },
  { name: "SA Repo Rate",      value: 7.75,  prior: 8.00,  unit: "%",   trend: "down" as const },
  { name: "SA GDP YoY",        value: 0.6,   prior: 0.4,   unit: "%",   trend: "up" as const },
  { name: "SA Unemployment",   value: 32.1,  prior: 33.5,  unit: "%",   trend: "down" as const },
  { name: "ZAR Reserves",      value: 64.2,  prior: 63.8,  unit: "USDbn", trend: "up" as const },
  { name: "US Fed Funds",      value: 4.50,  prior: 4.75,  unit: "%",   trend: "down" as const },
  { name: "US CPI YoY",        value: 2.6,   prior: 2.6,   unit: "%",   trend: "flat" as const },
  { name: "Brent Crude",       value: 78.12, prior: 78.57, unit: "USD/bbl", trend: "down" as const },
];

// ---------------------------------------------------------------------------
// Synthetic intraday series for sparklines / charts
// ---------------------------------------------------------------------------
export const generateIntraday = (base: number, points = 60, vol = 0.002) => {
  let p = base;
  return Array.from({ length: points }, (_, i) => {
    p = p * (1 + (Math.random() - 0.5) * vol);
    const t = new Date();
    t.setMinutes(t.getMinutes() - (points - i));
    return { t: t.toLocaleTimeString("en-ZA", { hour: "2-digit", minute: "2-digit" }), v: +p.toFixed(2) };
  });
};

export const formatZAR = (n: number) =>
  n >= 1_000_000_000 ? `R${(n / 1_000_000_000).toFixed(2)}bn` :
  n >= 1_000_000     ? `R${(n / 1_000_000).toFixed(1)}m` :
  n >= 1_000         ? `R${(n / 1_000).toFixed(0)}k` :
  `R${n.toFixed(2)}`;

export const formatPct = (n: number, dp = 2) => `${n >= 0 ? "+" : ""}${n.toFixed(dp)}%`;

// ---------------------------------------------------------------------------
// IRIS INTEGRATION MAP — single source of truth for engineering
// ---------------------------------------------------------------------------
export const IRIS_INTEGRATION_MAP = [
  { surface: "Market Watch — Equities table",        endpoint: "GET /v1/securities/quotes?exchange=JSE&symbols=NPN,PRX,FSR,...", refresh: "1s (WebSocket) or 5s REST", auth: "Bearer + X-Iris-Tenant", notes: "Use streaming WS /stream/quotes for sub-second; fall back to REST poll on disconnect." },
  { surface: "Global Indices strip",                  endpoint: "GET /v1/indices?codes=J203,J200,SPX,NDX,UKX,DAX,N225,HSI",     refresh: "5s",                       auth: "Bearer",                  notes: "Cache 5s; indices update on exchange tick." },
  { surface: "FX & Commodities ticker",               endpoint: "GET /v1/fx?pairs=USD/ZAR,...  &  GET /v1/commodities?ids=XAU,BRENT,XPT,Cu,Fe", refresh: "2s", auth: "Bearer", notes: "FX 24/5; commodities follow CME/ICE sessions." },
  { surface: "Money Market — JIBAR fixings",         endpoint: "GET /v1/rates/jibar  (daily 11:00 SAST fixing)",              refresh: "Daily 11:05",              auth: "Bearer",                  notes: "Source of truth: SARB. IRIS mirrors within 60s of fixing." },
  { surface: "Money Market — Yield curve",           endpoint: "GET /v1/yieldcurve/zar?source=bestaa",                         refresh: "15min",                    auth: "Bearer",                  notes: "Nelson-Siegel-Svensson fit available via ?model=nss." },
  { surface: "Money Market — Instrument reference",  endpoint: "GET /v1/securities/{isin}  +  /v1/securities/{isin}/cashflows", refresh: "On demand",                auth: "Bearer",                  notes: "Use ISIN for NCDs / T-bills; RIC for repos." },
  { surface: "News flow",                             endpoint: "GET /v1/news?sources=reuters,sens,moneyweb,bloomberg&since=…", refresh: "WebSocket /stream/news",   auth: "Bearer + entitlement check", notes: "SENS is JSE regulated; surface with 'REGULATORY' badge." },
  { surface: "Macro calendar",                        endpoint: "GET /v1/macro/calendar?countries=ZA,US,EU,UK&from=…&to=…",    refresh: "1h",                       auth: "Bearer",                  notes: "Importance flag drives row colour; consensus = mean of contributors." },
  { surface: "Macro indicators tiles",                endpoint: "GET /v1/macro/series?ids=ZACPI,ZAREPO,ZAGDP,...",             refresh: "On release",               auth: "Bearer",                  notes: "Subscribe to /stream/macro for push updates as releases hit." },
  { surface: "Strategy intraday P&L",                 endpoint: "INTERNAL: positions × IRIS quotes (mark-to-market)",          refresh: "5s",                       auth: "Internal",                notes: "Multiply qty × IRIS last; cash leg from internal ledger." },
  { surface: "Rebalance pre-trade compliance",        endpoint: "INTERNAL + IRIS borrow/short flags via /v1/securities/{id}/flags", refresh: "On rebalance click",   auth: "Bearer",                  notes: "Block rebalance if any holding flagged HALTED, SUSPENDED, or NON-TRADEABLE." },
  { surface: "Corporate actions overlay",             endpoint: "GET /v1/corporateactions?symbols=…&from=…",                   refresh: "Daily 06:00 + intraday",   auth: "Bearer",                  notes: "Adjust positions for splits/dividends before P&L calc." },
];
