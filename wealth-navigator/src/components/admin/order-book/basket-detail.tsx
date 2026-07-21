"use client";

import * as React from "react";

import { usePolling } from "@/lib/hooks/use-polling";
import { R, type StrategyGroup, pnlCls, th } from "./format";
import { type InvestorAgg, InvestorFilterTable } from "./investor-filter-table";
import { type ExecSlice, SecurityRow, buildSecurityGroups } from "./security-row";

interface ExecutionApiRow {
  id: string;
  holding_id: string | null;
  state: string;
  filled_pct: number;
  avg_fill_price: number | null;
}
interface ExecutionApiResponse {
  ok: boolean;
  rows?: ExecutionApiRow[];
}

/**
 * Basket drill-down — CRM orderbook.html's exact pattern: two tables shown
 * together ("Holdings under {strategy}" grouped by security, "Investors in
 * {strategy}" one row per investor), plus a per-security IRESS status pill.
 * Clicking an investor row filters the securities table to that investor's
 * own holdings (mirrors CRM's toggle-to-revert behavior) and shows a small
 * stat strip for that investor's own P&L subtotal.
 *
 * Execution rows are fetched lazily (only while this component is mounted,
 * i.e. only while the basket is expanded) — most baskets have never been
 * sent to market, so fetching this for every basket on page load would be
 * pure institutional-DB overhead for an almost-always-empty result.
 */
export function BasketDetail({
  group,
  onDeferred,
}: { group: StrategyGroup; onDeferred: (label: string) => void }) {
  const [selectedInvestorKey, setSelectedInvestorKey] = React.useState<string | null>(null);

  const { data: execData } = usePolling<ExecutionApiResponse>(
    `/api/admin/orderbook/execution?book_id=${encodeURIComponent(group.strategy)}`,
    { interval: 30_000 },
  );

  // Keyed by BOTH holding_id (real client holdings) and the execution row's
  // own id (synthetic ad-hoc rows have no stock_holdings_c row behind them —
  // the UAT-ADHOC ticket flow writes straight to oems_order_audit — so the
  // parent builds a synthetic Row per audit row and sets that Row's `id` to
  // the audit row's own id, matched here as a fallback).
  const execByHolding = React.useMemo(() => {
    const m = new Map<string, ExecSlice>();
    for (const r of execData?.rows ?? []) {
      const slice: ExecSlice = {
        holding_id: r.holding_id,
        state: r.state,
        filled_pct: r.filled_pct,
        avg_fill_price: r.avg_fill_price,
      };
      if (r.holding_id) m.set(r.holding_id, slice);
      m.set(r.id, slice);
    }
    return m;
  }, [execData]);

  const investors = React.useMemo<InvestorAgg[]>(() => {
    const m = new Map<string, InvestorAgg>();
    for (const r of group.rows) {
      const key = r.user_id || r.email;
      const existing = m.get(key);
      const marketValue = r.livePrice * r.qty;
      if (existing) {
        existing.marketValue += marketValue;
        existing.holdingsCount += 1;
      } else {
        m.set(key, { key, email: r.email, client: r.client, marketValue, holdingsCount: 1 });
      }
    }
    return [...m.values()].sort((a, b) => b.marketValue - a.marketValue);
  }, [group.rows]);

  const toggleInvestor = (key: string) => setSelectedInvestorKey((prev) => (prev === key ? null : key));

  const visibleRows = React.useMemo(
    () =>
      selectedInvestorKey
        ? group.rows.filter((r) => (r.user_id || r.email) === selectedInvestorKey)
        : group.rows,
    [group.rows, selectedInvestorKey],
  );

  const securities = React.useMemo(
    () => buildSecurityGroups(visibleRows, execByHolding),
    [visibleRows, execByHolding],
  );

  const selectedInvestor = investors.find((i) => i.key === selectedInvestorKey) ?? null;
  const selectedStats = React.useMemo(() => {
    if (!selectedInvestorKey) return null;
    const rs = group.rows.filter((r) => (r.user_id || r.email) === selectedInvestorKey);
    return {
      clientPnl: rs.reduce((s, r) => s + r.clientPnl, 0),
      mintPnl: rs.reduce((s, r) => s + r.mintPnl, 0),
    };
  }, [group.rows, selectedInvestorKey]);

  return (
    <div className="space-y-3 py-3">
      <div>
        <div className="px-1 pb-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          Holdings under {group.strategy}
          {selectedInvestor && (
            <span className="ml-2 normal-case text-foreground">— filtered to {selectedInvestor.client}</span>
          )}
        </div>
        <div className="overflow-x-auto rounded-lg border border-border/60">
          <table className="w-full border-collapse">
            <thead>
              <tr className="border-b border-border/60 bg-card/40">
                {[
                  "Instrument",
                  "Side",
                  "Qty",
                  "Avg Fill",
                  "Order Value",
                  "Last",
                  "Client P&L",
                  "MINT P&L",
                  "IRESS",
                ].map((c) => (
                  <th key={c} className={th}>
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {securities.length === 0 ? (
                <tr>
                  <td colSpan={9} className="px-3 py-6 text-center text-sm text-muted-foreground">
                    No holdings.
                  </td>
                </tr>
              ) : (
                securities.map((sec) => <SecurityRow key={sec.key} sec={sec} onDeferred={onDeferred} />)
              )}
            </tbody>
          </table>
        </div>
      </div>

      {selectedInvestor && selectedStats && (
        <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border/60 bg-card/40 px-3 py-2">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            {selectedInvestor.client} — individual fills &amp; P&amp;L
          </div>
          <div className="text-[12px]">
            Client P&amp;L:{" "}
            <span className={pnlCls(selectedStats.clientPnl)}>{R(selectedStats.clientPnl)}</span>
          </div>
          <div className="text-[12px]">MINT P&amp;L: {R(selectedStats.mintPnl)}</div>
        </div>
      )}

      <div>
        <div className="px-1 pb-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          Investors in {group.strategy}
          <span className="ml-2 normal-case text-muted-foreground/70">
            (click a row to see this client&apos;s individual fills)
          </span>
        </div>
        <InvestorFilterTable
          investors={investors}
          selectedKey={selectedInvestorKey}
          onSelect={toggleInvestor}
        />
      </div>
    </div>
  );
}
