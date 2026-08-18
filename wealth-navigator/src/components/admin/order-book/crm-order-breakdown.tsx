"use client";

import * as React from "react";

import { cn } from "@/lib/cn";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import type { OrderBookMember } from "./execution-view";

type CrmHolding = NonNullable<OrderBookMember["crm_details"]>["holdings"][number];

const money = (value: number | null) =>
  value == null
    ? "—"
    : new Intl.NumberFormat("en-ZA", {
        style: "currency",
        currency: "ZAR",
        minimumFractionDigits: 2,
      }).format(value);

export function CrmOrderBreakdown({ member, bookId }: { member: OrderBookMember; bookId: string }) {
  const details = member.crm_details;
  const [selectedInvestorId, setSelectedInvestorId] = React.useState<string | null>(null);
  const [investorHoldings, setInvestorHoldings] = React.useState<CrmHolding[] | null>(null);
  const [investorLoading, setInvestorLoading] = React.useState(false);
  const [investorError, setInvestorError] = React.useState<string | null>(null);
  const [sending, setSending] = React.useState<Record<string, boolean>>({});

  const sendConfirmation = async (investorId: string, investorName: string) => {
    setSending((p) => ({ ...p, [investorId]: true }));
    try {
      const res = await fetch("/api/admin/orderbook/send-confirmation", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          order_id: member.order_id || member.id,
          book_id: bookId,
          investor_id: investorId,
        }),
      });
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok || body.ok === false) {
        toast.error(body.error ?? `Send Confirmation failed (${res.status})`);
        return;
      }
      toast.success(`Confirmation sent for ${investorName}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Send Confirmation failed");
    } finally {
      setSending((p) => ({ ...p, [investorId]: false }));
    }
  };

  if (!details) return null;
  const selectedInvestor =
    details.investors.find((investor) => investor.id === selectedInvestorId) ?? null;
  const selectedSources = new Set(selectedInvestor?.source_ids ?? []);
  const visibleHoldings =
    selectedInvestor && investorHoldings
      ? investorHoldings
      : selectedInvestor && selectedSources.size > 0
      ? details.holdings.filter((holding) =>
          holding.source_ids.some((sourceId) => selectedSources.has(sourceId)),
        )
      : details.holdings;

  const selectInvestor = async (investorId: string) => {
    if (selectedInvestorId === investorId) {
      setSelectedInvestorId(null);
      setInvestorHoldings(null);
      setInvestorError(null);
      return;
    }
    const investor = details.investors.find((item) => item.id === investorId);
    setSelectedInvestorId(investorId);
    setInvestorHoldings(null);
    setInvestorError(null);
    if (!investor?.source_ids.length) return;
    setInvestorLoading(true);
    try {
      const response = await fetch(
        `/api/admin/orderbook/crm-investor-holdings?ids=${encodeURIComponent(investor.source_ids.join(","))}`,
        { cache: "no-store" },
      );
      const payload = (await response.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        holdings?: CrmHolding[];
      };
      if (!response.ok || payload.ok === false) {
        setInvestorError(payload.error ?? `Investor holdings returned ${response.status}`);
      } else {
        setInvestorHoldings(payload.holdings ?? []);
      }
    } catch (error) {
      setInvestorError(error instanceof Error ? error.message : String(error));
    } finally {
      setInvestorLoading(false);
    }
  };

  return (
    <div className="space-y-3 border-t border-border/40 bg-muted/20 px-3 py-3">
      {details.is_strategy ? (
        <>
          <section>
            <h4 className="mb-1.5 text-[10px] font-semibold uppercase text-muted-foreground">
              Holdings under {details.strategy_name ?? member.symbol ?? "strategy"}
              {selectedInvestor ? ` · ${selectedInvestor.name}` : ""}
            </h4>
            {investorLoading ? (
              <div className="mb-2 text-[11px] text-violet-600 dark:text-violet-300">Loading investor values...</div>
            ) : investorError ? (
              <div className="mb-2 text-[11px] text-destructive">{investorError}</div>
            ) : null}
            {visibleHoldings.length ? (
              <div className="overflow-x-auto">
                <table className="w-full text-[11px]">
                  <thead>
                    <tr className="text-left text-[10px] uppercase text-muted-foreground">
                      <th className="py-1 pr-3">Instrument</th>
                      <th className="py-1 pr-3">Ticker</th>
                      <th className="py-1 pr-3">Side</th>
                      <th className="py-1 pr-3 text-right">Qty</th>
                      <th className="py-1 pr-3 text-right">Avg fill</th>
                      <th className="py-1 pr-3 text-right">Expected fill</th>
                      <th className="py-1 pr-3 text-right">Market value</th>
                      <th className="py-1 text-right">Position PnL (unrealised)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleHoldings.map((holding) => (
                      <tr key={holding.id} className="border-t border-border/30">
                        <td className="py-1.5 pr-3 font-medium">{holding.instrument}</td>
                        <td className="py-1.5 pr-3 text-muted-foreground">{holding.ticker}</td>
                        <td className="py-1.5 pr-3">{holding.side}</td>
                        <td className="py-1.5 pr-3 text-right tabular-nums">{holding.qty}</td>
                        <td className="py-1.5 pr-3 text-right tabular-nums">{money(holding.avg_fill_rands)}</td>
                        <td className="py-1.5 pr-3 text-right tabular-nums">{money(holding.expected_fill_rands)}</td>
                        <td className="py-1.5 pr-3 text-right tabular-nums">{money(holding.market_value_rands)}</td>
                        <td className="py-1.5 text-right tabular-nums">{money(holding.pnl_rands)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="text-[11px] text-muted-foreground">No holdings captured for this strategy.</div>
            )}
          </section>

          <section>
            <h4 className="mb-1.5 text-[10px] font-semibold uppercase text-muted-foreground">
              Investors in {details.strategy_name ?? member.symbol ?? "strategy"}
            </h4>
            {details.investors.length ? (
              <div className="overflow-x-auto">
                <table className="w-full text-[11px]">
                  <thead>
                    <tr className="text-left text-[10px] uppercase text-muted-foreground">
                      <th className="py-1 pr-3">Client</th>
                      <th className="py-1 pr-3">Account</th>
                      <th className="py-1 pr-3">Owner</th>
                      <th className="py-1 pr-3 text-right">Holdings</th>
                      <th className="py-1 pr-3 text-right">Market value</th>
                      <th className="py-1 text-right">Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {details.investors.map((investor) => {
                      const selected = investor.id === selectedInvestorId;
                      const isSending = !!sending[investor.id];
                      return (
                      <tr
                        key={investor.id}
                        className={cn(
                          "border-t border-border/30 transition-colors",
                          selected && "bg-violet-600/25 text-violet-200",
                        )}
                        aria-selected={selected}
                      >
                        <td className="p-0 pr-3 font-medium">
                          <button
                            type="button"
                            className={cn(
                              "w-full px-2 py-2 text-left font-semibold transition-colors hover:bg-violet-500/15 hover:text-violet-300",
                              selected && "text-violet-200",
                            )}
                            onClick={() => void selectInvestor(investor.id)}
                            aria-pressed={selected}
                          >
                            {investor.name}
                          </button>
                        </td>
                        <td className="py-1.5 pr-3">{investor.account_id ?? "—"}</td>
                        <td className="py-1.5 pr-3 text-muted-foreground">
                          {investor.family_relationship ?? "Primary"}
                        </td>
                        <td className="py-1.5 pr-3 text-right tabular-nums">{investor.holdings_count}</td>
                        <td className="py-1.5 pr-3 text-right tabular-nums">{money(investor.market_value_rands)}</td>
                        <td className="py-1.5 text-right">
                          <Button
                            variant="outline"
                            size="sm"
                            className="h-6 text-[10px]"
                            disabled={isSending}
                            onClick={() => void sendConfirmation(investor.id, investor.name)}
                            title="Sends trade confirmation emails to this client."
                          >
                            {isSending ? "Sending…" : "Send Confirm"}
                          </Button>
                        </td>
                      </tr>
                    )})}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="text-[11px] text-muted-foreground">No investors captured for this strategy.</div>
            )}
          </section>
        </>
      ) : details.allocations.length ? (
        <section>
          <h4 className="mb-1.5 text-[10px] font-semibold uppercase text-muted-foreground">
            BND allocation details
          </h4>
          <div className="overflow-x-auto">
            <table className="w-full text-[11px]">
              <thead>
                <tr className="text-left text-[10px] uppercase text-muted-foreground">
                  <th className="py-1 pr-3">Client</th>
                  <th className="py-1 pr-3">Account</th>
                  <th className="py-1 pr-3">BND reference</th>
                  <th className="py-1 pr-3 text-right">Qty</th>
                  <th className="py-1 pr-3 text-right">Market value</th>
                  <th className="py-1 pr-3">Order time</th>
                  <th className="py-1 pr-3">Instruction</th>
                  <th className="py-1">Settlement ref</th>
                </tr>
              </thead>
              <tbody>
                {details.allocations.map((allocation) => (
                  <tr key={allocation.id} className="border-t border-border/30">
                    <td className="py-1.5 pr-3 font-medium">{allocation.name}</td>
                    <td className="py-1.5 pr-3">{allocation.account_id ?? "—"}</td>
                    <td className="py-1.5 pr-3 font-mono text-[10px]">{allocation.reference ?? "—"}</td>
                    <td className="py-1.5 pr-3 text-right tabular-nums">{allocation.qty}</td>
                    <td className="py-1.5 pr-3 text-right tabular-nums">{money(allocation.market_value_rands)}</td>
                    <td className="py-1.5 pr-3">{allocation.timestamp ?? "—"}</td>
                    <td className="py-1.5 pr-3">{allocation.instruction_type ?? "Market"}</td>
                    <td className="py-1.5">{allocation.settlement_ref ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}
    </div>
  );
}
