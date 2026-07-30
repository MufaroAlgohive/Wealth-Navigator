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

export type TruthSeverity = "ok" | "warning" | "urgent";

export function classifyDifference(differenceCents: number, baselineCents: number): TruthSeverity {
  const absolute = Math.abs(differenceCents);
  const ratio = baselineCents > 0 ? absolute / baselineCents : absolute > 0 ? 1 : 0;
  if (absolute >= 10_000 || ratio >= 0.02) return "urgent";
  if (absolute >= 100 || ratio >= 0.0025) return "warning";
  return "ok";
}

export function possibleDifferenceReasons(input: {
  differenceCents: number;
  canonicalAsOf?: string | null;
  quoteTime?: string | null;
  residualUpdatedAt?: string | null;
  hasReserve: boolean;
  hasLiability: boolean;
}) {
  const reasons: string[] = [];
  if (input.differenceCents === 0)
    return ["Live reconstruction agrees with the canonical value to the cent."];
  if (
    input.canonicalAsOf &&
    input.quoteTime &&
    input.quoteTime.slice(0, 10) > input.canonicalAsOf.slice(0, 10)
  ) {
    reasons.push(
      "Yahoo prices are newer than the canonical valuation date, so genuine market movement is included.",
    );
  }
  if (
    input.residualUpdatedAt &&
    input.canonicalAsOf &&
    input.residualUpdatedAt.slice(0, 10) > input.canonicalAsOf.slice(0, 10)
  ) {
    reasons.push("Residual cash changed after the canonical valuation was published.");
  }
  if (input.hasReserve)
    reasons.push("Unused execution reserve is included separately from strategy residual cash.");
  if (input.hasLiability) reasons.push("Open accrued fees reduce the independently reconstructed value.");
  reasons.push(
    "Check quantity, fill-price units, late settlement, corporate actions, and missing canonical publication.",
  );
  return reasons;
}

export function returnScopeBenchmarks(clientYtd: number | null, strategyYtd: number | null) {
  return {
    investorsExpectedYtd: clientYtd,
    strategyPageExpectedYtd: strategyYtd,
    factsheetExpectedYtd: strategyYtd,
  };
}
