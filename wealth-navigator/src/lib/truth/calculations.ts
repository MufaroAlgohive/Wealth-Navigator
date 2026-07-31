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

export function chainReturnFromAnchor(
  rows: Array<{ anchorPct?: number | null; dailyPct?: number | null }>,
) {
  if (!rows.length || rows[0]?.anchorPct == null || !Number.isFinite(Number(rows[0].anchorPct))) {
    return null;
  }
  let factor = 1 + Number(rows[0].anchorPct) / 100;
  for (const row of rows.slice(1)) {
    if (row.dailyPct == null || !Number.isFinite(Number(row.dailyPct))) continue;
    factor *= 1 + Number(row.dailyPct) / 100;
  }
  return (factor - 1) * 100;
}

export function classifyPercentageDifference(deltaPp: number | null): TruthSeverity {
  if (deltaPp == null || !Number.isFinite(deltaPp)) return "warning";
  const absolute = Math.abs(deltaPp);
  if (absolute > 0.25) return "urgent";
  if (absolute > 0.01) return "warning";
  return "ok";
}

export function reconcileIressPrice(yahooCents: number, iressLast: number | null) {
  if (!(yahooCents > 0) || iressLast == null || !Number.isFinite(iressLast) || iressLast <= 0) {
    return {
      normalisedCents: null,
      scale: "unavailable" as const,
      differenceCents: null,
      differencePct: null,
      status: "warning" as TruthSeverity,
    };
  }
  const randsCandidate = Math.round(iressLast * 100);
  const centsCandidate = Math.round(iressLast);
  const useCents = Math.abs(centsCandidate - yahooCents) < Math.abs(randsCandidate - yahooCents);
  const normalisedCents = useCents ? centsCandidate : randsCandidate;
  const differenceCents = normalisedCents - yahooCents;
  const differencePct = (differenceCents / yahooCents) * 100;
  const absolutePct = Math.abs(differencePct);
  return {
    normalisedCents,
    scale: useCents ? ("already-cents" as const) : ("rands-x100" as const),
    differenceCents,
    differencePct,
    status: absolutePct > 2 ? "urgent" : absolutePct > 0.5 || useCents ? "warning" : "ok",
  };
}

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

export function reconstructClientHistoryPoint(input: {
  securitiesCents: number | null;
  residualCents: number | null;
  reserveCents: number | null;
  liabilityCents: number | null;
}) {
  if (Object.values(input).some((value) => value == null)) return null;
  return (
    Number(input.securitiesCents) +
    Number(input.residualCents) +
    Number(input.reserveCents) -
    Number(input.liabilityCents)
  );
}

export function reconstructStrategyHistoryPoint(
  securitiesCents: number | null,
  strategyCaCents: number | null,
) {
  if (securitiesCents == null || strategyCaCents == null) return null;
  return Number(securitiesCents) + Number(strategyCaCents);
}
