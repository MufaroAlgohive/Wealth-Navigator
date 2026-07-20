/**
 * Y-domain for the Research IC price-with-triggers chart.
 *
 * Anchors on the live price series (and optional "now" mark). Triggers that sit
 * near the band are folded into the domain; triggers far outside (e.g. stale
 * post-corporate-action levels at 4–5× the market) stay off-scale so they don't
 * crush the series into a flat line at the bottom of the pane.
 */

export type ChartDomain = {
  min: number;
  max: number;
  /** Trigger prices included in the visible y-range. */
  inRange: number[];
  /** Trigger prices rendered as ↑/↓ edge annotations. */
  offScale: number[];
};

/**
 * @param pricePts  series values in Rands (major units)
 * @param triggerPrices  trigger levels in Rands
 * @param current  optional live last in Rands
 */
export function priceTriggerYDomain(
  pricePts: number[],
  triggerPrices: number[],
  current?: number | null,
): ChartDomain | null {
  const series = [...pricePts, ...(current != null && Number.isFinite(current) ? [current] : [])].filter(
    (n) => Number.isFinite(n) && n > 0,
  );
  const triggers = triggerPrices.filter((n) => Number.isFinite(n) && n > 0);

  if (series.length === 0 && triggers.length === 0) return null;

  // No series yet — fall back to trigger span so levels still render.
  if (series.length === 0) {
    const lo = Math.min(...triggers);
    const hi = Math.max(...triggers);
    const span = hi - lo > 0 ? hi - lo : lo * 0.05 || 1;
    return {
      min: lo - span * 0.08,
      max: hi + span * 0.08,
      inRange: triggers,
      offScale: [],
    };
  }

  const dataLo = Math.min(...series);
  const dataHi = Math.max(...series);
  let dataSpan = dataHi - dataLo;
  if (dataSpan <= 0) dataSpan = (dataHi || 1) * 0.05;

  // Near = within 1.5× the series span of either edge. Farther than that is
  // treated as off-scale (typical when thesis levels pre-date a ~5× re-base).
  const nearLo = dataLo - dataSpan * 1.5;
  const nearHi = dataHi + dataSpan * 1.5;
  const inRange = triggers.filter((t) => t >= nearLo && t <= nearHi);
  const offScale = triggers.filter((t) => t < nearLo || t > nearHi);

  const lo = inRange.length > 0 ? Math.min(dataLo, ...inRange) : dataLo;
  const hi = inRange.length > 0 ? Math.max(dataHi, ...inRange) : dataHi;
  const span = hi - lo > 0 ? hi - lo : dataSpan;
  return {
    min: lo - span * 0.08,
    max: hi + span * 0.08,
    inRange,
    offScale,
  };
}
