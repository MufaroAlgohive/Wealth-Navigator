"use client";

import { useQuery } from "@tanstack/react-query";
import { queryOpts } from "@/lib/store/query-provider";
import type { BffUnavailableReason } from "@/lib/bff-reasons";

export interface PortfolioAccount {
  account_code: string;
  account_name: string | null;
  account_type: string | null;
  currency: string | null;
  base_currency: string | null;
  beneficiary: string | null;
  account_status: string | null;
  open_date: string | null;
  nav_value: number | null;
  cash_balance: number | null;
  payload: Record<string, unknown> | null;
  ingested_at: string;
  updated_at: string;
}

export interface PortfolioPosition {
  id: string;
  account_code: string;
  security_code: string;
  exchange: string | null;
  quantity: number;
  open_average_price: number | null;
  market_value: number | null;
  open_pl: number | null;
  currency: string | null;
  open_date: string | null;
  payload: Record<string, unknown> | null;
  ingested_at: string;
  updated_at: string;
}

export interface PortfolioTransaction {
  transaction_number: string;
  account_code: string;
  tx_date: string;
  tx_type: string;
  security_code: string;
  quantity: number | null;
  price: number | null;
  amount: number | null;
  currency: string | null;
  ingested_at: string;
}

export interface PortfolioSummary {
  accounts: PortfolioAccount[];
  positions: PortfolioPosition[];
  recentTx: PortfolioTransaction[];
  aum: number;
  cashBalance: number;
  dayPnl: number;
  rebalanceDrift: number;
  rebalanceLocked: boolean;
  lastUpdatedAt: string | null;
  source: "supabase" | "unavailable";
  reason?: BffUnavailableReason;
  migration?: string;
  error?: string;
}

async function fetchPortfolio(): Promise<PortfolioSummary> {
  const res = await fetch("/api/portfolio");
  const data = (await res.json()) as PortfolioSummary;
  if (!res.ok) throw new Error(data.error ?? `portfolio ${res.status}`);
  return data;
}

/**
 * Pulls the IPS portfolio mirror from `oems_account_c` /
 * `oems_position_c` / `oems_transaction_c` via the `/api/portfolio` BFF.
 *
 * Refreshes every 30s — same cadence as `useWorkerHealth` so the
 * Platform AUM / Day P&L / Rebalance Locked tiles and the Portfolio
 * section stay in sync with the worker's `ipsLoop` writes. The 30s
 * interval is intentional: faster polling just burns the React Query
 * cache without surfacing fresh `lastUpdatedAt` (the worker writes
 * every ~60s). Audit #35.
 */
export function usePortfolio(enabled = true) {
  return useQuery({
    queryKey: ["portfolio"],
    queryFn: fetchPortfolio,
    enabled,
    refetchInterval: 30_000,
    ...queryOpts("live"),
  });
}
