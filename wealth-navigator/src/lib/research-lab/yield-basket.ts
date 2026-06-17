/** T6 synthetic — Yield Basket research workspace (Lovable prototype parity). */

export type Verdict = "BUY" | "HOLD" | "SELL" | null;
export type MetricTone = "good" | "neutral" | "concern" | null;
export type ResearchRole = "strategist" | "head";

export interface HoldingRow {
  ticker: string;
  name: string;
  assetClass: string;
  sector: string;
  shares: number;
  price: number;
  value: number;
  constWeight: number;
  basketWeight: number;
  rating?: Verdict;
}

export interface FundamentalMetric {
  id: string;
  group: string;
  label: string;
  hint?: string;
  values: Record<string, string | null>;
  tones?: Record<string, MetricTone>;
}

export interface SectorSlice {
  sector: string;
  weight: number;
}

export interface AuditEntry {
  id: string;
  ts: string;
  actor: string;
  action: string;
  detail: string;
}

export const YIELD_BASKET_META = {
  name: "Yield Basket",
  description:
    "A diversified South African strategy focused on steady growth with controlled risk across major sectors.",
  strategist: "T. Maluleke",
  strategistTitle: "Portfolio Strategist",
  benchmark: "JSE ALSI",
  inception: "30/01/2026",
  state: "Has investors",
  asOf: "15 Jun 2026",
  cashTargetPct: 7.41,
};

export const CURRENT_HOLDINGS: HoldingRow[] = [
  { ticker: "NED", name: "Nedbank Group Limited", assetClass: "Equities", sector: "Financials — Banks", shares: 2, price: 264.08, value: 528.16, constWeight: 21.89, basketWeight: 20.27 },
  { ticker: "SUI", name: "Sun International Limited", assetClass: "Equities", sector: "Consumer — Leisure", shares: 5, price: 55.16, value: 275.8, constWeight: 11.43, basketWeight: 10.59 },
  { ticker: "DIB", name: "Dipula Income Fund B", assetClass: "Real estate", sector: "Real estate / REIT", shares: 20, price: 6.9, value: 138, constWeight: 5.72, basketWeight: 5.3 },
  { ticker: "CLI", name: "Clientele Limited", assetClass: "Equities", sector: "Financials — Insurance", shares: 20, price: 19.49, value: 389.8, constWeight: 16.16, basketWeight: 14.96 },
  { ticker: "EXX", name: "Exxaro Resources Limited", assetClass: "Equities", sector: "Resources — Coal", shares: 5, price: 216.12, value: 1080.6, constWeight: 44.79, basketWeight: 41.48 },
];

export const PROPOSED_HOLDINGS: HoldingRow[] = [
  { ticker: "ABG", name: "Absa Group Limited", assetClass: "Equities", sector: "Financials — Banks", shares: 2, price: 249.81, value: 499.62, constWeight: 22.82, basketWeight: 21.13, rating: "BUY" },
  { ticker: "SUI", name: "Sun International Limited", assetClass: "Equities", sector: "Consumer — Leisure", shares: 5, price: 55.16, value: 275.8, constWeight: 12.6, basketWeight: 11.67, rating: "HOLD" },
  { ticker: "DIB", name: "Dipula Income Fund B", assetClass: "Real estate", sector: "Real estate / REIT", shares: 20, price: 6.9, value: 138, constWeight: 6.3, basketWeight: 5.84, rating: "HOLD" },
  { ticker: "MTM", name: "Momentum Metropolitan", assetClass: "Equities", sector: "Financials — Insurance", shares: 10, price: 19.49, value: 194.9, constWeight: 8.9, basketWeight: 8.24, rating: "BUY" },
  { ticker: "EXX", name: "Exxaro Resources Limited", assetClass: "Equities", sector: "Resources — Coal", shares: 5, price: 216.12, value: 1080.6, constWeight: 49.37, basketWeight: 45.71, rating: "HOLD" },
];

const TICKERS = ["NED", "SUI", "DIB", "CLI", "EXX"] as const;

export const FUNDAMENTAL_METRICS: FundamentalMetric[] = [
  {
    id: "verdict",
    group: "",
    label: "Verdict",
    values: { NED: "SELL", SUI: "HOLD", DIB: "HOLD", CLI: null, EXX: "HOLD" },
  },
  {
    id: "mktcap",
    group: "Liquidity",
    label: "Market cap (R bn)",
    hint: "Shares outstanding × price",
    values: { NED: "R 123.9bn", SUI: "R 9.4bn", DIB: "R 6.4bn", CLI: null, EXX: "R 42.8bn" },
  },
  {
    id: "roe",
    group: "Profitability & capital efficiency",
    label: "Return on Equity (ROE)",
    hint: "Net Income / Shareholders' Equity",
    values: { NED: "6,20%", SUI: "46,70%", DIB: "13,80%", CLI: null, EXX: "10,80%" },
    tones: { NED: "concern", SUI: "good", DIB: "neutral", EXX: "neutral" },
  },
  {
    id: "roce",
    group: "Profitability & capital efficiency",
    label: "Return on Capital (ROCE)",
    hint: "EBIT / (Total Assets − Current Liabilities)",
    values: { NED: "0,70%", SUI: "13,70%", DIB: null, CLI: null, EXX: "8,00%" },
    tones: { NED: "concern", SUI: "good", EXX: "neutral" },
  },
  {
    id: "opmargin",
    group: "Profitability & capital efficiency",
    label: "Operating profit margin",
    values: { NED: null, SUI: "19,50%", DIB: "56,80%", CLI: null, EXX: "17,60%" },
    tones: { SUI: "good", DIB: "good", EXX: "neutral" },
  },
  {
    id: "pe",
    group: "Valuation",
    label: "Price-to-Earnings",
    values: { NED: "16.2x", SUI: "5.9x", DIB: "5.5x", CLI: null, EXX: "5.6x" },
  },
  {
    id: "fpe",
    group: "Valuation",
    label: "Forward P/E",
    hint: "Price / Forward EPS (next 12M)",
    values: { NED: "6.7x", SUI: "6.4x", DIB: null, CLI: null, EXX: "4.6x" },
  },
  {
    id: "pb",
    group: "Valuation",
    label: "Price-to-Book",
    values: { NED: "1.1x", SUI: "2.9x", DIB: "0.8x", CLI: null, EXX: "0.7x" },
  },
  {
    id: "peg",
    group: "Valuation",
    label: "PEG ratio",
    values: { NED: "3.6x", SUI: "1.2x", DIB: null, CLI: null, EXX: "0.3x" },
    tones: { NED: "concern", SUI: "neutral", EXX: "good" },
  },
  {
    id: "fcfy",
    group: "Quality & income",
    label: "Free Cash Flow Yield",
    hint: "FCF / Market cap",
    values: { NED: "-86,00%", SUI: "20,10%", DIB: "10,40%", CLI: null, EXX: "7,70%" },
    tones: { NED: "concern", SUI: "good", DIB: "good", EXX: "neutral" },
  },
  {
    id: "div",
    group: "Quality & income",
    label: "Dividend yield",
    hint: "DPS / Price",
    values: { NED: "8,00%", SUI: "10,60%", DIB: "8,80%", CLI: null, EXX: "9,50%" },
    tones: { NED: "good", SUI: "good", DIB: "good", EXX: "good" },
  },
  {
    id: "eps",
    group: "Growth & momentum",
    label: "EPS growth (y/y)",
    hint: "(EPS current / EPS prior) − 1",
    values: { NED: "-53,43%", SUI: "-12,05%", DIB: null, CLI: null, EXX: null },
    tones: { NED: "concern", SUI: "concern" },
  },
  {
    id: "nde",
    group: "Liquidity, solvency & financial risk",
    label: "Net debt / EBITDA",
    values: { NED: "0.4x", SUI: "1.7x", DIB: "4.5x", CLI: null, EXX: "-1.0x" },
    tones: { DIB: "concern", EXX: "good" },
  },
  {
    id: "ic",
    group: "Liquidity, solvency & financial risk",
    label: "Interest cover",
    hint: "EBIT / Interest expense",
    values: { NED: null, SUI: "4.9x", DIB: "2.3x", CLI: null, EXX: "9.4x" },
    tones: { SUI: "good", DIB: "neutral", EXX: "good" },
  },
  {
    id: "fcf",
    group: "Liquidity, solvency & financial risk",
    label: "FCF conversion",
    hint: "(Operating CF − CapEx) / Net income",
    values: { NED: "13.66", SUI: "1.16", DIB: "0.57", CLI: null, EXX: "0.43" },
    tones: { NED: "concern", SUI: "good", DIB: "neutral", EXX: "neutral" },
  },
];

export const SECTOR_BEFORE: SectorSlice[] = [
  { sector: "Resources — Coal", weight: 41.48 },
  { sector: "Financials — Banks", weight: 20.27 },
  { sector: "Financials — Insurance", weight: 14.96 },
  { sector: "Consumer — Leisure", weight: 10.59 },
  { sector: "Real estate / REIT", weight: 5.3 },
  { sector: "Cash", weight: 7.41 },
];

export const SECTOR_AFTER: SectorSlice[] = [
  { sector: "Resources — Coal", weight: 45.71 },
  { sector: "Financials — Banks", weight: 21.13 },
  { sector: "Financials — Insurance", weight: 8.24 },
  { sector: "Consumer — Leisure", weight: 11.67 },
  { sector: "Real estate / REIT", weight: 5.84 },
  { sector: "Cash", weight: 7.41 },
];

export const RESEARCH_TICKERS = [...TICKERS];

export function sumHoldings(rows: HoldingRow[]) {
  return rows.reduce((s, r) => s + r.value, 0);
}

export function basketMinPrice(constituentTotal: number, cashPct: number) {
  return constituentTotal / (1 - cashPct / 100);
}

export const CURRENT_TOTALS = {
  constituent: sumHoldings(CURRENT_HOLDINGS),
  cash: 192.99,
  basketMin: 2605.35,
};

export const PROPOSED_TOTALS = {
  constituent: sumHoldings(PROPOSED_HOLDINGS),
  cash: 175.18,
  basketMin: 2364.1,
};
