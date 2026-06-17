"use client";

import { Bar, BarChart, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { CHART_COLORS, tooltipStyle } from "@/components/research-lab/chart-theme";
import type { HoldingRow } from "@/lib/research-lab/types";

interface HoldingsWeightChartProps {
  holdings: HoldingRow[];
  title?: string;
}

export function HoldingsWeightChart({ holdings, title = "Weight in basket" }: HoldingsWeightChartProps) {
  const data = [...holdings]
    .sort((a, b) => b.basketWeight - a.basketWeight)
    .map((h) => ({ ticker: h.ticker, weight: h.basketWeight, pending: h.pending }));

  if (data.length === 0) return null;

  return (
    <div className="space-y-2">
      <p className="text-caption">{title}</p>
      <div className="w-full" style={{ height: Math.max(120, data.length * 32) }}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} layout="vertical" margin={{ left: 0, right: 12, top: 4, bottom: 4 }}>
            <XAxis
              type="number"
              domain={[0, "dataMax"]}
              tick={{ fontSize: 9, fill: "hsl(var(--muted-foreground))" }}
              tickFormatter={(v) => `${v}%`}
            />
            <YAxis
              type="category"
              dataKey="ticker"
              width={36}
              tick={{ fontSize: 10, fill: "hsl(var(--foreground))", fontWeight: 600 }}
            />
            <Tooltip
              contentStyle={tooltipStyle}
              formatter={(v: number) => [`${v.toFixed(2)}%`, "Basket weight"]}
            />
            <Bar dataKey="weight" radius={[0, 4, 4, 0]} maxBarSize={18}>
              {data.map((d, i) => (
                <Cell
                  key={d.ticker}
                  fill={d.pending ? "hsl(var(--warning))" : (CHART_COLORS[i % CHART_COLORS.length] ?? CHART_COLORS[0])}
                />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
