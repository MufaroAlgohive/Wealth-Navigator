export interface PositionTruthInput {
  securitiesCents: number;
  residualCents: number;
  reserveCents: number;
  liabilityCents: number;
  canonicalValueCents: number;
  canonicalPnlCents: number;
}

export function calculatePositionTruth(input: PositionTruthInput) {
  const liveValueCents =
    input.securitiesCents + input.residualCents + input.reserveCents - input.liabilityCents;
  const investedCents = input.canonicalValueCents - input.canonicalPnlCents;
  const livePnlCents = liveValueCents - investedCents;
  return {
    liveValueCents,
    investedCents,
    livePnlCents,
    liveReturnPct: investedCents > 0 ? (livePnlCents / investedCents) * 100 : null,
    differenceCents: liveValueCents - input.canonicalValueCents,
  };
}

export function calculateStrategyCashAsset(securitiesCents: number, minimumInvestmentRands: number) {
  const modelCapitalCents = Math.max(Math.round(minimumInvestmentRands * 100), securitiesCents);
  const strategyCaCents = modelCapitalCents - securitiesCents;
  return {
    modelCapitalCents,
    strategyCaCents,
    caWeightPct: modelCapitalCents > 0 ? (strategyCaCents / modelCapitalCents) * 100 : 0,
  };
}
