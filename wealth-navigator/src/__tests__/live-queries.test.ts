import { afterEach, describe, expect, it, vi } from "vitest";

import type { IressClient } from "@/lib/iress/client";
import type { Quote } from "@/types/iress";

const SAMPLE_QUOTE: Quote = {
  symbol: "NPN",
  last: 4180.5,
  bid: 4179,
  ask: 4182,
  bidSize: 100,
  askSize: 200,
  open: 4100,
  high: 4200,
  low: 4080,
  close: 4150,
  prevClose: 4150,
  change: 30.5,
  changePct: 0.74,
  volume: 12345,
  vwap: 4175,
  currency: "ZAR",
  marketState: "OPEN",
  ts: Date.now(),
};

function makeMockLiveClient(overrides: Partial<IressClient> = {}): IressClient {
  return {
    iressSessionStart: vi.fn(),
    iressSessionEnd: vi.fn(),
    serviceSessionStart: vi.fn(),
    serviceSessionEnd: vi.fn(),
    pricingQuoteGet: vi.fn().mockResolvedValue({
      Header: { StatusCode: 2 as const, ErrorNumber: 0 },
      DataRows: [SAMPLE_QUOTE],
    }),
    pricingQuoteGetUpdates: vi.fn().mockResolvedValue({ Header: { StatusCode: 3 as const, ErrorNumber: 0 }, DataRows: [] }),
    timeSeriesGet2: vi.fn(),
    timeSeriesGet2Updates: vi.fn(),
    orderCreate3: vi.fn(),
    orderAmend2: vi.fn(),
    orderDelete: vi.fn(),
    orderNoGetByOrderTag: vi.fn(),
    orderPadGetByAccount: vi.fn(),
    orderPadGetByAccountUpdates: vi.fn(),
    bookingGetByOrganisation2: vi.fn(),
    ipsTransactionGetByAccount5: vi.fn(),
    ipsAccountGetAll1: vi.fn(),
    ipsPositionGetAll1: vi.fn(),
    targetIdGet: vi.fn(),
    targetIdStatusGet: vi.fn(),
    ...overrides,
  };
}

describe("live-queries", () => {
  const ORIGINAL_MODE = process.env.IRESS_MODE;

  afterEach(() => {
    process.env.IRESS_MODE = ORIGINAL_MODE;
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it("returns mock source when IRESS_MODE=mock", async () => {
    process.env.IRESS_MODE = "mock";
    vi.resetModules();
    const { fetchQuotes } = await import("@/lib/iress/live-queries");
    const results = await fetchQuotes(["NPN"], "JSE");
    expect(results).toHaveLength(1);
    expect(results[0]?.source).toBe("mock");
    expect(results[0]?.quote.last).toBeGreaterThan(0);
  });

  it("returns live quotes when session and client succeed", async () => {
    process.env.IRESS_MODE = "live";
    vi.resetModules();

    vi.doMock("@/lib/iress/index", () => ({
      iressConfig: { mode: "live" },
      getIressClient: () => makeMockLiveClient(),
    }));
    vi.doMock("@/lib/iress/session-manager", () => ({
      getMintSession: vi.fn().mockResolvedValue({
        iressSessionKey: "KEY@CT",
        sessionTimeout: 120,
        expiresAt: Date.now() + 120_000,
        serviceKeys: {},
        startedAt: Date.now(),
      }),
      withMintSession: vi.fn(async (fn: (s: unknown) => Promise<unknown>) => fn({
        iressSessionKey: "KEY@CT",
        serviceKeys: {},
      })),
      invalidateMintSession: vi.fn(),
    }));

    const { fetchQuotes } = await import("@/lib/iress/live-queries");
    const results = await fetchQuotes(["NPN"], "JSE");
    expect(results[0]?.source).toBe("live");
    expect(results[0]?.quote.last).toBe(4180.5);
  });

  it("falls back to seed on quote failure", async () => {
    process.env.IRESS_MODE = "live";
    vi.resetModules();

    vi.doMock("@/lib/iress/index", () => ({
      iressConfig: { mode: "live" },
      getIressClient: () => makeMockLiveClient({
        pricingQuoteGet: vi.fn().mockRejectedValue(new Error("network down")),
      }),
    }));
    vi.doMock("@/lib/iress/session-manager", () => ({
      getMintSession: vi.fn().mockResolvedValue({
        iressSessionKey: "KEY@CT",
        sessionTimeout: 120,
        expiresAt: Date.now() + 120_000,
        serviceKeys: {},
        startedAt: Date.now(),
      }),
      withMintSession: vi.fn(async (fn: (s: unknown) => Promise<unknown>) => fn({ iressSessionKey: "KEY@CT", serviceKeys: {} })),
      invalidateMintSession: vi.fn(),
    }));

    const { fetchQuotes } = await import("@/lib/iress/live-queries");
    const results = await fetchQuotes(["NPN"], "JSE");
    expect(results[0]?.source).toBe("seed-fallback");
    expect(results[0]?.quote.last).toBeGreaterThan(0);
  });
});
