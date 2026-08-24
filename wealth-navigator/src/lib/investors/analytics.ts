export type DailyReturnPoint = { date: string; dailyPct: number | null };
export type WealthPoint = { date: string; value: number };

export function buildWealthIndex(points: DailyReturnPoint[], base = 100): WealthPoint[] {
  let wealth = base;
  const out: WealthPoint[] = [];
  for (const point of [...points].sort((a, b) => a.date.localeCompare(b.date))) {
    if (point.dailyPct == null || !Number.isFinite(point.dailyPct)) continue;
    wealth *= 1 + point.dailyPct / 100;
    if (!(wealth > 0) || !Number.isFinite(wealth)) continue;
    out.push({ date: point.date, value: wealth });
  }
  return out;
}

export function calculateRisk(index: WealthPoint[]) {
  const ordered = [...index].sort((a, b) => a.date.localeCompare(b.date));
  if (ordered.length < 3) return { sharpe: null, sortino: null, vol: null, maxDD: null, annRet: null };
  const returns: number[] = [];
  for (let i = 1; i < ordered.length; i += 1) {
    const previous = ordered[i - 1]!.value;
    const current = ordered[i]!.value;
    if (previous > 0 && current > 0) returns.push(current / previous - 1);
  }
  if (returns.length < 2) return { sharpe: null, sortino: null, vol: null, maxDD: null, annRet: null };
  const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length;
  const variance = returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (returns.length - 1);
  const standardDeviation = Math.sqrt(Math.max(0, variance));
  const downsideReturns = returns.filter((value) => value < 0);
  const downsideDeviation = downsideReturns.length
    ? Math.sqrt(downsideReturns.reduce((sum, value) => sum + value ** 2, 0) / downsideReturns.length)
    : 0;
  let peak = ordered[0]!.value;
  let maxDrawdown = 0;
  for (const point of ordered) {
    peak = Math.max(peak, point.value);
    maxDrawdown = Math.min(maxDrawdown, point.value / peak - 1);
  }
  const totalReturn = ordered.at(-1)!.value / ordered[0]!.value;
  const annualised = totalReturn > 0 ? totalReturn ** (252 / returns.length) - 1 : null;
  return {
    sharpe: standardDeviation > 0 ? (mean / standardDeviation) * Math.sqrt(252) : null,
    sortino: downsideDeviation > 0 ? (mean / downsideDeviation) * Math.sqrt(252) : null,
    vol: standardDeviation * Math.sqrt(252) * 100,
    maxDD: maxDrawdown * 100,
    annRet: annualised == null ? null : annualised * 100,
  };
}

export function calculateMonthlyReturns(index: WealthPoint[]): Record<string, Record<number, number>> {
  const ordered = [...index].sort((a, b) => a.date.localeCompare(b.date));
  const priorMonthClose = new Map<string, number>();
  const monthEnd = new Map<string, number>();
  for (const point of ordered) monthEnd.set(point.date.slice(0, 7), point.value);
  // The wealth index starts from 100, so the first observed month can be
  // measured against that explicit opening baseline as well.
  let previous: number | null = 100;
  for (const month of [...monthEnd.keys()].sort()) {
    if (previous != null) priorMonthClose.set(month, previous);
    previous = monthEnd.get(month)!;
  }
  const result: Record<string, Record<number, number>> = {};
  for (const [month, close] of monthEnd) {
    const baseline = priorMonthClose.get(month);
    if (!(baseline && baseline > 0)) continue;
    const [year, monthNumber] = month.split("-").map(Number);
    (result[String(year)] ||= {})[monthNumber! - 1] = (close / baseline - 1) * 100;
  }
  return result;
}

export function valueWeightedReturn(rows: Array<{ valueCents: number; returnPct: number | null }>): number | null {
  const eligible = rows.filter((row) => row.valueCents > 0 && row.returnPct != null && Number.isFinite(row.returnPct));
  const denominator = eligible.reduce((sum, row) => sum + row.valueCents, 0);
  return denominator > 0
    ? eligible.reduce((sum, row) => sum + row.valueCents * Number(row.returnPct), 0) / denominator
    : null;
}
