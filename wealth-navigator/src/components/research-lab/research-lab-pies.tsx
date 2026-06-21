"use client";

import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from "recharts";
import { CHART_COLORS, CASH_COLOR, tooltipStyle } from "@/components/research-lab/chart-theme";
import { formatZARExact } from "@/lib/format";
import type { BasketTotals, HoldingRow, SectorSlice } from "@/lib/research-lab/types";

interface PieSlice {
  name: string;
  fullName: string;
  value: number;
  pct: number;
  fill: string;
  /** Whether `value` is a money amount (vs a weight % stand-in). */
  isMoney: boolean;
}

/** One donut + a colour-coded legend list. Shared chrome for both pies. */
function LabPie({
  title,
  slices,
  centerLabel,
  centerValue,
  valueFormatter,
}: {
  title: string;
  slices: PieSlice[];
  centerLabel: string;
  centerValue: string;
  valueFormatter: (slice: PieSlice) => string;
}) {
  if (slices.length === 0) return null;

  return (
    <div className="space-y-3">
      <p className="text-caption">{title}</p>
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
                formatter={(_v: number, _n, p) => {
                  const slice = p?.payload as PieSlice | undefined;
                  return [slice ? valueFormatter(slice) : "", slice?.fullName ?? ""];
                }}
              />
            </PieChart>
          </ResponsiveContainer>
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
            <span className="font-mono text-[9px] uppercase tracking-wider text-muted-foreground">
              {centerLabel}
            </span>
            <span className="font-mono text-sm font-semibold tabular-nums">{centerValue}</span>
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

interface ResearchLabPiesProps {
  holdings: HoldingRow[];
  totals: BasketTotals;
  sectors: SectorSlice[];
  /** Optional label suffix, e.g. "Current" / "Proposed". */
  scope?: string;
}

/**
 * Item 5 — two ADJACENT pies that replace the old duplicated
 * "sector exposure" + "weights" blocks:
 *   • left  — sector-exposure pie (weight by sector)
 *   • right — weight pie (weight by individual holding)
 * Both read the same live-recomputed basket so they stay in lock-step
 * with add/remove edits.
 */
export function ResearchLabPies({ holdings, totals, sectors, scope }: ResearchLabPiesProps) {
  const suffix = scope ? ` — ${scope}` : "";

  const sectorSlices: PieSlice[] = sectors.map((s, i) => ({
    name: (s.sector.split("—")[0] ?? s.sector).trim(),
    fullName: s.sector,
    value: s.weight,
    pct: s.weight,
    isMoney: false,
    fill: s.sector === "Cash" ? CASH_COLOR : (CHART_COLORS[i % CHART_COLORS.length] ?? CHART_COLORS[0]),
  }));

  const weightSlices: PieSlice[] = [
    ...holdings.map((h, i) => ({
      name: h.ticker,
      fullName: h.name,
      value: h.value > 0 ? h.value : h.basketWeight,
      pct: h.basketWeight,
      isMoney: h.value > 0,
      fill: CHART_COLORS[i % CHART_COLORS.length] ?? CHART_COLORS[0],
    })),
    ...(totals.cashPct > 0.01
      ? [
          {
            name: "Cash",
            fullName: "Cash reserve",
            value: totals.cash > 0 ? totals.cash : totals.cashPct,
            pct: totals.cashPct,
            isMoney: totals.cash > 0,
            fill: CASH_COLOR,
          },
        ]
      : []),
  ];

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
      <div className="glass-inset p-4">
        <LabPie
          title={`Sector exposure${suffix}`}
          slices={sectorSlices}
          centerLabel="Sectors"
          centerValue={String(sectors.filter((s) => s.sector !== "Cash").length)}
          valueFormatter={(s) => `${s.pct.toFixed(2)}%`}
        />
      </div>
      <div className="glass-inset p-4">
        <LabPie
          title={`Weight by holding${suffix}`}
          slices={weightSlices}
          centerLabel="Basket"
          centerValue={formatZARExact(totals.basketMin)}
          valueFormatter={(s) =>
            s.isMoney
              ? `${formatZARExact(s.value)} (${s.pct.toFixed(1)}%)`
              : `${s.pct.toFixed(1)}%`
          }
        />
      </div>
    </div>
  );
}
