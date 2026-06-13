"use client";

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";

import { usePortfolio, type PortfolioSummary } from "@/lib/hooks/use-portfolio";
import { isRealDataOnlyClient } from "@/lib/data-policy";
import { queryOpts } from "@/lib/store/query-provider";

export interface AccountCash {
  accountCode: string;
  /** Available cash in ZAR rands (NOT cents). Falls back to 0 when unknown. */
  available: number;
  /** Whether the number is from real Supabase data or the `MOCK_ACCOUNT_CASH` fixture. */
  source: "supabase" | "mock-fallback" | "unavailable";
}

/**
 * Legacy mock fixture the new-order dialog used before the
 * /api/portfolio route existed. Kept in one place so the unit test
 * (and the dialog) can both reference the same fixture. Real code
 * paths should consult the portfolio hook first and only fall back
 * here when the user is running the demo in mock mode.
 */
export const MOCK_ACCOUNT_CASH: Record<string, number> = {
  "MINT-LIVE-001": 4_250_000,
  "MINT-LIVE-002": 1_900_000,
  "MINT-MM-001": 12_500_000,
};

function mockAccountCash(accountCode: string): AccountCash {
  return {
    accountCode,
    available: MOCK_ACCOUNT_CASH[accountCode] ?? 0,
    source: "mock-fallback",
  };
}

/**
 * Resolve the buying-power cash for a given account. In real-data mode
 * the number comes from the IPS portfolio mirror (`oems_account_c`).
 * In mock / demo mode we fall back to the seed fixture so the dialog
 * still has a number to put on the pre-trade check.
 */
export function useAccountCash(accountCode: string): AccountCash {
  const realDataOnly = isRealDataOnlyClient();
  const portfolio = usePortfolio(realDataOnly);

  return useMemo<AccountCash>(() => {
    if (!accountCode) return { accountCode: "", available: 0, source: "unavailable" };
    if (!realDataOnly) return mockAccountCash(accountCode);
    const summary: PortfolioSummary | undefined = portfolio.data;
    if (!summary) {
      // Still loading; render the mock number behind a `mock-fallback`
      // tag so the UI doesn't pop a flash to "0" before the first
      // portfolio fetch completes. The /api/portfolio response will
      // replace this on the next render.
      return mockAccountCash(accountCode);
    }
    if (summary.source !== "supabase") {
      return mockAccountCash(accountCode);
    }
    const acc = summary.accounts.find((a) => a.account_code === accountCode);
    const available = acc ? Number(acc.cash_balance ?? 0) : 0;
    if (!acc) {
      // Real-data mode but the account isn't in the mirror yet. Tell
      // the dialog to treat the pre-trade cash check as "unknown" by
      // returning 0 with the unavailable source — the `blocked` gate
      // will keep the Send button disabled until the worker fills in
      // the row.
      return { accountCode, available: 0, source: "unavailable" };
    }
    return { accountCode, available, source: "supabase" };
  }, [accountCode, realDataOnly, portfolio.data]);
}

/**
 * Lightweight fetcher for the new-order dialog's submitter to use
 * when it needs a one-shot portfolio refresh (e.g. after a successful
 * fill to re-validate buying power). Wraps the existing `usePortfolio`
 * query — kept as a separate export so tests can pre-populate the
 * query cache.
 */
export function usePortfolioRefetch() {
  const realDataOnly = isRealDataOnlyClient();
  return useQuery({
    queryKey: ["portfolio"],
    queryFn: async () => {
      const res = await fetch("/api/portfolio");
      if (!res.ok) throw new Error(`portfolio ${res.status}`);
      return (await res.json()) as PortfolioSummary;
    },
    enabled: realDataOnly,
    refetchInterval: 30_000,
    ...queryOpts("live"),
  });
}
