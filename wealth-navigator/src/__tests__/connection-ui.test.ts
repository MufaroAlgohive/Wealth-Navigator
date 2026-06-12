import { describe, expect, it } from "vitest";
import {
  deriveConnectionStatus,
  STREAM_LIVE_MS,
  STREAM_STALE_MS,
  SUPABASE_STALE_MS,
} from "@/lib/connection-status";
import { resolveSideNavBadge } from "@/lib/side-nav-badges";

describe("deriveConnectionStatus", () => {
  it("shows SUPABASE OK within 20s in real-data mode", () => {
    expect(deriveConnectionStatus(9_000, "mock", true)).toEqual({
      label: "SUPABASE OK",
      tone: "live",
      stale: false,
    });
    expect(deriveConnectionStatus(SUPABASE_STALE_MS, "supabase", false).label).toBe("SUPABASE OK");
  });

  it("shows STALE after 20s in supabase mode", () => {
    expect(deriveConnectionStatus(SUPABASE_STALE_MS + 1, "supabase", false)).toEqual({
      label: "STALE",
      tone: "stale",
      stale: true,
    });
  });

  it("uses WS thresholds for stream feed in dev mode", () => {
    expect(deriveConnectionStatus(STREAM_LIVE_MS - 1, "stream", false).label).toBe("WS OK");
    expect(deriveConnectionStatus(3_000, "stream", false).label).toBe("LAG");
    expect(deriveConnectionStatus(STREAM_STALE_MS + 1, "stream", false).label).toBe("STALE");
  });
});

describe("resolveSideNavBadge", () => {
  it("keeps seed badges in demo mode", () => {
    expect(resolveSideNavBadge("/oems/blotter", false, "12", {})).toBe("12");
    expect(resolveSideNavBadge("/oems/strategies", false, "6", {})).toBe("6");
  });

  it("shows audit order count for blotter in real-data mode", () => {
    expect(resolveSideNavBadge("/oems/blotter", true, "12", { blotterOrders: 0 })).toBe(0);
    expect(resolveSideNavBadge("/oems/blotter", true, "12", { blotterOrders: 3 })).toBe(3);
  });

  it("hides strategies and news badges in real-data mode", () => {
    expect(resolveSideNavBadge("/oems/strategies", true, "6", { blotterOrders: 0 })).toBeUndefined();
    expect(resolveSideNavBadge("/oems/news", true, "4", { blotterOrders: 0 })).toBeUndefined();
  });
});
