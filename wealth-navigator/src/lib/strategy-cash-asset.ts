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
