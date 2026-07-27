/**
 * Shared types for the OEMS order system.
 *
 * This is the single source of truth for the preflight + submit contract.
 * Every BFF route (UAT ad-hoc, bulk send-to-market, blotter dialog, future
 * research-lab / paper-model consumers) goes through `src/lib/orders/` and
 * inherits the same shape — so the shared `<GuardrailForceCorrectionDialog/>`
 * can render force-correction UX across every entry point without per-route
 * markup or copy drift.
 *
 * See plan §0 (`src/lib/orders/` core module) and the
 * `<GuardrailForceCorrectionDialog/>` primitive in
 * `src/oems/primitives/guardrail-force-correction-dialog.tsx`.
 */

export type OrderSide = "buy" | "sell";

/**
 * Every producer of an `oems_order_audit` row. Worker-poll rows are tagged
 * `IRESS`; everything else is a BFF-seeded row whose guard path is decided
 * by `source`. Adding a new consumer (research-lab thesis, paper-model
 * rebalance, …) means adding a literal here — no other code needs to know.
 */
export type OrderSource =
  | "UAT_ADHOC_ORDER"
  | "OB_SEND_TO_MARKET_UAT"
  | "BLOTTER_NEW_ORDER"
  | "RESEARCH_LAB_THESIS"
  | "PAPER_MODEL_REBALANCE"
  | "MINT_CLIENT_ORDER"
  /** Desk places an order on a named client's behalf from the order book. */
  | "MANUAL_CLIENT_ORDER"
  | "IRESS";

/** What the worker preflight / limit guard decided. */
export type PreflightVerdict =
  | "pass"
  | "blocked_naked_short"
  | "blocked_insufficient_cash"
  | "blocked_unverifiable";

/** Stable error codes surfaced verbatim to the UI modal. */
export type PreflightCode =
  | "pass"
  | "naked_short_blocked"
  | "insufficient_cash"
  | "sell_guard_unavailable"
  | "buy_guard_unavailable"
  | "limit_guard_violation"
  | "limit_guard_unverified_sell";

/** Sell-side availability as computed by the worker `availableToSell`. */
export interface SellAvailabilityLite {
  held: number;
  inflight_sells: number;
  available: number;
  /** "ips" | "derived" | "none" — what the worker reported. */
  source: string;
  note: string;
}

/** Buy-side availability as computed by the worker `availableToBuy`. */
export interface CashAvailabilityLite {
  cash: number | null;
  inflight_buys: number;
  available: number | null;
  /** "ips" | "cap" | "none" — what the worker reported. */
  source: string;
  note: string;
}

export interface PreflightInput {
  /** IRESS account code (e.g. "56378" for the UAT desk account). */
  account_code: string;
  symbol: string;
  side: OrderSide;
  qty: number;
  /** Limit price in cents. `null`/missing = market order. */
  price_cents?: number | null;
  source: OrderSource;
  /** Optional book id (strategy_name_snapshot for bulk). */
  book_id?: string;
  /**
   * When set, the worker checks THIS client's own wallet and holdings instead
   * of the desk omnibus. Must match the `user_id` the order will be parked
   * with, or the advisory verdict shown on the ticket will not match the
   * binding one at release time.
   */
  user_id?: string | null;
}

export interface PreflightResult {
  ok: boolean;
  verdict: PreflightVerdict;
  code: PreflightCode;
  /** Human-readable; surfaced verbatim in `<GuardrailForceCorrectionDialog/>`. */
  message: string;
  sell?: SellAvailabilityLite;
  cash?: CashAvailabilityLite;
}

export interface SubmitInput extends PreflightInput {
  /** The trader's auth email — written to `client_account` for audit. */
  trader_email: string;
  /**
   * The exact `stock_holdings_c.id` this order came from (mint client
   * orders, and eventually bulk/basket dispatch). Lets the order-book UI
   * join a specific investor's specific security position to its live
   * IRESS execution status. `null`/omitted for orders with no underlying
   * holding row (e.g. the ad-hoc UAT ticket).
   */
  holding_id?: string | null;
  /**
   * The RETAIL auth user this order is FOR.
   *
   * The broker never sees it — LONGMARK only knows the MINT account, and MINT
   * does the client breakdown internally. It exists so the pre-trade guard can
   * check the order against THIS client's own wallet and holdings rather than
   * the desk omnibus (see resolveHolderKind + availableTo*ForClient in the
   * worker). Without it a manual client order classifies as "desk" and the
   * client's available cash is never enforced.
   *
   * Omit for genuine desk orders.
   */
  user_id?: string | null;
}

export interface SubmitResult {
  ok: boolean;
  /** UUID of the audit row when one was written (i.e. `ok: true` or post-insert rejection). */
  order_audit_id?: string;
  /** Internal OrderTag / OrderNumber seed. */
  order_id?: string;
  /** IRESS OrderNumber once the worker stamped it back. */
  iress_order_number?: string;
  status?: string;
  preflight: PreflightResult;
  error?: string;
  /** What the worker said when it rejected AFTER we already wrote the row. */
  worker_code?: string;
}

/**
 * Bulk-path violation row shape — surfaced by `/api/admin/orderbook/send-to-market`
 * and rendered in the `<GuardrailForceCorrectionDialog/>` bulk mode. Mirrors the
 * `LimitViolation` type in the send-to-market route; kept here so the modal can
 * type-check against the core module without re-defining the field set.
 */
export interface BulkViolation {
  holding_id: string;
  symbol: string;
  side: OrderSide;
  qty: number;
  reason: string;
  detail: Record<string, number | string | null>;
}
