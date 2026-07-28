export const CASH_ASSET_SYMBOL = "CA" as const;
export const CASH_ASSET_NAME = "Cash asset";
export const CASH_ASSET_COLOR = "#22c55e";

export interface StrategyCashAsset {
  symbol: typeof CASH_ASSET_SYMBOL;
  name: typeof CASH_ASSET_NAME;
  value: number;
  weight: number;
}

export function strategyCashAsset(
  residualCashCents: number,
  securitiesValueCents: number,
): StrategyCashAsset | null {
  if (!Number.isFinite(residualCashCents) || residualCashCents <= 0) return null;
  const securities = Number.isFinite(securitiesValueCents) ? Math.max(0, securitiesValueCents) : 0;
  const invested = securities + residualCashCents;
  return {
    symbol: CASH_ASSET_SYMBOL,
    name: CASH_ASSET_NAME,
    value: residualCashCents / 100,
    weight: invested > 0 ? (residualCashCents / invested) * 100 : 0,
  };
}

export interface StrategyCashReturnRow {
  as_of_date: string;
  continuity_cash_cents: number | null;
  securities_value_cents: number | null;
}

export function strategyCashAssetFromCanonicalReturns(
  rows: StrategyCashReturnRow[],
): StrategyCashAsset | null {
  const latest = [...rows]
    .filter((row) => row.as_of_date)
    .sort((a, b) => b.as_of_date.localeCompare(a.as_of_date))[0];
  if (!latest) return null;
  return strategyCashAsset(
    Number(latest.continuity_cash_cents ?? 0),
    Number(latest.securities_value_cents ?? 0),
  );
}
