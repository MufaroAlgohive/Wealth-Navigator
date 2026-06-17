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
    <div className="glass-inset overflow-hidden">
      <div className="overflow-x-auto scrollbar-thin">
        <table className="w-full min-w-[720px]">
          <thead>
            <tr className="border-b border-[hsl(var(--glass-border))] bg-[hsl(var(--foreground)/0.02)]">
              <th className="px-4 py-3 text-left text-caption font-medium">Ticker</th>
              <th className="px-4 py-3 text-left text-caption font-medium">Name</th>
              {!showRating && <th className="px-4 py-3 text-left text-caption font-medium">Class</th>}
              <th className="px-4 py-3 text-left text-caption font-medium">Sector</th>
              {showRating && <th className="px-4 py-3 text-left text-caption font-medium">Rating</th>}
              <th className="px-4 py-3 text-right text-caption font-medium">Shares</th>
              <th className="px-4 py-3 text-right text-caption font-medium">Price</th>
              <th className="px-4 py-3 text-right text-caption font-medium">Value</th>
              <th className="px-4 py-3 text-right text-caption font-medium">Const.</th>
              <th className="px-4 py-3 text-right text-caption font-medium">Basket</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr
                key={r.ticker}
                className="border-b border-[hsl(var(--glass-border))]/60 transition-colors hover:bg-[hsl(var(--primary)/0.04)]"
              >
                <td className="px-4 py-3 font-mono text-sm font-semibold text-primary">{r.ticker}</td>
                <td className="max-w-[160px] truncate px-4 py-3 text-sm text-foreground/90">{r.name}</td>
                {!showRating && (
                  <td className="px-4 py-3 text-caption">{r.assetClass}</td>
                )}
                <td className="max-w-[130px] truncate px-4 py-3 text-caption">{r.sector}</td>
                {showRating && (
                  <td className="px-4 py-3">
                    {r.rating ? (
                      <Pill tone={verdictTone(r.rating)} size="xs">
                        {r.rating}
                      </Pill>
                    ) : (
                      "—"
                    )}
                  </td>
                )}
                <td className="px-4 py-3 text-right font-mono text-sm tabular-nums">{r.shares}</td>
                <td className="px-4 py-3 text-right font-mono text-sm tabular-nums">
                  {formatZARExact(r.price)}
                </td>
                <td className="px-4 py-3 text-right font-mono text-sm font-medium tabular-nums">
                  {formatZARExact(r.value)}
                </td>
                <td className="px-4 py-3 text-right font-mono text-xs tabular-nums text-muted-foreground">
                  {r.constWeight.toFixed(1)}%
                </td>
                <td className="px-4 py-3 text-right font-mono text-xs font-medium tabular-nums">
                  {r.basketWeight.toFixed(1)}%
                </td>
              </tr>
            ))}
            <tr className="bg-[hsl(var(--foreground)/0.03)]">
              <td colSpan={6} className="px-4 py-3 text-right text-sm font-medium">
                Constituent total
              </td>
              <td className="px-4 py-3 text-right font-mono text-sm font-semibold tabular-nums">
                {formatZARExact(constituentTotal)}
              </td>
              <td className="px-4 py-3 text-right font-mono text-xs tabular-nums">100%</td>
              <td className="px-4 py-3 text-right font-mono text-xs tabular-nums">
                {(100 - cashPct).toFixed(1)}%
              </td>
            </tr>
            <tr>
              <td className="px-4 py-3 font-mono text-sm font-semibold">CASH</td>
              <td colSpan={5} className="px-4 py-3 text-caption">
                {cashLabel}
              </td>
              <td className="px-4 py-3 text-right font-mono text-sm tabular-nums">
                {formatZARExact(cash)}
              </td>
              <td className="px-4 py-3 text-right">—</td>
              <td className="px-4 py-3 text-right font-mono text-xs tabular-nums">{cashPct.toFixed(1)}%</td>
            </tr>
            <tr className="border-t border-[hsl(var(--primary)/0.2)] bg-[hsl(var(--primary)/0.06)]">
              <td colSpan={6} className="px-4 py-3 text-sm font-medium">
                Basket minimum price
              </td>
              <td className="px-4 py-3 text-right font-mono text-sm font-semibold text-primary tabular-nums">
                {formatZARExact(basketMin)}
              </td>
              <td className="px-4 py-3 text-right">—</td>
              <td className="px-4 py-3 text-right font-mono text-xs tabular-nums">100%</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}
