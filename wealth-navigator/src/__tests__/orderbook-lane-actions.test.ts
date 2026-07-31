import { describe, expect, it } from "vitest";

import { allowsMarketRelease, allowsUatSelfFill } from "@/lib/oems/orderbook-lane-actions";

describe("OEM order-book lane actions", () => {
  it("never exposes market release on UAT", () => {
    expect(allowsMarketRelease("uat")).toBe(false);
    expect(allowsMarketRelease("live")).toBe(true);
  });

  it("keeps the pencil self-fill action available for UAT app orders", () => {
    expect(allowsUatSelfFill("uat", "MINT_CLIENT_ORDER")).toBe(true);
    expect(allowsUatSelfFill("live", "MINT_CLIENT_ORDER")).toBe(false);
    expect(allowsUatSelfFill(undefined, "UAT_ADHOC_ORDER")).toBe(true);
  });
});
