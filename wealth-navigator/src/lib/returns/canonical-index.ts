export interface CanonicalDailyReturn {
  as_of_date: string;
  "1d_pct": number | null;
}

export interface IndexedReturnPoint {
  asOfDate: string;
  value: number;
}

export interface CanonicalCumulativeReturn {
  as_of_date: string;
  ytd_pct: number | null;
}

/**
 * Build a wealth index from canonical daily returns. Rebalance cash flows and
 * composition changes never enter this calculation; only the approved daily
 * return chain does.
 */
export function buildCanonicalReturnIndex(rows: CanonicalDailyReturn[]): IndexedReturnPoint[] {
  const ordered = [...rows]
    .filter((row) => row.as_of_date && row["1d_pct"] != null && Number.isFinite(Number(row["1d_pct"])))
    .sort((a, b) => a.as_of_date.localeCompare(b.as_of_date));
  if (!ordered.length) return [];

  let value = 100;
  return ordered.map((row, index) => {
    if (index > 0) value *= 1 + Number(row["1d_pct"]) / 100;
    return { asOfDate: row.as_of_date, value };
  });
}

/**
 * Plot the publisher's chain-linked cumulative YTD values directly. This is
 * the safe factsheet series: old 1d_pct history may reset at legacy
 * composition boundaries, while canonical ytd_pct already neutralises those
 * rebalance cash flows.
 */
export function buildCanonicalYtdSeries(rows: CanonicalCumulativeReturn[]): IndexedReturnPoint[] {
  const ordered = [...rows]
    .filter((row) => row.as_of_date && row.ytd_pct != null && Number.isFinite(Number(row.ytd_pct)))
    .sort((a, b) => a.as_of_date.localeCompare(b.as_of_date));
  if (!ordered.length) return [];
  const latestYear = ordered[ordered.length - 1]?.as_of_date.slice(0, 4) ?? "";
  return ordered
    .filter((row) => row.as_of_date.startsWith(latestYear))
    .map((row) => ({ asOfDate: row.as_of_date, value: 100 * (1 + Number(row.ytd_pct) / 100) }));
}

export function buildCanonicalCalendarReturns(
  rows: CanonicalCumulativeReturn[],
): Record<string, Record<number, number>> {
  const monthEnds = new Map<string, number>();
  for (const row of [...rows].sort((a, b) => a.as_of_date.localeCompare(b.as_of_date))) {
    if (!row.as_of_date || row.ytd_pct == null || !Number.isFinite(Number(row.ytd_pct))) continue;
    monthEnds.set(row.as_of_date.slice(0, 7), 1 + Number(row.ytd_pct) / 100);
  }
  const result: Record<string, Record<number, number>> = {};
  let previousYear = "";
  let previousFactor = 1;
  for (const [yearMonth, factor] of monthEnds) {
    const [year, month] = yearMonth.split("-");
    if (!year || !month) continue;
    if (year !== previousYear) previousFactor = 1;
    if (!result[year]) result[year] = {};
    result[year][Number(month) - 1] = (factor / previousFactor - 1) * 100;
    previousYear = year;
    previousFactor = factor;
  }
  return result;
}
