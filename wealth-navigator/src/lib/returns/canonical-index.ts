export interface CanonicalDailyReturn {
  as_of_date: string;
  "1d_pct": number | null;
}

export interface IndexedReturnPoint {
  asOfDate: string;
  value: number;
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
