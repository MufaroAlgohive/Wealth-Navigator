import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { isJseHoliday, isJseOpen, JSE_HOLIDAYS_2026 } from "@/lib/sa-holidays";

describe("isJseHoliday", () => {
  it("returns true for a known 2026 JSE holiday (Human Rights Day)", () => {
    expect(isJseHoliday(new Date("2026-03-20T10:00:00Z"))).toBe(true);
  });

  it("returns true for Christmas Day 2026", () => {
    expect(isJseHoliday(new Date("2026-12-25T08:00:00Z"))).toBe(true);
  });

  it("returns false for a known business day", () => {
    expect(isJseHoliday(new Date("2026-06-09T10:00:00Z"))).toBe(false);
  });
});

describe("isJseOpen", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns false on a Saturday", () => {
    // 2026-06-06 is a Saturday.
    vi.setSystemTime(new Date("2026-06-06T11:00:00Z"));
    expect(isJseOpen()).toBe(false);
  });

  it("returns false on a Sunday", () => {
    // 2026-06-07 is a Sunday.
    vi.setSystemTime(new Date("2026-06-07T11:00:00Z"));
    expect(isJseOpen()).toBe(false);
  });

  it("returns true on a weekday during 09:00–17:00 SAST on a non-holiday", () => {
    // 2026-06-09 is a Tuesday. 12:00 UTC = 14:00 SAST (UTC+2 in June? SAST is fixed UTC+2).
    vi.setSystemTime(new Date("2026-06-09T12:00:00Z"));
    expect(isJseOpen()).toBe(true);
  });

  it("returns false before 09:00 SAST on a weekday", () => {
    // 2026-06-09 06:00 UTC = 08:00 SAST.
    vi.setSystemTime(new Date("2026-06-09T06:00:00Z"));
    expect(isJseOpen()).toBe(false);
  });

  it("returns false at exactly 17:00 SAST on a weekday (boundary is exclusive)", () => {
    // 2026-06-09 15:00 UTC = 17:00 SAST.
    vi.setSystemTime(new Date("2026-06-09T15:00:00Z"));
    expect(isJseOpen()).toBe(false);
  });

  it("returns false on a weekday that is a JSE holiday", () => {
    // 2026-06-16 is Youth Day (Tuesday, weekday, but a holiday).
    vi.setSystemTime(new Date("2026-06-16T12:00:00Z"));
    expect(isJseOpen()).toBe(false);
  });
});

describe("JSE_HOLIDAYS_2026", () => {
  it("contains the expected number of observed holidays", () => {
    // We don't pin a count — just sanity-check it is a non-empty list of ISO date strings.
    expect(JSE_HOLIDAYS_2026.length).toBeGreaterThan(5);
    for (const d of JSE_HOLIDAYS_2026) {
      expect(d).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });
});
