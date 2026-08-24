import { describe, expect, it } from "vitest";

import { activeSectionTitle, PERSONA_HOME, PLATFORM_NAV } from "./nav";

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

  it("keeps Dividends inside Clients & Investors", () => {
    expect(activeSectionTitle("/admin/investors/dividends")).toBe("Clients & Investors");
  });

  it("maps every configured navigation destination back to its owning filter", () => {
    const personaHomes = new Set(Object.values(PERSONA_HOME).map((home) => home.href));
    for (const section of PLATFORM_NAV) {
      for (const item of section.items) {
        // A persona home can intentionally also appear as an operational link;
        // persisted user selection resolves that ambiguity in PlatformNav.
        if (personaHomes.has(item.href)) continue;
        expect(activeSectionTitle(item.href), item.href).toBe(section.title);
      }
    }
  });
});
