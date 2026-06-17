"use client";

import { ArrowDownRight, ArrowUpRight, Minus } from "lucide-react";
import { cn } from "@/lib/cn";
import { formatZARExact } from "@/lib/format";
import type { BasketTotals, HoldingRow } from "@/lib/research-lab/types";
import { HoldingsWeightChart } from "@/components/research-lab/holdings-weight-chart";

interface ProposalImpactPreviewProps {
  action: "add" | "remove";
  ticker: string;
  name: string;
  shares: number;
  before: HoldingRow | null;
  after: HoldingRow | null;
  totals: BasketTotals;
  weightDelta: number;
  className?: string;
}

export function ProposalImpactPreview({
  action,
  ticker,
  name,
  shares,
  before,
  after,
  totals,
  weightDelta,
  className,
}: ProposalImpactPreviewProps) {
  const isAdd = action === "add";
  const DeltaIcon = weightDelta > 0.01 ? ArrowUpRight : weightDelta < -0.01 ? ArrowDownRight : Minus;
  const deltaTone =
    weightDelta > 0.01 ? "text-up" : weightDelta < -0.01 ? "text-down" : "text-muted-foreground";

  return (
    <div className={cn("space-y-4", className)}>
      <div className="glass-inset grid grid-cols-2 gap-3 p-4 sm:grid-cols-4">
        <ImpactKpi
          label="Action"
          value={isAdd ? "Add" : "Remove"}
          accent={isAdd ? "primary" : "negative"}
        />
        <ImpactKpi label="Ticker" value={ticker} sub={name} accent="primary" />
        <ImpactKpi label="Shares" value={String(shares)} sub={isAdd ? "to add" : "to sell"} />
        <ImpactKpi
          label="Basket weight"
          value={after ? `${after.basketWeight.toFixed(2)}%` : "0.00%"}
          sub={
            before || after ? (
              <span className={cn("inline-flex items-center gap-0.5", deltaTone)}>
                <DeltaIcon className="h-3 w-3" />
                {weightDelta >= 0 ? "+" : ""}
                {weightDelta.toFixed(2)} pp
              </span>
            ) : (
              "New position"
            )
          }
        />
      </div>

      <div className="glass-inset overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-[hsl(var(--glass-border))] bg-[hsl(var(--foreground)/0.02)]">
              <th className="px-4 py-2 text-left text-caption font-medium">Metric</th>
              <th className="px-4 py-2 text-right text-caption font-medium">Current</th>
              <th className="px-4 py-2 text-right text-caption font-medium">Proposed</th>
              <th className="px-4 py-2 text-right text-caption font-medium">Change</th>
            </tr>
          </thead>
          <tbody>
            <ImpactRow
              label="Shares"
              current={before?.shares ?? 0}
              proposed={after?.shares ?? 0}
              format={(v) => String(v)}
            />
            <ImpactRow
              label="Position value"
              current={before?.value ?? 0}
              proposed={after?.value ?? 0}
              format={formatZARExact}
            />
            <ImpactRow
              label="Constituent weight"
              current={before?.constWeight ?? 0}
              proposed={after?.constWeight ?? 0}
              format={(v) => `${v.toFixed(2)}%`}
              suffix="pp"
            />
            <ImpactRow
              label="Basket weight"
              current={before?.basketWeight ?? 0}
              proposed={after?.basketWeight ?? 0}
              format={(v) => `${v.toFixed(2)}%`}
              suffix="pp"
              highlight
            />
          </tbody>
        </table>
      </div>

      <div className="glass-inset grid grid-cols-2 gap-3 p-4 sm:grid-cols-3">
        <ImpactKpi
          label="Constituent total"
          value={formatZARExact(totals.constituent)}
          sub="after change"
        />
        <ImpactKpi
          label="Cash reserve"
          value={formatZARExact(totals.cash)}
          sub={`${totals.cashPct.toFixed(1)}% of basket`}
        />
        <ImpactKpi
          label="Basket minimum"
          value={formatZARExact(totals.basketMin)}
          sub="unchanged"
        />
      </div>
    </div>
  );
}

interface CompactWeightPreviewProps {
  holdings: HoldingRow[];
  highlightTicker: string;
}

export function CompactWeightPreview({ holdings, highlightTicker }: CompactWeightPreviewProps) {
  if (holdings.length === 0) return null;
  return (
    <div className="glass-inset p-4">
      <p className="mb-2 text-caption">Resulting basket weights</p>
      <HoldingsWeightChart holdings={holdings} title="" />
      <p className="mt-2 text-caption">
        Highlighted:{" "}
        <span className="font-mono font-semibold text-primary">{highlightTicker}</span>
        {" · "}
        {holdings.find((h) => h.ticker === highlightTicker)?.basketWeight.toFixed(2) ?? "0.00"}% basket
        weight
      </p>
    </div>
  );
}

function ImpactKpi({
  label,
  value,
  sub,
  accent = "default",
}: {
  label: string;
  value: string;
  sub?: React.ReactNode;
  accent?: "default" | "primary" | "negative";
}) {
  return (
    <div>
      <p className="text-caption">{label}</p>
      <p
        className={cn(
          "mt-1 font-mono text-sm font-semibold tabular-nums",
          accent === "primary" && "text-primary",
          accent === "negative" && "text-down",
        )}
      >
        {value}
      </p>
      {sub && <p className="mt-0.5 text-caption">{sub}</p>}
    </div>
  );
}

function ImpactRow({
  label,
  current,
  proposed,
  format,
  suffix,
  highlight,
}: {
  label: string;
  current: number;
  proposed: number;
  format: (v: number) => string;
  suffix?: string;
  highlight?: boolean;
}) {
  const delta = proposed - current;
  const deltaStr =
    suffix === "pp"
      ? `${delta >= 0 ? "+" : ""}${delta.toFixed(2)} pp`
      : format(Math.abs(delta));

  return (
    <tr className={cn(highlight && "bg-[hsl(var(--primary)/0.04)]")}>
      <td className="px-4 py-2.5 text-caption">{label}</td>
      <td className="px-4 py-2.5 text-right font-mono text-xs tabular-nums text-muted-foreground">
        {format(current)}
      </td>
      <td className="px-4 py-2.5 text-right font-mono text-xs font-medium tabular-nums">
        {format(proposed)}
      </td>
      <td
        className={cn(
          "px-4 py-2.5 text-right font-mono text-xs tabular-nums",
          delta > 0.001 && "text-up",
          delta < -0.001 && "text-down",
          Math.abs(delta) <= 0.001 && "text-muted-foreground",
        )}
      >
        {Math.abs(delta) <= 0.001 ? "—" : deltaStr}
      </td>
    </tr>
  );
}
