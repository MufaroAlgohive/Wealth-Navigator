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
/**
 * OEMS-facing order lifecycle. Derived from the IRESS Hermes row shape
 * (`OrderState` + `ActionStatus` + `InternalOrderStatus` + `DoneVolumeTotal`).
 *
 * The IRESS V4 wire doc collapses everything onto `OrderState` (`ACTIVE` /
 * `INACTIVE`) plus an `ActionStatus` field on the Hermes UI (Pending /
 * Acknowledged / OK / Cancelled / Rejected). The single `OrderState` enum
 * the worker historically surfaced could not distinguish "trader ack'd on
 * Hermes, no fills yet" from "live in the book waiting for fills" — both
 * looked like `WORKING`. This union adds the intermediate states that
 * CARE / desk-routed orders actually traverse, so the operator can see
 * exactly where an order is stuck.
 *
 * State mapping (worker `live.ts::mapOrder` + `orders.ts::STATE_MAP`):
 *   - PENDING_ACK : OrderCreate3 returned OrderNumber, broker hasn't
 *                   acked yet (CARE flow — Andre, 2026-07-13).
 *   - ACKNOWLEDGED: ActionStatus=OK, no fills yet.
 *   - WORKING     : OrderState=ACTIVE, ActionStatus=OK, no fills yet,
 *                   OR any INACTIVE state with partial fill.
 *   - PARTIAL     : DoneVolumeTotal > 0 AND < OrderVolume (live OR inactive).
 *   - FILLED      : DoneVolumeTotal >= OrderVolume. INACTIVE here means
 *                   "row closed" (not "cancelled") — the broker moves a
 *                   fully-filled order to INACTIVE. The previous mapper
 *                   collapsed this to CANCELLED, which is the bug Juan
 *                   hit on the 400 SOL CARE order.
 *   - CANCELLED   : OrderState=INACTIVE AND DoneVolumeTotal < OrderVolume.
 *   - EXPIRED     : TimeInForce=DAY rolled off without a fill.
 *   - REJECTED    : OrderCreate3 response ErrorNumber != 0.
 */
export type OrderState =
  | "PENDING_ACK"
  | "ACKNOWLEDGED"
  | "WORKING"
  | "PARTIAL"
  | "FILLED"
  | "CANCELLED"
  | "EXPIRED"
  | "REJECTED";
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
  // Lifecycle detail captured from the IRESS row (Hermes OrderPad). Optional
  // because older audit rows + the mock do not supply them; the worker
  // mapper always populates them when reading from live OrderPadGetByAccount.
  // Surface them on the type so the OEMS UI can render the exact broker-side
  // status text, not just the downmapped lifecycle state.
  brokerState?: string | null;          // "ACTIVE" | "INACTIVE"
  actionStatus?: string | null;         // "Pending" | "Acknowledged" | "OK" | "Cancelled" | ...
  internalOrderStatus?: string | null;  // finer status (Hermes-side)
  stateDescription?: string | null;     // free-text "Traded 200@177, then 200@179"
  remainingVolume?: number | null;
  remainingValueCents?: number | null;
  orderValueCents?: number | null;
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
