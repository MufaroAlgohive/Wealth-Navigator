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

describe("syncWatchlistQuotes closed-market write-through (Bug B fix)", () => {
  afterEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it("counts a closed-with-data row in the result and surfaces it in the quote_sync_complete log", async () => {
    // Bug B regression: a SOL row with marketState=C used to be logged as
    // "no trade" and the worker dropped the write. The fix routes the raw
    // LastPrice/PreviousClosePrice through `quoteRawRowLast` so the weekend
    // / holiday UI keeps showing a real number.
    const env = makeEnv();
    const client = {
      pricingQuoteGet: vi.fn(async () => ({
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
            prevClose: 15_800,
            change: 0,
            changePct: 0,
            volume: 0,
            vwap: 0,
            currency: "ZAR",
            marketState: "CLOSED",
            ts: Date.now(),
          },
        ],
        RawDataRows: [
          {
            SecurityCode: "NPN",
            Exchange: "JSE",
            MarketState: "C",
            Last: 0,
            LastPrice: 1_582_300, // R15,823.00 in cents
            PreviousClosePrice: 1_580_000,
          },
        ],
      })),
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
    const withSession = vi.fn(async (fn) => fn({ iressSessionKey: "k" }));
    const info = vi.spyOn(console, "info").mockImplementation(() => {});

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

    expect(result.closedWithData).toBe(1);
    expect(result.empty).toBe(0);
    expect(result.errors).toBe(0);
    // The worker must produce a non-zero upsert plan for the closed row so
    // the writer can persist it and the UI can show the prior close during
    // the weekend (instead of dropping the symbol entirely).
    expect(result.plans).toHaveLength(1);
    expect(result.plans[0]?.symbol).toBe("NPN");
    // `quoteToCents(last)` is the canonical cents shape the upsert plan stores.
    expect(result.plans[0]?.currentPriceCents).toBeGreaterThan(0);
    // The structured log line must report the new counter.
    const completeLine = info.mock.calls
      .map((c) => c[0])
      .find((m) => typeof m === "string" && m.includes("quote_sync_complete"));
    expect(completeLine).toBeDefined();
    const parsed = JSON.parse(completeLine as string);
    expect(parsed.closedWithData).toBe(1);
    expect(parsed.ok).toBe(1);
    info.mockRestore();
  });
});

/**
 * Bug C follow-up regression: the live CT server honours
 * `<Frequency>` (Long), NOT the `<Interval>` STRING enum the V4 WSDL
 * sample documents. Earlier Long guesses (0, 8) returned
 * `soap:Receiver — Invalid Parameter Value: <n> as Frequency` because
 * those specific values were wrong, not because the wire shape was.
 * The brute-force probe pinned the daily-bucket value in
 * `docs/TIMESERIES_PROBE_REPORT_FINAL.md`. The fix renames
 * `timeSeriesIntervalString` (V4 string enum) to
 * `timeSeriesFrequencyLong` (V4 Long) and pins `1d` to the probed
 * value. Every other token is speculative — only `1d` is on the
 * load-bearing Tier-2 path; the other entries are placeholders the
 * next probe can validate.
 */
describe("timeSeriesFrequencyLong (V4 Frequency LONG)", () => {
  it("maps worker-friendly tokens to non-empty V4 Frequency Longs", async () => {
    const { timeSeriesFrequencyLong } = await import(
      "../../workers/iress-ingest/src/timeseries"
    );
    // The Long for every token is finite and a positive integer.
    const tokens = ["tick", "1m", "5m", "1h", "1d", "1w", "1mo", "1q", "1y"] as const;
    for (const t of tokens) {
      const out = timeSeriesFrequencyLong(t);
      expect(typeof out).toBe("number");
      expect(Number.isFinite(out)).toBe(true);
      expect(Number.isInteger(out)).toBe(true);
      expect(out).toBeGreaterThan(0);
    }
  });

  it("pins 1d to the DAILY_FREQUENCY_LONG constant (the probed value)", async () => {
    const { timeSeriesFrequencyLong, DAILY_FREQUENCY_LONG } = await import(
      "../../workers/iress-ingest/src/timeseries"
    );
    // The brute-force probe against the live CT server (June 13 2026)
    // established that this specific Long is the value the live server
    // accepts for the daily bucket. See
    // `wealth-navigator/docs/TIMESERIES_PROBE_REPORT_FINAL.md` for the
    // candidate-vs-response table. The `1d` token MUST resolve to that
    // value; if a future probe invalidates it, the report + this
    // constant need to be updated together.
    expect(timeSeriesFrequencyLong("1d")).toBe(DAILY_FREQUENCY_LONG);
  });

  it("DAILY_FREQUENCY_LONG is a positive integer (the wire shape is `<Frequency>N</Frequency>`)", async () => {
    const { DAILY_FREQUENCY_LONG } = await import(
      "../../workers/iress-ingest/src/timeseries"
    );
    expect(typeof DAILY_FREQUENCY_LONG).toBe("number");
    expect(Number.isInteger(DAILY_FREQUENCY_LONG)).toBe(true);
    expect(DAILY_FREQUENCY_LONG).toBeGreaterThanOrEqual(0);
  });
});
