// ============================================================================
// MINT OEMS — Extended mock layer
// Bonds, orders/blotter, depth, time & sales, SENS, curves history, sectors.
// Each block is tagged with the matching IRESS endpoint (see v1.0 spec).
// ============================================================================

export type OrderSide = "BUY" | "SELL";
export type OrderState = "WORKING" | "PARTIAL" | "FILLED" | "CANCELLED" | "REJECTED";
export type TIF = "DAY" | "IOC" | "FOK" | "GTC";

// ----- Blotter / Orders — IRESS /v1/orders, /v1/executions ------------------
export interface Order {
  id: string;
  parentId?: string;
  time: string;         // HH:mm:ss
  strategy: string;
  side: OrderSide;
  symbol: string;
  isin: string;
  qty: number;
  filled: number;
  limit: number | null;
  last: number;
  vwap: number;
  venue: string;
  trader: string;
  tif: TIF;
  state: OrderState;
  slippageBps: number;
}

export const orders: Order[] = [
  { id: "ORD-44218", time: "09:42:18", strategy: "SA Equity Alpha", side: "BUY",  symbol: "NPN", isin: "ZAE000015889", qty: 12_000, filled: 8_400,  limit: 4180.00, last: 4180.55, vwap: 4179.20, venue: "JSE", trader: "akhumalo", tif: "DAY", state: "PARTIAL", slippageBps: -2.1 },
  { id: "ORD-44219", time: "09:48:02", strategy: "Resources Tilt", side: "SELL", symbol: "AGL", isin: "GB00B1XZS820", qty: 6_500,  filled: 6_500,  limit: 552.00,  last: 552.10, vwap: 552.08, venue: "JSE", trader: "akhumalo", tif: "DAY", state: "FILLED",  slippageBps:  0.4 },
  { id: "ORD-44220", time: "09:55:31", strategy: "SA Equity Alpha", side: "BUY",  symbol: "FSR", isin: "ZAE000066304", qty: 45_000, filled: 0,      limit: 78.35,   last: 78.42,  vwap: 78.50,  venue: "JSE", trader: "akhumalo", tif: "DAY", state: "WORKING", slippageBps:  0.0 },
  { id: "ORD-44221", time: "10:02:14", strategy: "Global Quality", side: "BUY",  symbol: "MSFT",isin: "US5949181045", qty: 1_200,  filled: 1_200,  limit: 442.50,  last: 442.78, vwap: 442.40, venue: "NASDAQ", trader: "sdlamini", tif: "IOC", state: "FILLED",  slippageBps: -0.9 },
  { id: "ORD-44222", time: "10:08:55", strategy: "SA Equity Alpha", side: "SELL", symbol: "SOL", isin: "ZAE000006896", qty: 18_000, filled: 12_000, limit: 163.00,  last: 162.80, vwap: 162.95, venue: "JSE", trader: "akhumalo", tif: "DAY", state: "PARTIAL", slippageBps: -1.2 },
  { id: "ORD-44223", time: "10:14:09", strategy: "Resources Tilt", side: "BUY",  symbol: "BHG", isin: "GB00BH0P3Z91", qty: 8_000,  filled: 0,      limit: 528.00,  last: 528.40, vwap: 528.30, venue: "JSE", trader: "akhumalo", tif: "GTC", state: "WORKING", slippageBps:  0.0 },
  { id: "ORD-44224", time: "10:18:42", strategy: "Inst. MM",       side: "BUY",  symbol: "SARB-TB182", isin: "ZAG000182TB", qty: 50_000_000, filled: 50_000_000, limit: 8.34, last: 8.34, vwap: 8.34, venue: "OTC", trader: "nsithole", tif: "FOK", state: "FILLED",  slippageBps: 0.0 },
  { id: "ORD-44225", time: "10:22:01", strategy: "Inst. MM",       side: "BUY",  symbol: "FSR-NCD90",  isin: "ZAG000FSRNCD", qty: 25_000_000, filled: 0, limit: 8.45, last: 8.45, vwap: 8.45, venue: "OTC", trader: "nsithole", tif: "DAY", state: "WORKING", slippageBps: 0.0 },
  { id: "ORD-44226", time: "10:31:27", strategy: "SA Equity Alpha", side: "BUY",  symbol: "CPI", isin: "ZAE000064676", qty: 1_800, filled: 0, limit: 2835.00, last: 2840.25, vwap: 2839.10, venue: "JSE", trader: "akhumalo", tif: "DAY", state: "WORKING", slippageBps: 0.0 },
  { id: "ORD-44227", time: "10:35:48", strategy: "Global Quality", side: "SELL", symbol: "AAPL",isin: "US0378331005", qty: 950,  filled: 0,    limit: 232.00,  last: 231.40, vwap: 231.75, venue: "NASDAQ", trader: "sdlamini", tif: "DAY", state: "REJECTED", slippageBps: 0.0 },
  { id: "ORD-44228", time: "10:41:12", strategy: "SA Equity Alpha", side: "BUY",  symbol: "SBK", isin: "ZAE000109815", qty: 9_500, filled: 9_500, limit: 226.80, last: 226.75, vwap: 226.78, venue: "JSE", trader: "akhumalo", tif: "DAY", state: "FILLED",   slippageBps: 0.2 },
  { id: "ORD-44229", time: "10:47:38", strategy: "Resources Tilt", side: "BUY",  symbol: "GFI", isin: "ZAE000018123", qty: 11_000, filled: 0, limit: 412.50, last: 414.20, vwap: 413.80, venue: "JSE", trader: "akhumalo", tif: "DAY", state: "CANCELLED", slippageBps: 0.0 },
];

// ----- Order book depth (L2) — IRESS /v1/depth/{isin} -----------------------
export interface DepthLevel { price: number; qty: number; orders: number; }
export interface OrderBook { bids: DepthLevel[]; asks: DepthLevel[]; }

export function generateDepth(mid: number, tick = 0.05, depth = 10): OrderBook {
  const bids: DepthLevel[] = [];
  const asks: DepthLevel[] = [];
  for (let i = 1; i <= depth; i++) {
    bids.push({ price: +(mid - i * tick).toFixed(2), qty: Math.floor(500 + Math.random() * 5000), orders: 1 + Math.floor(Math.random() * 8) });
    asks.push({ price: +(mid + i * tick).toFixed(2), qty: Math.floor(500 + Math.random() * 5000), orders: 1 + Math.floor(Math.random() * 8) });
  }
  return { bids, asks };
}

// ----- Time & Sales — IRESS /v1/trades/{isin}/stream ------------------------
export interface PrintTick { time: string; price: number; qty: number; side: "B" | "S"; venue: string; }
export function generatePrints(mid: number, n = 30): PrintTick[] {
  const out: PrintTick[] = [];
  let p = mid;
  for (let i = 0; i < n; i++) {
    p = +(p + (Math.random() - 0.5) * 0.4).toFixed(2);
    const d = new Date(Date.now() - (n - i) * 8000);
    out.push({
      time: d.toLocaleTimeString("en-ZA", { hour: "2-digit", minute: "2-digit", second: "2-digit" }),
      price: p,
      qty: Math.floor(100 + Math.random() * 4000),
      side: Math.random() > 0.5 ? "B" : "S",
      venue: Math.random() > 0.85 ? "DARK" : "JSE",
    });
  }
  return out.reverse();
}

// ----- Fixed Income screener — IRESS /v1/securities?type=bond ---------------
export interface Bond {
  isin: string;
  issuer: string;
  name: string;     // e.g. R2030 11.875%
  coupon: number;
  maturity: string;
  ytm: number;      // %
  clean: number;
  dirty: number;
  modDur: number;
  dv01: number;     // ZAR per R1m notional
  convexity: number;
  rating: string;
  spread: number;   // bps over curve
  liquidity: "deep" | "medium" | "thin";
}

export const bonds: Bond[] = [
  { isin: "ZAG000077876", issuer: "RSA Govt", name: "R2030 8.00%",  coupon: 8.00,  maturity: "2030-01-31", ytm: 10.42, clean: 92.18, dirty: 93.04, modDur: 4.21, dv01: 421, convexity: 22.4, rating: "BB",  spread: 0,   liquidity: "deep" },
  { isin: "ZAG000085236", issuer: "RSA Govt", name: "R2035 8.875%", coupon: 8.875, maturity: "2035-02-28", ytm: 11.42, clean: 88.05, dirty: 89.40, modDur: 6.84, dv01: 684, convexity: 56.1, rating: "BB",  spread: 0,   liquidity: "deep" },
  { isin: "ZAG000091221", issuer: "RSA Govt", name: "R2040 9.00%",  coupon: 9.00,  maturity: "2040-01-31", ytm: 12.05, clean: 84.20, dirty: 85.32, modDur: 8.71, dv01: 871, convexity: 92.8, rating: "BB",  spread: 0,   liquidity: "medium" },
  { isin: "ZAG000101148", issuer: "RSA Govt", name: "R2048 8.75%",  coupon: 8.75,  maturity: "2048-02-28", ytm: 12.38, clean: 78.50, dirty: 79.61, modDur: 10.42, dv01: 1042, convexity: 138.2, rating: "BB", spread: 0, liquidity: "medium" },
  { isin: "ZAG000125112", issuer: "Eskom",    name: "ES33 (Gov Gtd) 11.50%", coupon: 11.50, maturity: "2033-08-15", ytm: 11.95, clean: 96.40, dirty: 98.20, modDur: 5.42, dv01: 542, convexity: 38.1, rating: "BB-", spread: 53, liquidity: "thin" },
  { isin: "ZAG000118245", issuer: "Transnet", name: "TR30 10.25%",  coupon: 10.25, maturity: "2030-11-15", ytm: 11.62, clean: 94.10, dirty: 95.21, modDur: 4.15, dv01: 415, convexity: 21.8, rating: "BB-", spread: 120, liquidity: "thin" },
  { isin: "ZAG000132201", issuer: "Standard Bank", name: "SBK28 Sr 9.40%", coupon: 9.40, maturity: "2028-06-30", ytm: 10.18, clean: 97.85, dirty: 98.60, modDur: 2.84, dv01: 284, convexity: 9.8, rating: "AA+", spread: 35, liquidity: "medium" },
  { isin: "ZAG000148812", issuer: "FirstRand",     name: "FSR29 Sub 10.10%", coupon: 10.10, maturity: "2029-09-30", ytm: 10.85, clean: 96.20, dirty: 97.45, modDur: 3.62, dv01: 362, convexity: 15.2, rating: "AA-", spread: 78, liquidity: "medium" },
  { isin: "ZAG000159034", issuer: "RSA Govt ILB",  name: "I2033 1.875% (CPI)", coupon: 1.875, maturity: "2033-04-30", ytm: 5.21, clean: 88.40, dirty: 89.10, modDur: 6.91, dv01: 691, convexity: 58.2, rating: "BB", spread: 0, liquidity: "medium" },
  { isin: "ZAG000162910", issuer: "RSA Govt ILB",  name: "I2046 2.50% (CPI)",  coupon: 2.50,  maturity: "2046-03-31", ytm: 5.84, clean: 82.10, dirty: 82.95, modDur: 11.42, dv01: 1142, convexity: 158.4, rating: "BB", spread: 0, liquidity: "thin" },
];

// ----- Curve history (today, -1D, -1W, -1M) — IRESS /v1/yieldcurve/zar/history
export const zarCurveHistory = {
  today: [
    { tenor: "1M", t: 1/12, yield: 7.83 }, { tenor: "3M", t: 0.25, yield: 8.11 }, { tenor: "6M", t: 0.5, yield: 8.42 },
    { tenor: "1Y", t: 1, yield: 8.84 }, { tenor: "2Y", t: 2, yield: 9.21 }, { tenor: "3Y", t: 3, yield: 9.62 },
    { tenor: "5Y", t: 5, yield: 10.18 }, { tenor: "7Y", t: 7, yield: 10.74 }, { tenor: "10Y", t: 10, yield: 11.42 },
    { tenor: "15Y", t: 15, yield: 12.05 }, { tenor: "20Y", t: 20, yield: 12.38 }, { tenor: "25Y", t: 25, yield: 12.51 },
  ],
  d1:    [7.85, 8.13, 8.44, 8.86, 9.24, 9.65, 10.21, 10.76, 11.44, 12.06, 12.39, 12.52],
  w1:    [7.91, 8.20, 8.49, 8.92, 9.30, 9.74, 10.30, 10.85, 11.55, 12.18, 12.50, 12.62],
  m1:    [8.02, 8.30, 8.60, 9.05, 9.42, 9.88, 10.48, 11.04, 11.78, 12.42, 12.74, 12.84],
};

// Real (inflation-linked) curve for breakeven calc
export const zarRealCurve = [
  { tenor: "2Y", t: 2, yield: 3.18 }, { tenor: "5Y", t: 5, yield: 4.42 },
  { tenor: "10Y", t: 10, yield: 5.21 }, { tenor: "15Y", t: 15, yield: 5.62 },
  { tenor: "20Y", t: 20, yield: 5.84 }, { tenor: "25Y", t: 25, yield: 5.91 },
];

// Swap curve
export const zarSwapCurve = [
  { tenor: "1Y", t: 1, yield: 8.92 }, { tenor: "2Y", t: 2, yield: 9.34 },
  { tenor: "3Y", t: 3, yield: 9.78 }, { tenor: "5Y", t: 5, yield: 10.42 },
  { tenor: "7Y", t: 7, yield: 11.02 }, { tenor: "10Y", t: 10, yield: 11.71 },
];

// ----- Sector heat-map — IRESS /v1/indices/sectors --------------------------
export const sectorHeatmap = [
  { sector: "Banks",      weight: 22.4, change: 0.42 },
  { sector: "Mining",     weight: 18.8, change: 1.21 },
  { sector: "Technology", weight: 15.2, change: 1.84 },
  { sector: "Retail",     weight:  9.8, change: 0.28 },
  { sector: "Telco",      weight:  7.4, change: -0.92 },
  { sector: "Energy",     weight:  6.8, change: 2.14 },
  { sector: "Industrials",weight:  6.2, change: -0.18 },
  { sector: "Healthcare", weight:  5.4, change: 0.65 },
  { sector: "Property",   weight:  4.2, change: -0.42 },
  { sector: "Insurance",  weight:  3.8, change: 0.18 },
];

// ----- SENS feed (live) — IRESS /v1/news/sens -------------------------------
export interface SensItem {
  id: string;
  ts: string;       // HH:mm:ss
  issuer: string;
  ticker: string;
  category: "TRADING" | "RESULTS" | "DIVIDEND" | "DIRECTORATE" | "RELATED PARTY" | "CORP ACTION" | "CAUTIONARY";
  headline: string;
  severity: "info" | "important" | "regulatory";
}
export const sensFeed: SensItem[] = [
  { id: "S1", ts: "14:12:08", issuer: "Naspers Ltd", ticker: "NPN", category: "RESULTS",      headline: "Interim results: HEPS +24%, buyback raised to USD 3.2bn", severity: "important" },
  { id: "S2", ts: "14:08:42", issuer: "Anglo American", ticker: "AGL", category: "CORP ACTION", headline: "De Beers demerger circular posted; vote scheduled 14 Feb 2026", severity: "regulatory" },
  { id: "S3", ts: "13:55:21", issuer: "Capitec Bank", ticker: "CPI", category: "TRADING",     headline: "Trading update: active client base +11.2% YoY", severity: "important" },
  { id: "S4", ts: "13:48:09", issuer: "Sasol Ltd", ticker: "SOL", category: "CAUTIONARY",  headline: "Cautionary: discussions re. partial divestment of Secunda chemicals", severity: "regulatory" },
  { id: "S5", ts: "13:32:14", issuer: "MTN Group", ticker: "MTN", category: "TRADING",     headline: "Q3 trading update — Nigerian FX backlog fully cleared", severity: "important" },
  { id: "S6", ts: "13:14:55", issuer: "FirstRand",  ticker: "FSR", category: "DIVIDEND",    headline: "Interim dividend declared 215c, LDT 12 Dec 2025", severity: "info" },
  { id: "S7", ts: "12:58:27", issuer: "Shoprite Holdings", ticker: "SHP", category: "DIRECTORATE", headline: "Appointment of Lead Independent Director effective 1 Jan 2026", severity: "info" },
  { id: "S8", ts: "12:42:18", issuer: "Standard Bank", ticker: "SBK", category: "RELATED PARTY", headline: "Small related-party transaction — fairness opinion attached", severity: "info" },
  { id: "S9", ts: "12:18:02", issuer: "BHP Group", ticker: "BHG", category: "CORP ACTION",   headline: "Interim dividend USD 0.55/share, ZAR equivalent 1014c", severity: "info" },
  { id: "S10", ts: "11:55:41", issuer: "Prosus NV", ticker: "PRX", category: "TRADING",     headline: "Trading statement: NAV per share USD 14.82 (+8.4% HoH)", severity: "important" },
];

// ----- IRESS endpoint health — for Integration tab --------------------------
export interface EndpointHealth {
  path: string;
  domain: string;
  status: "green" | "amber" | "red";
  p50: number;   // ms
  p95: number;   // ms
  lastSeq: number;
  msgsPerSec: number;
  lastError?: string;
}
export const endpointHealth: EndpointHealth[] = [
  { path: "/v1/quotes/{isin}",          domain: "Equities",    status: "green", p50: 38,  p95: 86,  lastSeq: 4_281_192, msgsPerSec: 1240 },
  { path: "/v1/depth/{isin}",           domain: "Equities",    status: "green", p50: 42,  p95: 94,  lastSeq: 8_192_044, msgsPerSec: 2180 },
  { path: "/v1/trades/{isin}/stream",   domain: "Equities",    status: "green", p50: 31,  p95: 71,  lastSeq: 2_140_588, msgsPerSec: 940 },
  { path: "/v1/bonds/{isin}/pricing",   domain: "Fixed Income",status: "green", p50: 110, p95: 240, lastSeq: 184_812,   msgsPerSec: 12 },
  { path: "/v1/yieldcurve/zar",         domain: "Curves",      status: "green", p50: 220, p95: 410, lastSeq: 14_281,    msgsPerSec: 0.07 },
  { path: "/v1/rates/jibar",            domain: "Money Market",status: "green", p50: 88,  p95: 180, lastSeq: 2_188,     msgsPerSec: 0.02 },
  { path: "/v1/rates/zaronia",          domain: "Money Market",status: "amber", p50: 142, p95: 380, lastSeq: 1_840,     msgsPerSec: 0.01, lastError: "Stale > SLA (300s)" },
  { path: "/v1/news/sens",              domain: "News",        status: "green", p50: 64,  p95: 138, lastSeq: 5_421,     msgsPerSec: 2.4 },
  { path: "/v1/macro/calendar",         domain: "Macro",       status: "green", p50: 180, p95: 320, lastSeq: 412,       msgsPerSec: 0.001 },
  { path: "/v1/macro/series/{id}",      domain: "Macro",       status: "green", p50: 195, p95: 340, lastSeq: 1_205,     msgsPerSec: 0.003 },
  { path: "/v1/fx/{pair}",              domain: "FX",          status: "green", p50: 28,  p95: 64,  lastSeq: 9_482_001, msgsPerSec: 4200 },
  { path: "/v1/corporate-actions",      domain: "Reference",   status: "green", p50: 240, p95: 480, lastSeq: 184,       msgsPerSec: 0.001 },
];

// ----- Strategy holdings (sample) -------------------------------------------
export const strategyHoldings = {
  "eq-001": [
    { symbol: "NPN",  name: "Naspers",       target: 12.0, actual: 12.4, qty: 14_200, mv: 59_356_000 },
    { symbol: "PRX",  name: "Prosus",        target: 10.0, actual:  9.2, qty: 19_100, mv: 43_835_000 },
    { symbol: "FSR",  name: "FirstRand",     target:  8.0, actual:  8.4, qty: 510_000, mv: 39_994_000 },
    { symbol: "SBK",  name: "Standard Bank", target:  7.5, actual:  7.1, qty: 149_000, mv: 33_785_000 },
    { symbol: "AGL",  name: "Anglo American",target:  6.0, actual:  6.8, qty:  58_500, mv: 32_298_000 },
    { symbol: "CPI",  name: "Capitec Bank",  target:  5.5, actual:  5.2, qty:   8_700, mv: 24_710_000 },
    { symbol: "SHP",  name: "Shoprite",      target:  5.0, actual:  4.9, qty:  83_800, mv: 23_565_000 },
    { symbol: "SOL",  name: "Sasol",         target:  4.5, actual:  5.1, qty: 150_400, mv: 24_485_000 },
    { symbol: "MTN",  name: "MTN Group",     target:  4.0, actual:  3.6, qty: 159_300, mv: 17_307_000 },
    { symbol: "CASH", name: "ZAR Cash",      target:  2.0, actual:  3.2, qty: 0, mv: 15_424_000 },
  ],
};

// ----- Connection health (header pill) --------------------------------------
export const connectionHealth = {
  ws: "connected" as const,
  lagMs: 24,
  lastSeqGlobal: 12_481_028,
  reconnects24h: 0,
};
