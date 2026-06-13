import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";

/**
 * Tests for `useAccountCash`. The hook has three behaviours:
 *  1. mock mode: returns the `MOCK_ACCOUNT_CASH` fixture
 *  2. real-data + portfolio loaded + account present: returns
 *     `source: "supabase"` with the real cash_balance (ZAR rands)
 *  3. real-data + portfolio loaded but account missing: returns
 *     `source: "unavailable"` with `available: 0` (gates the Send
 *     button until the worker fills in the row)
 *  4. real-data + portfolio still loading: returns the mock number
 *     tagged `mock-fallback` so the dialog doesn't pop a flash to 0
 *
 * We mock `@/lib/hooks/use-portfolio` and `@/lib/data-policy` so the
 * test exercises only the hook's mapping logic.
 */

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.restoreAllMocks();
});

describe("useAccountCash", () => {
  it("returns the mock fixture when running in mock mode", async () => {
    vi.doMock("@/lib/data-policy", () => ({
      isRealDataOnlyClient: () => false,
    }));
    vi.doMock("@/lib/hooks/use-portfolio", () => ({
      usePortfolio: () => ({ data: undefined }),
    }));
    const { useAccountCash, MOCK_ACCOUNT_CASH } = await import("@/lib/hooks/use-account-cash");
    const { result } = renderHook(() => useAccountCash("MINT-LIVE-001"));
    expect(result.current.source).toBe("mock-fallback");
    expect(result.current.available).toBe(MOCK_ACCOUNT_CASH["MINT-LIVE-001"]);
  });

  it("returns unavailable when real-data + account missing from the IPS mirror", async () => {
    vi.doMock("@/lib/data-policy", () => ({
      isRealDataOnlyClient: () => true,
    }));
    vi.doMock("@/lib/hooks/use-portfolio", () => ({
      usePortfolio: () => ({
        data: {
          source: "supabase" as const,
          accounts: [{ account_code: "MINT-LIVE-001", cash_balance: 4_250_000 } as never],
          positions: [],
          recentTx: [],
          aum: 0,
          cashBalance: 0,
          dayPnl: 0,
          rebalanceDrift: 0,
          rebalanceLocked: false,
          lastUpdatedAt: null,
        },
      }),
    }));
    const { useAccountCash } = await import("@/lib/hooks/use-account-cash");
    const { result } = renderHook(() => useAccountCash("MINT-MM-001"));
    expect(result.current.source).toBe("unavailable");
    expect(result.current.available).toBe(0);
  });

  it("returns the real cash_balance when the account is present in the IPS mirror", async () => {
    vi.doMock("@/lib/data-policy", () => ({
      isRealDataOnlyClient: () => true,
    }));
    vi.doMock("@/lib/hooks/use-portfolio", () => ({
      usePortfolio: () => ({
        data: {
          source: "supabase" as const,
          accounts: [
            { account_code: "MINT-LIVE-001", cash_balance: 4_250_000 } as never,
            { account_code: "MINT-MM-001", cash_balance: 12_500_000 } as never,
          ],
          positions: [],
          recentTx: [],
          aum: 0,
          cashBalance: 0,
          dayPnl: 0,
          rebalanceDrift: 0,
          rebalanceLocked: false,
          lastUpdatedAt: null,
        },
      }),
    }));
    const { useAccountCash } = await import("@/lib/hooks/use-account-cash");
    const { result } = renderHook(() => useAccountCash("MINT-MM-001"));
    expect(result.current.source).toBe("supabase");
    expect(result.current.available).toBe(12_500_000);
  });

  it("returns unavailable with available=0 when accountCode is empty", async () => {
    vi.doMock("@/lib/data-policy", () => ({
      isRealDataOnlyClient: () => true,
    }));
    vi.doMock("@/lib/hooks/use-portfolio", () => ({
      usePortfolio: () => ({ data: undefined }),
    }));
    const { useAccountCash } = await import("@/lib/hooks/use-account-cash");
    const { result } = renderHook(() => useAccountCash(""));
    expect(result.current.source).toBe("unavailable");
    expect(result.current.available).toBe(0);
  });

  it("falls back to the mock fixture when the portfolio is still loading in real-data mode", async () => {
    vi.doMock("@/lib/data-policy", () => ({
      isRealDataOnlyClient: () => true,
    }));
    vi.doMock("@/lib/hooks/use-portfolio", () => ({
      usePortfolio: () => ({ data: undefined }),
    }));
    const { useAccountCash, MOCK_ACCOUNT_CASH } = await import("@/lib/hooks/use-account-cash");
    const { result } = renderHook(() => useAccountCash("MINT-LIVE-001"));
    // Real-data mode + loading → fall back to the mock fixture but
    // tag it `mock-fallback` so the UI knows to expect a real number
    // when the portfolio fetch lands.
    expect(result.current.source).toBe("mock-fallback");
    expect(result.current.available).toBe(MOCK_ACCOUNT_CASH["MINT-LIVE-001"]);
  });

  it("falls back to the mock fixture when portfolio source is unavailable", async () => {
    vi.doMock("@/lib/data-policy", () => ({
      isRealDataOnlyClient: () => true,
    }));
    vi.doMock("@/lib/hooks/use-portfolio", () => ({
      usePortfolio: () => ({
        data: {
          source: "unavailable" as const,
          accounts: [],
          positions: [],
          recentTx: [],
          aum: 0,
          cashBalance: 0,
          dayPnl: 0,
          rebalanceDrift: 0,
          rebalanceLocked: false,
          lastUpdatedAt: null,
        },
      }),
    }));
    const { useAccountCash, MOCK_ACCOUNT_CASH } = await import("@/lib/hooks/use-account-cash");
    const { result } = renderHook(() => useAccountCash("MINT-LIVE-001"));
    expect(result.current.source).toBe("mock-fallback");
    expect(result.current.available).toBe(MOCK_ACCOUNT_CASH["MINT-LIVE-001"]);
  });
});
