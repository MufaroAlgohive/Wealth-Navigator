"use client";

import { Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { SectorSlice } from "@/lib/research-lab/types";

const PURPLE = "hsl(263 82% 68%)";
const PURPLE_MUTED = "hsl(263 45% 45%)";

interface SectorExposureChartProps {
  title: string;
  data: SectorSlice[];
}

export function SectorExposureChart({ title, data }: SectorExposureChartProps) {
  const chartData = data.map((d) => ({
    ...d,
    short: (d.sector.split("—")[0] ?? d.sector).trim().slice(0, 14),
  }));

  return (
    <div className="space-y-2">
      <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{title}</p>
      <div className="h-[200px] w-full">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={chartData} layout="vertical" margin={{ left: 4, right: 8, top: 4, bottom: 4 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" horizontal={false} />
            <XAxis
              type="number"
              domain={[0, 50]}
              tick={{ fontSize: 9, fill: "hsl(var(--muted-foreground))" }}
              tickFormatter={(v) => `${v}%`}
            />
            <YAxis
              type="category"
              dataKey="short"
              width={88}
              tick={{ fontSize: 9, fill: "hsl(var(--muted-foreground))" }}
            />
            <Tooltip
              contentStyle={{
                background: "hsl(var(--card))",
                border: "1px solid hsl(var(--border))",
                borderRadius: 6,
                fontSize: 11,
                fontFamily: "var(--font-mono)",
              }}
              formatter={(v: number) => [`${v.toFixed(2)}%`, "Weight"]}
              labelFormatter={(_, payload) => payload?.[0]?.payload?.sector ?? ""}
            />
            <Bar dataKey="weight" radius={[0, 3, 3, 0]} maxBarSize={14}>
              {chartData.map((_, i) => (
                <Cell key={i} fill={i % 2 === 0 ? PURPLE : PURPLE_MUTED} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
