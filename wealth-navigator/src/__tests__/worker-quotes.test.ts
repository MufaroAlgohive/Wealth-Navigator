import { afterEach, describe, expect, it, vi } from "vitest";

import { IressError } from "@/lib/iress/errors";

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
      {
        workerId: "w",
        iressMode: "live",
        dryRun: true,
        allowWrites: false,
        heartbeatSec: 30,
        quoteIntervalSec: 15,
        orderPollIntervalSec: 60,
        watchlistSymbols: ["NPN"],
        instrumentSync: false,
        supabaseUrl: "",
        supabaseServiceKey: "",
        iressAccountCode: "",
        applicationLabel: "lbl",
      },
      { withSession } as never,
      null,
    );

    expect(result.synced).toBe(0);
    expect(withSession).toHaveBeenCalled();
  });
});
