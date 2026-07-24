/**
 * Reference-anchored price scaling for JSE market data (shared by the worker
 * ingest path and the Vercel BFF chart routes).
 *
 * IRESS returns JSE prices inconsistently — some names as a bare value in ZAR
 * (Rands), others as integer cents — and a naive magnitude heuristic mis-scales
 * by exactly 100× for sub-~R45 stocks when there is no OHLC anchor (the
 * 2026-06-13/14 coverage probe: 121 / 128 priced symbols were 100× off, all
 * clustered below R45). The same ambiguity exists in TimeSeriesGet2 history
 * rows: the client maps `ClosePrice` verbatim (see src/lib/iress/live.ts) and
 * the wire scale is not guaranteed, so a blind ÷100 on a LABELLED price chart
 * is unsafe — it could render every price 100× off in either direction.
 *
 * `chooseDisplayCents` removes the guesswork by anchoring to a known reference
 * price — the existing `securities_c.last_price` (cents) — and picking the
 * interpretation of the value whose magnitude best matches. Because the two
 * candidates differ by 100×, even a stale or moderately-off reference still
 * disambiguates correctly. With no reference it falls back to the plain
 * Rands→cents conversion, so it never makes things worse.
 *
 * `anchorHistoryToRands` applies the same logic to a whole IRESS price series:
 * it picks ONE scale for the series from a robust representative (the median),
 * so a single outlier can't flip the scale mid-series, and returns the points
 * in RANDS (major units). It reports `anchored=false` when there is no usable
 * reference — callers should prefer Yahoo in that case rather than trust an
 * unanchored guess on a client-facing chart.
 */

export interface CentsChoice {
  /** Chosen price in cents (the unit `stock_intraday_c.current_price` expects). */
  cents: number;
  basis: "rands" | "cents-mislabeled" | "no-reference" | "empty";
  /** Multiplier to convert a same-scale value to cents under the chosen scale. */
  centsMultiplier: 1 | 100;
  /**
   * True ONLY when a positive reference actually disambiguated the cents/Rand
   * scale (basis "rands" or "cents-mislabeled"). False for "no-reference" and
   * "empty" — i.e. the ×100 was a GUESS, not a verified scale.
   *
   * Money-track writers (securities_c.last_price / stock_intraday_c) MUST NOT
   * persist a value when this is false: an unanchored ×100 guess is exactly what
   * seeds the daily corruption. Display/chart callers may still show it (with a
   * caveat) or prefer Yahoo. See docs/IRESS_PRICE_SCALE_INCIDENT_HANDOFF.md.
   */
  scaleVerified: boolean;
}

/**
 * @param lastRands  the value intended to be Rands, but which may actually be an
 *                   un-divided cents value (the 100× ambiguity).
 * @param referenceCents  existing `securities_c.last_price` in cents (0 if unknown).
 *                   NOTE: the tick loop OVERWRITES this column, so a corrupted
 *                   value here can "confirm" its own ×100 scale — the
 *                   self-perpetuating anchor behind the daily corruption.
 * @param trustedRefCents  optional IMMUTABLE, human-verified magnitude in cents
 *                   (e.g. securities_c.scale_ref_cents) that no tick loop
 *                   overwrites. When > 0 it takes precedence over referenceCents,
 *                   breaking the self-referential anchor. Default 0 (disabled) →
 *                   behaviour identical to the original two-argument form.
 */
export function chooseDisplayCents(
  lastRands: number,
  referenceCents: number,
  trustedRefCents = 0,
): CentsChoice {
  if (!Number.isFinite(lastRands) || lastRands <= 0) {
    return { cents: 0, basis: "empty", centsMultiplier: 100, scaleVerified: false };
  }
  const asRands = Math.round(lastRands * 100); // value treated as Rands (the intended path)
  // Prefer the immutable trusted reference; fall back to the mutable last_price.
  const ref =
    Number.isFinite(trustedRefCents) && trustedRefCents > 0 ? trustedRefCents : referenceCents;
  if (!Number.isFinite(ref) || ref <= 0) {
    // No anchor → the ×100 is a GUESS, not a verified scale. Kept for the chart
    // path (anchored=false ⇒ prefer Yahoo); money-track writers must skip on
    // scaleVerified=false rather than persist an unanchored guess.
    return { cents: asRands, basis: "no-reference", centsMultiplier: 100, scaleVerified: false };
  }
  const asCents = Math.round(lastRands); // value was actually cents (the 100× mis-scale)
  const dist = (c: number) => Math.abs(Math.log(c / ref));
  if (asCents > 0 && dist(asCents) < dist(asRands)) {
    return { cents: asCents, basis: "cents-mislabeled", centsMultiplier: 1, scaleVerified: true };
  }
  return { cents: asRands, basis: "rands", centsMultiplier: 100, scaleVerified: true };
}

export interface AnchoredSeries {
  /** Series in RANDS (major units), key `c` to match the chart component shape. */
  points: Array<{ t: number; c: number }>;
  /** rands = rawValue * multiplier (0.01 when the series is cents, 1 when rands). */
  multiplier: number;
  basis: CentsChoice["basis"];
  /** True when a reference disambiguated the scale; false → caller should prefer Yahoo. */
  anchored: boolean;
}

/**
 * Normalize an IRESS price series (raw values in an ambiguous rands|cents scale)
 * to RANDS, anchored to `referenceCents` (securities_c.last_price, cents). Picks
 * one scale for the whole series from the median positive value so an outlier
 * can't flip it. Returns `anchored=false` when there is no usable reference.
 */
export function anchorHistoryToRands(
  raw: Array<{ t: number; v: number }>,
  referenceCents: number,
  trustedRefCents = 0,
): AnchoredSeries {
  const positive = raw
    .map((p) => p.v)
    .filter((v) => Number.isFinite(v) && v > 0)
    .sort((a, b) => a - b);
  if (positive.length === 0) {
    return { points: [], multiplier: 0.01, basis: "empty", anchored: false };
  }
  const representative = positive[Math.floor(positive.length / 2)]!; // median
  const choice = chooseDisplayCents(representative, referenceCents, trustedRefCents);
  const multiplier = choice.centsMultiplier / 100; // rands = value * centsMultiplier / 100
  const points = raw
    .filter((p) => Number.isFinite(p.t) && Number.isFinite(p.v) && p.v > 0)
    .map((p) => ({ t: p.t, c: p.v * multiplier }))
    .sort((a, b) => a.t - b.t);
  const anchored = choice.basis === "rands" || choice.basis === "cents-mislabeled";
  return { points, multiplier, basis: choice.basis, anchored };
}
