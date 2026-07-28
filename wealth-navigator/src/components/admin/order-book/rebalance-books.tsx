"use client";

import { ChevronRight } from "lucide-react";
import * as React from "react";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/cn";
import { usePolling } from "@/lib/hooks/use-polling";

interface RebalanceEvent {
  id: string;
  client: string;
  relationship: string | null;
  instrument: string;
  ticker: string;
  side: string;
  qty: number;
  fill_rands: number | null;
  fill_date: string | null;
  reason: string | null;
}
interface RebalanceBatch {
  id: string;
  strategy: string;
  status: string;
  settlement_state: string;
  settlement_error: string | null;
  sell_isin: string | null;
  buy_isin: string | null;
  extra_buy_isin: string | null;
  display_at: string;
  reversed_reason: string | null;
  events: RebalanceEvent[];
}

const money = (value: number | null) =>
  value == null ? "—" : `R${value.toLocaleString("en-ZA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function RebalanceBooks({ scope = "live" }: { scope?: "live" | "uat" }) {
  const query = usePolling<{ ok: boolean; batches?: RebalanceBatch[]; error?: string }>(
    `/api/admin/orderbook/crm-modules?module=rebalances&scope=${scope}`,
    { interval: 15_000 },
  );
  const [expanded, setExpanded] = React.useState<Set<string>>(new Set());
  const batches = query.data?.batches ?? [];

  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card/40">
      <div className="border-b border-border px-4 py-3">
        <h2 className="text-xs font-semibold uppercase text-muted-foreground">Rebalance Books</h2>
      </div>
      {query.error || query.data?.error ? (
        <div className="px-4 py-3 text-xs text-destructive">{query.error?.message ?? query.data?.error}</div>
      ) : query.loading ? (
        <div className="px-4 py-8 text-center text-xs text-muted-foreground">Loading rebalances...</div>
      ) : batches.length === 0 ? (
        <div className="px-4 py-8 text-center text-xs text-muted-foreground">No rebalance batches.</div>
      ) : (
        <div className="divide-y divide-border/50">
          {batches.map((batch) => {
            const open = expanded.has(batch.id);
            const destination = batch.buy_isin || "Cash";
            return (
              <div key={batch.id}>
                <button
                  type="button"
                  className="flex w-full flex-wrap items-center justify-between gap-3 px-4 py-3 text-left hover:bg-accent/30"
                  onClick={() =>
                    setExpanded((current) => {
                      const next = new Set(current);
                      if (next.has(batch.id)) next.delete(batch.id);
                      else next.add(batch.id);
                      return next;
                    })
                  }
                >
                  <span className="flex items-center gap-2 text-xs font-semibold">
                    <ChevronRight className={cn("h-4 w-4 transition-transform", open && "rotate-90")} />
                    {batch.buy_isin ? "Rebalance" : "Liquidation"} · {batch.strategy} ({batch.sell_isin || "—"} →{" "}
                    {destination}{batch.extra_buy_isin ? ` + ${batch.extra_buy_isin}` : ""})
                  </span>
                  <span className="flex items-center gap-2">
                    <Badge variant={batch.status === "SETTLED" ? "success" : batch.status === "REVERSED" ? "destructive" : "warning"}>
                      {batch.status}
                    </Badge>
                    <Badge variant="outline">{batch.settlement_state}</Badge>
                    <span className="text-[11px] text-muted-foreground">{batch.events.length} clients</span>
                    <span className="text-[11px] text-muted-foreground">
                      {batch.display_at ? new Date(batch.display_at).toLocaleString("en-ZA") : "—"}
                    </span>
                  </span>
                </button>
                {open ? (
                  <div className="overflow-x-auto border-t border-border/40 px-4 py-2">
                    {batch.settlement_error || batch.reversed_reason ? (
                      <div className="mb-2 text-[11px] text-destructive">
                        {batch.settlement_error ?? batch.reversed_reason}
                      </div>
                    ) : null}
                    <table className="w-full text-[11px]">
                      <thead>
                        <tr className="text-left text-[10px] uppercase text-muted-foreground">
                          <th className="py-1 pr-3">Client</th><th className="py-1 pr-3">Instrument</th>
                          <th className="py-1 pr-3">Ticker</th><th className="py-1 pr-3">Side</th>
                          <th className="py-1 pr-3 text-right">Qty</th><th className="py-1 pr-3 text-right">Fill</th>
                          <th className="py-1 pr-3">Fill date</th><th className="py-1">Reason</th>
                        </tr>
                      </thead>
                      <tbody>
                        {batch.events.map((event) => (
                          <tr key={event.id} className="border-t border-border/30">
                            <td className="py-1.5 pr-3 font-medium">{event.client}{event.relationship ? ` (${event.relationship})` : ""}</td>
                            <td className="py-1.5 pr-3">{event.instrument}</td><td className="py-1.5 pr-3">{event.ticker}</td>
                            <td className="py-1.5 pr-3">{event.side}</td><td className="py-1.5 pr-3 text-right">{event.qty}</td>
                            <td className="py-1.5 pr-3 text-right">{money(event.fill_rands)}</td>
                            <td className="py-1.5 pr-3">{event.fill_date ?? "—"}</td><td className="py-1.5">{event.reason ?? "—"}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
