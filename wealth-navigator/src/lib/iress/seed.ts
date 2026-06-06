// Deterministic seed data for the IRESS V4 mock adapter.
// Every fixture here is tagged with the V4 method (or sub-table) it would
// come from in production. The point: when we flip IRESS_MODE=live, the
// shapes are stable.

import type {
  Bond,
  Holding,
  Instrument,
  MacroIndicator,
  MacroRelease,
  MoneyMarketInstrument,
  NewsItem,
  Order,
  Quote,
  SensItem,
  Strategy,
} from "@/types/iress";

// Deterministic PRNG so ticks look real but SSR matches CSR.
function mulberry32(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rng = mulberry32(87412);

// ─── Instruments (IRESS ref-data feed) ──────────────────────────────────

export const jseEquities: Instrument[] = [
  { symbol: "NPN", isin: "ZAE000015889", ric: "NPNJ.J", name: "Naspers", exchange: "JSE", sector: "Technology", currency: "ZAR", assetClass: "equity" },
  { symbol: "PRX", isin: "NL0013654783", ric: "PRX.J", name: "Prosus", exchange: "JSE", sector: "Technology", currency: "ZAR", assetClass: "equity" },
  { symbol: "FSR", isin: "ZAE000066304", ric: "FSRJ.J", name: "FirstRand", exchange: "JSE", sector: "Banks", currency: "ZAR", assetClass: "equity" },
  { symbol: "SBK", isin: "ZAE000109815", ric: "SBKJ.J", name: "Standard Bank", exchange: "JSE", sector: "Banks", currency: "ZAR", assetClass: "equity" },
  { symbol: "AGL", isin: "GB00B1XZS820", ric: "AGLJ.J", name: "Anglo American", exchange: "JSE", sector: "Mining", currency: "ZAR", assetClass: "equity" },
  { symbol: "BHG", isin: "GB00BH0P3Z91", ric: "BHGJ.J", name: "BHP Group", exchange: "JSE", sector: "Mining", currency: "ZAR", assetClass: "equity" },
  { symbol: "MTN", isin: "ZAE000042164", ric: "MTNJ.J", name: "MTN Group", exchange: "JSE", sector: "Telco", currency: "ZAR", assetClass: "equity" },
  { symbol: "SOL", isin: "ZAE000006896", ric: "SOLJ.J", name: "Sasol", exchange: "JSE", sector: "Energy", currency: "ZAR", assetClass: "equity" },
  { symbol: "SHP", isin: "ZAE000012084", ric: "SHPJ.J", name: "Shoprite", exchange: "JSE", sector: "Retail", currency: "ZAR", assetClass: "equity" },
  { symbol: "CPI", isin: "ZAE000064676", ric: "CPIJ.J", name: "Capitec", exchange: "JSE", sector: "Banks", currency: "ZAR", assetClass: "equity" },
  { symbol: "MSFT", isin: "US5949181045", ric: "MSFT.OQ", name: "Microsoft", exchange: "NASDAQ", sector: "Tech", currency: "USD", assetClass: "equity" },
  { symbol: "AAPL", isin: "US0378331005", ric: "AAPL.OQ", name: "Apple Inc.", exchange: "NASDAQ", sector: "Tech", currency: "USD", assetClass: "equity" },
  { symbol: "GFI", isin: "ZAE000018123", ric: "GFIJ.J", name: "Gold Fields", exchange: "JSE", sector: "Mining", currency: "ZAR", assetClass: "equity" },
];

// ─── JSE sector heatmap (J200 / sector indices) ─────────────────────────

export interface SectorPerf {
  sector: string;
  weight: number;
  change: number; // % day
}

export const sectorHeatmap: SectorPerf[] = [
  { sector: "Tech", weight: 28.4, change: 1.62 },
  { sector: "Banks", weight: 21.2, change: -0.34 },
  { sector: "Mining", weight: 14.1, change: 2.18 },
  { sector: "Retail", weight: 8.4, change: 0.72 },
  { sector: "Telco", weight: 6.8, change: -1.05 },
  { sector: "Energy", weight: 5.1, change: 1.84 },
  { sector: "Industrials", weight: 4.2, change: 0.21 },
  { sector: "Healthcare", weight: 3.8, change: -0.42 },
  { sector: "Consumer", weight: 3.4, change: 0.95 },
  { sector: "Property", weight: 2.1, change: -0.62 },
  { sector: "Media", weight: 1.2, change: 1.45 },
  { sector: "Other", weight: 1.3, change: 0.18 },
];

// ─── Global indices (IRIS /v1/indices) ──────────────────────────────────

export interface IndexQuote {
  code: string;
  name: string;
  last: number;
  change: number;
  changePct: number;
  region: "ZA" | "US" | "UK" | "DE" | "JP" | "HK" | "CN";
  prevClose: number;
}

export const globalIndices: IndexQuote[] = [
  { code: "J203", name: "JSE All Share", last: 87412.18, change: 421.3, changePct: 0.48, region: "ZA", prevClose: 86990.88 },
  { code: "J200", name: "FTSE/JSE Top 40", last: 80115.4, change: 388.1, changePct: 0.49, region: "ZA", prevClose: 79727.3 },
  { code: "J257", name: "SA Financials 15", last: 18245.62, change: -54.12, changePct: -0.3, region: "ZA", prevClose: 18299.74 },
  { code: "J433", name: "SA Resources 10", last: 64220.15, change: 812.4, changePct: 1.28, region: "ZA", prevClose: 63407.75 },
  { code: "SPX", name: "S&P 500", last: 5812.45, change: 24.18, changePct: 0.42, region: "US", prevClose: 5788.27 },
  { code: "NDX", name: "Nasdaq 100", last: 20445.2, change: 142.55, changePct: 0.7, region: "US", prevClose: 20302.65 },
  { code: "DJI", name: "Dow Jones", last: 42118.3, change: -38.2, changePct: -0.09, region: "US", prevClose: 42156.5 },
  { code: "UKX", name: "FTSE 100", last: 8245.18, change: 12.4, changePct: 0.15, region: "UK", prevClose: 8232.78 },
  { code: "DAX", name: "DAX 40", last: 19512.4, change: 88.1, changePct: 0.45, region: "DE", prevClose: 19424.3 },
  { code: "N225", name: "Nikkei 225", last: 38924.55, change: -212.3, changePct: -0.54, region: "JP", prevClose: 39136.85 },
  { code: "HSI", name: "Hang Seng", last: 19842.18, change: 312.4, changePct: 1.6, region: "HK", prevClose: 19529.78 },
];

// ─── FX & commodities (IRIS /v1/fx, /v1/commodities) ────────────────────

export interface FxQuote {
  pair: string;
  last: number;
  change: number;
  changePct: number;
}

export const fxQuotes: FxQuote[] = [
  { pair: "USD/ZAR", last: 18.452, change: -0.042, changePct: -0.23 },
  { pair: "EUR/ZAR", last: 19.881, change: 0.021, changePct: 0.11 },
  { pair: "GBP/ZAR", last: 23.418, change: 0.054, changePct: 0.23 },
  { pair: "EUR/USD", last: 1.0775, change: 0.0035, changePct: 0.33 },
  { pair: "USD/JPY", last: 152.4, change: -0.42, changePct: -0.27 },
  { pair: "AUD/USD", last: 0.6612, change: 0.0028, changePct: 0.42 },
];

export interface CommodityQuote {
  name: string;
  unit: string;
  last: number;
  change: number;
  changePct: number;
}

export const commodityQuotes: CommodityQuote[] = [
  { name: "Gold", unit: "USD/oz", last: 2682.4, change: 18.3, changePct: 0.69 },
  { name: "Brent", unit: "USD/bbl", last: 78.12, change: -0.45, changePct: -0.57 },
  { name: "Platinum", unit: "USD/oz", last: 992.55, change: 8.4, changePct: 0.85 },
  { name: "Iron Ore", unit: "USD/t", last: 102.4, change: 1.2, changePct: 1.18 },
  { name: "Copper", unit: "USD/t", last: 9245.5, change: 42.1, changePct: 0.46 },
];

// ─── Sovereign bonds (IRIS /v1/bonds) ───────────────────────────────────

export const bonds: Bond[] = [
  { isin: "ZAG000077876", issuer: "RSA Govt", name: "R2030 8.00%", coupon: 8.0, maturity: "2030-01-31", ytm: 10.42, clean: 92.18, dirty: 93.04, modDur: 4.21, dv01: 421, convexity: 22.4, rating: "BB", spread: 0, liquidity: "deep" },
  { isin: "ZAG000085236", issuer: "RSA Govt", name: "R2035 8.875%", coupon: 8.875, maturity: "2035-02-28", ytm: 11.42, clean: 88.05, dirty: 89.4, modDur: 6.84, dv01: 684, convexity: 56.1, rating: "BB", spread: 0, liquidity: "deep" },
  { isin: "ZAG000090152", issuer: "RSA Govt", name: "R2040 9.00%", coupon: 9.0, maturity: "2040-01-31", ytm: 12.05, clean: 81.42, dirty: 82.8, modDur: 8.12, dv01: 812, convexity: 78.2, rating: "BB", spread: 0, liquidity: "deep" },
  { isin: "ZAG000098478", issuer: "RSA Govt", name: "R2044 8.75%", coupon: 8.75, maturity: "2044-02-29", ytm: 12.38, clean: 78.16, dirty: 79.5, modDur: 9.04, dv01: 904, convexity: 102.4, rating: "BB", spread: 0, liquidity: "medium" },
  { isin: "ZAG000107220", issuer: "RSA Govt", name: "R2048 8.75%", coupon: 8.75, maturity: "2048-02-28", ytm: 12.51, clean: 76.83, dirty: 78.1, modDur: 9.78, dv01: 978, convexity: 122.8, rating: "BB", spread: 0, liquidity: "medium" },
  { isin: "ZAG000114820", issuer: "Eskom", name: "Eskom 8.50% 2028", coupon: 8.5, maturity: "2028-04-30", ytm: 13.42, clean: 87.12, dirty: 87.95, modDur: 2.12, dv01: 212, convexity: 6.8, rating: "BB-", spread: 188, liquidity: "thin" },
  { isin: "ZAG000128945", issuer: "Transnet", name: "Transnet 9.25% 2031", coupon: 9.25, maturity: "2031-08-15", ytm: 13.85, clean: 84.32, dirty: 85.4, modDur: 4.84, dv01: 484, convexity: 28.4, rating: "BB-", spread: 232, liquidity: "thin" },
  { isin: "ZAG000135214", issuer: "FirstRand", name: "FirstRand 10.50% 2029", coupon: 10.5, maturity: "2029-06-30", ytm: 11.28, clean: 98.21, dirty: 99.05, modDur: 3.42, dv01: 342, convexity: 14.2, rating: "AA-", spread: 78, liquidity: "medium" },
];

// ─── Yield curve (IRIS /v1/yieldcurve/zar?model=nss) ────────────────────

export interface CurvePoint {
  tenor: string;
  tenorMonths: number;
  yield: number;
}

export const zarGoviCurve: CurvePoint[] = [
  { tenor: "1M",  tenorMonths: 1,    yield: 7.83 },
  { tenor: "3M",  tenorMonths: 3,    yield: 8.11 },
  { tenor: "6M",  tenorMonths: 6,    yield: 8.42 },
  { tenor: "1Y",  tenorMonths: 12,   yield: 8.84 },
  { tenor: "2Y",  tenorMonths: 24,   yield: 9.21 },
  { tenor: "3Y",  tenorMonths: 36,   yield: 9.62 },
  { tenor: "5Y",  tenorMonths: 60,   yield: 10.18 },
  { tenor: "7Y",  tenorMonths: 84,   yield: 10.74 },
  { tenor: "10Y", tenorMonths: 120,  yield: 11.42 },
  { tenor: "15Y", tenorMonths: 180,  yield: 12.05 },
  { tenor: "20Y", tenorMonths: 240,  yield: 12.38 },
  { tenor: "25Y", tenorMonths: 300,  yield: 12.51 },
];

export const zarSwapCurve: CurvePoint[] = [
  { tenor: "1M",  tenorMonths: 1,    yield: 7.78 },
  { tenor: "3M",  tenorMonths: 3,    yield: 8.05 },
  { tenor: "6M",  tenorMonths: 6,    yield: 8.32 },
  { tenor: "1Y",  tenorMonths: 12,   yield: 8.68 },
  { tenor: "2Y",  tenorMonths: 24,   yield: 9.02 },
  { tenor: "3Y",  tenorMonths: 36,   yield: 9.45 },
  { tenor: "5Y",  tenorMonths: 60,   yield: 10.0 },
  { tenor: "7Y",  tenorMonths: 84,   yield: 10.55 },
  { tenor: "10Y", tenorMonths: 120,  yield: 11.18 },
  { tenor: "15Y", tenorMonths: 180,  yield: 11.78 },
  { tenor: "20Y", tenorMonths: 240,  yield: 12.1 },
  { tenor: "25Y", tenorMonths: 300,  yield: 12.22 },
];

export const zarRealCurve: CurvePoint[] = [
  { tenor: "1Y",  tenorMonths: 12,   yield: 4.92 },
  { tenor: "3Y",  tenorMonths: 36,   yield: 5.18 },
  { tenor: "5Y",  tenorMonths: 60,   yield: 5.62 },
  { tenor: "7Y",  tenorMonths: 84,   yield: 6.04 },
  { tenor: "10Y", tenorMonths: 120,  yield: 6.45 },
  { tenor: "15Y", tenorMonths: 180,  yield: 6.78 },
  { tenor: "20Y",  tenorMonths: 240, yield: 6.92 },
  { tenor: "25Y",  tenorMonths: 300, yield: 7.05 },
];

// ─── Breakeven (Govi - Real) ────────────────────────────────────────────

export interface BreakevenPoint {
  tenor: string;
  tenorMonths: number;
  breakeven: number;
}

export const zarBreakeven: BreakevenPoint[] = zarGoviCurve.map((g, i) => {
  const r = zarRealCurve[i];
  return {
    tenor: g.tenor,
    tenorMonths: g.tenorMonths,
    breakeven: r ? +(g.yield - r.yield).toFixed(2) : g.yield - 5,
  };
});

// ─── Money market (IRIS /v1/rates/jibar, /v1/securities money-market) ────

export const jibarFixings = [
  { tenor: "O/N",  rate: 7.5,  prev: 7.5,   change: 0.0 },
  { tenor: "1M",   rate: 7.83, prev: 7.85,  change: -0.02 },
  { tenor: "3M",   rate: 8.11, prev: 8.14,  change: -0.03 },
  { tenor: "6M",   rate: 8.42, prev: 8.4,   change: 0.02 },
  { tenor: "9M",   rate: 8.61, prev: 8.59,  change: 0.02 },
  { tenor: "12M",  rate: 8.84, prev: 8.81,  change: 0.03 },
];

export const zaronia = { value: 7.48, prev: 7.5, change: -0.02 };

export const mmInstruments: MoneyMarketInstrument[] = [
  { ticker: "SARB-TB91",   name: "RSA T-Bill 91d",            type: "TB",         issuer: "National Treasury", tenor: "91d",  yield: 8.12, duration: 0.25, rating: "BB",  notional: 250_000_000, maturity: "2026-02-28" },
  { ticker: "SARB-TB182",  name: "RSA T-Bill 182d",           type: "TB",         issuer: "National Treasury", tenor: "182d", yield: 8.34, duration: 0.5,  rating: "BB",  notional: 180_000_000, maturity: "2026-05-29" },
  { ticker: "SARB-TB364",  name: "RSA T-Bill 364d",           type: "TB",         issuer: "National Treasury", tenor: "364d", yield: 8.58, duration: 1.0,  rating: "BB",  notional: 320_000_000, maturity: "2026-11-29" },
  { ticker: "FSR-NCD90",   name: "FirstRand NCD 90d",         type: "NCD",        issuer: "FirstRand Bank",    tenor: "90d",  yield: 8.45, duration: 0.25, rating: "AA+", notional: 120_000_000, maturity: "2026-02-27" },
  { ticker: "SBK-NCD180",  name: "Standard Bank NCD 180d",    type: "NCD",        issuer: "Standard Bank",     tenor: "180d", yield: 8.62, duration: 0.5,  rating: "AA+", notional: 200_000_000, maturity: "2026-05-29" },
  { ticker: "NED-NCD365",  name: "Nedbank NCD 365d",          type: "NCD",        issuer: "Nedbank",           tenor: "365d", yield: 8.88, duration: 1.0,  rating: "AA",  notional: 150_000_000, maturity: "2026-11-29" },
  { ticker: "ABSA-FRN3Y",  name: "Absa Floating Rate Note 3y", type: "FRN",      issuer: "Absa",              tenor: "3y",   yield: 9.15, duration: 2.85, rating: "AA",  notional: 90_000_000,  maturity: "2028-11-29" },
  { ticker: "ESKM-CP12",   name: "Eskom CP 12m (Gov Gtd)",    type: "Corp Paper", issuer: "Eskom",             tenor: "12m",  yield: 9.42, duration: 1.0,  rating: "BB-", notional: 75_000_000,  maturity: "2026-11-29" },
  { ticker: "REPO-7D",     name: "SARB Repo 7d",              type: "Repo",       issuer: "SARB",              tenor: "7d",   yield: 7.75, duration: 0.02, rating: "BB",  notional: 500_000_000, maturity: "2025-12-08" },
  { ticker: "CALL-OD",     name: "Call Deposit (Overnight)",  type: "Call",       issuer: "ABSA Treasury",     tenor: "O/N",  yield: 7.5,  duration: 0.003, rating: "AA+", notional: 80_000_000,  maturity: "2025-12-01" },
];

// ─── Macro (IRIS /v1/macro/series, /v1/macro/calendar) ───────────────────

export const macroIndicators: MacroIndicator[] = [
  { name: "SA CPI YoY",      value: 3.8,  prior: 3.9,  unit: "%",      trend: "down" },
  { name: "SA Repo Rate",    value: 7.75, prior: 8.0,  unit: "%",      trend: "down" },
  { name: "SA GDP YoY",      value: 0.6,  prior: 0.4,  unit: "%",      trend: "up" },
  { name: "SA Unemployment", value: 32.1, prior: 33.5, unit: "%",      trend: "down" },
  { name: "SA Reserves",     value: 64.2, prior: 63.8, unit: "USDbn",  trend: "up" },
  { name: "US Fed Funds",    value: 4.5,  prior: 4.75, unit: "%",      trend: "down" },
  { name: "US CPI YoY",      value: 2.6,  prior: 2.6,  unit: "%",      trend: "flat" },
  { name: "Brent",           value: 78.12, prior: 78.57, unit: "USD/bbl", trend: "down" },
];

export const macroCalendar: MacroRelease[] = [
  { id: "m1", date: "2025-12-02", time: "10:00", country: "ZA", indicator: "ABSA Manufacturing PMI", period: "Nov", forecast: "51.2", previous: "50.6", importance: "med" },
  { id: "m2", date: "2025-12-03", time: "11:30", country: "ZA", indicator: "GDP QoQ", period: "Q3", forecast: "0.4%", previous: "-0.1%", importance: "high" },
  { id: "m3", date: "2025-12-04", time: "08:00", country: "ZA", indicator: "Current Account", period: "Q3", forecast: "-1.8%", previous: "-1.2%", importance: "med" },
  { id: "m4", date: "2025-12-05", time: "11:00", country: "ZA", indicator: "SARB Quarterly Bulletin", period: "Q3", forecast: "-", previous: "-", importance: "low" },
  { id: "m5", date: "2025-12-06", time: "15:30", country: "US", indicator: "Non-Farm Payrolls", period: "Nov", forecast: "+182k", previous: "+12k", importance: "high" },
  { id: "m6", date: "2025-12-10", time: "10:00", country: "ZA", indicator: "Mining Production YoY", period: "Oct", forecast: "1.2%", previous: "-0.5%", importance: "med" },
  { id: "m7", date: "2025-12-11", time: "15:30", country: "US", indicator: "CPI YoY", period: "Nov", forecast: "2.6%", previous: "2.6%", importance: "high" },
  { id: "m8", date: "2025-12-18", time: "15:00", country: "ZA", indicator: "SARB MPC Rate Decision", period: "Dec", forecast: "7.50%", previous: "7.75%", importance: "high" },
];

/**
 * Enriched view of the macro calendar for the dashboard — adds
 * `name`/`source`/`ts`/`consensus`/`tags` so the macro page can render
 * it without juggling field names from the V4 spec.
 */
export interface MacroReleaseView {
  id: string;
  ts: number;
  date: string;
  time: string;
  name: string;
  source: string;
  country: "ZA" | "US" | "EU" | "UK" | "JP" | "CN";
  period: string;
  consensus: string;
  prior: string;
  importance: "high" | "medium" | "low";
  tags: string[];
}

const SOURCE_BY_INDICATOR: Record<string, string> = {
  "ABSA Manufacturing PMI": "ABSA / BER",
  "GDP QoQ": "StatsSA",
  "Current Account": "SARB",
  "SARB Quarterly Bulletin": "SARB",
  "Non-Farm Payrolls": "BLS",
  "Mining Production YoY": "StatsSA",
  "CPI YoY": "BLS",
  "SARB MPC Rate Decision": "SARB MPC",
};

export const macroReleases: MacroReleaseView[] = macroCalendar.map((r) => {
  const [y, m, d] = r.date.split("-").map(Number);
  const [hh, mm] = r.time.split(":").map(Number);
  const date = new Date(y ?? 2025, (m ?? 1) - 1, d ?? 1, hh ?? 0, mm ?? 0);
  const importance: MacroReleaseView["importance"] =
    r.importance === "high" ? "high" : r.importance === "med" ? "medium" : "low";
  return {
    id: r.id,
    ts: date.getTime(),
    date: r.date,
    time: r.time,
    name: r.indicator,
    source: SOURCE_BY_INDICATOR[r.indicator] ?? "—",
    country: r.country,
    period: r.period,
    consensus: r.forecast,
    prior: r.previous,
    importance,
    tags: r.country === "ZA" ? ["ZA", "local"] : ["G10", "global"],
  };
});

// ─── Strategies (internal, not V4) ─────────────────────────────────────

export const oemsStrategies: Strategy[] = [
  { id: "eq-001", name: "MINT SA Equity Alpha",     kind: "equity", manager: "Andile Khumalo", managerId: "st1", aum: 482_000_000, ytd: 18.42, dayPnl: 2_140_000, sharpe: 1.42, maxDD: -8.2,  benchmark: "JSE Top 40",       benchmarkYtd: 14.2, investorCount: 38, holdingsCount: 42, cashWeight: 3.2, status: "live",  lastRebalanced: "2025-11-24", trackingError: 4.2 },
  { id: "eq-002", name: "MINT Global Quality",      kind: "equity", manager: "Sipho Dlamini",  managerId: "st2", aum: 318_000_000, ytd: 22.18, dayPnl: 1_840_000, sharpe: 1.61, maxDD: -6.4,  benchmark: "MSCI ACWI",        benchmarkYtd: 19.8, investorCount: 24, holdingsCount: 55, cashWeight: 2.1, status: "live",  lastRebalanced: "2025-11-26", trackingError: 3.1 },
  { id: "eq-003", name: "MINT Resources Tilt",      kind: "equity", manager: "Andile Khumalo", managerId: "st1", aum: 142_000_000, ytd: 12.85, dayPnl: -420_000,  sharpe: 0.94, maxDD: -14.3, benchmark: "JSE Resources 10", benchmarkYtd: 9.4,  investorCount: 12, holdingsCount: 18, cashWeight: 4.8, status: "live",  lastRebalanced: "2025-11-20", trackingError: 6.8 },
  { id: "eq-004", name: "MINT Smart Beta Low Vol",  kind: "equity", manager: "Andile Khumalo", managerId: "st1", aum: 0,           ytd: 11.4,  dayPnl: 0,         sharpe: 1.18, maxDD: -5.1,  benchmark: "JSE Top 40",       benchmarkYtd: 14.2, investorCount: 0,  holdingsCount: 35, cashWeight: 1.5, status: "paper", lastRebalanced: "2025-11-15", trackingError: 5.2 },
  { id: "mm-001", name: "MINT Institutional Money Market", kind: "money_market", manager: "Nomvula Sithole", managerId: "st4", aum: 850_000_000, ytd: 8.62, dayPnl: 190_000, sharpe: 3.21, maxDD: -0.12, benchmark: "STeFI Composite", benchmarkYtd: 8.41, investorCount: 1, holdingsCount: 14, cashWeight: 12.4, status: "live",  lastRebalanced: "2025-11-28", weightedAvgYield: 8.74, weightedAvgDuration: 0.42 },
  { id: "mm-002", name: "MINT Enhanced Yield",            kind: "money_market", manager: "Nomvula Sithole", managerId: "st4", aum: 0,           ytd: 9.04, dayPnl: 0,      sharpe: 2.85, maxDD: -0.31, benchmark: "STeFI Plus 1%",   benchmarkYtd: 9.41, investorCount: 0, holdingsCount: 22, cashWeight: 8.2,  status: "paper", lastRebalanced: "2025-11-25", weightedAvgYield: 9.18, weightedAvgDuration: 0.85 },
];

export const strategyHoldings: Record<string, Holding[]> = {
  "eq-001": [
    { symbol: "NPN",  name: "Naspers",        qty: 12_400, mv: 51_838_820, target: 10.5, actual: 10.75, sector: "Tech" },
    { symbol: "PRX",  name: "Prosus",         qty: 28_200, mv: 64_721_820, target: 13.0, actual: 13.42, sector: "Tech" },
    { symbol: "FSR",  name: "FirstRand",      qty: 540_000, mv: 42_346_800, target: 9.0,  actual: 8.78,  sector: "Banks" },
    { symbol: "SBK",  name: "Standard Bank",  qty: 180_000, mv: 40_815_000, target: 8.5,  actual: 8.46,  sector: "Banks" },
    { symbol: "AGL",  name: "Anglo American", qty: 60_000,  mv: 33_126_000, target: 7.0,  actual: 6.87,  sector: "Mining" },
    { symbol: "MTN",  name: "MTN Group",      qty: 320_000, mv: 34_768_000, target: 7.0,  actual: 7.21,  sector: "Telco" },
    { symbol: "SOL",  name: "Sasol",          qty: 200_000, mv: 32_560_000, target: 6.5,  actual: 6.75,  sector: "Energy" },
    { symbol: "SHP",  name: "Shoprite",       qty: 110_000, mv: 30_943_000, target: 6.5,  actual: 6.42,  sector: "Retail" },
    { symbol: "CPI",  name: "Capitec",        qty: 11_000,  mv: 31_242_750, target: 6.5,  actual: 6.48,  sector: "Banks" },
  ],
  "eq-002": [
    { symbol: "MSFT", name: "Microsoft", qty: 18_500, mv: 8_191_430,   target: 14, actual: 14.2, sector: "Tech" },
    { symbol: "AAPL", name: "Apple",     qty: 35_000, mv: 8_099_000,   target: 13, actual: 12.8, sector: "Tech" },
  ],
  "mm-001": mmInstruments.slice(0, 8).map((m, i) => ({
    symbol: m.ticker, name: m.name, qty: 0, mv: m.notional,
    target: +(12.5 - i * 1.4).toFixed(2), actual: +(12.5 - i * 1.4 + (i % 2 ? 0.3 : -0.3)).toFixed(2),
    sector: m.type,
  })),
};

// ─── Orders (IRIS /v1/orders, /v1/executions) ───────────────────────────

export const orders: Order[] = [
  { id: "ORD-44218", account: "MINT-LIVE-001", strategy: "SA Equity Alpha",  side: "BUY",  symbol: "NPN",  isin: "ZAE000015889", type: "LMT", tif: "DAY", destination: "JSE",    qty: 12_000,   filled: 8_400,         limit: 4180,    stop: null, avgPx: 4179.2,  vwap: 4179.2,  trader: "akhumalo", ts: hoursAgoMs(0.3), state: "PARTIAL",  slippageBps: -2.1, arrivalMid: 4180.55, orderTag: "mint-ord-c1f2e0" },
  { id: "ORD-44219", account: "MINT-LIVE-001", strategy: "Resources Tilt",   side: "SELL", symbol: "AGL",  isin: "GB00B1XZS820", type: "LMT", tif: "DAY", destination: "JSE",    qty: 6_500,    filled: 6_500,         limit: 552,     stop: null, avgPx: 552.08,   vwap: 552.08,  trader: "akhumalo", ts: hoursAgoMs(0.5), state: "FILLED",   slippageBps:  0.4, arrivalMid: 552.1,  orderTag: "mint-ord-c1f2e1" },
  { id: "ORD-44220", account: "MINT-LIVE-001", strategy: "SA Equity Alpha",  side: "BUY",  symbol: "FSR",  isin: "ZAE000066304", type: "LMT", tif: "DAY", destination: "JSE",    qty: 45_000,   filled: 0,             limit: 78.35,   stop: null, avgPx: 0,        vwap: 78.5,    trader: "akhumalo", ts: hoursAgoMs(0.8), state: "WORKING",  slippageBps:  0,   arrivalMid: 78.42,  orderTag: "mint-ord-c1f2e2" },
  { id: "ORD-44221", account: "MINT-LIVE-002", strategy: "Global Quality",   side: "BUY",  symbol: "MSFT", isin: "US5949181045", type: "LMT", tif: "IOC", destination: "NASDAQ", qty: 1_200,    filled: 1_200,         limit: 442.5,   stop: null, avgPx: 442.4,    vwap: 442.4,   trader: "sdlamini", ts: hoursAgoMs(1.2), state: "FILLED",   slippageBps: -0.9, arrivalMid: 442.78, orderTag: "mint-ord-c1f2e3" },
  { id: "ORD-44222", account: "MINT-LIVE-001", strategy: "SA Equity Alpha",  side: "SELL", symbol: "SOL",  isin: "ZAE000006896", type: "LMT", tif: "DAY", destination: "JSE",    qty: 18_000,   filled: 12_000,        limit: 163,     stop: null, avgPx: 162.95,   vwap: 162.95,  trader: "akhumalo", ts: hoursAgoMs(1.5), state: "PARTIAL",  slippageBps: -1.2, arrivalMid: 162.8,  orderTag: "mint-ord-c1f2e4" },
  { id: "ORD-44223", account: "MINT-LIVE-001", strategy: "Resources Tilt",   side: "BUY",  symbol: "BHG",  isin: "GB00BH0P3Z91", type: "LMT", tif: "GTC", destination: "JSE",    qty: 8_000,    filled: 0,             limit: 528,     stop: null, avgPx: 0,        vwap: 528.3,   trader: "akhumalo", ts: hoursAgoMs(1.8), state: "WORKING",  slippageBps:  0,   arrivalMid: 528.4,  orderTag: "mint-ord-c1f2e5" },
  { id: "ORD-44224", account: "MINT-MM-001",   strategy: "Inst. MM",         side: "BUY",  symbol: "SARB-TB182", isin: "ZAG000182TB", type: "LMT", tif: "FOK", destination: "OTC", qty: 50_000_000, filled: 50_000_000,    limit: 8.34,    stop: null, avgPx: 8.34,     vwap: 8.34,    trader: "nsithole", ts: hoursAgoMs(2.0), state: "FILLED",   slippageBps:  0,   arrivalMid: 8.34,   orderTag: "mint-ord-c1f2e6" },
  { id: "ORD-44225", account: "MINT-MM-001",   strategy: "Inst. MM",         side: "BUY",  symbol: "FSR-NCD90",   isin: "ZAG000FSRNCD", type: "LMT", tif: "DAY", destination: "OTC", qty: 25_000_000, filled: 0,            limit: 8.45,    stop: null, avgPx: 0,        vwap: 8.45,   trader: "nsithole", ts: hoursAgoMs(2.3), state: "WORKING",  slippageBps:  0,   arrivalMid: 8.45,   orderTag: "mint-ord-c1f2e7" },
  { id: "ORD-44226", account: "MINT-LIVE-001", strategy: "SA Equity Alpha",  side: "BUY",  symbol: "CPI",  isin: "ZAE000064676", type: "LMT", tif: "DAY", destination: "JSE",    qty: 1_800,    filled: 0,             limit: 2835,    stop: null, avgPx: 0,        vwap: 2839.1,  trader: "akhumalo", ts: hoursAgoMs(2.5), state: "WORKING",  slippageBps:  0,   arrivalMid: 2840.25, orderTag: "mint-ord-c1f2e8" },
  { id: "ORD-44227", account: "MINT-LIVE-002", strategy: "Global Quality",   side: "SELL", symbol: "AAPL", isin: "US0378331005", type: "LMT", tif: "DAY", destination: "NASDAQ", qty: 950,      filled: 0,             limit: 232,     stop: null, avgPx: 0,        vwap: 231.75,  trader: "sdlamini", ts: hoursAgoMs(2.7), state: "REJECTED", rejectReason: "Buying power exceeded", slippageBps: 0, arrivalMid: 231.4, orderTag: "mint-ord-c1f2e9" },
  { id: "ORD-44228", account: "MINT-LIVE-001", strategy: "SA Equity Alpha",  side: "BUY",  symbol: "SBK",  isin: "ZAE000109815", type: "LMT", tif: "DAY", destination: "JSE",    qty: 9_500,    filled: 9_500,         limit: 226.8,   stop: null, avgPx: 226.78,   vwap: 226.78,  trader: "akhumalo", ts: hoursAgoMs(3.0), state: "FILLED",   slippageBps:  0.2, arrivalMid: 226.75, orderTag: "mint-ord-c1f2ea" },
  { id: "ORD-44229", account: "MINT-LIVE-001", strategy: "Resources Tilt",   side: "BUY",  symbol: "GFI",  isin: "ZAE000018123", type: "LMT", tif: "DAY", destination: "JSE",    qty: 11_000,   filled: 0,             limit: 412.5,   stop: null, avgPx: 0,        vwap: 413.8,   trader: "akhumalo", ts: hoursAgoMs(3.3), state: "CANCELLED", slippageBps:  0,   arrivalMid: 414.2,  orderTag: "mint-ord-c1f2eb" },
];

function hoursAgoMs(h: number) { return Date.now() - h * 3_600_000; }

// ─── News (IRIS /v1/news, SENS feed) ────────────────────────────────────

export const newsFeed: NewsItem[] = [
  { id: "n1",  ts: hoursAgoMs(0.1), headline: "SARB holds repo rate at 7.75%, signals data-dependent path into 2026", source: "Reuters",     tickers: ["J203", "USD/ZAR"], category: "rates",    priority: "high" },
  { id: "n2",  ts: hoursAgoMs(0.4), headline: "Naspers reports interim earnings beat on Tencent uplift, raises buyback", source: "SENS",        tickers: ["NPN", "PRX"],      category: "company",  priority: "high" },
  { id: "n3",  ts: hoursAgoMs(0.9), headline: "Anglo American formalises De Beers separation timeline for H2 2026",  source: "Bloomberg",  tickers: ["AGL"],                category: "company",  priority: "normal" },
  { id: "n4",  ts: hoursAgoMs(1.3), headline: "US PCE inflation prints 2.3% YoY, in line — DXY softens, gold to 2 680", source: "Dow Jones", tickers: ["SPX", "Gold"],       category: "macro",    priority: "high" },
  { id: "n5",  ts: hoursAgoMs(1.8), headline: "Treasury sells R3.9bn fixed bond auction at 11.42% (10y), bid-cover 2.8x", source: "Moneyweb", tickers: ["R2035", "JIBAR"],     category: "rates",    priority: "normal" },
  { id: "n6",  ts: hoursAgoMs(2.2), headline: "Eskom load-shedding suspended for 12th consecutive week", source: "Business Day", tickers: ["SOL", "ESKM"],        category: "politics", priority: "normal" },
  { id: "n7",  ts: hoursAgoMs(2.8), headline: "MTN Nigeria FX backlog cleared, repatriation resumes Q1 2026", source: "Reuters",    tickers: ["MTN"],                category: "company",  priority: "normal" },
  { id: "n8",  ts: hoursAgoMs(3.2), headline: "OPEC+ extends voluntary cuts into Q1 2026, Brent +0.6% intraday", source: "Bloomberg", tickers: ["Brent", "SOL"],        category: "commodity", priority: "normal" },
  { id: "n9",  ts: hoursAgoMs(3.6), headline: "JPY strengthens past 152 as BoJ Ueda flags Dec hike risk", source: "Dow Jones", tickers: ["USD/JPY", "N225"],   category: "fx",       priority: "normal" },
  { id: "n10", ts: hoursAgoMs(4.0), headline: "Capitec Q3 trading update: active clients +11.2% YoY", source: "SENS",            tickers: ["CPI"],                category: "company",  priority: "normal" },
];

export const sensFeed: SensItem[] = [
  { id: "s1", ts: hoursAgoMs(0.05), ticker: "NPN", issuer: "Naspers Ltd",     category: "RESULTS",    severity: "info",       headline: "Interim results: HEPS up 28% YoY to USD 1.42" },
  { id: "s2", ts: hoursAgoMs(0.15), ticker: "AGL", issuer: "Anglo American",  category: "CORP ACTION", severity: "regulatory", headline: "De Beers separation: scheme record date 2026-04-30" },
  { id: "s3", ts: hoursAgoMs(0.45), ticker: "SBK", issuer: "Standard Bank",   category: "DIVIDEND",   severity: "info",       headline: "Interim dividend of 750cps declared, LDR 1.5x" },
  { id: "s4", ts: hoursAgoMs(0.75), ticker: "FSR", issuer: "FirstRand",       category: "TRADING",    severity: "info",       headline: "Q1 trading update: advances +8.4%, NIM -3bp" },
  { id: "s5", ts: hoursAgoMs(1.20), ticker: "MTN", issuer: "MTN Group",       category: "CAUTIONARY", severity: "regulatory", headline: "Cautionary: Nigeria FX repatriation framework update" },
  { id: "s6", ts: hoursAgoMs(1.80), ticker: "SOL", issuer: "Sasol",           category: "DIRECTORATE", severity: "info",      headline: "Appointment of independent non-executive director" },
  { id: "s7", ts: hoursAgoMs(2.30), ticker: "BHG", issuer: "BHP Group",       category: "CORP ACTION", severity: "regulatory", headline: "Unbundling of BHP Foundation shares, ratio 1:25" },
  { id: "s8", ts: hoursAgoMs(3.10), ticker: "SHP", issuer: "Shoprite",        category: "TRADING",    severity: "info",       headline: "Black Friday week: sales +12% YoY in internal currency" },
];

// ─── Endpoint health (ops surface, not V4) ──────────────────────────────

export interface EndpointHealth {
  path: string;
  domain: "Market Data" | "Trading" | "Portfolio" | "Reference" | "FIX+" | "Streaming";
  status: "green" | "amber" | "red";
  p50: number;
  p95: number;
  msgsPerSec: number;
  lastSeq: number;
  lastError?: string;
}

export const endpointHealth: EndpointHealth[] = [
  { path: "IRESSSessionStart",           domain: "Reference",   status: "green", p50: 18,  p95: 42,  msgsPerSec: 0.2,    lastSeq: 12_412_004, lastError: undefined },
  { path: "PricingQuoteGet",             domain: "Market Data", status: "green", p50: 6,   p95: 14,  msgsPerSec: 142,    lastSeq: 12_412_004, lastError: undefined },
  { path: "PricingQuoteGetUpdates",      domain: "Streaming",   status: "green", p50: 4,   p95: 11,  msgsPerSec: 4_180,  lastSeq: 12_412_004, lastError: undefined },
  { path: "TimeSeriesGet2",              domain: "Market Data", status: "green", p50: 22,  p95: 48,  msgsPerSec: 8,      lastSeq: 12_411_987, lastError: undefined },
  { path: "TimeSeriesGet2Updates",       domain: "Streaming",   status: "amber", p50: 11,  p95: 92,  msgsPerSec: 410,    lastSeq: 12_411_902, lastError: "Reconnect 14:22 SAST · 25019" },
  { path: "OrderCreate3",                domain: "Trading",     status: "green", p50: 31,  p95: 78,  msgsPerSec: 2.4,    lastSeq: 12_412_001, lastError: undefined },
  { path: "OrderAmend2",                 domain: "Trading",     status: "green", p50: 28,  p95: 64,  msgsPerSec: 0.8,    lastSeq: 12_412_001, lastError: undefined },
  { path: "OrderDelete",                 domain: "Trading",     status: "green", p50: 24,  p95: 58,  msgsPerSec: 0.3,    lastSeq: 12_412_001, lastError: undefined },
  { path: "OrderPadGetByAccount",        domain: "Trading",     status: "green", p50: 38,  p95: 92,  msgsPerSec: 1.2,    lastSeq: 12_412_002, lastError: undefined },
  { path: "OrderPadGetByAccountUpdates", domain: "Streaming",   status: "green", p50: 6,   p95: 18,  msgsPerSec: 220,    lastSeq: 12_412_003, lastError: undefined },
  { path: "BookingGetByOrganisation2",   domain: "Trading",     status: "green", p50: 84,  p95: 192, msgsPerSec: 0.1,    lastSeq: 12_411_998, lastError: undefined },
  { path: "IPSTransactionGetByAccount5", domain: "Portfolio",   status: "amber", p50: 118, p95: 248, msgsPerSec: 0.4,    lastSeq: 12_411_980, lastError: "EOD batch 17:00 SAST" },
  { path: "TargetIDGet",                 domain: "FIX+",        status: "green", p50: 12,  p95: 28,  msgsPerSec: 0.05,   lastSeq: 12_412_004, lastError: undefined },
  { path: "TargetIDStatusGet",           domain: "FIX+",        status: "green", p50: 14,  p95: 32,  msgsPerSec: 0.6,    lastSeq: 12_412_004, lastError: undefined },
];

/**
 * UI view of an endpoint row — what the integration page renders.
 * Derived from the ops `EndpointHealth` so the dashboard doesn't have
 * to know about the green/amber/red enum (it wants ok/lag/warn/error).
 */
export interface EndpointHealthView {
  name: string;
  method: string;
  p50: number;
  p95: number;
  rps: number;
  errPct: number;
  status: "ok" | "lag" | "warn" | "error";
  lastCheck: number;
}

const HEALTH_TO_STATUS: Record<"green" | "amber" | "red", "ok" | "lag" | "warn" | "error"> = {
  green: "ok",
  amber: "lag",
  red:   "error",
};

export const endpoints: EndpointHealthView[] = endpointHealth.map((e) => {
  // Reconstruct the HTTP method. Sessions are GETs; the streaming ones
  // are long-polling POSTs; OrderCreate/Amend/Delete are POSTs.
  const isWrite = /Create|Amend|Delete/.test(e.path);
  const isStream = /Updates$/.test(e.path);
  const method = isStream ? "LPP" : isWrite ? "POST" : "GET";
  // errPct is 0 for green, ~0.4 for amber, ~1.8 for red (illustrative).
  const errPct = e.status === "green" ? 0.0 : e.status === "amber" ? 0.42 : 1.84;
  return {
    name: e.path,
    method,
    p50: e.p50,
    p95: e.p95,
    rps: e.msgsPerSec,
    errPct,
    status: HEALTH_TO_STATUS[e.status],
    lastCheck: Date.now() - Math.floor(Math.random() * 90_000),
  };
});

// ─── Persona fixtures (WM, Strategist, Admin, Business, FC) ─────────────

export type ClientMandate = "Discretionary" | "Advisory" | "Execution-only" | "Wealth Preservation" | "Retirement" | "Endowment";

export interface Client {
  id: string;
  name: string;
  mandate: ClientMandate;
  aum: number;
  mtd: number;     // month-to-date % perf
  ytd: number;     // year-to-date % perf
  riskProfile: "Cautious" | "Balanced" | "Growth" | "Aggressive";
  wealthManagerId: string;
  nextReviewDate: string; // ISO yyyy-mm-dd
}

export const clientsByWealthManager: Client[] = [
  { id: "c-001", name: "Mokoena household",  mandate: "Discretionary",      aum: 124_500_000, mtd:  1.42, ytd:  16.8, riskProfile: "Balanced",   wealthManagerId: "wm1", nextReviewDate: "2026-07-12" },
  { id: "c-002", name: "Khumalo trust",      mandate: "Advisory",           aum:  86_200_000, mtd:  0.84, ytd:  12.1, riskProfile: "Growth",     wealthManagerId: "wm1", nextReviewDate: "2026-06-22" },
  { id: "c-003", name: "Naidoo family",      mandate: "Wealth Preservation",aum:  62_400_000, mtd:  0.32, ytd:   7.4, riskProfile: "Cautious",   wealthManagerId: "wm1", nextReviewDate: "2026-09-04" },
  { id: "c-004", name: "Van Wyk endowment", mandate: "Endowment",          aum: 248_900_000, mtd:  1.18, ytd:  14.6, riskProfile: "Balanced",   wealthManagerId: "wm1", nextReviewDate: "2026-12-01" },
  { id: "c-005", name: "Pillay retirement",  mandate: "Retirement",         aum:  18_750_000, mtd:  0.21, ytd:   6.8, riskProfile: "Cautious",   wealthManagerId: "wm1", nextReviewDate: "2026-08-18" },
  { id: "c-006", name: "Dlamini holdings",   mandate: "Discretionary",      aum: 312_300_000, mtd:  1.62, ytd:  19.2, riskProfile: "Aggressive", wealthManagerId: "wm1", nextReviewDate: "2026-07-30" },
  { id: "c-007", name: "Maharaj family",     mandate: "Advisory",           aum:  44_800_000, mtd:  0.94, ytd:  11.0, riskProfile: "Balanced",   wealthManagerId: "wm1", nextReviewDate: "2026-06-15" },
  { id: "c-008", name: "Nkosi testamentary", mandate: "Wealth Preservation",aum:  97_600_000, mtd:  0.41, ytd:   8.2, riskProfile: "Cautious",   wealthManagerId: "wm1", nextReviewDate: "2026-10-22" },
  { id: "c-009", name: "Banda pension fund", mandate: "Retirement",         aum: 156_400_000, mtd:  0.74, ytd:   9.8, riskProfile: "Cautious",   wealthManagerId: "wm1", nextReviewDate: "2026-11-08" },
];

export interface PendingApproval {
  id: string;
  kind: "suitability" | "ip_rebalance" | "discretionary_override" | "mandate_signoff";
  title: string;
  client?: string;
  submittedBy: string;
  submittedAt: string;     // ISO
  status: "pending" | "escalated" | "auto_flagged";
  notes?: string;
}

export const pendingApprovals: PendingApproval[] = [
  { id: "ap-1", kind: "suitability",            title: "Suitability review — Mokoena household",     client: "Mokoena household", submittedBy: "James Mokoena",  submittedAt: "2026-06-05T08:42:00Z", status: "pending",       notes: "Risk profile change: Balanced → Growth" },
  { id: "ap-2", kind: "ip_rebalance",           title: "IP rebalance — Khumalo trust",              client: "Khumalo trust",     submittedBy: "Andile Khumalo", submittedAt: "2026-06-05T07:18:00Z", status: "pending",       notes: "Drift > 5% on SA Equity sleeve" },
  { id: "ap-3", kind: "discretionary_override", title: "Override: discretionary limit",             client: "Dlamini holdings",  submittedBy: "Sipho Dlamini",  submittedAt: "2026-06-05T06:55:00Z", status: "escalated",     notes: "Single ticket > 2% of mandate AUM" },
  { id: "ap-4", kind: "mandate_signoff",        title: "New mandate sign-off — Banda pension fund", client: "Banda pension fund", submittedBy: "Thabo Makgoba", submittedAt: "2026-06-04T16:30:00Z", status: "auto_flagged", notes: "Distribution permission not yet issued" },
];

export interface AuditEvent {
  id: string;
  ts: string;     // ISO
  actor: string;
  action: string;
  target?: string;
  notes?: string;
  tone: "info" | "warning" | "destructive" | "success";
}

export const auditTrail: AuditEvent[] = [
  { id: "au-1", ts: "2026-06-06T10:32:00Z", actor: "Lerato van der Merwe", action: "placed order",         target: "ORD-1234",            tone: "info" },
  { id: "au-2", ts: "2026-06-06T10:31:00Z", actor: "James Mokoena",        action: "viewed client",        target: "Mokoena household",   tone: "info" },
  { id: "au-3", ts: "2026-06-06T10:30:00Z", actor: "System",               action: "tick stream reconnect", target: "PricingQuoteGetUpdates", tone: "warning" },
  { id: "au-4", ts: "2026-06-06T10:25:00Z", actor: "Refilwe Ntsoane",      action: "approved mandate",     target: "Banda pension fund",  tone: "success" },
  { id: "au-5", ts: "2026-06-06T10:14:00Z", actor: "Andile Khumalo",       action: "amended rebalance",    target: "SA Equity Alpha",     tone: "info" },
  { id: "au-6", ts: "2026-06-06T10:02:00Z", actor: "Nomvula Sithole",      action: "rejected order",       target: "ORD-1229",            tone: "destructive", notes: "FICA expired on counterparty" },
  { id: "au-7", ts: "2026-06-06T09:55:00Z", actor: "System",               action: "CPD overdue",          target: "Lerato van der Merwe", tone: "warning", notes: "Annual CPD overdue by 12 days" },
];

export interface MandateTemplate {
  id: string;
  name: string;
  risk: "Cautious" | "Balanced" | "Growth" | "Aggressive";
  /** Target real return per annum, %. */
  targetReturn: number;
  /** Volatility, %. */
  volatility: number;
  /** Investment horizon in years. */
  horizonYears: number;
  equityWeight: number;
  bondWeight: number;
  cashWeight: number;
  altWeight: number;
  description: string;
}

export const mandateTemplates: MandateTemplate[] = [
  { id: "tpl-1", name: "Conservative Equity",     risk: "Cautious",   targetReturn:  7.5, volatility:  6.2, horizonYears: 3,  equityWeight: 30, bondWeight: 55, cashWeight: 12, altWeight:  3, description: "Capital preservation with a real return over the repo rate. Drawdown budget < 5%." },
  { id: "tpl-2", name: "Balanced",                risk: "Balanced",   targetReturn:  9.8, volatility:  9.4, horizonYears: 5,  equityWeight: 55, bondWeight: 30, cashWeight:  8, altWeight:  7, description: "Default multi-asset default for HNW households. Equity tilt with downside hedges." },
  { id: "tpl-3", name: "Growth Equity",           risk: "Growth",     targetReturn: 12.4, volatility: 14.1, horizonYears: 7,  equityWeight: 78, bondWeight: 12, cashWeight:  4, altWeight:  6, description: "SA + global equity core with thematic overlays (tech, resources, EM)." },
  { id: "tpl-4", name: "Money Market Enhanced",   risk: "Cautious",   targetReturn:  9.0, volatility:  0.6, horizonYears: 1,  equityWeight:  0, bondWeight:  0, cashWeight: 95, altWeight:  5, description: "Yield-enhanced cash for treasury management. NCD + TB + FRN blend, dur ≤ 1y." },
];

export interface Deal {
  id: string;
  client: string;
  value: number;
  stage: "Prospect" | "Discovery" | "Proposal" | "Mandate" | "KYC" | "Closed" | "Onboarding";
  owner: string;
  nextAction: string;
  probability: number;  // 0..100
}

export const deals: Deal[] = [
  { id: "d-1", client: "Retirement fund R 120M", value: 120_000_000, stage: "Proposal",   owner: "Thabo Makgoba",   nextAction: "Await trustee response",       probability: 65 },
  { id: "d-2", client: "Family trust R 35M",     value:  35_000_000, stage: "KYC",        owner: "Lerato van der Merwe", nextAction: "Collect FICA bundle",     probability: 80 },
  { id: "d-3", client: "Mining exec package",     value:  48_500_000, stage: "Discovery",  owner: "James Mokoena",    nextAction: "Book suitability interview",   probability: 35 },
  { id: "d-4", client: "Church endowment R 22M",  value:  22_000_000, stage: "Mandate",    owner: "Andile Khumalo",   nextAction: "Generate proposal PDF",        probability: 90 },
];

export interface ReconLeg {
  id: string;
  ts: number;
  account: string;
  side: "BUY" | "SELL";
  symbol: string;
  qty: number;
  notional: number;
  status: "PENDING_BOOKING" | "BOOKED" | "MISMATCH";
  source: "IPS" | "FILL" | "BOOKING";
}

export const reconLegs: ReconLeg[] = [
  { id: "rl-1", ts: hoursAgoMs(0.4), account: "MINT-LIVE-001", side: "BUY",  symbol: "NPN",  qty:  8_400, notional:  35_105_280, status: "PENDING_BOOKING", source: "FILL" },
  { id: "rl-2", ts: hoursAgoMs(0.7), account: "MINT-LIVE-001", side: "SELL", symbol: "AGL",  qty:  6_500, notional:   3_588_520, status: "PENDING_BOOKING", source: "FILL" },
  { id: "rl-3", ts: hoursAgoMs(1.1), account: "MINT-LIVE-001", side: "SELL", symbol: "SOL",  qty: 12_000, notional:   1_955_400, status: "PENDING_BOOKING", source: "FILL" },
  { id: "rl-4", ts: hoursAgoMs(1.6), account: "MINT-LIVE-002", side: "BUY",  symbol: "MSFT", qty:  1_200, notional:     530_880, status: "PENDING_BOOKING", source: "FILL" },
  { id: "rl-5", ts: hoursAgoMs(2.0), account: "MINT-LIVE-001", side: "BUY",  symbol: "SBK",  qty:  9_500, notional:   2_154_410, status: "PENDING_BOOKING", source: "FILL" },
  { id: "rl-6", ts: hoursAgoMs(2.4), account: "MINT-MM-001",   side: "BUY",  symbol: "SARB-TB182", qty: 50_000_000, notional: 4_170_000, status: "PENDING_BOOKING", source: "FILL" },
  { id: "rl-7", ts: hoursAgoMs(3.2), account: "MINT-LIVE-001", side: "SELL", symbol: "CPI",  qty:      0, notional:           0, status: "PENDING_BOOKING", source: "IPS" },
];

export interface CashPosition {
  id: string;
  account: string;
  currency: "ZAR" | "USD";
  current: number;
  target: number;
  drift: number; // current - target
}

export const cashPositions: CashPosition[] = [
  { id: "cp-1", account: "MINT-LIVE-001", currency: "ZAR", current:  18_400_000, target:  22_000_000, drift:  -3_600_000 },
  { id: "cp-2", account: "MINT-LIVE-002", currency: "USD", current:     482_000, target:     500_000, drift:     -18_000 },
  { id: "cp-3", account: "MINT-MM-001",   currency: "ZAR", current: 105_300_000, target:  95_000_000, drift:  10_300_000 },
  { id: "cp-4", account: "MINT-PENSION-7",currency: "ZAR", current:  42_800_000, target:  40_000_000, drift:   2_800_000 },
];

export interface ReconException {
  id: string;
  ts: string;        // ISO
  category: "open_leg" | "unmatched_cash" | "missing_fill" | "stale_quote";
  description: string;
  ref: string;       // order id or transaction id
  severity: "high" | "medium" | "low";
}

export const reconExceptions: ReconException[] = [
  { id: "ex-1", ts: "2026-06-06T09:12:00Z", category: "open_leg",        description: "CANCELLED order still has open working leg",          ref: "ORD-44205", severity: "high" },
  { id: "ex-2", ts: "2026-06-05T16:48:00Z", category: "unmatched_cash",   description: "CASH-USD leg from 2026-06-05 not matched against IPS", ref: "TX-USD-08", severity: "medium" },
];

// ─── Helpers ───────────────────────────────────────────────────────────

/** Find an instrument in the seed universe. */
export function findInstrument(symbol: string): Instrument | undefined {
  return jseEquities.find((i) => i.symbol === symbol);
}

/** Build the initial Quote for an instrument using its seed last + change fields. */
export function initialQuotes(): Record<string, Quote> {
  const out: Record<string, Quote> = {};
  // JSE equities
  for (const inst of jseEquities) {
    const seed = seedLastFor(inst.symbol);
    out[inst.symbol] = synthQuote(inst.symbol, inst, seed, seed * 0.9995, seed * 1.0005);
  }
  // Indices (use code as key)
  for (const idx of globalIndices) {
    out[idx.code] = {
      symbol: idx.code, last: idx.last,
      bid: idx.last, ask: idx.last,
      bidSize: 0, askSize: 0,
      open: idx.last - idx.change * 0.3, high: idx.last + Math.abs(idx.change) * 0.4, low: idx.last - Math.abs(idx.change) * 0.6, close: idx.last, prevClose: idx.prevClose,
      change: idx.change, changePct: idx.changePct,
      volume: 0, vwap: idx.last,
      currency: idx.region === "ZA" ? "ZAR" : "USD", marketState: "OPEN", ts: Date.now(),
    };
  }
  // FX
  for (const f of fxQuotes) {
    const k = f.pair.replace("/", "");
    out[k] = {
      symbol: k, last: f.last, bid: f.last - f.last * 0.0002, ask: f.last + f.last * 0.0002,
      bidSize: 0, askSize: 0, open: f.last - f.change, high: f.last + Math.abs(f.change), low: f.last - Math.abs(f.change),
      close: f.last, prevClose: f.last - f.change, change: f.change, changePct: f.changePct,
      volume: 0, vwap: f.last, currency: "ZAR", marketState: "OPEN", ts: Date.now(),
    };
  }
  // Commodities
  for (const c of commodityQuotes) {
    out[c.name] = {
      symbol: c.name, last: c.last, bid: c.last - 0.05, ask: c.last + 0.05,
      bidSize: 0, askSize: 0, open: c.last - c.change, high: c.last + Math.abs(c.change) * 1.2, low: c.last - Math.abs(c.change) * 1.2,
      close: c.last, prevClose: c.last - c.change, change: c.change, changePct: c.changePct,
      volume: 0, vwap: c.last, currency: "USD", marketState: "OPEN", ts: Date.now(),
    };
  }
  // JIBAR fixings
  for (const f of jibarFixings) {
    const k = `JIBAR_${f.tenor.replace("/", "")}`;
    out[k] = {
      symbol: k, last: f.rate, bid: f.rate, ask: f.rate,
      bidSize: 0, askSize: 0, open: f.rate, high: f.rate, low: f.rate,
      close: f.rate, prevClose: f.prev, change: f.change, changePct: (f.change / f.prev) * 100,
      volume: 0, vwap: f.rate, currency: "ZAR", marketState: "OPEN", ts: Date.now(),
    };
  }
  return out;
}

export function seedLastFor(symbol: string): number {
  switch (symbol) {
    case "NPN": return 4180.55;
    case "PRX": return 2295.10;
    case "FSR": return 78.42;
    case "SBK": return 226.75;
    case "AGL": return 552.10;
    case "BHG": return 528.40;
    case "MTN": return 108.65;
    case "SOL": return 162.80;
    case "SHP": return 281.30;
    case "CPI": return 2840.25;
    case "MSFT": return 442.78;
    case "AAPL": return 231.40;
    case "GFI": return 414.20;
    default: return 100;
  }
}

function synthQuote(symbol: string, inst: Instrument, last: number, bid: number, ask: number): Quote {
  return {
    symbol, last, bid, ask,
    bidSize: 0, askSize: 0,
    open: last * 0.998, high: last * 1.004, low: last * 0.995, close: last, prevClose: last * 0.999,
    change: last - last * 0.999, changePct: 0.1,
    volume: Math.floor(rng() * 5_000_000), vwap: last,
    marketCap: undefined,
    currency: inst.currency, marketState: "OPEN", ts: Date.now(),
  };
}

// Suppress unused warning on `rng` (it's used in the module but linters complain)
void rng;
