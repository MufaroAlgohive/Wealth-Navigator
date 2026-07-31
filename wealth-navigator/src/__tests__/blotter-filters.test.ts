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
    expect(
      isLiveBlotterAuditRow(
        {
          source: "MINT_CLIENT_ORDER",
          payload: { uat_test: false, trader: "lulamasw@gmail.com" },
        },
        new Set(["uat-user"]),
        new Set(["lulamasw@gmail.com"]),
      ),
    ).toBe(false);
    expect(
      isLiveBlotterAuditRow(
        { source: "MINT_CLIENT_ORDER", payload: { user_id: "uat-user" } },
        new Set(["uat-user"]),
      ),
    ).toBe(false);
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

  it("supports a one-click Today filter", () => {
    expect(matchesBlotterDate(Date.now(), "TODAY", "")).toBe(true);
    expect(matchesBlotterDate(Date.now() - 48 * 60 * 60 * 1000, "TODAY", "")).toBe(false);
  });
});
