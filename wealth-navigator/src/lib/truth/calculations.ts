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

/**
 * Revalue a strategy without allowing market movement to manufacture or erase
 * cash.  The attributable cash sleeve is a ledger/model input; it is not the
 * balancing figure between today's securities and the original minimum.
 */
export function calculateStrategyLiveValue(securitiesCents: number, attributableCashCents: number) {
  const liveSecuritiesCents = Math.round(securitiesCents);
  const strategyCaCents = Math.round(attributableCashCents);
  if (liveSecuritiesCents < 0 || strategyCaCents < 0) {
    throw new Error("Strategy live value cannot be reconstructed from negative securities or CA");
  }
  const modelCapitalCents = liveSecuritiesCents + strategyCaCents;
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

export type ValuationComparisonKind =
  | "timestamp-aligned"
  | "market-movement"
  | "provider-stale"
  | "timestamp-unavailable";

/**
 * A price from a different valuation date cannot prove an accounting error.
 * Preserve the monetary drift for information, but cap severity at warning
 * until both sides are timestamp-aligned.
 */
export function classifyValuationComparison(input: {
  differenceCents: number;
  baselineCents: number;
  canonicalAsOf?: string | null;
  quoteTime?: string | null;
}) {
  const canonicalDate = String(input.canonicalAsOf ?? "").slice(0, 10);
  const quoteDate = String(input.quoteTime ?? "").slice(0, 10);
  if (!canonicalDate || !quoteDate) {
    return {
      kind: "timestamp-unavailable" as ValuationComparisonKind,
      severity: "warning" as TruthSeverity,
      accountingComparable: false,
      message: "Timestamp alignment is unavailable, so the monetary drift is not proof of an accounting error.",
    };
  }
  if (quoteDate > canonicalDate) {
    return {
      kind: "market-movement" as ValuationComparisonKind,
      severity: "warning" as TruthSeverity,
      accountingComparable: false,
      message: "Live prices are newer than the canonical valuation; the drift is market movement until a same-date check proves otherwise.",
    };
  }
  if (quoteDate < canonicalDate) {
    return {
      kind: "provider-stale" as ValuationComparisonKind,
      severity: "warning" as TruthSeverity,
      accountingComparable: false,
      message: "The provider price predates the canonical valuation and cannot prove the current accounting value.",
    };
  }
  return {
    kind: "timestamp-aligned" as ValuationComparisonKind,
    severity: classifyDifference(input.differenceCents, input.baselineCents),
    accountingComparable: true,
    message: "Provider and canonical values share the same valuation date.",
  };
}

export function auditReturnChain(
  rows: Array<{ date?: string | null; anchorPct?: number | null; dailyPct?: number | null }>,
) {
  const sorted = [...rows].sort((a, b) => String(a.date ?? "").localeCompare(String(b.date ?? "")));
  const dates = sorted.map((row) => String(row.date ?? "").slice(0, 10)).filter(Boolean);
  const duplicates = [...new Set(dates.filter((date, index) => dates.indexOf(date) !== index))];
  const missingDailyDates = sorted
    .slice(1)
    .filter((row) => row.dailyPct == null || !Number.isFinite(Number(row.dailyPct)))
    .map((row) => String(row.date ?? "unknown"));
  let largestCalendarGapDays = 0;
  for (let index = 1; index < dates.length; index += 1) {
    const previous = Date.parse(`${dates[index - 1]}T00:00:00Z`);
    const current = Date.parse(`${dates[index]}T00:00:00Z`);
    if (Number.isFinite(previous) && Number.isFinite(current)) {
      largestCalendarGapDays = Math.max(largestCalendarGapDays, Math.round((current - previous) / 86_400_000));
    }
  }
  const anchorAvailable = sorted[0]?.anchorPct != null && Number.isFinite(Number(sorted[0]?.anchorPct));
  const complete = Boolean(sorted.length && anchorAvailable && !duplicates.length && !missingDailyDates.length);
  return {
    complete,
    observedRows: sorted.length,
    anchorAvailable,
    missingDailyDates,
    duplicateDates: duplicates,
    largestCalendarGapDays,
    returnPct: complete
      ? chainReturnFromAnchor(sorted.map((row) => ({ anchorPct: row.anchorPct, dailyPct: row.dailyPct })))
      : null,
  };
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
