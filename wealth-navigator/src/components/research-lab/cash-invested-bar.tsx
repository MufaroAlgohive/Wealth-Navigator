"use client";

import type { BasketTotals } from "@/lib/research-lab/types";
import { formatZARExact } from "@/lib/format";

export function CashInvestedBar({ totals }: { totals: BasketTotals }) {
  const investedPct = 100 - totals.cashPct;

  return (
    <div className="glass-panel p-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-section">Capital deployment</p>
          <p className="mt-0.5 text-caption">
            Live constituent value vs published basket minimum
          </p>
        </div>
        <p className="font-mono text-sm tabular-nums text-muted-foreground">
          <span className="text-foreground">{formatZARExact(totals.constituent)}</span>
          {" + "}
          <span>{formatZARExact(totals.cash)}</span>
          {" cash"}
        </p>
      </div>
      <div className="mt-4 flex h-4 overflow-hidden rounded-full bg-[hsl(var(--foreground)/0.06)] p-0.5">
        <div
          className="rounded-full bg-gradient-to-r from-primary/90 to-primary shadow-[0_0_20px_hsl(var(--primary)/0.4)] transition-all duration-700"
          style={{ width: `${Math.max(4, Math.min(100, investedPct))}%` }}
        />
      </div>
      <div className="mt-2 flex justify-between text-caption">
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
