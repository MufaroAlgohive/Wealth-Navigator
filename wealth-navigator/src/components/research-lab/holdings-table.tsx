"use client";

import { cn } from "@/lib/cn";
import { formatZARExact } from "@/lib/format";
import { Pill } from "@/components/oems/primitives/pill";
import type { HoldingRow, Verdict } from "@/lib/research-lab/types";

function verdictTone(v: Verdict) {
  if (v === "BUY") return "success" as const;
  if (v === "SELL") return "destructive" as const;
  if (v === "HOLD") return "warning" as const;
  return "neutral" as const;
}

interface HoldingsTableProps {
  rows: HoldingRow[];
  constituentTotal: number;
  cash: number;
  cashPct: number;
  basketMin: number;
  showRating?: boolean;
  cashLabel?: string;
}

export function HoldingsTable({
  rows,
  constituentTotal,
  cash,
  cashPct,
  basketMin,
  showRating = false,
  cashLabel = "Cash reserve",
}: HoldingsTableProps) {
  return (
    <div className="overflow-x-auto scrollbar-thin">
      <table className="w-full min-w-[720px] font-mono text-[11px]">
        <thead className="text-[9.5px] uppercase tracking-wider text-muted-foreground">
          <tr className="border-b border-border/70">
            <th className="px-2.5 py-2 text-left">Ticker</th>
            <th className="px-2.5 py-2 text-left">Name</th>
            {!showRating && <th className="px-2.5 py-2 text-left">Asset class</th>}
            <th className="px-2.5 py-2 text-left">Sector</th>
            {showRating && <th className="px-2.5 py-2 text-left">Rating</th>}
            <th className="px-2.5 py-2 text-right">Shares</th>
            <th className="px-2.5 py-2 text-right">Price</th>
            <th className="px-2.5 py-2 text-right">Value</th>
            <th className="px-2.5 py-2 text-right">Const. wt</th>
            <th className="px-2.5 py-2 text-right">Basket wt</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border/50">
          {rows.map((r) => (
            <tr key={r.ticker} className="hover:bg-muted/25">
              <td className="px-2.5 py-1.5 font-semibold text-primary">{r.ticker}</td>
              <td className="max-w-[140px] truncate px-2.5 py-1.5 font-sans text-xs">{r.name}</td>
              {!showRating && <td className="px-2.5 py-1.5 text-muted-foreground">{r.assetClass}</td>}
              <td className="max-w-[120px] truncate px-2.5 py-1.5 text-muted-foreground">{r.sector}</td>
              {showRating && (
                <td className="px-2.5 py-1.5">
                  {r.rating ? (
                    <Pill tone={verdictTone(r.rating)} size="xs">
                      {r.rating}
                    </Pill>
                  ) : (
                    "—"
                  )}
                </td>
              )}
              <td className="px-2.5 py-1.5 text-right tabular-nums">{r.shares}</td>
              <td className="px-2.5 py-1.5 text-right tabular-nums">{formatZARExact(r.price)}</td>
              <td className="px-2.5 py-1.5 text-right tabular-nums">{formatZARExact(r.value)}</td>
              <td className="px-2.5 py-1.5 text-right tabular-nums">{r.constWeight.toFixed(2)}%</td>
              <td className="px-2.5 py-1.5 text-right tabular-nums">{r.basketWeight.toFixed(2)}%</td>
            </tr>
          ))}
          <tr className="bg-muted/20 font-semibold">
            <td colSpan={6} className="px-2.5 py-1.5 text-right font-sans text-xs">
              Constituent total
            </td>
            <td className="px-2.5 py-1.5 text-right tabular-nums">{formatZARExact(constituentTotal)}</td>
            <td className="px-2.5 py-1.5 text-right tabular-nums">100.00%</td>
            <td className="px-2.5 py-1.5 text-right tabular-nums">
              {(100 - cashPct).toFixed(2)}%
            </td>
          </tr>
          <tr className="text-muted-foreground">
            <td className="px-2.5 py-1.5 font-semibold text-foreground">CASH</td>
            <td colSpan={5} className="px-2.5 py-1.5 font-sans text-xs">
              {cashLabel}
            </td>
            <td className="px-2.5 py-1.5 text-right tabular-nums">{formatZARExact(cash)}</td>
            <td className="px-2.5 py-1.5 text-right">—</td>
            <td className="px-2.5 py-1.5 text-right tabular-nums">{cashPct.toFixed(2)}%</td>
          </tr>
          <tr className="border-t border-border bg-primary/5 font-semibold">
            <td colSpan={6} className="px-2.5 py-1.5 font-sans text-xs">
              Basket minimum price
            </td>
            <td className="px-2.5 py-1.5 text-right tabular-nums text-primary">
              {formatZARExact(basketMin)}
            </td>
            <td className="px-2.5 py-1.5 text-right">—</td>
            <td className="px-2.5 py-1.5 text-right tabular-nums">100.00%</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}
