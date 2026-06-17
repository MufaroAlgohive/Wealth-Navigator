"use client";

import { useState } from "react";
import { Plus } from "lucide-react";
import { cn } from "@/lib/cn";
import { Button } from "@/components/ui/button";
import { Pill } from "@/components/oems/primitives/pill";
import type { FundamentalMetric, MetricTone, Verdict } from "@/lib/research-lab/types";

function metricCellClass(tone?: MetricTone) {
  if (tone === "good") return "text-up";
  if (tone === "concern") return "text-down";
  if (tone === "neutral") return "text-warning";
  return "";
}

function verdictPill(v: string | null) {
  if (!v) return "—";
  const tone = v === "BUY" ? "success" : v === "SELL" ? "destructive" : "warning";
  return (
    <Pill tone={tone as "success" | "destructive" | "warning"} size="xs">
      {v as Verdict}
    </Pill>
  );
}

interface FundamentalsMatrixProps {
  metrics: FundamentalMetric[];
  tickers: string[];
}

export function FundamentalsMatrix({ metrics, tickers }: FundamentalsMatrixProps) {
  const [extraCols, setExtraCols] = useState<string[]>([]);
  const columns = [...tickers, ...extraCols];

  let lastGroup = "";

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-3 text-[10px]">
        <span className="text-muted-foreground">Verdict scale</span>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-full bg-up" /> Good
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-full bg-warning" /> Neutral
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-full bg-down" /> Concern
        </span>
      </div>
      <div className="overflow-x-auto scrollbar-thin">
        <table className="w-full min-w-[640px] font-mono text-[10.5px]">
          <thead className="text-[9.5px] uppercase tracking-wider text-muted-foreground">
            <tr className="border-b border-border/70">
              <th className="min-w-[200px] px-2.5 py-2 text-left">Metric</th>
              {columns.map((t) => (
                <th key={t} className="px-2.5 py-2 text-right">
                  {t}
                </th>
              ))}
              <th className="px-2.5 py-2 text-right">
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 gap-1 px-2 font-mono text-[9.5px] uppercase"
                  onClick={() => setExtraCols((c) => [...c, `R${c.length + 1}`])}
                >
                  <Plus className="h-3 w-3" />
                  Add research
                </Button>
              </th>
            </tr>
          </thead>
          <tbody>
            {metrics.map((m) => {
              const showGroup = m.group && m.group !== lastGroup;
              if (m.group) lastGroup = m.group;
              return (
                <tr key={m.id} className="border-b border-border/40 hover:bg-muted/20">
                  <td className="px-2.5 py-1.5 align-top">
                    {showGroup && (
                      <div className="mb-0.5 text-[9px] font-semibold uppercase tracking-wider text-primary/80">
                        {m.group}
                      </div>
                    )}
                    <div className="font-sans text-[11px] font-medium">{m.label}</div>
                    {m.hint && (
                      <div className="mt-0.5 text-[9px] leading-snug text-muted-foreground">{m.hint}</div>
                    )}
                  </td>
                  {columns.map((t) => {
                    const raw = extraCols.includes(t) ? null : (m.values[t] ?? null);
                    const tone = m.tones?.[t];
                    const display = m.unavailable ? "—" : raw;
                    return (
                      <td
                        key={t}
                        className={cn(
                          "px-2.5 py-1.5 text-right align-top tabular-nums",
                          m.unavailable && "text-muted-foreground/50",
                          !m.unavailable && metricCellClass(tone),
                        )}
                      >
                        {m.id === "verdict" ? verdictPill(display) : display ?? "—"}
                      </td>
                    );
                  })}
                  <td className="px-2.5 py-1.5" />
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="text-[10px] text-muted-foreground">
        Basket constituents shown by default. Use Add research to compare candidate stocks side-by-side — research
        columns are session-only and reset when you leave this page.
      </p>
    </div>
  );
}
