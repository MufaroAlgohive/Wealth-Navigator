import { describe, expect, it } from "vitest";

import {
  calculatePositionTruth,
  calculateStrategyCashAsset,
  chainReturnFromAnchor,
  classifyPercentageDifference,
  classifyDifference,
  possibleDifferenceReasons,
  reconstructClientHistoryPoint,
  reconstructStrategyHistoryPoint,
  reconcileIressPrice,
  returnScopeBenchmarks,
} from "@/lib/truth/calculations";
import { yahooPriceToCents } from "@/lib/truth/yahoo-live";

describe("source-of-truth calculations", () => {
  it("keeps residual and execution reserve separate in client value", () => {
    const result = calculatePositionTruth({
      securitiesCents: 127_772,
      residualCents: 14_847,
      reserveCents: 8_413,
      liabilityCents: 0,
      canonicalValueCents: 151_032,
      canonicalPnlCents: -5_251,
    });
    expect(result.liveValueCents).toBe(151_032);
    expect(result.investedCents).toBe(156_283);
    expect(result.livePnlCents).toBe(-5_251);
    expect(result.differenceCents).toBe(0);
  });

  it("derives strategy CA only from that strategy model", () => {
    expect(calculateStrategyCashAsset(151_153, 2_000)).toMatchObject({
      modelCapitalCents: 200_000,
      strategyCaCents: 48_847,
    });
  });

  it("normalises Yahoo JSE and major-currency prices to cents", () => {
    expect(yahooPriceToCents("BHG.JO", 701.71)).toBe(702);
    expect(yahooPriceToCents("AAPL", 215.4)).toBe(21_540);
  });

  it("escalates material cent and percentage differences", () => {
    expect(classifyDifference(0, 100_000)).toBe("ok");
    expect(classifyDifference(500, 100_000)).toBe("warning");
    expect(classifyDifference(2_100, 100_000)).toBe("urgent");
    expect(classifyDifference(10_000, 2_000_000)).toBe("urgent");
  });

  it("explains timing, reserve and liability evidence without claiming certainty", () => {
    const reasons = possibleDifferenceReasons({
      differenceCents: 250,
      canonicalAsOf: "2026-07-28",
      quoteTime: "2026-07-29T12:00:00Z",
      residualUpdatedAt: "2026-07-29T10:00:00Z",
      hasReserve: true,
      hasLiability: true,
    });
    expect(reasons.join(" ")).toContain("newer than the canonical");
    expect(reasons.join(" ")).toContain("Residual cash changed");
    expect(reasons.join(" ")).toContain("execution reserve");
    expect(reasons.join(" ")).toContain("accrued fees");
  });

  it("never compares personal client YTD with strategy-page or factsheet YTD", () => {
    expect(returnScopeBenchmarks(-5.08, 5.274)).toEqual({
      investorsExpectedYtd: -5.08,
      strategyPageExpectedYtd: 5.274,
      factsheetExpectedYtd: 5.274,
    });
  });

  it("reconstructs dated client and strategy values without merging CA and reserve", () => {
    expect(
      reconstructClientHistoryPoint({
        securitiesCents: 127_772,
        residualCents: 14_847,
        reserveCents: 8_413,
        liabilityCents: 100,
      }),
    ).toBe(150_932);
    expect(reconstructStrategyHistoryPoint(151_153, 48_847)).toBe(200_000);
  });

  it("refuses to invent a historical value when a component is missing", () => {
    expect(
      reconstructClientHistoryPoint({
        securitiesCents: 127_772,
        residualCents: null,
        reserveCents: 8_413,
        liabilityCents: 0,
      }),
    ).toBeNull();
    expect(reconstructStrategyHistoryPoint(151_153, null)).toBeNull();
  });

  it("rebuilds YTD from the approved opening anchor and later daily returns", () => {
    const rebuilt = chainReturnFromAnchor([
      { anchorPct: -0.2901196997362548, dailyPct: null },
      { dailyPct: -0.773869 },
      { dailyPct: -0.399863 },
      { dailyPct: 0.139313 },
    ]);
    expect(rebuilt).toBeCloseTo(-1.320077, 5);
    expect(classifyPercentageDifference(0.000002)).toBe("ok");
    expect(classifyPercentageDifference(0.1)).toBe("warning");
    expect(classifyPercentageDifference(0.3)).toBe("urgent");
  });

  it("normalises IRESS Rand and already-cent quotes against Yahoo without hiding scale anomalies", () => {
    expect(reconcileIressPrice(12_474, 124.74)).toMatchObject({
      normalisedCents: 12_474,
      scale: "rands-x100",
      differenceCents: 0,
      status: "ok",
    });
    expect(reconcileIressPrice(3_082, 3_082)).toMatchObject({
      normalisedCents: 3_082,
      scale: "already-cents",
      differenceCents: 0,
      status: "warning",
    });
  });
});
