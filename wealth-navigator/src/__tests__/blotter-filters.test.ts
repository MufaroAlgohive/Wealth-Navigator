import { describe, expect, it } from "vitest";

import {
  isLiveBlotterAuditRow,
  matchesBlotterDate,
  matchesBlotterStatus,
} from "@/lib/orders/blotter-filters";

describe("Live OEM blotter scope", () => {
  it("excludes both UAT sources and test-tagged client orders", () => {
    expect(isLiveBlotterAuditRow({ source: "UAT_ADHOC_ORDER", payload: {} })).toBe(false);
    expect(isLiveBlotterAuditRow({ source: "MINT_CLIENT_ORDER", payload: { uat_test: true } })).toBe(false);
    expect(isLiveBlotterAuditRow({ source: "MINT_CLIENT_ORDER", payload: { uat_test: false } })).toBe(true);
  });
});

describe("OEM blotter filters", () => {
  it("allows combined statuses and groups partial fills under Working", () => {
    const selected = new Set(["WORKING", "FILLED"] as const);
    expect(matchesBlotterStatus("WORKING", selected)).toBe(true);
    expect(matchesBlotterStatus("PARTIAL", selected)).toBe(true);
    expect(matchesBlotterStatus("FILLED", selected)).toBe(true);
    expect(matchesBlotterStatus("REJECTED", selected)).toBe(false);
  });

  it("filters independently by exact date, month, and year", () => {
    const ts = Date.parse("2026-07-29T10:15:00.000Z");
    expect(matchesBlotterDate(ts, "DATE", "2026-07-29")).toBe(true);
    expect(matchesBlotterDate(ts, "MONTH", "2026-07")).toBe(true);
    expect(matchesBlotterDate(ts, "YEAR", "2026")).toBe(true);
    expect(matchesBlotterDate(ts, "MONTH", "2026-06")).toBe(false);
  });
});
