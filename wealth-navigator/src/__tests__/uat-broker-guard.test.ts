import { describe, expect, it } from "vitest";

import { isUatBrokerBlocked } from "@/lib/orders/uat-guard";

/**
 * The single predicate that keeps UAT orders off the broker. A UAT order is one
 * whose source is UAT_ADHOC_ORDER or which is tagged payload.uat_test === true;
 * every send-to-broker path checks this so UAT can only ever self-fill.
 */
describe("isUatBrokerBlocked", () => {
  it("blocks UAT_ADHOC_ORDER source (any case)", () => {
    expect(isUatBrokerBlocked({ source: "UAT_ADHOC_ORDER" })).toBe(true);
    expect(isUatBrokerBlocked({ source: "uat_adhoc_order" })).toBe(true);
  });

  it("blocks anything tagged payload.uat_test === true", () => {
    expect(isUatBrokerBlocked({ source: "MINT_CLIENT_ORDER", payload: { uat_test: true } })).toBe(true);
    expect(isUatBrokerBlocked({ source: "MANUAL_CLIENT_ORDER", payload: { uat_test: true } })).toBe(true);
  });

  it("does NOT block real app / manual orders", () => {
    expect(isUatBrokerBlocked({ source: "MINT_CLIENT_ORDER" })).toBe(false);
    expect(isUatBrokerBlocked({ source: "MANUAL_CLIENT_ORDER", payload: { uat_test: false } })).toBe(false);
    expect(isUatBrokerBlocked({ source: null, payload: null })).toBe(false);
  });
});
