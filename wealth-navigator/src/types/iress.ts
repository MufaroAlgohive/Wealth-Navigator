// Domain types — the shape our app code uses.
// These mirror the IRESS V4 WSDL fields per the doc set in
// `Documentation & Vision/iress-v4-docs/`.

// ─── Reference / instrument ─────────────────────────────────────────────

export type AssetClass = "equity" | "money_market" | "fixed_income" | "fx" | "commodity" | "index";

export interface Instrument {
  symbol: string;
  isin: string;
  ric: string;
  name: string;
  exchange: string;
  sector: string;
  currency: string;
  assetClass: AssetClass;
}

// ─── Quote (L1) ─────────────────────────────────────────────────────────

export interface Quote {
  symbol: string;
  last: number;
  bid: number;
  ask: number;
  bidSize: number;
  askSize: number;
  open: number;
  high: number;
  low: number;
  close: number;
  prevClose: number;
  change: number;
  changePct: number;
  volume: number;
  vwap: number;
  marketCap?: number;
  currency: string;
  marketState: "PRE_OPEN" | "OPEN" | "CLOSING" | "CLOSED" | "HALT";
  ts: number; // ms since epoch
}

// ─── Time-series point (curves, history) ────────────────────────────────

export interface SeriesPoint {
  t: number; // ms
  v: number;
}

// ─── Order pad row ──────────────────────────────────────────────────────

export type OrderSide = "BUY" | "SELL";
export type OrderType = "MKT" | "LMT" | "STP" | "STP_LMT";
export type OrderTIF = "DAY" | "IOC" | "FOK" | "GTC";
export type OrderState = "WORKING" | "PARTIAL" | "FILLED" | "CANCELLED" | "REJECTED";
export type OrderDestination = "JSE" | "NASDAQ" | "NYSE" | "LSE" | "OTC" | "DARK";

export interface Order {
  id: string;
  parentId?: string;
  account: string;
  strategy: string;
  side: OrderSide;
  symbol: string;
  isin: string;
  type: OrderType;
  tif: OrderTIF;
  destination: OrderDestination;
  qty: number;
  filled: number;
  limit: number | null;
  stop: number | null;
  // null = no real execution data (e.g. an audit row with no fills). Renders
  // "—" rather than a fabricated price/slippage. Mock + live-IRESS producers
  // still set real numbers; only the audit BFF leaves them null when absent.
  avgPx: number | null;
  vwap: number | null;
  trader: string;
  ts: number;
  state: OrderState;
  rejectReason?: string;
  slippageBps: number | null;
  arrivalMid: number;
  orderTag: string; // IRESS idempotency key
}

// ─── Strategy / mandate ─────────────────────────────────────────────────

export type StrategyKind = "equity" | "money_market";
export type StrategyStatus = "live" | "paper" | "halted";

export interface Strategy {
  id: string;
  name: string;
  kind: StrategyKind;
  manager: string;
  /** Stable persona-id for the manager (e.g. "st1" for Andile Khumalo). */
  managerId?: string;
  aum: number;
  ytd: number;
  dayPnl: number;
  sharpe: number;
  maxDD: number;
  benchmark: string;
  benchmarkYtd: number;
  investorCount: number;
  holdingsCount: number;
  cashWeight: number;
  status: StrategyStatus;
  lastRebalanced: string;
  trackingError?: number;
  weightedAvgYield?: number;
  weightedAvgDuration?: number;
}

export interface Holding {
  symbol: string;
  name: string;
  qty: number;
  mv: number;
  target: number; // % weight
  actual: number; // % weight
  sector: string;
}

// ─── Macro ──────────────────────────────────────────────────────────────

export interface MacroRelease {
  id: string;
  date: string;
  time: string;
  country: "ZA" | "US" | "EU" | "UK" | "JP" | "CN";
  indicator: string;
  period: string;
  actual?: string;
  forecast: string;
  previous: string;
  importance: "high" | "med" | "low";
}

export interface MacroIndicator {
  name: string;
  value: number;
  prior: number;
  unit: string;
  trend: "up" | "down" | "flat";
}

// ─── Money market ───────────────────────────────────────────────────────

export type MoneyMarketType = "NCD" | "TB" | "Repo" | "Call" | "FRN" | "Corp Paper";

export interface MoneyMarketInstrument {
  ticker: string;
  name: string;
  type: MoneyMarketType;
  issuer: string;
  tenor: string;
  yield: number;
  duration: number;
  rating: string;
  notional: number;
  maturity: string;
}

// ─── Fixed income (bond) ────────────────────────────────────────────────

export interface Bond {
  isin: string;
  issuer: string;
  name: string;
  coupon: number;
  maturity: string;
  ytm: number;
  clean: number;
  dirty: number;
  modDur: number;
  dv01: number;
  convexity: number;
  rating: string;
  spread: number;
  liquidity: "deep" | "medium" | "thin";
}

// ─── News & SENS ────────────────────────────────────────────────────────

export interface NewsItem {
  id: string;
  headline: string;
  source: "Reuters" | "Bloomberg" | "Moneyweb" | "SENS" | "Dow Jones" | "Business Day" | "IRESS";
  ts: number;
  tickers: string[];
  category: "company" | "macro" | "rates" | "fx" | "commodity" | "politics";
  priority: "high" | "normal";
}

export type SensCategory =
  | "RESULTS"
  | "TRADING"
  | "DIVIDEND"
  | "DIRECTORATE"
  | "RELATED PARTY"
  | "CORP ACTION"
  | "CAUTIONARY";

export interface SensItem {
  id: string;
  ts: number;
  ticker: string;
  issuer: string;
  category: SensCategory;
  severity: "info" | "regulatory";
  headline: string;
}

// ─── Depth / prints ─────────────────────────────────────────────────────

export interface DepthLevel {
  price: number;
  qty: number;
  orders: number;
}

export interface OrderBook {
  bids: DepthLevel[];
  asks: DepthLevel[];
  ts: number;
}

export interface Print {
  ts: number;
  price: number;
  qty: number;
  side: "B" | "S";
  venue: string;
}

// ─── IRESS session state ────────────────────────────────────────────────

export type IressService = "Iress" | "IOSPlus" | "IPS" | "FIXPlus";

export interface IressSession {
  sessionKey: string;
  serviceSessionKeys: Partial<Record<IressService, string>>;
  applicationId: string;
  applicationLabel: string;
  locale: string;
  startedAt: number;
  lastActivity: number;
  sessionNumber: number;
  // SHA-256(sessionKey).slice(0, 8) — what we log.
  sessionKeyHash: string;
}
