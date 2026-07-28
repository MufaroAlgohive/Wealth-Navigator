import { describe, expect, it } from "vitest";

import { scopeRebalanceEvents } from "@/lib/oems/rebalance-scope";

describe("scopeRebalanceEvents", () => {
  const testUsers = new Set(["uat-user"]);
  const events = [
    { id: "live-event", user_id: "live-user" },
    { id: "uat-event", user_id: "uat-user" },
  ];

  it("keeps UAT owners exclusively in UAT", () => {
    expect(scopeRebalanceEvents(events, "uat", testUsers).map((event) => event.id)).toEqual(["uat-event"]);
  });

  it("keeps test owners out of LIVE", () => {
    expect(scopeRebalanceEvents(events, "live", testUsers).map((event) => event.id)).toEqual(["live-event"]);
  });
});
