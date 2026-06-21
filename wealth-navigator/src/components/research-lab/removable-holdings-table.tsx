"use client";

import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/cn";
import { formatZARExact } from "@/lib/format";
import { Pill } from "@/components/oems/primitives/pill";
import { Button } from "@/components/ui/button";
import { ResearchTick } from "@/components/research-lab/security-research";
import type { HoldingRow, Verdict } from "@/lib/research-lab/types";

function verdictTone(v: Verdict) {
  if (v === "BUY") return "success" as const;
  if (v === "SELL") return "destructive" as const;
  if (v === "HOLD") return "warning" as const;
  return "neutral" as const;
}

/**
 * Inline-editable share count. Commits the new TOTAL on blur / Enter; the page
 * converts the target into one delta proposal so the proposed basket (pies,
 * summary bar, delta strip) recomputes live. Syncs back to the projected value
 * after each commit.
 */
function ShareCell({ row, onSetShares }: { row: HoldingRow; onSetShares: (row: HoldingRow, shares: number) => void }) {
  const [val, setVal] = useState(String(row.shares));
  useEffect(() => {
    setVal(String(row.shares));
  }, [row.shares]);
  const commit = () => {
    const n = Math.max(0, Math.round(Number(val)));
    if (Number.isFinite(n) && n !== row.shares) onSetShares(row, n);
    else setVal(String(row.shares));
  };
  return (
    <input
      type="number"
      min={0}
      value={val}
      onChange={(e) => setVal(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.currentTarget as HTMLInputElement).blur();
      }}
      aria-label={`Shares for ${row.ticker}`}
      className="w-16 rounded-md border border-input bg-background px-2 py-1 text-right font-mono text-sm tabular-nums outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
    />
  );
}

interface RemovableHoldingsTableProps {
  rows: HoldingRow[];
  constituentTotal: number;
  cash: number;
  cashPct: number;
  basketMin: number;
  /** Tickers that have research on file — drives the tick + rating fallback. */
  researchedTickers?: Set<string>;
  /** Standing rating per ticker from saved research (overrides row rating). */
  ratingFor?: (ticker: string) => Verdict;
  /** Click a name to open its research thesis dialog. */
  onOpenResearch?: (ticker: string, name: string) => void;
  /**
   * Item 3 — remove a single constituent. The page turns this into one
   * session proposal and recomputes weights live. Omit to render read-only.
   */
  onRemoveOne?: (row: HoldingRow) => void;
  /**
   * Inline-edit the share count of an existing constituent ("move this to 22
   * shares") — the page turns the new total into one delta proposal and
   * recomputes weights live. Omit to render shares read-only.
   */
  onSetShares?: (row: HoldingRow, shares: number) => void;
  cashLabel?: string;
}

/**
 * Holdings table with per-row, one-by-one removal (item 3) and clickable names
 * that open per-security research (item 7). A green tick marks names that
 * already have a thesis on file. Weight recomputation happens on the page via
 * `onRemoveOne` → it stays in lock-step with the basket pies and summary bar.
 */
export function RemovableHoldingsTable({
  rows,
  constituentTotal,
  cash,
  cashPct,
  basketMin,
  researchedTickers,
  ratingFor,
  onOpenResearch,
  onRemoveOne,
  onSetShares,
  cashLabel = "Cash reserve",
}: RemovableHoldingsTableProps) {
  const showRemove = Boolean(onRemoveOne);

  return (
    <div className="glass-inset overflow-hidden">
      <div className="overflow-x-auto scrollbar-thin">
        <table className="w-full min-w-[760px]">
          <thead>
            <tr className="border-b border-[hsl(var(--glass-border))] bg-[hsl(var(--foreground)/0.02)]">
              <th className="px-4 py-3 text-left text-caption font-medium">Ticker</th>
              <th className="px-4 py-3 text-left text-caption font-medium">Name</th>
              <th className="px-4 py-3 text-left text-caption font-medium">Sector</th>
              <th className="px-4 py-3 text-left text-caption font-medium">Rating</th>
              <th className="px-4 py-3 text-right text-caption font-medium">Shares</th>
              <th className="px-4 py-3 text-right text-caption font-medium">Price</th>
              <th className="px-4 py-3 text-right text-caption font-medium">Value</th>
              <th className="px-4 py-3 text-right text-caption font-medium">Basket</th>
              {showRemove && <th className="px-4 py-3 text-right text-caption font-medium">Remove</th>}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const researched = researchedTickers?.has(r.ticker) ?? false;
              const rating = ratingFor?.(r.ticker) ?? r.rating ?? null;
              return (
                <tr
                  key={r.ticker}
                  className={cn(
                    "border-b border-[hsl(var(--glass-border))]/60 transition-colors hover:bg-[hsl(var(--primary)/0.04)]",
                    r.pending && "bg-[hsl(var(--warning)/0.06)]",
                  )}
                >
                  <td className="px-4 py-3 font-mono text-sm font-semibold text-primary">{r.ticker}</td>
                  <td className="max-w-[180px] px-4 py-3">
                    {onOpenResearch ? (
                      <button
                        type="button"
                        onClick={() => onOpenResearch(r.ticker, r.name)}
                        className="flex items-center gap-1.5 truncate text-left text-sm text-foreground/90 underline-offset-2 hover:text-primary hover:underline"
                        title="Open research thesis"
                      >
                        <span className="truncate">{r.name}</span>
                        <ResearchTick active={researched} />
                      </button>
                    ) : (
                      <span className="flex items-center gap-1.5 truncate text-sm text-foreground/90">
                        <span className="truncate">{r.name}</span>
                        <ResearchTick active={researched} />
                      </span>
                    )}
                  </td>
                  <td className="max-w-[130px] truncate px-4 py-3 text-caption">{r.sector}</td>
                  <td className="px-4 py-3">
                    {rating ? (
                      <Pill tone={verdictTone(rating)} size="xs">
                        {rating}
                      </Pill>
                    ) : (
                      <span className="text-caption">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right font-mono text-sm tabular-nums">
                    {onSetShares ? <ShareCell row={r} onSetShares={onSetShares} /> : r.shares}
                  </td>
                  <td className="px-4 py-3 text-right font-mono text-sm tabular-nums">
                    {formatZARExact(r.price)}
                  </td>
                  <td className="px-4 py-3 text-right font-mono text-sm font-medium tabular-nums">
                    {formatZARExact(r.value)}
                  </td>
                  <td className="px-4 py-3 text-right font-mono text-xs font-medium tabular-nums">
                    {r.basketWeight.toFixed(1)}%
                  </td>
                  {showRemove && (
                    <td className="px-2 py-2 text-right">
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 text-muted-foreground hover:bg-[hsl(var(--destructive)/0.1)] hover:text-destructive"
                        onClick={() => onRemoveOne?.(r)}
                        aria-label={`Remove ${r.ticker} from basket`}
                        title={`Remove ${r.ticker}`}
                      >
                        <X className="h-4 w-4" />
                      </Button>
                    </td>
                  )}
                </tr>
              );
            })}
            <tr className="bg-[hsl(var(--foreground)/0.03)]">
              <td colSpan={6} className="px-4 py-3 text-right text-sm font-medium">
                Constituent total
              </td>
              <td className="px-4 py-3 text-right font-mono text-sm font-semibold tabular-nums">
                {formatZARExact(constituentTotal)}
              </td>
              <td className="px-4 py-3 text-right font-mono text-xs tabular-nums">
                {(100 - cashPct).toFixed(1)}%
              </td>
              {showRemove && <td />}
            </tr>
            <tr>
              <td className="px-4 py-3 font-mono text-sm font-semibold">CASH</td>
              <td colSpan={5} className="px-4 py-3 text-caption">
                {cashLabel}
              </td>
              <td className="px-4 py-3 text-right font-mono text-sm tabular-nums">
                {formatZARExact(cash)}
              </td>
              <td className="px-4 py-3 text-right font-mono text-xs tabular-nums">{cashPct.toFixed(1)}%</td>
              {showRemove && <td />}
            </tr>
            <tr className="border-t border-[hsl(var(--primary)/0.2)] bg-[hsl(var(--primary)/0.06)]">
              <td colSpan={6} className="px-4 py-3 text-sm font-medium">
                Basket minimum price
              </td>
              <td className="px-4 py-3 text-right font-mono text-sm font-semibold text-primary tabular-nums">
                {formatZARExact(basketMin)}
              </td>
              <td className="px-4 py-3 text-right font-mono text-xs tabular-nums">100%</td>
              {showRemove && <td />}
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}
