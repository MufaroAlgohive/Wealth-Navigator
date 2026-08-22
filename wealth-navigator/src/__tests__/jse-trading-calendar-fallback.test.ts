import { describe, expect, it, vi } from "vitest";

import { isJseTradingDayStatic, resolveJseTradingDay } from "@/lib/returns/jse-trading-calendar-fallback";

describe("resolveJseTradingDay", () => {
  it("trusts an explicit calendar row over the static fallback", () => {
    expect(resolveJseTradingDay("2026-08-24", { is_trading_day: false })).toEqual({
      isTradingDay: false,
      source: "calendar",
    });
    // Even a Monday (which the static check would call a trading day) must defer to an
    // explicit calendar closure.
    expect(isJseTradingDayStatic("2026-08-24")).toBe(true);
    expect(resolveJseTradingDay("2026-08-24", { is_trading_day: true })).toEqual({
      isTradingDay: true,
      source: "calendar",
    });
  });

  it("falls back to the static weekday/holiday check when there is no calendar row at all", () => {
    // 2026-08-24 is a Monday, not a known JSE holiday -> should proceed.
    expect(resolveJseTradingDay("2026-08-24", null)).toEqual({
      isTradingDay: true,
      source: "static_fallback",
    });
  });

  it("still correctly skips a weekend when there is no calendar row", () => {
    // 2026-08-22 is a Saturday.
    expect(resolveJseTradingDay("2026-08-22", null)).toEqual({
      isTradingDay: false,
      source: "static_fallback",
    });
  });

  it("still correctly skips a known JSE public holiday when there is no calendar row", () => {
    // 2026-12-25 (Christmas Day) is a Friday but a hardcoded JSE holiday.
    expect(resolveJseTradingDay("2026-12-25", null)).toEqual({
      isTradingDay: false,
      source: "static_fallback",
    });
  });
});

describe("publishCanonicalLedgerDraft calendar fallback (no calendar row for the date)", () => {
  function makeDb(strategies: Array<{ id: string; name: string; status: string }>) {
    const calendarBuilder = {
      eq: () => calendarBuilder,
      maybeSingle: () => Promise.resolve({ data: null, error: null }),
    };
    const strategiesBuilder = {
      eq: () => strategiesBuilder,
      neq: () => strategiesBuilder,
      then: (resolve: (v: { data: unknown; error: null }) => void) =>
        resolve({ data: strategies, error: null }),
    };
    return {
      from: (table: string) => {
        if (table === "jse_trading_calendar") return { select: () => calendarBuilder };
        if (table === "strategies_c") return { select: () => strategiesBuilder };
        throw new Error(`unexpected table in this test: ${table}`);
      },
    };
  }

  it("proceeds (does not return an empty skipped result) on a real weekday with no calendar row", async () => {
    vi.resetModules();
    vi.doMock("@/lib/supabase/server", () => ({
      createRetailServiceRoleClient: () => makeDb([]), // no active strategies -> exits cleanly after the calendar check
      isRetailSupabaseConfigured: () => true,
    }));
    const { publishCanonicalLedgerDraft } = await import("@/lib/returns/publish-canonical-ledger-draft");
    // 2026-08-24 is a Monday, not a JSE holiday.
    const result = await publishCanonicalLedgerDraft({ asOfDate: "2026-08-24" });
    expect(result.ok).toBe(true);
    // Crucially, this must NOT be the "not a JSE trading day" short-circuit note — it should
    // have proceeded past the calendar check (and only found zero strategies configured in
    // this test double), carrying a note that explains the fallback was used.
    expect(result.note).not.toBe("not a JSE trading day");
    expect(result.note).toMatch(/static weekday\/holiday fallback/);
    expect(result.summary).toEqual({ written: 0, planned: 0, skipped: 0, failed: 0, total: 0 });
    vi.doUnmock("@/lib/supabase/server");
  });

  it("still correctly skips a real weekend/holiday with no calendar row", async () => {
    vi.resetModules();
    vi.doMock("@/lib/supabase/server", () => ({
      createRetailServiceRoleClient: () => makeDb([{ id: "strat-1", name: "Growth", status: "active" }]),
      isRetailSupabaseConfigured: () => true,
    }));
    const { publishCanonicalLedgerDraft } = await import("@/lib/returns/publish-canonical-ledger-draft");
    // 2026-08-22 is a Saturday.
    const result = await publishCanonicalLedgerDraft({ asOfDate: "2026-08-22" });
    expect(result.ok).toBe(true);
    expect(result.results).toEqual([]);
    expect(result.note).toMatch(/not a JSE trading day/);
    expect(result.note).toMatch(/static weekday\/holiday fallback used/);
    vi.doUnmock("@/lib/supabase/server");
  });
});
