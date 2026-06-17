"use client";

import { Bar, BarChart, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { tooltipStyle } from "@/components/research-lab/chart-theme";
import { formatZARExact } from "@/lib/format";

interface DeltaComparisonChartProps {
  label: string;
  current: number;
  proposed: number;
}

export function DeltaComparisonChart({ label, current, proposed }: DeltaComparisonChartProps) {
  const data = [
    { name: "Current", value: current, fill: "hsl(var(--muted-foreground) / 0.5)" },
    { name: "Proposed", value: proposed, fill: "hsl(var(--primary))" },
  ];

  return (
    <div className="rounded-md border border-border bg-card p-3">
      <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{label}</p>
      <div className="mt-2 h-[100px] w-full">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} margin={{ top: 4, right: 8, left: 8, bottom: 0 }}>
            <XAxis
              dataKey="name"
              tick={{ fontSize: 9, fill: "hsl(var(--muted-foreground))" }}
            />
            <YAxis hide domain={[0, Math.max(current, proposed) * 1.1]} />
            <Tooltip
              contentStyle={tooltipStyle}
              formatter={(v: number) => [formatZARExact(v), ""]}
            />
            <Bar dataKey="value" radius={[4, 4, 0, 0]} maxBarSize={48}>
              {data.map((d) => (
                <Cell key={d.name} fill={d.fill} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
      <p className="mt-1 text-center font-mono text-xs font-semibold tabular-nums">
        {formatZARExact(proposed)}
        <span className="ml-1 text-[10px] font-normal text-muted-foreground">
          from {formatZARExact(current)}
        </span>
      </p>
    </div>
  );
}
