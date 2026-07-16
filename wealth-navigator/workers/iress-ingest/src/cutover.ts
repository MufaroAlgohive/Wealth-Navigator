/**
 * Per-symbol Yahoo->IRESS cutover decision for the worker's money-track writes.
 *
 * The money track (securities_c.last_price / stock_intraday_c) feeds real client
 * portfolios. A symbol is switched from Yahoo to IRESS ONLY when the backend has
 * validated it AND a human approved it (loadApprovedIressSymbols), the PROD
 * market-data seat is live, and the live tick passes a runtime divergence check.
 * Everything else stays on Yahoo. Fail-closed via the empty approved set.
 */

import { computeDivergence } from "../../../src/lib/iress/overlay-policy";
import { marketDataProdEnabled } from "./market-data";

export { loadApprovedIressSymbols } from "../../../src/lib/iress/approved-symbols";

/** "MTN.JO" / " mtn " -> "MTN". */
export function bareCode(symbol: string): string {
  return String(symbol ?? "")
    .trim()
    .toUpperCase()
    .replace(/\.(JO|JSE)$/i, "");
}

/**
 * IRESS is the approved money-track source for this symbol: the PROD market-data
 * seat is on (so the price is real prod data, not CT/test) AND the symbol is in
 * the approved+validated set.
 */
export function iressOwnsSymbol(symbol: string, approved: Set<string>): boolean {
  return marketDataProdEnabled() && approved.has(bareCode(symbol));
}

/**
 * Runtime circuit-breaker: even for an approved symbol, refuse to write an IRESS
 * price that diverges past the hard reject threshold from the current reference
 * (the last known securities_c value). Catches a bad / mis-scaled / stale tick
 * at write time. No reference (refCents <= 0) => allowed (nothing to compare).
 * Both args in the SAME unit (cents).
 */
export function withinWriteGuard(iressCents: number, refCents: number): boolean {
  if (!(refCents > 0)) return true;
  return computeDivergence(iressCents, refCents).severity !== "breach";
}
