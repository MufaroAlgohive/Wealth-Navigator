"use client";

import type { BasketTotals } from "@/lib/research-lab/types";
import { formatZARExact } from "@/lib/format";

/** Stacked bar: invested vs cash — makes basket drift immediately visible */
export function CashInvestedBar({ totals }: { totals: BasketTotals }) {
  const investedPct = 100 - totals.cashPct;

  return (
    <div className="space-y-2 rounded-md border border-border/60 bg-muted/10 p-3">
      <div className="flex items-center justify-between text-[10px]">
        <span className="font-semibold uppercase tracking-wider text-muted-foreground">
          Invested vs cash
        </span>
        <span className="font-mono tabular-nums text-muted-foreground">
          {formatZARExact(totals.constituent)} + {formatZARExact(totals.cash)} cash
        </span>
      </div>
      <div className="flex h-3 overflow-hidden rounded-full bg-muted/40">
        <div
          className="bg-primary transition-all"
          style={{ width: `${Math.max(0, Math.min(100, investedPct))}%` }}
          title={`Invested ${investedPct.toFixed(1)}%`}
        />
        <div
          className="bg-muted-foreground/25"
          style={{ width: `${Math.max(0, Math.min(100, totals.cashPct))}%` }}
          title={`Cash ${totals.cashPct.toFixed(1)}%`}
        />
      </div>
      <div className="flex justify-between font-mono text-[9.5px] text-muted-foreground">
        <span className="text-primary">Constituents {investedPct.toFixed(1)}%</span>
        <span>Cash {totals.cashPct.toFixed(1)}%</span>
      </div>
    </div>
  );
}
