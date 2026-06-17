"use client";

import { Bar, BarChart, CartesianGrid, Cell, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { CHART_COLORS, CASH_COLOR, tooltipStyle } from "@/components/research-lab/chart-theme";
import type { SectorSlice } from "@/lib/research-lab/types";

interface SectorExposureChartProps {
  title: string;
  data: SectorSlice[];
  variant?: "bar" | "pie" | "both";
}

export function SectorExposureChart({ title, data, variant = "both" }: SectorExposureChartProps) {
  const chartData = data.map((d, i) => ({
    ...d,
    short: (d.sector.split("—")[0] ?? d.sector).trim().slice(0, 16),
    fill: d.sector === "Cash" ? CASH_COLOR : CHART_COLORS[i % CHART_COLORS.length],
  }));

  if (chartData.length === 0) return null;

  const maxWt = Math.max(...chartData.map((d) => d.weight), 10);

  return (
    <div className="space-y-3">
      <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{title}</p>

      {(variant === "pie" || variant === "both") && (
        <div className="flex flex-col items-center gap-3 sm:flex-row sm:items-start">
          <div className="h-[160px] w-[160px] shrink-0">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  data={chartData}
                  dataKey="weight"
                  nameKey="short"
                  cx="50%"
                  cy="50%"
                  innerRadius={42}
                  outerRadius={68}
                  paddingAngle={2}
                  stroke="hsl(var(--card))"
                  strokeWidth={2}
                >
                  {chartData.map((d) => (
                    <Cell key={d.sector} fill={d.fill} />
                  ))}
                </Pie>
                <Tooltip
                  contentStyle={tooltipStyle}
                  formatter={(v: number, _n, p) => [
                    `${v.toFixed(2)}%`,
                    (p?.payload as SectorSlice)?.sector ?? "",
                  ]}
                />
              </PieChart>
            </ResponsiveContainer>
          </div>
          <ul className="grid min-w-0 flex-1 grid-cols-1 gap-1 sm:grid-cols-2">
            {chartData.map((d) => (
              <li key={d.sector} className="flex items-center gap-2 text-[10px]">
                <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: d.fill }} />
                <span className="min-w-0 truncate text-muted-foreground">{d.short}</span>
                <span className="ml-auto font-mono tabular-nums">{d.weight.toFixed(1)}%</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {(variant === "bar" || variant === "both") && (
        <div className="w-full" style={{ height: Math.max(140, chartData.length * 28) }}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={chartData} layout="vertical" margin={{ left: 4, right: 8, top: 4, bottom: 4 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" horizontal={false} />
              <XAxis
                type="number"
                domain={[0, Math.ceil(maxWt / 10) * 10]}
                tick={{ fontSize: 9, fill: "hsl(var(--muted-foreground))" }}
                tickFormatter={(v) => `${v}%`}
              />
              <YAxis
                type="category"
                dataKey="short"
                width={92}
                tick={{ fontSize: 9, fill: "hsl(var(--muted-foreground))" }}
              />
              <Tooltip
                contentStyle={tooltipStyle}
                formatter={(v: number) => [`${v.toFixed(2)}%`, "Weight"]}
                labelFormatter={(_, payload) => payload?.[0]?.payload?.sector ?? ""}
              />
              <Bar dataKey="weight" radius={[0, 3, 3, 0]} maxBarSize={14}>
                {chartData.map((d) => (
                  <Cell key={d.sector} fill={d.fill} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}

interface SectorCompareProps {
  before: SectorSlice[];
  after: SectorSlice[];
}

/** Side-by-side sector pies — Lovable before/after layout */
export function SectorCompareCharts({ before, after }: SectorCompareProps) {
  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
      <div className="rounded-md border border-border/60 bg-muted/10 p-3">
        <SectorExposureChart title="Sector exposure — Before" data={before} variant="pie" />
      </div>
      <div className="rounded-md border border-primary/20 bg-primary/5 p-3">
        <SectorExposureChart title="Sector exposure — After" data={after} variant="pie" />
      </div>
    </div>
  );
}
