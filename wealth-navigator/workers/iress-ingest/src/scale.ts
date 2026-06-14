/**
 * Reference-anchored price scaling for JSE quotes.
 *
 * IRESS CT returns JSE prices inconsistently — some names as a bare `<Last>`
 * in ZAR (Rands), others as `<LastPrice>` integer cents — and the heuristic in
 * `src/lib/iress/live.ts` (`iressQuotePriceScale`) mis-scales by exactly 100×
 * when there is no OHLC anchor (e.g. a closed market) and the value is under
 * its ~R45 cents threshold: a sub-R45 stock's cents value (e.g. 4125 = R41.25)
 * is read as Rands (R4125). See the 2026-06-13/14 coverage probe: 121 / 128
 * priced symbols were 100× off, all of them clustered below R45.
 *
 * `chooseDisplayCents` removes the guesswork by anchoring to a known reference
 * price — the existing `securities_c.last_price` (cents, Yahoo-sourced today) —
 * and picking the interpretation of the worker's mapped `last` (Rands) whose
 * magnitude best matches the reference. Because the two candidates differ by
 * 100×, even a stale or moderately-off reference still disambiguates correctly.
 * With no reference it falls back to the plain Rands→cents conversion (current
 * behaviour), so it never makes things worse.
 */

export interface CentsChoice {
  /** Chosen price in cents (the unit `stock_intraday_c.current_price` expects). */
  cents: number;
  basis: "rands" | "cents-mislabeled" | "no-reference" | "empty";
  /** Multiplier to convert a same-row Rand value (e.g. prevClose) to cents under the chosen scale. */
  centsMultiplier: 1 | 100;
}

/**
 * @param lastRands  the worker's mapped `Quote.last` (intended to be Rands, but
 *                   may actually be an un-divided cents value — the 100× bug).
 * @param referenceCents  existing `securities_c.last_price` in cents (0 if unknown).
 */
export function chooseDisplayCents(lastRands: number, referenceCents: number): CentsChoice {
  if (!Number.isFinite(lastRands) || lastRands <= 0) {
    return { cents: 0, basis: "empty", centsMultiplier: 100 };
  }
  const asRands = Math.round(lastRands * 100); // mapped value treated as Rands (the intended path)
  if (!Number.isFinite(referenceCents) || referenceCents <= 0) {
    return { cents: asRands, basis: "no-reference", centsMultiplier: 100 };
  }
  const asCents = Math.round(lastRands); // mapped value was actually cents (the 100× mis-scale)
  const dist = (c: number) => Math.abs(Math.log(c / referenceCents));
  if (asCents > 0 && dist(asCents) < dist(asRands)) {
    return { cents: asCents, basis: "cents-mislabeled", centsMultiplier: 1 };
  }
  return { cents: asRands, basis: "rands", centsMultiplier: 100 };
}
