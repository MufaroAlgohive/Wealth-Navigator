import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Tests for the `USE_SUPABASE_QUOTES=true` path in live-queries.ts.
 */

const ORIGINAL_ENV = { ...process.env };

interface MockPayload {
  securities: Array<{ id: string; symbol: string; last_price: number | null; prev_close: number | null; currency: string | null }>;
  ticks: Array<{ security_id: string; current_price: number; timestamp: string }>;
}

interface QueryCall {
  table: string;
  filters: Array<{ op: string; value: unknown }>;
}

function makeMockSupabaseClient(payload: MockPayload, calls?: QueryCall[]) {
  const from = (table: string) => {
    const filters: QueryCall["filters"] = [];
    let data: unknown = [];
    if (table === "securities_c") {
      data = payload.securities;
    } else if (table === "stock_intraday_c") {
      data = payload.ticks;
    }

    // Single chain that records every call.
    const chain: any = {
      _table: table,
      _filters: filters,
      _data: data,
      _calls: calls,
      select() { return chain; },
      eq(_col: string, val: unknown) { filters.push({ op: "eq", value: val }); return chain; },
      in(_col: string, val: unknown) { filters.push({ op: "in", value: val }); return chain; },
      order() { return chain; },
      limit() { return chain; },
      maybeSingle: async () => {
        if (calls) calls.push({ table, filters });
        return { data, error: null };
      },
      // Awaiting the chain itself should resolve to { data, error }.
      then(resolve: (v: unknown) => void, reject?: (e: unknown) => void) {
        if (calls) calls.push({ table, filters });
        return Promise.resolve({ data, error: null }).then(resolve, reject);
      },
    };
    return chain;
  };
  return { from };
}

const SEC_1 = { id: "uuid-1", symbol: "NPN", last_price: 418055, prev_close: 415830, currency: "ZAR" };
const SEC_2 = { id: "uuid-2", symbol: "PRX", last_price: 90500, prev_close: 90000, currency: "ZAR" };
// The tick timestamp must be inside the freshness window (iressQuoteMaxAgeMs);
// buildQuote's anti-staleness gate correctly rejects an old tick and falls back
// to securities_c.last_price, so a hardcoded past date would defeat the "tick
// wins" assertions below. Stamp it a minute ago, relative to the test run.
const FRESH_TICK_TS = new Date(Date.now() - 60_000).toISOString();
const TICK_1 = { security_id: "uuid-1", current_price: 420000, timestamp: FRESH_TICK_TS };
const TICK_2 = { security_id: "uuid-2", current_price: 91000, timestamp: FRESH_TICK_TS };

describe("USE_SUPABASE_QUOTES flag", () => {
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it("defaults to off — fetchQuotesSafe does NOT call Supabase", async () => {
    delete process.env.USE_SUPABASE_QUOTES;
    process.env.IRESS_MODE = "mock";
    vi.resetModules();

    const fromSpy = vi.fn();
    vi.doMock("@supabase/supabase-js", () => ({
      createClient: () => ({ from: fromSpy }),
    }));

    const { fetchQuotesSafe } = await import("@/lib/iress/live-queries");
    const results = await fetchQuotesSafe(["NPN"], "JSE");
    expect(fromSpy).not.toHaveBeenCalled();
    expect(results).toHaveLength(1);
    expect(results[0]?.source === "mock" || results[0]?.source === "seed-fallback").toBe(true);
  });

  it("when flag is true, reads stock_intraday_c and tags source='supabase'", async () => {
    process.env.USE_SUPABASE_QUOTES = "true";
    process.env.SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-key";
    process.env.IRESS_MODE = "live";
    vi.resetModules();

    const client = makeMockSupabaseClient({
      securities: [SEC_1, SEC_2],
      ticks: [TICK_1, TICK_2],
    });
    vi.doMock("@supabase/supabase-js", () => ({
      createClient: () => client,
    }));

    const { fetchQuotesSafe } = await import("@/lib/iress/live-queries");
    const results = await fetchQuotesSafe(["NPN", "PRX"], "JSE");

    expect(results).toHaveLength(2);
    const npn = results.find((r) => r.symbol === "NPN");
    const prx = results.find((r) => r.symbol === "PRX");
    expect(npn?.source).toBe("supabase");
    expect(prx?.source).toBe("supabase");
    expect(npn?.quote.last).toBe(4200);
    expect(prx?.quote.last).toBe(910);
  });

  it("normalises symbol aliases (.JSE, case, whitespace) before lookup", async () => {
    process.env.USE_SUPABASE_QUOTES = "true";
    process.env.SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-key";
    vi.resetModules();

    const calls: QueryCall[] = [];
    const client = makeMockSupabaseClient({ securities: [], ticks: [] }, calls);
    vi.doMock("@supabase/supabase-js", () => ({ createClient: () => client }));

    const { fetchQuotesSafe } = await import("@/lib/iress/live-queries");
    await fetchQuotesSafe(["npn.JSE", "  prx  ", "FSR"], "JSE");

    const secCall = calls.find((c) => c.table === "securities_c");
    expect(secCall).toBeDefined();
    const inFilter = secCall?.filters.find((f) => f.op === "in");
    expect(inFilter).toBeDefined();
    expect(inFilter?.value).toEqual(expect.arrayContaining(["NPN", "PRX", "FSR"]));
  });

  it("returns unavailable (not seed) when Supabase returns no securities rows", async () => {
    process.env.USE_SUPABASE_QUOTES = "true";
    process.env.SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-key";
    vi.resetModules();

    const client = makeMockSupabaseClient({ securities: [], ticks: [] });
    vi.doMock("@supabase/supabase-js", () => ({
      createClient: () => client,
    }));

    const { fetchQuotesSafe } = await import("@/lib/iress/live-queries");
    const results = await fetchQuotesSafe(["NPN"], "JSE");
    expect(results).toHaveLength(1);
    expect(results[0]?.source).toBe("unavailable");
    expect(results[0]?.quote.last).toBe(0);
  });

  it("returns unavailable for symbols missing from stock_intraday_c", async () => {
    process.env.USE_SUPABASE_QUOTES = "true";
    process.env.SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-key";
    vi.resetModules();

    const client = makeMockSupabaseClient({
      securities: [SEC_1, SEC_2],
      ticks: [TICK_1],
    });
    vi.doMock("@supabase/supabase-js", () => ({
      createClient: () => client,
    }));

    const { fetchQuotesSafe } = await import("@/lib/iress/live-queries");
    const results = await fetchQuotesSafe(["NPN", "PRX"], "JSE");
    const npn = results.find((r) => r.symbol === "NPN");
    const prx = results.find((r) => r.symbol === "PRX");
    expect(npn?.source).toBe("supabase");
    expect(prx?.source).toBe("unavailable");
    expect(prx?.quote.last).toBe(0);
  });
});
