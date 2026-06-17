"use client";

import { useMemo } from "react";
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { CHART_COLORS, tooltipStyle } from "@/components/research-lab/chart-theme";
import type { FundamentalMetric } from "@/lib/research-lab/types";

interface FundamentalsChartProps {
  tickers: string[];
  metrics: FundamentalMetric[];
}

function parseNum(raw: string | null | undefined): number | null {
  if (!raw || raw === "—") return null;
  const n = Number.parseFloat(raw.replace(/%/g, "").replace(/x/gi, "").replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

/** Grouped bars for P/E, dividend yield, YTD — visual complement to the matrix */
export function FundamentalsChart({ tickers, metrics }: FundamentalsChartProps) {
  const byId = useMemo(() => {
    const m = new Map<string, FundamentalMetric>();
    for (const row of metrics) m.set(row.id, row);
    return m;
  }, [metrics]);

  const data = useMemo(
    () =>
      tickers.map((t, i) => ({
        ticker: t,
        pe: parseNum(byId.get("pe")?.values[t]),
        div: parseNum(byId.get("div")?.values[t]),
        ytd: parseNum(byId.get("ytd")?.values[t]),
        fill: CHART_COLORS[i % CHART_COLORS.length],
      })),
    [tickers, byId],
  );

  const hasData = data.some((d) => d.pe != null || d.div != null || d.ytd != null);
  if (!hasData) return null;

  return (
    <div className="space-y-2 border-b border-[hsl(var(--glass-border))] pb-5">
      <p className="text-caption">
        Valuation &amp; momentum snapshot
      </p>
      <div className="h-[220px] w-full">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 4 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
            <XAxis
              dataKey="ticker"
              tick={{ fontSize: 10, fill: "hsl(var(--foreground))", fontWeight: 600 }}
            />
            <YAxis
              tick={{ fontSize: 9, fill: "hsl(var(--muted-foreground))" }}
              tickFormatter={(v) => `${v}`}
            />
            <Tooltip contentStyle={tooltipStyle} />
            <Legend
              wrapperStyle={{ fontSize: 10, fontFamily: "var(--font-jetbrains-mono)" }}
            />
            <Bar dataKey="pe" name="P/E" fill="hsl(var(--chart-1))" radius={[3, 3, 0, 0]} maxBarSize={20} />
            <Bar dataKey="div" name="Div %" fill="hsl(var(--chart-2))" radius={[3, 3, 0, 0]} maxBarSize={20} />
            <Bar dataKey="ytd" name="YTD %" fill="hsl(var(--chart-3))" radius={[3, 3, 0, 0]} maxBarSize={20} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

interface VerdictStripProps {
  tickers: string[];
  metrics: FundamentalMetric[];
}

/** Colour-coded verdict chips row */
export function VerdictStrip({ tickers, metrics }: VerdictStripProps) {
  const verdictRow = metrics.find((m) => m.id === "verdict");
  if (!verdictRow) return null;

  return (
    <div className="flex flex-wrap gap-2">
      {tickers.map((t) => {
        const v = verdictRow.values[t] ?? "—";
        const cls =
          v === "BUY"
            ? "border-success/30 bg-success/10 text-success"
            : v === "SELL"
              ? "border-destructive/30 bg-destructive/10 text-destructive"
              : v === "HOLD"
                ? "border-warning/30 bg-warning/10 text-warning"
                : "glass-inset border-0 text-muted-foreground";
        return (
          <div key={t} className={`flex items-center gap-2 rounded-xl border px-3 py-2 ${cls}`}>
            <span className="font-mono text-sm font-semibold">{t}</span>
            <span className="text-xs font-medium">{v}</span>
          </div>
        );
      })}
    </div>
  );
}
