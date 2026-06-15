import { afterEach, describe, expect, it, vi } from "vitest";

import { bringUpMintSession, iress } from "@/lib/iress/index";
import { IressError } from "@/lib/iress/errors";

function mockSupabase(row: { application_id: string } | null, upsert = vi.fn().mockResolvedValue({ error: null })) {
  const chain = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    maybeSingle: vi.fn().mockResolvedValue({ data: row, error: null }),
    upsert,
    update: vi.fn().mockReturnThis(),
  };
  return {
    from: vi.fn(() => chain),
    _upsert: upsert,
    _chain: chain,
  };
}

describe("WorkerSessionManager sticky ApplicationID", () => {
  afterEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it("reuses persisted ApplicationID from Supabase even when dryRun=1", async () => {
    const bringUp = vi.fn().mockResolvedValue({
      iressSession: {
        IRESSSessionKey: "KEY-1@WebServicesCT",
        SessionNumber: 1,
        SessionTimeout: 120,
        ApplicationID: "Mint-OEMS-Worker-railway-1",
      },
      serviceKeys: { IOSPlus: "SSK-1" },
    });
    const supabase = mockSupabase({ application_id: "Mint-OEMS-Worker-railway-1" });

    vi.doMock("@/lib/iress/index", async (importOriginal) => {
      const actual = await importOriginal<typeof import("@/lib/iress/index")>();
      return {
        ...actual,
        bringUpMintSessionFromEnv: bringUp,
        iressConfig: { mode: "live" },
      };
    });

    const { WorkerSessionManager } = await import("../../workers/iress-ingest/src/session");
    const mgr = new WorkerSessionManager({
      workerId: "iress-ingest-railway-1",
      node: "railway-1",
      applicationLabel: "Mint-OEMS-Worker",
      supabase: supabase as never,
      allowWrites: false,
      dryRun: true,
    });

    const session = await mgr.getSession();
    expect(session.applicationId).toBe("Mint-OEMS-Worker-railway-1");
    expect(bringUp).toHaveBeenCalledWith(
      expect.objectContaining({ applicationId: "Mint-OEMS-Worker-railway-1" }),
    );
    expect(supabase._upsert).not.toHaveBeenCalled();
  });

  it("persists sticky ApplicationID before IRESSSessionStart when writes are enabled", async () => {
    const bringUp = vi.fn().mockResolvedValue({
      iressSession: {
        IRESSSessionKey: "KEY-2@WebServicesCT",
        SessionNumber: 2,
        SessionTimeout: 120,
        ApplicationID: "Mint-OEMS-Worker-node-a",
      },
      serviceKeys: {},
    });
    const upsert = vi.fn().mockResolvedValue({ error: null });
    const supabase = mockSupabase(null, upsert);

    vi.doMock("@/lib/iress/index", async (importOriginal) => {
      const actual = await importOriginal<typeof import("@/lib/iress/index")>();
      return {
        ...actual,
        bringUpMintSessionFromEnv: bringUp,
        iressConfig: { mode: "live" },
      };
    });

    const { WorkerSessionManager } = await import("../../workers/iress-ingest/src/session");
    const mgr = new WorkerSessionManager({
      workerId: "iress-ingest-1",
      node: "node-a",
      applicationLabel: "Mint-OEMS-Worker",
      supabase: supabase as never,
      allowWrites: true,
      dryRun: false,
    });

    await mgr.getSession();

    expect(upsert).toHaveBeenCalled();
    const firstUpsert = upsert.mock.calls[0]?.[0];
    expect(firstUpsert?.application_id).toBe("Mint-OEMS-Worker-node-a");
    expect(bringUp).toHaveBeenCalledWith(
      expect.objectContaining({ applicationId: "Mint-OEMS-Worker-node-a" }),
    );
  });

  it("requests forceKickOn25008 when worker never held a session key", async () => {
    const bringUp = vi.fn().mockResolvedValue({
      iressSession: {
        IRESSSessionKey: "KEY-BOOT@WebServicesCT",
        SessionNumber: 4,
        SessionTimeout: 120,
        ApplicationID: "Mint-OEMS-Worker-node-b",
      },
      serviceKeys: {},
    });
    const supabase = mockSupabase({ application_id: "Mint-OEMS-Worker-node-b" });
    supabase._chain.maybeSingle.mockResolvedValue({
      data: { application_id: "Mint-OEMS-Worker-node-b", iress_session_key: null, expires_at: null },
      error: null,
    });

    vi.doMock("@/lib/iress/index", async (importOriginal) => {
      const actual = await importOriginal<typeof import("@/lib/iress/index")>();
      return {
        ...actual,
        bringUpMintSessionFromEnv: bringUp,
        iressConfig: { mode: "live" },
      };
    });

    const { WorkerSessionManager } = await import("../../workers/iress-ingest/src/session");
    const mgr = new WorkerSessionManager({
      workerId: "iress-ingest-1",
      node: "node-b",
      applicationLabel: "Mint-OEMS-Worker",
      supabase: supabase as never,
      allowWrites: true,
      dryRun: false,
    });

    await mgr.getSession();
    expect(bringUp).toHaveBeenCalledWith(
      expect.objectContaining({
        applicationId: "Mint-OEMS-Worker-node-b",
        forceKickOn25008: true,
      }),
    );
  });

  it("purges shutdown-persisted session key before IRESSSessionStart", async () => {
    const tearDown = vi.fn().mockResolvedValue(true);
    const bringUp = vi.fn().mockResolvedValue({
      iressSession: {
        IRESSSessionKey: "KEY-FRESH@WebServicesCT",
        SessionNumber: 5,
        SessionTimeout: 120,
        ApplicationID: "Mint-OEMS-Worker-railway-1",
      },
      serviceKeys: {},
    });
    const updateCalls: Array<Record<string, unknown>> = [];
    const update = vi.fn().mockImplementation((payload: Record<string, unknown>) => {
      updateCalls.push(payload);
      return { eq: vi.fn().mockResolvedValue({ error: null }) };
    });
    const supabase = {
      from: vi.fn(() => ({
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        maybeSingle: vi.fn().mockResolvedValue({
          data: {
            application_id: "Mint-OEMS-Worker-railway-1",
            iress_session_key: "KEY-STALE@WebServicesCT",
            expires_at: "2026-06-12T10:00:00.000Z",
            metadata: { shutdown: true },
          },
          error: null,
        }),
        upsert: vi.fn().mockResolvedValue({ error: null }),
        update,
      })),
    };

    vi.doMock("@/lib/iress/index", async (importOriginal) => {
      const actual = await importOriginal<typeof import("@/lib/iress/index")>();
      return {
        ...actual,
        bringUpMintSessionFromEnv: bringUp,
        tearDownIressWireSession: tearDown,
        iressConfig: { mode: "live" },
      };
    });

    const { WorkerSessionManager } = await import("../../workers/iress-ingest/src/session");
    const mgr = new WorkerSessionManager({
      workerId: "iress-ingest-railway-1",
      node: "railway-1",
      applicationLabel: "Mint-OEMS-Worker",
      supabase: supabase as never,
      allowWrites: true,
      dryRun: false,
    });

    await mgr.getSession();
    expect(tearDown).toHaveBeenCalledWith(
      expect.objectContaining({ iressSessionKey: "KEY-STALE@WebServicesCT" }),
    );
    expect(update).toHaveBeenCalled();
    // At least one update must have cleared the sticky session key
    // (iress_session_key: null) and another must have reset
    // metadata.shutdown: false so persistedSessionIsStale no longer
    // treats the row as stale on the next boot.
    const clearedKey = updateCalls.find((p) => "iress_session_key" in p);
    const resetShutdown = updateCalls.find(
      (p) =>
        typeof p.metadata === "object" &&
        p.metadata !== null &&
        (p.metadata as Record<string, unknown>).shutdown === false,
    );
    expect(clearedKey).toBeDefined();
    expect(resetShutdown).toBeDefined();
    expect(bringUp).toHaveBeenCalled();
  });

  it("recovers from logged-off PricingQuoteGet via session rebuild", async () => {
    let bringUpCalls = 0;
    const bringUp = vi.fn().mockImplementation(async () => {
      bringUpCalls += 1;
      return {
        iressSession: {
          IRESSSessionKey: bringUpCalls === 1 ? "KEY-DEAD@WebServicesCT" : "KEY-LIVE@WebServicesCT",
          SessionNumber: bringUpCalls,
          SessionTimeout: 120,
          ApplicationID: "app",
        },
        serviceKeys: {},
      };
    });
    const tearDown = vi.fn().mockResolvedValue(true);

    vi.doMock("@/lib/iress/index", async (importOriginal) => {
      const actual = await importOriginal<typeof import("@/lib/iress/index")>();
      return {
        ...actual,
        bringUpMintSessionFromEnv: bringUp,
        tearDownIressWireSession: tearDown,
        iressConfig: { mode: "live" },
      };
    });

    const { WorkerSessionManager } = await import("../../workers/iress-ingest/src/session");
    const mgr = new WorkerSessionManager({
      workerId: "w-logged-off",
      node: "n1",
      applicationLabel: "lbl",
      supabase: null,
      allowWrites: false,
      dryRun: true,
    });

    await mgr.getSession();
    const result = await mgr.withSession(async () => {
      if (bringUpCalls === 1) {
        throw new IressError(
          25022,
          "PricingQuoteGet",
          "soap:Receiver — not logged in. Current state: Logged off",
        );
      }
      return "ok";
    });

    expect(result).toBe("ok");
    expect(bringUp).toHaveBeenCalledTimes(2);
    expect(tearDown).toHaveBeenCalledWith(
      expect.objectContaining({ iressSessionKey: "KEY-DEAD@WebServicesCT" }),
    );
  });

  it("does not invalidate the cached session on non-25001 SOAP faults", async () => {
    const bringUp = vi.fn().mockResolvedValue({
      iressSession: {
        IRESSSessionKey: "KEY-3@WebServicesCT",
        SessionNumber: 3,
        SessionTimeout: 120,
        ApplicationID: "app",
      },
      serviceKeys: {},
    });

    vi.doMock("@/lib/iress/index", async (importOriginal) => {
      const actual = await importOriginal<typeof import("@/lib/iress/index")>();
      return {
        ...actual,
        bringUpMintSessionFromEnv: bringUp,
        iressConfig: { mode: "live" },
      };
    });

    const { WorkerSessionManager } = await import("../../workers/iress-ingest/src/session");
    const mgr = new WorkerSessionManager({
      workerId: "w1",
      node: "n1",
      applicationLabel: "lbl",
      supabase: null,
      allowWrites: false,
      dryRun: true,
    });

    await mgr.withSession(async () => "ok");
    await expect(
      mgr.withSession(async () => {
        throw new IressError(666, "PricingQuoteGet", "soap:Receiver — HTTP 500");
      }),
    ).rejects.toBeInstanceOf(IressError);

    await mgr.getSession();
    expect(bringUp).toHaveBeenCalledTimes(1);
  });
});

describe("bringUpMintSession service sessions", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.IRESS_ENABLE_IPS;
    delete process.env.IRESS_ENABLE_FIX;
  });

  it("continues when optional ServiceSessionStart calls fail", async () => {
    // With all three services enabled, a failing IOS+ session must not abort
    // the IPS / FIX+ attempts.
    process.env.IRESS_ENABLE_IPS = "1";
    process.env.IRESS_ENABLE_FIX = "1";
    const sessionStart = vi.spyOn(iress, "iressSessionStart").mockResolvedValue({
      IRESSSessionKey: "PARENT@WebServicesCT",
      SessionNumber: 1,
      SessionTimeout: 120,
      ApplicationID: "app",
    });
    const serviceSessionStart = vi
      .spyOn(iress, "serviceSessionStart")
      .mockRejectedValueOnce(new IressError(666, "ServiceSessionStart", "soap:Receiver — HTTP 500"))
      .mockResolvedValueOnce({ ServiceSessionKey: "IPS-KEY", Service: "IPS", Server: "IPSAPI" })
      .mockResolvedValueOnce({ ServiceSessionKey: "FIX-KEY", Service: "FIXPlus", Server: "FIXPLUSAPI" });

    const result = await bringUpMintSession(
      { userName: "u", company: "c", password: "p" },
      { applicationId: "app", node: "n1" },
    );

    expect(result.iressSession.IRESSSessionKey).toBe("PARENT@WebServicesCT");
    expect(result.serviceKeys.IOSPlus).toBeUndefined();
    expect(result.serviceKeys.IPS).toBe("IPS-KEY");
    expect(result.serviceKeys.FIXPlus).toBe("FIX-KEY");
    expect(serviceSessionStart).toHaveBeenCalledTimes(3);
    sessionStart.mockRestore();
    serviceSessionStart.mockRestore();
  });

  it("attempts only IOS+ by default (IPS / FIX+ parked)", async () => {
    const sessionStart = vi.spyOn(iress, "iressSessionStart").mockResolvedValue({
      IRESSSessionKey: "PARENT@WebServicesCT",
      SessionNumber: 1,
      SessionTimeout: 120,
      ApplicationID: "app",
    });
    const serviceSessionStart = vi
      .spyOn(iress, "serviceSessionStart")
      .mockResolvedValue({ ServiceSessionKey: "IOS-KEY", Service: "IOSPlus", Server: "IOSPLUSAPI" });

    const result = await bringUpMintSession(
      { userName: "u", company: "c", password: "p" },
      { applicationId: "app", node: "n1" },
    );

    expect(result.serviceKeys.IOSPlus).toBe("IOS-KEY");
    expect(result.serviceKeys.IPS).toBeUndefined();
    expect(result.serviceKeys.FIXPlus).toBeUndefined();
    expect(serviceSessionStart).toHaveBeenCalledTimes(1);
    expect(serviceSessionStart).toHaveBeenCalledWith(
      expect.objectContaining({ Service: "IOSPlus" }),
    );
    sessionStart.mockRestore();
    serviceSessionStart.mockRestore();
  });
});
