import { afterEach, describe, expect, it, vi } from "vitest";

import { IressError } from "@/lib/iress/errors";
import type { WorkerEnv } from "../../workers/iress-ingest/src/env";

/**
 * Minimal WorkerEnv for unit tests — the worker reads more from env
 * vars than it uses directly, and the new `watchlistEntries` /
 * `watchlistExchanges` fields aren't read by `syncWatchlistQuotes` itself.
 */
function makeEnv(overrides: Partial<WorkerEnv> = {}): WorkerEnv {
  return {
    workerId: "w",
    iressMode: "live",
    dryRun: true,
    allowWrites: false,
    heartbeatSec: 30,
    quoteIntervalSec: 15,
    orderPollIntervalSec: 60,
    watchlistSymbols: ["NPN"],
    watchlistEntries: [{ symbol: "NPN", kind: "equity" }],
    watchlistExchanges: {},
    instrumentSync: false,
    supabaseUrl: "",
    supabaseServiceKey: "",
    iressAccountCode: "",
    applicationLabel: "lbl",
    defaultExchange: "JSE",
    fxExchange: "FX",
    moneyMarketExchange: "MM",
    ...overrides,
  };
}

describe("syncWatchlistQuotes session resilience", () => {
  afterEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it("does not throw when the IRESS session cannot be established", async () => {
    const withSession = vi.fn().mockRejectedValue(
      new IressError(666, "ServiceSessionStart", "soap:Receiver — HTTP 500"),
    );

    vi.doMock("../../workers/iress-ingest/src/session", () => ({
      WorkerSessionManager: class {
        withSession = withSession;
      },
    }));
    vi.doMock("@/lib/iress/index", () => ({
      getIressClient: vi.fn(),
      iressConfig: { mode: "live" },
    }));

    const { syncWatchlistQuotes } = await import("../../workers/iress-ingest/src/quotes");
    const result = await syncWatchlistQuotes(
      makeEnv(),
      { withSession } as never,
      null,
    );

    expect(result.synced).toBe(0);
    expect(withSession).toHaveBeenCalled();
  });
});

describe("syncWatchlistQuotes empty / error visibility", () => {
  afterEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  const env = makeEnv();

  function mockClient(behavior: (securityCode: string) => Promise<unknown>) {
    return {
      pricingQuoteGet: vi.fn(async (req) => behavior(req.SecurityCode)),
      pricingQuoteGetUpdates: vi.fn(),
      timeSeriesGet2: vi.fn(),
      timeSeriesGet2Updates: vi.fn(),
      orderCreate3: vi.fn(),
      orderAmend2: vi.fn(),
      orderDelete: vi.fn(),
      orderPadGetByAccount: vi.fn(),
      orderPadGetByAccountUpdates: vi.fn(),
      bookingGetByOrganisation2: vi.fn(),
      ipsTransactionGetByAccount5: vi.fn(),
      iressSessionStart: vi.fn(),
      iressSessionEnd: vi.fn(),
      serviceSessionStart: vi.fn(),
      serviceSessionEnd: vi.fn(),
      targetIdGet: vi.fn(),
      targetIdStatusGet: vi.fn(),
    };
  }

  it("reports requested/ok/empty/errors in the structured quote_sync_complete log when all rows are empty", async () => {
    const client = mockClient(async () => ({
      Header: { StatusCode: 2, ErrorNumber: 0 },
      DataRows: [],
    }));
    const withSession = vi.fn(async (fn) => fn({ iressSessionKey: "k" }));
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    vi.doMock("../../workers/iress-ingest/src/session", () => ({
      WorkerSessionManager: class {
        withSession = withSession;
      },
    }));
    vi.doMock("@/lib/iress/index", () => ({
      getIressClient: () => client,
      iressConfig: { mode: "live" },
      redactSessionKeyForLog: (v: string) => v,
    }));

    const { syncWatchlistQuotes } = await import("../../workers/iress-ingest/src/quotes");
    const result = await syncWatchlistQuotes(env, { withSession } as never, null);

    expect(result.synced).toBe(0);
    expect(result.requested).toBe(1);
    expect(result.empty).toBe(1);
    expect(result.errors).toBe(0);
    const completeLine = info.mock.calls
      .map((c) => c[0])
      .find((m) => typeof m === "string" && m.includes("quote_sync_complete"));
    expect(completeLine).toBeDefined();
    const parsed = JSON.parse(completeLine as string);
    expect(parsed.requested).toBe(1);
    expect(parsed.ok).toBe(0);
    expect(parsed.empty).toBe(1);
    expect(parsed.errors).toBe(0);
    expect(parsed.sessionFatal).toBeNull();
    info.mockRestore();
    warn.mockRestore();
  });

  it("logs a warn per empty symbol and counts it as empty (not error)", async () => {
    const client = mockClient(async () => ({
      Header: { StatusCode: 2, ErrorNumber: 0 },
      DataRows: [
        {
          symbol: "NPN",
          last: 0,
          bid: 0,
          ask: 0,
          bidSize: 0,
          askSize: 0,
          open: 0,
          high: 0,
          low: 0,
          close: 0,
          prevClose: 0,
          change: 0,
          changePct: 0,
          volume: 0,
          vwap: 0,
          currency: "ZAR",
          marketState: "PRE_OPEN",
          ts: Date.now(),
        },
      ],
    }));
    const withSession = vi.fn(async (fn) => fn({ iressSessionKey: "k" }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    vi.doMock("../../workers/iress-ingest/src/session", () => ({
      WorkerSessionManager: class {
        withSession = withSession;
      },
    }));
    vi.doMock("@/lib/iress/index", () => ({
      getIressClient: () => client,
      iressConfig: { mode: "live" },
      redactSessionKeyForLog: (v: string) => v,
    }));

    const { syncWatchlistQuotes } = await import("../../workers/iress-ingest/src/quotes");
    const result = await syncWatchlistQuotes(env, { withSession } as never, null);

    expect(result.synced).toBe(0);
    expect(result.empty).toBe(1);
    expect(result.errors).toBe(0);
    expect(warn.mock.calls.some((c) => String(c[0]).includes("no trade"))).toBe(true);
    expect(warn.mock.calls.some((c) => String(c[0]).includes("PRE_OPEN"))).toBe(true);
    warn.mockRestore();
  });

  it("counts PricingQuoteGet IressError as an error and includes the message in the warn log", async () => {
    const client = mockClient(async () => {
      throw new IressError(25034, "PricingQuoteGet", "Entitlement check failed for NPN");
    });
    const withSession = vi.fn(async (fn) => fn({ iressSessionKey: "k" }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    vi.doMock("../../workers/iress-ingest/src/session", () => ({
      WorkerSessionManager: class {
        withSession = withSession;
      },
    }));
    vi.doMock("@/lib/iress/index", () => ({
      getIressClient: () => client,
      iressConfig: { mode: "live" },
      redactSessionKeyForLog: (v: string) => v,
    }));

    const { syncWatchlistQuotes } = await import("../../workers/iress-ingest/src/quotes");
    const result = await syncWatchlistQuotes(env, { withSession } as never, null);

    expect(result.synced).toBe(0);
    expect(result.empty).toBe(0);
    expect(result.errors).toBe(1);
    expect(
      warn.mock.calls.some(
        (c) => String(c[0]).includes("PricingQuoteGet(NPN) failed") && String(c[0]).includes("Entitlement"),
      ),
    ).toBe(true);
    warn.mockRestore();
  });
});
