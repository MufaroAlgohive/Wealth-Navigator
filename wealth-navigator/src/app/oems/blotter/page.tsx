"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarDays, ClipboardList, Search, X } from "lucide-react";
import { toast } from "sonner";

import { GlassBadge, GlassKpi, GlassSection } from "@/components/oems/primitives/glass";
import { NumberCell } from "@/components/oems/primitives/number-cell";
import { EmptyDataState } from "@/components/oems/primitives/empty-data-state";
import { ConfirmDestructive } from "@/components/oems/confirm-destructive";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useIress } from "@/lib/iress/provider";
import { useAuditOrders } from "@/lib/hooks/use-audit-orders";
import { isRealDataOnlyClient } from "@/lib/data-policy";
import { formatTime } from "@/lib/format";
import { cn } from "@/lib/cn";
import {
  filterBlotterOrders,
  type BlotterDateMode,
  type BlotterScope,
  type BlotterStatusFilter,
} from "@/lib/orders/blotter-filters";
import { NewOrderDialog } from "./new-order-dialog";
import type { Order, OrderState } from "@/types/iress";

const STATUS_FILTERS: Array<{ key: BlotterStatusFilter; label: string }> = [
  { key: "FILLED", label: "Filled" },
  { key: "WORKING", label: "Working" },
  { key: "CANCELLED", label: "Cancelled" },
  { key: "REJECTED", label: "Rejected" },
];

export default function BlotterPage() {
  const { data, client } = useIress();
  const realDataOnly = isRealDataOnlyClient();
  const qc = useQueryClient();
  const [statuses, setStatuses] = useState<Set<BlotterStatusFilter>>(new Set());
  const [dateMode, setDateMode] = useState<BlotterDateMode>("ALL");
  const [dateValue, setDateValue] = useState("");
  const [q, setQ] = useState("");
  const [scope, setScope] = useState<BlotterScope>("LIVE");

  const seedOrdersQ = useQuery({
    queryKey: ["orders"],
    queryFn: () => data.orders(),
    enabled: !realDataOnly,
  });
  const auditOrdersQ = useAuditOrders("ALL", realDataOnly || scope === "UAT", scope);
  const orders =
    scope === "UAT" || realDataOnly ? (auditOrdersQ.data?.orders ?? []) : (seedOrdersQ.data ?? []);
  const ordersLoading = scope === "UAT" || realDataOnly ? auditOrdersQ.isLoading : seedOrdersQ.isLoading;

  const filtered = useMemo(() => {
    return filterBlotterOrders(orders, { statuses, dateMode, dateValue, query: q });
  }, [orders, statuses, dateMode, dateValue, q]);

  const counts = orders.reduce<Record<string, number>>((acc, order) => {
    acc[order.state] = (acc[order.state] ?? 0) + 1;
    return acc;
  }, {});
  const workingCount = counts.WORKING ?? 0;
  const partialCount = counts.PARTIAL ?? 0;

  const openOrders = useMemo(
    () => orders.filter((o) => o.state === "WORKING" || o.state === "PARTIAL"),
    [orders],
  );

  const cancelAll = useMutation({
    mutationFn: async () => {
      const working = orders.filter((o) => o.state === "WORKING" || o.state === "PARTIAL");
      await Promise.all(
        working.map((o) => client.orderDelete({ ServiceSessionKey: "MOCK-S", OrderNumber: o.id })),
      );
      return working.length;
    },
    onSuccess: (n) => {
      toast.success(`Cancelled ${n} working order${n === 1 ? "" : "s"}`);
      qc.invalidateQueries({ queryKey: ["orders"] });
    },
    onError: () => toast.error("Cancel-all failed"),
  });

  const dataSourceLabel =
    scope === "UAT" ? "isolated UAT audit records" : realDataOnly ? "live order records" : "demo orders";

  return (
    <div className="space-y-4">
      <header className="glass-panel relative overflow-hidden p-5 md:p-6">
        <div className="pointer-events-none absolute -right-16 -top-16 h-48 w-48 rounded-full bg-primary/10 blur-3xl" />
        <div className="relative flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 space-y-3">
            <GlassBadge tone="primary">
              <ClipboardList className="h-3.5 w-3.5" />
              Execution tape
            </GlassBadge>
            <div>
              <h1 className="text-lg font-semibold tracking-tight md:text-xl">
                {scope === "UAT" ? "UAT Blotter" : "Live Blotter & Orders"}
              </h1>
              <p className="mt-1 text-xs text-muted-foreground">
                {scope === "UAT"
                  ? "Test-only execution evidence · isolated from the live broker tape"
                  : "Live execution tape · FIX 4.4 via IRESS gateway · slippage in bps vs arrival"}
              </p>
            </div>
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            <Link
              href="/oems"
              className="glass-inset inline-flex items-center px-3 py-1.5 text-[10.5px] text-muted-foreground transition-colors hover:text-primary"
            >
              ← Cockpit
            </Link>
            {!realDataOnly && scope === "LIVE" && (
              <>
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
              </>
            )}
            <GlassBadge tone={scope === "UAT" ? "warning" : realDataOnly ? "success" : "neutral"}>
              <span className="h-1.5 w-1.5 rounded-full bg-current opacity-80" />
              {scope === "UAT" ? "UAT · never routed live" : realDataOnly ? "IRESS order tape" : "Demo orders"}
            </GlassBadge>
          </div>
        </div>

        <div className="relative mt-5 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <GlassKpi label="Total" value={String(orders.length)} accent="primary" />
          <GlassKpi
            label="Working"
            value={String(workingCount)}
            accent={workingCount > 0 ? "primary" : "default"}
          />
          <GlassKpi
            label="Partial"
            value={String(partialCount)}
            accent={partialCount > 0 ? "negative" : "default"}
          />
          <GlassKpi label="Filled" value={String(counts.FILLED ?? 0)} accent="positive" />
          <GlassKpi label="Cancelled" value={String(counts.CANCELLED ?? 0)} />
          <GlassKpi
            label="Rejected"
            value={String(counts.REJECTED ?? 0)}
            accent={(counts.REJECTED ?? 0) > 0 ? "negative" : "default"}
          />
        </div>
      </header>

      <div className="glass-inset inline-flex gap-1 p-1" aria-label="Blotter environment">
        {(["LIVE", "UAT"] as BlotterScope[]).map((value) => (
          <Button
            key={value}
            type="button"
            size="sm"
            variant="ghost"
            aria-pressed={scope === value}
            onClick={() => setScope(value)}
            className={cn(
              "h-8 px-4 text-[11px]",
              scope === value
                ? value === "UAT"
                  ? "bg-amber-400/15 text-amber-200 hover:bg-amber-400/20"
                  : "bg-emerald-400/15 text-emerald-200 hover:bg-emerald-400/20"
                : "text-muted-foreground",
            )}
          >
            {value === "LIVE" ? "Live blotter" : "UAT blotter"}
          </Button>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <div className="glass-inset flex flex-wrap gap-1 p-1">
          {STATUS_FILTERS.map((status) => {
            const active = statuses.has(status.key);
            const count =
              status.key === "WORKING"
                ? (counts.WORKING ?? 0) + (counts.PARTIAL ?? 0)
                : (counts[status.key] ?? 0);
            return (
              <Button
                key={status.key}
                type="button"
                variant="ghost"
                size="sm"
                aria-pressed={active}
                onClick={() =>
                  setStatuses((current) => {
                    const next = new Set(current);
                    if (next.has(status.key)) next.delete(status.key);
                    else next.add(status.key);
                    return next;
                  })
                }
                className={cn(
                  "h-7 gap-1.5 rounded-md px-2.5 text-[11px] shadow-none",
                  active
                    ? "bg-foreground/10 text-foreground hover:bg-foreground/15"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {status.label}
                <span className="font-mono text-[9.5px] opacity-70">{count}</span>
              </Button>
            );
          })}
        </div>
        <div className="glass-inset flex h-9 items-center gap-1 p-1">
          <CalendarDays className="ml-1.5 h-3.5 w-3.5 text-muted-foreground" />
          <Select
            value={dateMode}
            onValueChange={(value) => {
              setDateMode(value as BlotterDateMode);
              setDateValue("");
            }}
          >
            <SelectTrigger className="h-7 w-[86px] border-0 bg-transparent px-2 text-[11px] shadow-none">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">Any date</SelectItem>
              <SelectItem value="TODAY">Today</SelectItem>
              <SelectItem value="DATE">Date</SelectItem>
              <SelectItem value="MONTH">Month</SelectItem>
              <SelectItem value="YEAR">Year</SelectItem>
            </SelectContent>
          </Select>
          {dateMode !== "ALL" && dateMode !== "TODAY" && (
            <Input
              type={dateMode === "DATE" ? "date" : dateMode === "MONTH" ? "month" : "number"}
              min={dateMode === "YEAR" ? "2000" : undefined}
              max={dateMode === "YEAR" ? "2100" : undefined}
              value={dateValue}
              onChange={(event) => setDateValue(event.target.value)}
              placeholder={dateMode === "YEAR" ? "YYYY" : undefined}
              className="h-7 w-[132px] border-0 bg-transparent px-2 text-[11px] shadow-none"
            />
          )}
        </div>
        {(statuses.size > 0 || dateMode !== "ALL") && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => {
              setStatuses(new Set());
              setDateMode("ALL");
              setDateValue("");
            }}
            className="h-8 gap-1 px-2 text-[10.5px] text-muted-foreground"
          >
            <X className="h-3.5 w-3.5" />
            Clear
          </Button>
        )}
        <div className="relative w-72">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Symbol, strategy, order id…"
            className="glass-inset h-8 border-0 pl-8 text-xs shadow-none"
          />
        </div>
        <div className="glass-inset ml-auto px-3 py-1.5 text-[10px] text-muted-foreground">
          {filtered.length} of {orders.length} orders · {dataSourceLabel}
        </div>
      </div>

      <GlassSection
        title={`Orders · ${filtered.length}`}
        db="institutional"
        endpoint={`GET /api/orders?scope=${scope}`}
        dataSource="supabase"
        noPadding
        className="flex min-h-0 flex-col h-[calc(100vh-380px)]"
      >
        {ordersLoading ? (
          <div className="space-y-1.5 px-3.5 py-2.5" aria-busy="true" aria-live="polite">
            {[0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => (
              <div key={`blotter-row-${n}`} className="flex items-center gap-3">
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
        ) : filtered.length === 0 ? (
          <div className="p-3.5">
            <EmptyDataState
              title="No orders"
              message={
                scope === "UAT"
                  ? "No UAT orders match this view. Test activity will appear here and never on the Live blotter."
                  : realDataOnly
                    ? "Live order history is syncing. Check back shortly."
                    : "No demo orders yet."
              }
            />
          </div>
        ) : (
          <div className="glass-inset m-3 min-h-0 flex-1 overflow-y-auto scrollbar-thin">
            <table className="w-full font-mono text-[11px]">
              <thead className="sticky top-0 z-10 bg-[hsl(var(--glass-bg-strong)/0.92)] backdrop-blur-md">
                <tr className="border-b border-[hsl(var(--glass-border))] text-[9.5px] uppercase tracking-wider text-muted-foreground">
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
              <tbody className="divide-y divide-[hsl(var(--glass-border))]">
                {filtered.map((o) => (
                  <OrderRow key={o.id} order={o} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </GlassSection>
    </div>
  );
}

function OrderRow({ order }: { order: Order }) {
  return (
    <tr className="transition-colors hover:bg-[hsl(var(--foreground)/0.04)]">
      <td className="px-2.5 py-1.5 text-muted-foreground">{order.id}</td>
      <td className="px-2.5 py-1.5 text-muted-foreground">{formatTime(order.ts)}</td>
      <td className="px-2.5 py-1.5">{order.strategy}</td>
      <td className={cn("px-2.5 py-1.5 font-semibold", order.side === "BUY" ? "text-up" : "text-down")}>
        {order.side}
      </td>
      <td className="px-2.5 py-1.5 font-semibold">{order.symbol}</td>
      <td className="px-2.5 py-1.5 text-[9.5px] text-muted-foreground">{order.isin}</td>
      <td className="px-2.5 py-1.5 text-right tabular-nums">{order.qty.toLocaleString()}</td>
      <td className="px-2.5 py-1.5 text-right tabular-nums">
        {order.filled.toLocaleString()}{" "}
        <span className="text-muted-foreground/70">
          ({order.qty > 0 ? Math.round((order.filled / order.qty) * 100) : 0}%)
        </span>
      </td>
      <td className="px-2.5 py-1.5 text-right tabular-nums">{order.limit?.toFixed(2) ?? "MKT"}</td>
      <td className="px-2.5 py-1.5 text-right tabular-nums">
        <NumberCell sym={order.symbol} fallback={order.arrivalMid} decimals={2} />
      </td>
      <td className="px-2.5 py-1.5 text-right tabular-nums">
        {order.vwap != null ? order.vwap.toFixed(2) : "—"}
      </td>
      <td
        className={cn(
          "px-2.5 py-1.5 text-right tabular-nums",
          order.slippageBps == null
            ? "text-muted-foreground"
            : order.slippageBps >= 0
              ? "text-up"
              : "text-down",
        )}
      >
        {order.slippageBps != null ? order.slippageBps.toFixed(1) : "—"}
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
    state === "FILLED"
      ? "success"
      : state === "PARTIAL"
        ? "warning"
        : state === "WORKING"
          ? "primary"
          : state === "REJECTED"
            ? "destructive"
            : "neutral";
  return (
    <Badge variant={tone as never} className="text-[9.5px]">
      {state}
    </Badge>
  );
}
