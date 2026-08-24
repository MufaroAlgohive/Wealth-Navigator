import { describe, expect, it } from "vitest";

import { activeSectionTitle } from "./nav";

describe("activeSectionTitle", () => {
  it("keeps Models inside the Strategies sidebar filter", () => {
    expect(activeSectionTitle("/oems/models")).toBe("Strategies");
  });

  it("keeps nested model pages inside Strategies", () => {
    expect(activeSectionTitle("/oems/models/model-123")).toBe("Strategies");
  });

  it("still maps securities to Markets", () => {
    expect(activeSectionTitle("/oems/equities")).toBe("Markets");
  });
});
