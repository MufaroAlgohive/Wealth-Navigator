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
  all_pct?: number | null;
}

export type CanonicalChartRange = "YTD" | "3M" | "6M" | "1Y" | "ALL";

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

/**
 * Build a rebalance-safe chart for a requested factsheet window. YTD uses the
 * publisher's YTD chain directly. Longer windows rebase the canonical all-time
 * chain at the first available point in the window; raw basket values are never
 * used because composition changes would appear as investment performance.
 */
export function buildCanonicalPeriodSeries(
  rows: CanonicalCumulativeReturn[],
  range: CanonicalChartRange,
): IndexedReturnPoint[] {
  if (range === "YTD") return buildCanonicalYtdSeries(rows);
  const ordered = [...rows]
    .filter(
      (row) =>
        row.as_of_date &&
        row.all_pct != null &&
        Number.isFinite(Number(row.all_pct)) &&
        1 + Number(row.all_pct) / 100 > 0,
    )
    .sort((a, b) => a.as_of_date.localeCompare(b.as_of_date));
  const latest = ordered.at(-1);
  if (!latest) return [];
  const cutoff = new Date(`${latest.as_of_date}T00:00:00Z`);
  if (range !== "ALL") {
    const months = range === "3M" ? 3 : range === "6M" ? 6 : 12;
    cutoff.setUTCMonth(cutoff.getUTCMonth() - months);
  }
  const visible =
    range === "ALL"
      ? ordered
      : ordered.filter((row) => new Date(`${row.as_of_date}T00:00:00Z`) >= cutoff);
  const base = visible[0] ? 1 + Number(visible[0].all_pct) / 100 : null;
  if (!base) return [];
  return visible.map((row) => ({
    asOfDate: row.as_of_date,
    value: 100 * ((1 + Number(row.all_pct) / 100) / base),
  }));
}

/** Monetary move for one canonical strategy basket/model unit. */
export function canonicalDailyPnlCents(
  completeValueCents: number | null | undefined,
  dailyReturnPct: number | null | undefined,
): number | null {
  if (
    completeValueCents == null ||
    dailyReturnPct == null ||
    !Number.isFinite(Number(completeValueCents)) ||
    !Number.isFinite(Number(dailyReturnPct))
  ) {
    return null;
  }
  const current = Number(completeValueCents);
  const factor = 1 + Number(dailyReturnPct) / 100;
  if (factor <= 0) return null;
  return Math.round(current - current / factor);
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
