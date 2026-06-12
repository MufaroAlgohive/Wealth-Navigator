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
  });

  it("continues when optional ServiceSessionStart calls fail", async () => {
    const sessionStart = vi.spyOn(iress, "iressSessionStart").mockResolvedValue({
      IRESSSessionKey: "PARENT@WebServicesCT",
      SessionNumber: 1,
      SessionTimeout: 120,
      ApplicationID: "app",
    });
    const serviceSessionStart = vi
      .spyOn(iress, "serviceSessionStart")
      .mockRejectedValueOnce(new IressError(666, "ServiceSessionStart", "soap:Receiver — HTTP 500"))
      .mockResolvedValueOnce({ ServiceSessionKey: "IPS-KEY" })
      .mockResolvedValueOnce({ ServiceSessionKey: "FIX-KEY" });

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
});
