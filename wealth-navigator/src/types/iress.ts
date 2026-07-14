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
 *   - CANCEL_PENDING: Desk-issued OrderDelete that hasn't been acknowledged
 *                   by the broker yet. Flips to CANCELLED on the next poll
 *                   once IRESS confirms. Stored as 'cancel_pending' on
 *                   oems_order_audit.status.
 *   - EXPIRED     : TimeInForce=DAY rolled off without a fill.
 *   - REJECTED    : OrderCreate3 response ErrorNumber != 0.
 *   - AMEND_PENDING: Desk-issued OrderAmend that hasn't been acknowledged
 *                   by the broker yet. Flips to WORKING / PARTIAL on the
 *                   next poll once IRESS confirms. Stored as 'amend_pending'
 *                   on oems_order_audit.status.
 *   - FAILED       : Terminal. OrderCreate3 / OrderAmend / OrderDelete was
 *                   rejected at the broker (network down, venue unavailable,
 *                   operator kicked the session, invalid account, etc.). The
 *                   IRESS ErrorNumber + ErrorDescription are surfaced on
 *                   `iressErrorNumber` / `rejectReason` so the operator can
 *                   see the actual reason. Distinct from REJECTED which is
 *                   a validation-level rejection pre-routing; FAILED is a
 *                   post-routing transport / venue failure. Stored as
 *                   'failed' on oems_order_audit.status.
 */
export type OrderState =
  | "PENDING_ACK"
  | "ACKNOWLEDGED"
  | "WORKING"
  | "PARTIAL"
  | "FILLED"
  | "CANCELLED"
  | "CANCEL_PENDING"
  | "EXPIRED"
  | "REJECTED"
  | "AMEND_PENDING"
  | "FAILED";

/**
 * IRESS Hermes OrderPad broker-side activity flag. Distinct from the
 * lifecycle `OrderState` because a fully-filled order is also INACTIVE
 * once the broker closes the row, but the operator needs to know the
 * order is still "live in the book" vs "done and parked". Render as a
 * green / grey chip on the OEMS row. Sourced from IRESS OrderState field
 * (not ActionStatus) — the worker mapper always populates this.
 *   - ACTIVE  : order is on the book, IRESS considers it live
 *   - INACTIVE: order is closed (filled, cancelled, expired, or rejected)
 *   - UNKNOWN : worker hasn't observed the order yet (e.g. fresh audit
 *               row pre-poll)
 */
export type OrderBrokerState = "ACTIVE" | "INACTIVE" | "UNKNOWN";
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
  // 2026-07-14 (Andre + Juan): surfaced on the typed Order (not just on
  // the SSE delta) so the audit BFF + the order book UI can render the
  // actual broker-side reason when an order goes FAILED post-routing.
  // IRESS ErrorNumber is non-zero on OrderPad rows that the broker parked
  // after a venue / transport failure (network down, kicked session, etc).
  iressErrorNumber?: number | null;
  iressErrorDescription?: string | null;
  slippageBps: number | null;
  arrivalMid: number;
  orderTag: string; // IRESS idempotency key
  // Lifecycle detail captured from the IRESS row (Hermes OrderPad). Optional
  // because older audit rows + the mock do not supply them; the worker
  // mapper always populates them when reading from live OrderPadGetByAccount.
  // Surface them on the type so the OEMS UI can render the exact broker-side
  // status text, not just the downmapped lifecycle state.
  brokerState?: OrderBrokerState | null;  // "ACTIVE" | "INACTIVE" | "UNKNOWN"
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
