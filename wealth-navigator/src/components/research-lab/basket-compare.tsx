"use client";

import type { ReactNode } from "react";
import { ArrowRight } from "lucide-react";
import { cn } from "@/lib/cn";
import { formatZARExact } from "@/lib/format";
import { ResearchLabPies } from "@/components/research-lab/research-lab-pies";
import type { BasketTotals, HoldingRow, SectorSlice } from "@/lib/research-lab/types";

export interface BasketSide {
  holdings: HoldingRow[];
  totals: BasketTotals;
  sectors: SectorSlice[];
}

interface BasketCompareProps {
  current: BasketSide;
  proposed: BasketSide;
  /** Table node for each side (current is read-only, proposed is editable). */
  currentTable: ReactNode;
  proposedTable: ReactNode;
}

function pp(delta: number) {
  return `${delta >= 0 ? "+" : ""}${delta.toFixed(1)}`;
}

function StatDelta({
  label,
  current,
  proposed,
  money = false,
}: {
  label: string;
  current: number;
  proposed: number;
  money?: boolean;
}) {
  const delta = proposed - current;
  const changed = Math.abs(delta) > (money ? 0.5 : 0.05);
  const fmt = (n: number) => (money ? formatZARExact(n) : `${n.toFixed(1)}%`);
  return (
    <div className="min-w-0">
      <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">{label}</p>
      <p className="flex items-center gap-1.5 font-mono text-sm font-semibold tabular-nums">
        <span className="text-muted-foreground/80">{fmt(current)}</span>
        <ArrowRight className="h-3 w-3 shrink-0 text-muted-foreground" />
        <span className={cn(changed ? "text-primary" : "text-foreground")}>{fmt(proposed)}</span>
        {changed && (
          <span
            className={cn(
              "text-[10px] font-normal",
              delta > 0 ? "text-up" : "text-down",
            )}
          >
            ({money ? `${delta >= 0 ? "+" : ""}${formatZARExact(delta)}` : `${pp(delta)} pp`})
          </span>
        )}
      </p>
    </div>
  );
}

/**
 * Item 4 — Current basket and Proposed basket SIDE-BY-SIDE.
 * Each column carries its own totals header, holdings table, and a pie chart
 * underneath so the analyst can literally see "here's how my basket is going
 * to look". A delta strip across the top recalculates in real time as the
 * proposed side is edited (add / remove / change shares).
 */
export function BasketCompare({
  current,
  proposed,
  currentTable,
  proposedTable,
}: BasketCompareProps) {
  const investedCur = 100 - current.totals.cashPct;
  const investedProp = 100 - proposed.totals.cashPct;

  return (
    <div className="space-y-4">
      {/* Real-time recalculated totals across both baskets */}
      <div className="glass-inset grid grid-cols-1 gap-4 p-4 sm:grid-cols-3">
        <StatDelta
          label="Constituent value"
          current={current.totals.constituent}
          proposed={proposed.totals.constituent}
          money
        />
        <StatDelta
          label="Invested weight"
          current={investedCur}
          proposed={investedProp}
        />
        <StatDelta
          label="Constituent count"
          current={current.holdings.length}
          proposed={proposed.holdings.length}
        />
      </div>

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
        {/* Current */}
        <section className="space-y-4">
          <header className="flex items-center justify-between gap-2">
            <h3 className="text-section">Current basket</h3>
            <span className="font-mono text-xs text-muted-foreground tabular-nums">
              {formatZARExact(current.totals.basketMin)} · {current.holdings.length} holdings
            </span>
          </header>
          {currentTable}
          <div className="glass-inset p-4">
            <ResearchLabPies
              holdings={current.holdings}
              totals={current.totals}
              sectors={current.sectors}
              scope="Current"
            />
          </div>
        </section>

        {/* Proposed */}
        <section className="space-y-4">
          <header className="flex items-center justify-between gap-2">
            <h3 className="text-section text-primary">Proposed basket</h3>
            <span className="font-mono text-xs text-muted-foreground tabular-nums">
              {formatZARExact(proposed.totals.basketMin)} · {proposed.holdings.length} holdings
            </span>
          </header>
          {proposedTable}
          <div className="glass-inset border-[hsl(var(--glass-border-strong))] bg-[hsl(var(--primary)/0.03)] p-4">
            <ResearchLabPies
              holdings={proposed.holdings}
              totals={proposed.totals}
              sectors={proposed.sectors}
              scope="Proposed"
            />
          </div>
        </section>
      </div>
    </div>
  );
}
