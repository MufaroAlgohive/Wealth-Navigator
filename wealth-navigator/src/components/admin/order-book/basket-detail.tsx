"use client";

import * as React from "react";

import { usePolling } from "@/lib/hooks/use-polling";
import { R, type StrategyGroup, pnlCls } from "./format";
import { type InvestorAgg, InvestorFilterTable } from "./investor-filter-table";
import { type ExecSlice, HOLDINGS_TABLE_COLS, SecurityRow, buildSecurityGroups, cth } from "./security-row";
import { useOrderActions } from "./use-order-actions";

interface ExecutionApiRow {
  id: string;
  holding_id: string | null;
  order_id: string | null;
  client_account: string | null;
  broker_account: string | null;
  ts: string | null;
  state: string;
  filled_pct: number;
  avg_fill_price: number | null;
  limit_price: number | null;
  slippage_cents: number | null;
  day1_pnl_cents: number | null;
  tif: string | null;
  order_type: "limit" | "market" | null;
}
interface ExecutionApiResponse {
  ok: boolean;
  rows?: ExecutionApiRow[];
}

/**
 * Basket drill-down — CRM orderbook.html's basket-> securities/investors
 * pattern, flattened into the SAME table the basket header row lives in
 * (no nested bordered "panel" — attaches directly under the header row,
 * matching the upper ExecutionView panel's single-continuous-table look).
 *
 * Each security is its own collapsed aggregate row (qty/avg fill/order
 * value/last summed across whoever holds it) — click it to expand the
 * individual underlying holdings/orders that make up that total, each with
 * its own execution-level detail (Slip / Day-1 P&L, Limit, IRESS status).
 * Those three columns are per-order attributes, not summable across
 * different holders, so they only render once expanded.
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
  const [expandedSecurities, setExpandedSecurities] = React.useState<Set<string>>(new Set());
  const actions = useOrderActions();

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
        id: r.id,
        holding_id: r.holding_id,
        order_id: r.order_id,
        client_account: r.client_account,
        broker_account: r.broker_account,
        ts: r.ts,
        state: r.state,
        filled_pct: r.filled_pct,
        avg_fill_price: r.avg_fill_price,
        limit_price: r.limit_price,
        slippage_cents: r.slippage_cents,
        day1_pnl_cents: r.day1_pnl_cents,
        tif: r.tif,
        order_type: r.order_type,
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
  const toggleSecurity = (key: string) =>
    setExpandedSecurities((prev) => {
      const n = new Set(prev);
      n.has(key) ? n.delete(key) : n.add(key);
      return n;
    });

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
    <div className="space-y-3 pb-3">
      <div className="overflow-x-auto">
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
                "Slip / Day-1 P&L",
                "Limit",
                "Order",
                "IRESS",
                "Actions",
              ].map((c) => (
                <th key={c} className={cth}>
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {securities.length === 0 ? (
              <tr>
                <td
                  colSpan={HOLDINGS_TABLE_COLS}
                  className="px-3 py-6 text-center text-sm text-muted-foreground"
                >
                  No holdings.
                </td>
              </tr>
            ) : (
              securities.map((sec) => (
                <SecurityRow
                  key={sec.key}
                  sec={sec}
                  expanded={expandedSecurities.has(sec.key)}
                  onToggle={() => toggleSecurity(sec.key)}
                  onDeferred={onDeferred}
                  actions={actions}
                />
              ))
            )}
          </tbody>
        </table>
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
          {selectedInvestor ? (
            <span className="ml-2 normal-case text-foreground">— filtered to {selectedInvestor.client}</span>
          ) : (
            <span className="ml-2 normal-case text-muted-foreground/70">
              (click a row to see this client&apos;s individual fills)
            </span>
          )}
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
