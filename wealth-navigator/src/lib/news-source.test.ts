import { describe, expect, it } from "vitest";

import { classifyNewsWire, newsWireLabel } from "./news-source";

describe("news source classification", () => {
  it("keeps Alliance and Moneyweb in distinct source groups", () => {
    expect(classifyNewsWire("Alliance News", "WIRE")).toBe("ALLIANCE");
    expect(classifyNewsWire("Moneyweb", "WIRE")).toBe("MONEYWEB");
  });

  it("keeps SENS regulatory items separate", () => {
    expect(classifyNewsWire("SENSD", "SENS")).toBe("SENS");
  });

  it("does not mislabel other RSS publishers as Alliance", () => {
    expect(classifyNewsWire("BusinessTech", "WIRE")).toBe("OTHER");
    expect(newsWireLabel("OTHER")).toBe("News");
  });
});
