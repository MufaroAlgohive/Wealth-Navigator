export interface ProceedsBridgeInput {
  grossSellCents: number;
  grossBuyCents: number;
  sellAssetCount: number;
  buyAssetCount: number;
  brokerageRate: number;
  custodyFeeCents: number;
  reserveCents: number;
  residualCents?: number;
}

const safeMoney = (value: number) => Math.max(0, Math.round(Number(value) || 0));
const safeCount = (value: number) => Math.max(0, Math.floor(Number(value) || 0));

/**
 * Preview the same reserve-first cash bridge used by rebalance settlement.
 * Gross proceeds and gross buys remain explicit; execution reserve absorbs
 * fees first and only the uncovered fee shortfall reduces available cash.
 */
export function calculateProceedsBridge(input: ProceedsBridgeInput) {
  const grossSellCents = safeMoney(input.grossSellCents);
  const grossBuyCents = safeMoney(input.grossBuyCents);
  const brokerageRate = Number(input.brokerageRate);
  const custodyFeeCents = safeMoney(input.custodyFeeCents);
  if (!Number.isFinite(brokerageRate) || brokerageRate < 0) {
    throw new Error("Rebalance brokerage rate must be a non-negative number");
  }

  const sellBrokerageCents = Math.round(grossSellCents * brokerageRate);
  const buyBrokerageCents = Math.round(grossBuyCents * brokerageRate);
  const sellCustodyCents = grossSellCents > 0 ? safeCount(input.sellAssetCount) * custodyFeeCents : 0;
  const buyCustodyCents = grossBuyCents > 0 ? safeCount(input.buyAssetCount) * custodyFeeCents : 0;
  const sellFeesCents = sellBrokerageCents + sellCustodyCents;
  const buyFeesCents = buyBrokerageCents + buyCustodyCents;
  const totalFeesCents = sellFeesCents + buyFeesCents;
  const reserveCents = safeMoney(input.reserveCents);
  const reserveUsedCents = Math.min(reserveCents, totalFeesCents);
  const feeShortfallCents = totalFeesCents - reserveUsedCents;
  const netProceedsCents = Math.max(0, grossSellCents - sellFeesCents);
  const residualCents = safeMoney(input.residualCents ?? 0);
  const strategyCashDeltaCents =
    residualCents + grossSellCents - grossBuyCents - feeShortfallCents;
  // Preserve the signed result. Clamping a shortfall to zero makes an
  // unfundable buy look settled and silently destroys value.
  const strategyCashAfterCents = strategyCashDeltaCents;

  return {
    grossSellCents,
    grossBuyCents,
    sellBrokerageCents,
    sellCustodyCents,
    sellFeesCents,
    netProceedsCents,
    buyBrokerageCents,
    buyCustodyCents,
    buyFeesCents,
    totalFeesCents,
    reserveCents,
    reserveUsedCents,
    reserveAfterCents: reserveCents - reserveUsedCents,
    feeShortfallCents,
    residualCents,
    strategyCashAfterCents,
    cashAfterCents: strategyCashDeltaCents,
    shortfall: strategyCashDeltaCents < 0,
  };
}
