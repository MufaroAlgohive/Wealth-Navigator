import type { Strategy } from "@/types/iress";

/**
 * The rebalance gate. A strategy can be rebalanced only when:
 *   1. At least one underlying investor is linked (`investorCount > 0`)
 *   2. The strategy itself is not halted by Risk
 *
 * This is the same condition the IRESS pre-trade mandate check enforces
 * server-side, mirrored on the client so the UI button can reflect it
 * before the user even tries to fire.
 */
export function canRebalance(s: Pick<Strategy, "investorCount" | "status">): boolean {
  return s.investorCount > 0 && s.status !== "halted";
}

/**
 * Human-readable reason the rebalance is blocked. Mirrors the
 * `canRebalance` gate so the UI can show "why" next to the lock pill.
 *   - "halted"  → Risk has stopped the strategy
 *   - "no-investors" → nothing to rebalance against
 *   - "ok"      → nothing to complain about
 */
export function rebalanceBlockReason(s: Pick<Strategy, "investorCount" | "status">): "halted" | "no-investors" | "ok" {
  if (s.status === "halted") return "halted";
  if (s.investorCount === 0) return "no-investors";
  return "ok";
}

/** Verbose, tooltip-shaped reason a rebalance is blocked. */
export function rebalanceBlockTooltip(s: Pick<Strategy, "investorCount" | "status" | "lastRebalanced">): string {
  const r = rebalanceBlockReason(s);
  if (r === "halted") return `Cannot rebalance: strategy halted by Risk since ${s.lastRebalanced} 14:32`;
  if (r === "no-investors") return "Cannot rebalance: at least one underlying investor is not linked";
  return "Rebalance allowed";
}

// ─── Pre-trade checks (IRESS IOS+ pre-trade mandate) ──────────────────────

/** Order side, as the trader types it in. */
export type PreTradeSide = "BUY" | "SELL";

/** Subset of an order needed to evaluate pre-trade checks. */
export interface PreTradeOrder {
  symbol: string;
  side: PreTradeSide;
  qty: number;
  price: number;
  strategyId?: string;
}

/** Subset of the account the trader is acting for. */
export interface PreTradeAccount {
  cash: number;
  /** Symbols the strategy is allowed to trade. `undefined` → unknown / no strategy. */
  mandate?: string[];
}

/** Per-leg pre-trade verdict. `ok` is the only green state. */
export type PreTradeHaltVerdict = "ok" | "halt" | "suspend";
export type PreTradeBPVerdict = "ok" | "exceeded";
export type PreTradeMandateVerdict = "ok" | "n/a" | "outside";

export interface PreTradeResult {
  halt: PreTradeHaltVerdict;
  bp: PreTradeBPVerdict;
  mandate: PreTradeMandateVerdict;
  /** First failing check's reason, suitable for a tooltip on the Send button. */
  reason?: string;
  /** Notional (qty * price) — surfaced for the "Estimated notional" line. */
  notional: number;
}

/**
 * Pure pre-trade check, callable from React without any IRESS / network
 * coupling. The caller supplies the `marketState` for the symbol (sourced
 * from `useTick` / a live feed in the UI, hard-coded in tests).
 */
export function preTradeCheck(
  order: PreTradeOrder,
  account: PreTradeAccount,
  marketState: string = "TRADE",
): PreTradeResult {
  const notional = order.qty * order.price;
  const result: PreTradeResult = { halt: "ok", bp: "ok", mandate: "ok", notional };

  // 1. Halt / suspension
  if (marketState === "HALT") {
    result.halt = "halt";
    result.reason = `${order.symbol} is halted — order will be rejected by IOS+`;
  } else if (marketState === "SUSPEND" || marketState === "SUSPENDED") {
    result.halt = "suspend";
    result.reason = `${order.symbol} is suspended — order will be rejected by IOS+`;
  }

  // 2. Buying power (notional vs cash)
  if (notional > account.cash) {
    result.bp = "exceeded";
    result.reason = `Buying power exceeded — notional ${notional.toLocaleString("en-ZA")} > cash ${account.cash.toLocaleString("en-ZA")}`;
  }

  // 3. Mandate / concentration
  //    - No mandate passed → "n/a" (we don't know the strategy universe;
  //      the caller is responsible for the "N/A" UI display when no
  //      strategy is attached). n/a is non-blocking.
  //    - Mandate passed and includes the symbol → "ok".
  //    - Mandate passed and missing the symbol → "outside" (blocking).
  if (account.mandate === undefined) {
    result.mandate = "n/a";
  } else if (!account.mandate.includes(order.symbol)) {
    result.mandate = "outside";
    if (!result.reason) {
      result.reason = `${order.symbol} is outside the strategy mandate (${account.mandate.join(", ") || "empty"})`;
    }
  }

  return result;
}

// ─── In-memory market state fixture (test + dev only) ─────────────────────

/**
 * Hard-coded market states for the symbols we know are halted / suspended.
 * Anything not in this map is treated as "TRADE" by `preTradeCheck`.
 *
 * The list lives here (not in `seed.ts`) because it's only consumed by the
 * pre-trade helper — a "halted" instrument is a pre-trade concern, not a
 * reference-data fact.
 */
export const marketStateBySymbol: Record<string, "TRADE" | "PRE_OPEN" | "INDICATIVE" | "HALT" | "SUSPEND" | "SUSPENDED"> = {
  ZZZZZ: "HALT",
  XX: "SUSPEND",
};

/** Resolve the configured state for a symbol, defaulting to "TRADE". */
export function getMarketState(symbol: string): string {
  return marketStateBySymbol[symbol] ?? "TRADE";
}
