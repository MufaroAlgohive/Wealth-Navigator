/** Lightweight technical helpers from close series (no external deps). */

export function computeRsi(closes: number[], period = 14): number | null {
  if (closes.length < period + 1) return null;
  let gains = 0;
  let losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const prev = closes[i - 1];
    const cur = closes[i];
    if (prev == null || cur == null) return null;
    const d = cur - prev;
    if (d >= 0) gains += d;
    else losses -= d;
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

/** Simple momentum: pct change over the last `lookback` closes. */
export function computeMomentum(closes: number[], lookback = 20): number | null {
  if (closes.length < lookback + 1) return null;
  const last = closes[closes.length - 1];
  const base = closes[closes.length - 1 - lookback];
  if (last == null || base == null || base === 0) return null;
  return ((last - base) / base) * 100;
}
