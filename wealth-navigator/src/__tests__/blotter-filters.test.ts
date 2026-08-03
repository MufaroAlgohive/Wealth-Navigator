import { describe, expect, it } from "vitest";

import {
  isLiveBlotterAuditRow,
  isUatBlotterAuditRow,
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

  it("puts every explicit or identity-derived test order in UAT and nowhere else", () => {
    const testIds = new Set(["test-owner"]);
    const testEmails = new Set(["test@mymint.co.za"]);
    const rows = [
      { source: "OB_SEND_TO_MARKET_UAT", payload: {} },
      { source: "MINT_CLIENT_ORDER", payload: { uat_test: true } },
      { source: "MINT_CLIENT_ORDER", payload: { owner_user_id: "test-owner" } },
      { source: "MINT_CLIENT_ORDER", payload: { investor_email: "TEST@mymint.co.za" } },
    ];
    for (const row of rows) {
      expect(isUatBlotterAuditRow(row, testIds, testEmails)).toBe(true);
      expect(isLiveBlotterAuditRow(row, testIds, testEmails)).toBe(false);
    }
    const live = { source: "MINT_CLIENT_ORDER", payload: { user_id: "real-owner" } };
    expect(isUatBlotterAuditRow(live, testIds, testEmails)).toBe(false);
    expect(isLiveBlotterAuditRow(live, testIds, testEmails)).toBe(true);
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
