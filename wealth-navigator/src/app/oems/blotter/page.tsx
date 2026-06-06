"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Search, RefreshCw, MoreHorizontal, Filter } from "lucide-react";
import { toast } from "sonner";

import { Panel } from "@/components/oems/primitives/panel";
import { Pill } from "@/components/oems/primitives/pill";
import { NumberCell } from "@/components/oems/primitives/number-cell";
import { ConfirmDestructive } from "@/components/oems/confirm-destructive";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { useIress } from "@/lib/iress/provider";
import { formatTime, formatZAR } from "@/lib/format";
import { cn } from "@/lib/cn";
import { NewOrderDialog } from "./new-order-dialog";
import type { Order, OrderState } from "@/types/iress";

const STATES: Array<{ key: OrderState | "ALL"; label: string }> = [
  { key: "ALL",       label: "All" },
  { key: "WORKING",   label: "Working" },
  { key: "PARTIAL",   label: "Partial" },
  { key: "FILLED",    label: "Filled" },
  { key: "CANCELLED", label: "Cancelled" },
  { key: "REJECTED",  label: "Rejected" },
];

export default function BlotterPage() {
  const { data, client } = useIress();
  const qc = useQueryClient();
  const [state, setState] = useState<OrderState | "ALL">("ALL");
  const [q, setQ] = useState("");

  const ordersQ = useQuery({ queryKey: ["orders"], queryFn: () => data.orders() });
  const orders = ordersQ.data ?? [];

  const filtered = useMemo(() => {
    return orders.filter((o) =>
      (state === "ALL" || o.state === state) &&
      (q === "" || o.symbol.toLowerCase().includes(q.toLowerCase()) || o.strategy.toLowerCase().includes(q.toLowerCase()) || o.id.toLowerCase().includes(q.toLowerCase())));
  }, [orders, state, q]);

  const counts = STATES.reduce<Record<string, number>>((acc, s) => {
    acc[s.key] = s.key === "ALL" ? orders.length : orders.filter((o) => o.state === s.key).length;
    return acc;
  }, {} as Record<string, number>);
  const workingCount = counts.WORKING ?? 0;
  const partialCount = counts.PARTIAL ?? 0;

  const openOrders = useMemo(
    () => orders.filter((o) => o.state === "WORKING" || o.state === "PARTIAL"),
    [orders],
  );

  const cancelAll = useMutation({
    mutationFn: async () => {
      const working = orders.filter((o) => o.state === "WORKING" || o.state === "PARTIAL");
      await Promise.all(working.map((o) => client.orderDelete({ ServiceSessionKey: "MOCK-S", OrderNumber: o.id })));
      return working.length;
    },
    onSuccess: (n) => {
      toast.success(`Cancelled ${n} working order${n === 1 ? "" : "s"}`);
      qc.invalidateQueries({ queryKey: ["orders"] });
    },
    onError: () => toast.error("Cancel-all failed"),
  });

  return (
    <div className="space-y-3">
      <header className="flex flex-wrap items-end justify-between gap-3 pb-1">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">Blotter & Orders</h1>
          <p className="text-xs text-muted-foreground">
            Live execution tape · FIX 4.4 via IRESS gateway · slippage in bps vs arrival
          </p>
        </div>
        <div className="flex items-center gap-2">
          <ConfirmDestructive
            count={openOrders.length}
            label={`CANCEL ${openOrders.length} ${openOrders.length === 1 ? "ORDER" : "ORDERS"}`}
            triggerLabel="Cancel working"
            triggerVariant="outline"
            disabled={cancelAll.isPending}
            description="IRESS · OrderDelete · orders will be removed from the venue"
            previewItems={openOrders.map((o) => ({
              id: o.id,
              primary: `${o.side} ${o.qty.toLocaleString()} ${o.symbol}`,
              secondary: `@ ${o.arrivalMid.toFixed(2)}${o.destination ? ` · ${o.destination}` : ""}`,
            }))}
            onConfirm={async () => {
              await cancelAll.mutateAsync();
            }}
          />
          <NewOrderDialog onCreated={() => qc.invalidateQueries({ queryKey: ["orders"] })} />
        </div>
      </header>

      <div className="flex flex-wrap items-center gap-3">
        <Tabs value={state} onValueChange={(v) => setState(v as typeof state)}>
          <TabsList className="h-8">
            {STATES.map((s) => (
              <TabsTrigger key={s.key} value={s.key} className="h-6 text-[11px] gap-1.5">
                {s.label}
                <span className="rounded bg-muted px-1 font-mono text-[9.5px] text-muted-foreground">{counts[s.key]}</span>
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <div className="relative w-72">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Symbol, strategy, order id…" className="h-8 pl-8 text-xs" />
        </div>
        <div className="ml-auto text-[10px] text-muted-foreground">
          {filtered.length} of {orders.length} orders · IRESS · OrderPadGetByAccount
        </div>
      </div>

      <Panel title={`Orders · ${filtered.length}`} endpoint="GET /v1/orders" density="scroll" className="h-[calc(100vh-260px)]">
        {ordersQ.isLoading ? (
          <div className="space-y-1.5 px-3.5 py-2.5" aria-busy="true" aria-live="polite">
            {Array.from({ length: 10 }).map((_, i) => (
              <div key={i} className="flex items-center gap-3">
                <span className="shimmer h-2.5 w-20 rounded" />
                <span className="shimmer h-2.5 w-14 rounded" />
                <span className="shimmer h-2.5 w-24 rounded" />
                <span className="shimmer h-2.5 w-10 rounded" />
                <span className="shimmer h-2.5 w-14 rounded" />
                <span className="shimmer h-2.5 w-20 rounded" />
                <span className="shimmer h-2.5 w-16 rounded" />
                <span className="ml-auto shimmer h-2.5 w-12 rounded" />
              </div>
            ))}
          </div>
        ) : (
          <table className="w-full font-mono text-[11px]">
            <thead className="sticky top-0 z-10 bg-card/95 backdrop-blur">
              <tr className="text-[9.5px] uppercase tracking-wider text-muted-foreground">
                <th className="px-2.5 py-2 text-left">Order ID</th>
                <th className="px-2.5 py-2 text-left">Time</th>
                <th className="px-2.5 py-2 text-left">Strategy</th>
                <th className="px-2.5 py-2 text-left">Side</th>
                <th className="px-2.5 py-2 text-left">Sym</th>
                <th className="px-2.5 py-2 text-left">ISIN</th>
                <th className="px-2.5 py-2 text-right">Qty</th>
                <th className="px-2.5 py-2 text-right">Filled</th>
                <th className="px-2.5 py-2 text-right">Limit</th>
                <th className="px-2.5 py-2 text-right">Last</th>
                <th className="px-2.5 py-2 text-right">VWAP</th>
                <th className="px-2.5 py-2 text-right">Slip</th>
                <th className="px-2.5 py-2 text-left">Venue</th>
                <th className="px-2.5 py-2 text-left">TIF</th>
                <th className="px-2.5 py-2 text-left">Trader</th>
                <th className="px-2.5 py-2 text-left">State</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/60">
              {filtered.map((o) => (
                <OrderRow key={o.id} order={o} />
              ))}
            </tbody>
          </table>
        )}
      </Panel>
    </div>
  );
}

function OrderRow({ order }: { order: Order }) {
  return (
    <tr className="hover:bg-muted/30">
      <td className="px-2.5 py-1.5 text-muted-foreground">{order.id}</td>
      <td className="px-2.5 py-1.5 text-muted-foreground">{formatTime(order.ts)}</td>
      <td className="px-2.5 py-1.5">{order.strategy}</td>
      <td className={cn("px-2.5 py-1.5 font-semibold", order.side === "BUY" ? "text-up" : "text-down")}>{order.side}</td>
      <td className="px-2.5 py-1.5 font-semibold">{order.symbol}</td>
      <td className="px-2.5 py-1.5 text-[9.5px] text-muted-foreground">{order.isin}</td>
      <td className="px-2.5 py-1.5 text-right tabular-nums">{order.qty.toLocaleString()}</td>
      <td className="px-2.5 py-1.5 text-right tabular-nums">
        {order.filled.toLocaleString()} <span className="text-muted-foreground/70">({Math.round((order.filled / order.qty) * 100)}%)</span>
      </td>
      <td className="px-2.5 py-1.5 text-right tabular-nums">{order.limit?.toFixed(2) ?? "MKT"}</td>
      <td className="px-2.5 py-1.5 text-right tabular-nums">
        <NumberCell sym={order.symbol} fallback={order.arrivalMid} decimals={2} />
      </td>
      <td className="px-2.5 py-1.5 text-right tabular-nums">{order.vwap.toFixed(2)}</td>
      <td className={cn("px-2.5 py-1.5 text-right tabular-nums", order.slippageBps >= 0 ? "text-up" : "text-down")}>
        {order.slippageBps.toFixed(1)}
      </td>
      <td className="px-2.5 py-1.5 text-muted-foreground">{order.destination}</td>
      <td className="px-2.5 py-1.5 text-muted-foreground">{order.tif}</td>
      <td className="px-2.5 py-1.5 text-muted-foreground">{order.trader}</td>
      <td className="px-2.5 py-1.5">
        <OrderStatePill state={order.state} />
      </td>
    </tr>
  );
}

function OrderStatePill({ state }: { state: OrderState }) {
  const tone =
    state === "FILLED"   ? "success" :
    state === "PARTIAL"  ? "warning" :
    state === "WORKING"  ? "primary" :
    state === "REJECTED" ? "destructive" :
                            "neutral";
  return <Badge variant={tone as never} className="text-[9.5px]">{state}</Badge>;
}
