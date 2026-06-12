import { afterEach, describe, expect, it } from "vitest";
import {
  deriveDataSource,
  isUseSupabaseQuotesClientEnabled,
  normaliseBffQuotes,
  normaliseIressQuotes,
  resolveQuoteApiMode,
  tickerFeedFromDataSource,
} from "@/lib/hooks/quote-routing";

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("isUseSupabaseQuotesClientEnabled", () => {
  it("is false when unset", () => {
    delete process.env.NEXT_PUBLIC_USE_SUPABASE_QUOTES;
    expect(isUseSupabaseQuotesClientEnabled()).toBe(false);
  });

  it("accepts true and 1", () => {
    process.env.NEXT_PUBLIC_USE_SUPABASE_QUOTES = "true";
    expect(isUseSupabaseQuotesClientEnabled()).toBe(true);
    process.env.NEXT_PUBLIC_USE_SUPABASE_QUOTES = "1";
    expect(isUseSupabaseQuotesClientEnabled()).toBe(true);
  });
});

describe("resolveQuoteApiMode", () => {
  it("prefers supabase when client flag is set", () => {
    expect(resolveQuoteApiMode({ useSupabaseFlag: true, iressMode: "mock" })).toBe("supabase");
    expect(resolveQuoteApiMode({ useSupabaseFlag: true, iressMode: "live" })).toBe("supabase");
  });

  it("uses iress when live and flag off", () => {
    expect(resolveQuoteApiMode({ useSupabaseFlag: false, iressMode: "live" })).toBe("iress");
    expect(resolveQuoteApiMode({ useSupabaseFlag: false, iressMode: "wsdl-stub" })).toBe("iress");
  });

  it("defaults mock to BFF supabase path", () => {
    expect(resolveQuoteApiMode({ useSupabaseFlag: false, iressMode: "mock" })).toBe("supabase");
  });
});

describe("normaliseBffQuotes", () => {
  it("maps BFF rows to tick seed shape", () => {
    const rows = normaliseBffQuotes({
      mode: "supabase",
      useSupabase: true,
      quotes: [
        { symbol: "NPN", last_price: 4180.55, bid: 4180, ask: 4181, change_pct: 0.5, source: "supabase" },
      ],
      liveCount: 0,
      fallbackCount: 0,
      supabaseCount: 1,
    });
    expect(rows[0]).toMatchObject({ sym: "NPN", last: 4180.55, source: "supabase" });
  });
});

describe("normaliseIressQuotes", () => {
  it("maps legacy iress rows", () => {
    const rows = normaliseIressQuotes({
      mode: "live",
      quotes: [
        {
          symbol: "NPN",
          source: "live",
          quote: { last: 100, bid: 99, ask: 101, change: 1, changePct: 1, volume: 0, vwap: 100 },
        },
      ],
      liveCount: 1,
      fallbackCount: 0,
    });
    expect(rows[0]?.sym).toBe("NPN");
    expect(rows[0]?.last).toBe(100);
  });
});

describe("deriveDataSource", () => {
  it("tags pure supabase", () => {
    expect(
      deriveDataSource(
        [{ sym: "NPN", last: 1, source: "supabase" }],
        { liveCount: 0, fallbackCount: 0, supabaseCount: 1 },
      ),
    ).toBe("supabase");
  });

  it("tags hybrid when mixed", () => {
    expect(
      deriveDataSource(
        [
          { sym: "NPN", last: 1, source: "supabase" },
          { sym: "PRX", last: 2, source: "seed-fallback" },
        ],
        { liveCount: 0, fallbackCount: 1, supabaseCount: 1 },
      ),
    ).toBe("hybrid");
  });
});

describe("tickerFeedFromDataSource", () => {
  it("maps supabase/live to supabase chrome", () => {
    expect(tickerFeedFromDataSource("supabase")).toBe("supabase");
    expect(tickerFeedFromDataSource("live")).toBe("supabase");
  });

  it("maps seed/mock to mock chrome", () => {
    expect(tickerFeedFromDataSource("seed")).toBe("mock");
    expect(tickerFeedFromDataSource("mock")).toBe("mock");
  });
});
