"use client";

import { cn } from "@/lib/cn";
import { formatZARExact } from "@/lib/format";
import type { BasketTotals } from "@/lib/research-lab/types";

interface BasketSummaryBarProps {
  totals: BasketTotals;
  constituentCount: number;
  /** Number of in-flight (pending) edits — drives the proposed accent. */
  pendingCount?: number;
  className?: string;
}

/**
 * Item 2 — the resulting-basket-weight / summary bar.
 * Rendered `position: sticky` so it stays pinned to the top of the viewport
 * while the holdings list scrolls underneath. `top-2` clears the app chrome;
 * `z-30` keeps it above table rows.
 */
export function BasketSummaryBar({
  totals,
  constituentCount,
  pendingCount = 0,
  className,
}: BasketSummaryBarProps) {
  const investedPct = 100 - totals.cashPct;
  const hasPending = pendingCount > 0;

  return (
    <div
      className={cn(
        "z-30 glass-panel border p-4",
        hasPending && "border-[hsl(var(--warning)/0.4)]",
        className,
      )}
      // `glass-panel` sets position:relative, which silently beats the Tailwind
      // `sticky` utility — force sticky inline so the bar actually pins on scroll.
      style={{ position: "sticky", top: "0.5rem" }}
    >
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
          <SummaryStat label="Constituents" value={String(constituentCount)} />
          <SummaryStat label="Constituent value" value={formatZARExact(totals.constituent)} />
          <SummaryStat
            label="Cash reserve"
            value={formatZARExact(totals.cash)}
            sub={`${totals.cashPct.toFixed(1)}%`}
          />
          <SummaryStat
            label="Basket minimum"
            value={formatZARExact(totals.basketMin)}
            accent="primary"
          />
        </div>
        {hasPending && (
          <span className="rounded-full border border-[hsl(var(--warning)/0.4)] bg-warning/10 px-3 py-1 text-[11px] font-medium text-warning">
            {pendingCount} pending edit{pendingCount === 1 ? "" : "s"}
          </span>
        )}
      </div>

      <div className="mt-3 flex h-3 overflow-hidden rounded-full bg-[hsl(var(--foreground)/0.06)] p-0.5">
        <div
          className="rounded-full bg-gradient-to-r from-primary/90 to-primary shadow-[0_0_16px_hsl(var(--primary)/0.4)] transition-all duration-500"
          style={{ width: `${Math.max(4, Math.min(100, investedPct))}%` }}
        />
      </div>
      <div className="mt-1.5 flex justify-between text-caption">
        <span>
          Invested <span className="font-mono font-medium text-primary">{investedPct.toFixed(1)}%</span>
        </span>
        <span>
          Cash <span className="font-mono font-medium">{totals.cashPct.toFixed(1)}%</span>
        </span>
      </div>
    </div>
  );
}

function SummaryStat({
  label,
  value,
  sub,
  accent = "default",
}: {
  label: string;
  value: string;
  sub?: string;
  accent?: "default" | "primary";
}) {
  return (
    <div className="min-w-0">
      <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">{label}</p>
      <p
        className={cn(
          "font-mono text-sm font-semibold tabular-nums",
          accent === "primary" && "text-primary",
        )}
      >
        {value}
        {sub && <span className="ml-1 text-[10px] font-normal text-muted-foreground">{sub}</span>}
      </p>
    </div>
  );
}
