import { afterEach, describe, expect, it, vi } from "vitest";

import { IressError } from "@/lib/iress/errors";

describe("session-manager", () => {
  afterEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it("caches session and reuses it within timeout", async () => {
    const bringUp = vi.fn().mockResolvedValue({
      iressSession: {
        IRESSSessionKey: "KEY-1@WebServicesCT",
        SessionNumber: 1,
        SessionTimeout: 120,
        ApplicationID: "Mint-OEMS-Dev-web-1-abc",
      },
      serviceKeys: { IOSPlus: "SSK-1", IPS: "SSK-2", FIXPlus: "SSK-3" },
    });

    vi.doMock("@/lib/iress/index", () => ({
      bringUpMintSessionFromEnv: bringUp,
      iress: { iressSessionEnd: vi.fn() },
      iressConfig: { mode: "mock" },
    }));

    const mod = await import("@/lib/iress/session-manager");
    mod.invalidateMintSession();

    const s1 = await mod.getMintSession();
    const s2 = await mod.getMintSession();

    expect(s1.iressSessionKey).toBe("KEY-1@WebServicesCT");
    expect(s2.iressSessionKey).toBe("KEY-1@WebServicesCT");
    expect(bringUp).toHaveBeenCalledTimes(1);
    expect(mod.hasValidCachedSession()).toBe(true);
  });

  it("retries once on 25001 via withMintSession", async () => {
    let calls = 0;
    const bringUp = vi.fn().mockImplementation(async () => {
      calls++;
      return {
        iressSession: {
          IRESSSessionKey: `KEY-${calls}@WebServicesCT`,
          SessionNumber: calls,
          SessionTimeout: 120,
          ApplicationID: "app",
        },
        serviceKeys: { IOSPlus: "SSK" },
      };
    });

    vi.doMock("@/lib/iress/index", () => ({
      bringUpMintSessionFromEnv: bringUp,
      iress: { iressSessionEnd: vi.fn() },
      iressConfig: { mode: "mock" },
    }));

    const mod = await import("@/lib/iress/session-manager");
    mod.invalidateMintSession();

    let attempt = 0;
    const result = await mod.withMintSession(async () => {
      attempt++;
      if (attempt === 1) throw new IressError(25001, "PricingQuoteGet", "session expired");
      return "ok";
    });

    expect(result).toBe("ok");
    expect(bringUp).toHaveBeenCalledTimes(2);
  });

  it("getSessionStatus reports uncached state after invalidate", async () => {
    vi.doMock("@/lib/iress/index", () => ({
      bringUpMintSessionFromEnv: vi.fn().mockResolvedValue({
        iressSession: { IRESSSessionKey: "K", SessionTimeout: 120, SessionNumber: 1, ApplicationID: "a" },
        serviceKeys: {},
      }),
      iress: { iressSessionEnd: vi.fn() },
      iressConfig: { mode: "mock" },
    }));

    const mod = await import("@/lib/iress/session-manager");
    mod.invalidateMintSession();
    expect(mod.getSessionStatus().cached).toBe(false);

    await mod.getMintSession();
    expect(mod.getSessionStatus().cached).toBe(true);
  });

  it("tearDownMintSession calls IRESSSessionEnd and clears cache", async () => {
    const iressSessionEnd = vi.fn().mockResolvedValue(undefined);
    const bringUp = vi.fn().mockResolvedValue({
      iressSession: {
        IRESSSessionKey: "KEY-END@WebServicesCT",
        SessionNumber: 1,
        SessionTimeout: 120,
        ApplicationID: "app",
      },
      serviceKeys: { IOSPlus: "SSK-1" },
    });

    vi.doMock("@/lib/iress/index", () => ({
      bringUpMintSessionFromEnv: bringUp,
      iress: { iressSessionEnd },
      iressConfig: { mode: "live" },
    }));

    const mod = await import("@/lib/iress/session-manager");
    mod.invalidateMintSession();
    await mod.getMintSession();

    const ended = await mod.tearDownMintSession();
    expect(ended).toBe(true);
    expect(iressSessionEnd).toHaveBeenCalledWith({
      IRESSSessionKey: "KEY-END@WebServicesCT",
    });
    expect(mod.getSessionStatus().cached).toBe(false);
  });

  it("tearDownMintSession is no-op when cache is empty", async () => {
    vi.doMock("@/lib/iress/index", () => ({
      bringUpMintSessionFromEnv: vi.fn(),
      iress: { iressSessionEnd: vi.fn() },
      iressConfig: { mode: "live" },
    }));

    const mod = await import("@/lib/iress/session-manager");
    mod.invalidateMintSession();
    expect(await mod.tearDownMintSession()).toBe(false);
  });
});
