"use client";

import { useMemo } from "react";
import { Panel } from "@/components/oems/primitives/panel";
import type { DataSourceKind } from "@/components/oems/primitives/data-source-badge";
import { cn } from "@/lib/cn";
import { formatPct, formatPctAbs } from "@/lib/format";

interface Sector {
  sector: string;
  weight: number;
  change: number;
}

interface SectorHeatmapProps {
  data: Sector[];
  dataSource?: DataSourceKind;
  className?: string;
}

/**
 * Institutional, IRESS-style sector performance tape.
 *
 * Rendered as a flat 12-row list (sorted by weight descending) — the same
 * density you'd see on a Bloomberg HP <GO> or an IRESS V4 sector board.
 * Each row carries a small weight-bar on the left (the "heatmap" cue),
 * the sector name in the middle, and a signed change + weight on the
 * right, monospaced.
 */
export function SectorHeatmap({ data, dataSource, className }: SectorHeatmapProps) {
  const sorted = useMemo(
    () => [...data].sort((a, b) => b.weight - a.weight),
    [data],
  );
  const maxWeight = useMemo(
    () => sorted.reduce((m, x) => (x.weight > m ? x.weight : m), 0),
    [sorted],
  );

  return (
    <Panel
      title="JSE Sectors"
      endpoint="PricingQuoteGet (sector indices)"
      dataSource={dataSource}
      subtitle={`${data.length} sectors`}
      className={className}
    >
      <ul role="list" className="divide-y divide-border/40">
        {sorted.map((s) => {
          const up = s.change > 0;
          const down = s.change < 0;
          const tone = up
            ? "text-up"
            : down
              ? "text-down"
              : "text-muted-foreground";
          const fill = up
            ? "bg-up/30"
            : down
              ? "bg-down/30"
              : "bg-muted-foreground/30";
          const barPct = maxWeight > 0 ? Math.min(100, (s.weight / maxWeight) * 100) : 0;
          return (
            <li
              key={s.sector}
              className={cn(
                "group relative flex items-center gap-3 px-3 py-1.5",
                "transition-colors hover:bg-muted/30",
              )}
              title={`${s.sector} · ${formatPct(s.change)} · weight ${s.weight.toFixed(1)}%`}
            >
              <span
                aria-hidden
                className={cn(
                  "pointer-events-none absolute inset-y-0 left-0 w-px opacity-0 transition-opacity group-hover:opacity-100",
                  up ? "bg-up" : down ? "bg-down" : "bg-muted-foreground",
                )}
              />
              <div
                className="relative h-1.5 w-12 shrink-0 overflow-hidden rounded-full bg-muted/40"
                aria-hidden
              >
                <div
                  className={cn("absolute inset-y-0 left-0", fill)}
                  style={{ width: `${barPct}%` }}
                />
              </div>
              <span className="flex-1 truncate text-sm font-medium text-foreground/90">
                {s.sector}
              </span>
              <span
                className={cn(
                  "w-14 shrink-0 text-right font-mono text-xs font-semibold tabular-nums",
                  tone,
                )}
              >
                {formatPct(s.change)}
              </span>
              <span className="w-16 shrink-0 text-right font-mono text-[11px] tabular-nums">
                <span className="text-muted-foreground/60">w </span>
                <span className="text-foreground/80">{formatPctAbs(s.weight, 1)}</span>
              </span>
            </li>
          );
        })}
      </ul>
    </Panel>
  );
}
