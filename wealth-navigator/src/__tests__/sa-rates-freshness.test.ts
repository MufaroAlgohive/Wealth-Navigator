import { describe, expect, it } from "vitest";

import { ageInCalendarDays, classifyFreshness } from "@/app/api/sa-rates/route";

const now = new Date("2026-08-25T12:00:00.000Z");

describe("SARB indicator freshness", () => {
  it("treats a recent daily observation as current", () => {
    expect(classifyFreshness("MMRD855A", "2026-08-24", now)).toEqual({
      freshness: "current",
      ageDays: 1,
    });
  });

  it("marks an old daily observation stale", () => {
    expect(classifyFreshness("MMRD002A", "2026-08-10", now)).toEqual({
      freshness: "stale",
      ageDays: 15,
    });
  });

  it("uses a monthly publication window for CPI and PPI", () => {
    expect(classifyFreshness("CPI1000F", "2026-07-31", now).freshness).toBe("current");
    expect(classifyFreshness("PPI1000F", "2026-06-30", now).freshness).toBe("delayed");
  });

  it("fails closed when an observation date is missing or invalid", () => {
    expect(classifyFreshness("MMRD855A", null, now)).toEqual({
      freshness: "unavailable",
      ageDays: null,
    });
    expect(ageInCalendarDays("not-a-date", now)).toBeNull();
  });
});
