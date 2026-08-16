import { describe, expect, it } from "vitest";

import {
  AUTOMATIC_CERTIFICATION_ACTOR,
  canonicalDraftShapeBlockers,
} from "@/lib/returns/publish-canonical-ledger-certification";

const periods = Object.fromEntries(
  ["1D", "1W", "WTD", "1M", "3M", "YTD", "SI"].map((period) => [
    period,
    { reference_date: "2026-08-14", denominator_cents: 100_000, return_pct: 1.25 },
  ]),
);

const valid = {
  strategy_id: "00000000-0000-0000-0000-000000000001",
  as_of_date: "2026-08-14",
  certification_status: "DRAFT",
  securities_value_cents: 184_364,
  continuity_cash_cents: 49_194,
  complete_value_cents: 233_558,
  leg_snapshot: [{ ticker: "NED", units: 1 }],
  period_metrics: periods,
  source_evidence: {
    opening_model_snapshot: {},
    ordered_settled_batches: [],
    price_coverage: {},
    reconciliation: {},
  },
  source_evidence_sha256: "a".repeat(64),
  calculation_notes: { daily_writer: "canonical-draft-stable-composition-v1" },
};

describe("canonical daily certification guards", () => {
  it("accepts only a complete continuation draft", () => {
    expect(canonicalDraftShapeBlockers(valid)).toEqual([]);
    expect(AUTOMATIC_CERTIFICATION_ACTOR).toBe("SYSTEM:WEALTH_NAVIGATOR_DAILY_V1");
  });

  it("rejects a value identity mismatch", () => {
    expect(canonicalDraftShapeBlockers({ ...valid, complete_value_cents: 999_999 })).toContain(
      "COMPLETE_VALUE_IDENTITY_FAILED",
    );
  });

  it("never automatically certifies a newly bootstrapped strategy", () => {
    expect(
      canonicalDraftShapeBlockers({
        ...valid,
        calculation_notes: { daily_writer: "canonical-draft-auto-inception-v1" },
      }),
    ).toContain("AUTOMATIC_SEED_FORBIDDEN");
  });

  it("requires the full evidence family and every public period", () => {
    const broken = canonicalDraftShapeBlockers({
      ...valid,
      source_evidence: {},
      period_metrics: { ...periods, YTD: { reference_date: "2026-08-14", denominator_cents: 0 } },
    });
    expect(broken).toContain("EVIDENCE_PRICE_COVERAGE_MISSING");
    expect(broken).toContain("PERIOD_YTD_RETURN_INVALID");
    expect(broken).toContain("PERIOD_YTD_DENOMINATOR_INVALID");
  });
});
