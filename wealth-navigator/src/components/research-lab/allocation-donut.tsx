"use client";

import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from "recharts";
import { CHART_COLORS, CASH_COLOR, tooltipStyle } from "@/components/research-lab/chart-theme";
import type { BasketTotals, HoldingRow } from "@/lib/research-lab/types";
import { formatZARExact } from "@/lib/format";

interface Slice {
  name: string;
  value: number;
  pct: number;
  fill: string;
}

interface AllocationDonutProps {
  holdings: HoldingRow[];
  totals: BasketTotals;
  title?: string;
}

export function AllocationDonut({ holdings, totals, title = "Basket allocation" }: AllocationDonutProps) {
  const slices: Slice[] = [
    ...holdings.map((h, i) => ({
      name: h.ticker,
      value: h.value,
      pct: h.basketWeight,
      fill: CHART_COLORS[i % CHART_COLORS.length] ?? CHART_COLORS[0],
    })),
    ...(totals.cashPct > 0.01
      ? [{ name: "Cash", value: totals.cash, pct: totals.cashPct, fill: CASH_COLOR }]
      : []),
  ];

  if (slices.length === 0) return null;

  return (
    <div className="space-y-3">
      <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{title}</p>
      <div className="flex flex-col items-center gap-4 sm:flex-row sm:items-start">
        <div className="relative h-[180px] w-[180px] shrink-0">
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie
                data={slices}
                dataKey="value"
                nameKey="name"
                cx="50%"
                cy="50%"
                innerRadius={52}
                outerRadius={78}
                paddingAngle={2}
                stroke="hsl(var(--card))"
                strokeWidth={2}
              >
                {slices.map((s) => (
                  <Cell key={s.name} fill={s.fill} />
                ))}
              </Pie>
              <Tooltip
                contentStyle={tooltipStyle}
                formatter={(v: number, _n, p) => [
                  `${formatZARExact(v)} (${(p?.payload as Slice)?.pct?.toFixed(1) ?? "0"}%)`,
                  (p?.payload as Slice)?.name,
                ]}
              />
            </PieChart>
          </ResponsiveContainer>
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
            <span className="font-mono text-[9px] uppercase tracking-wider text-muted-foreground">Basket</span>
            <span className="font-mono text-sm font-semibold tabular-nums">
              {formatZARExact(totals.basketMin)}
            </span>
          </div>
        </div>

        <ul className="min-w-0 flex-1 space-y-1.5">
          {slices.map((s) => (
            <li key={s.name} className="flex items-center justify-between gap-2 text-[11px]">
              <span className="flex min-w-0 items-center gap-2">
                <span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: s.fill }} />
                <span className="truncate font-medium">{s.name}</span>
              </span>
              <span className="shrink-0 font-mono tabular-nums text-muted-foreground">
                {s.pct.toFixed(1)}%
              </span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
