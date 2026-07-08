"use client";

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { cn } from "@/lib/cn";
import { CHART_COLORS, tooltipStyle } from "@/components/research-lab/chart-theme";

/**
 * Normalized strategy-vs-JSE-All-Share performance chart with time-range filters.
 *
 * Every strategy's daily basket_value series and the J203 benchmark are rebased
 * to 100 on the window's start date, so relative performance is comparable
 * regardless of absolute NAV/index scale. Ranges anchor to the LATEST available
 * data date (not "now"), so they stay meaningful even while the returns series
 * is stale. Per-series chips toggle each line; J203 is drawn thicker/dashed.
 */

interface Pt {
  t: number;
  v: number;
}
interface ApiSeries {
  id: string;
  name: string;
  points: Pt[];
}
interface ApiResponse {
  source: string;
  range: { from: string; to: string } | null;
  benchmark: { code: string; name: string; points: Pt[] } | null;
  strategies: ApiSeries[];
}

interface Series {
  key: string;
  name: string;
  color: string;
  isBench: boolean;
  byDate: Map<string, number>;
  dates: string[]; // sorted ascending
}

type RangeKey = "1D" | "1W" | "1M" | "3M" | "6M" | "1Y" | "ALL";
const RANGES: Array<{ key: RangeKey; days: number }> = [
  { key: "1D", days: 1 },
  { key: "1W", days: 7 },
  { key: "1M", days: 30 },
  { key: "3M", days: 91 },
  { key: "6M", days: 182 },
  { key: "1Y", days: 365 },
  { key: "ALL", days: Infinity },
];
const DAY_MS = 86_400_000;
const BENCH_COLOR = "hsl(var(--foreground))";
const toDate = (t: number): string => new Date(t).toISOString().slice(0, 10);

function buildSeries(data: ApiResponse | undefined): Series[] {
  if (!data) return [];
  const out: Series[] = [];
  data.strategies.forEach((s, i) => {
    const byDate = new Map<string, number>();
    for (const p of s.points) byDate.set(toDate(p.t), p.v);
    out.push({
      key: s.id,
      name: s.name,
      color: CHART_COLORS[i % CHART_COLORS.length] ?? "hsl(var(--chart-1))",
      isBench: false,
      byDate,
      dates: [...byDate.keys()].sort(),
    });
  });
  if (data.benchmark && data.benchmark.points.length > 0) {
    const byDate = new Map<string, number>();
    for (const p of data.benchmark.points) byDate.set(toDate(p.t), p.v);
    out.push({
      key: "j203",
      name: data.benchmark.name,
      color: BENCH_COLOR,
      isBench: true,
      byDate,
      dates: [...byDate.keys()].sort(),
    });
  }
  return out;
}

interface Rebased {
  chartData: Array<Record<string, number | null>>;
  series: Series[];
  from: string | null;
  to: string | null;
}

/** Rebase every series to 100 at the window start (the later of `windowStart`
 *  and each series' first date), then merge onto one date axis. `windowStart`
 *  is "" for the full range. */
function rebase(series: Series[], windowStart: string): Rebased {
  const usable = series.filter((s) => s.dates.length >= 2);
  if (usable.length === 0) return { chartData: [], series: [], from: null, to: null };
  let commonStart = windowStart;
  for (const s of usable) {
    const first = s.dates[0];
    if (first && first > commonStart) commonStart = first;
  }
  const base = new Map<string, number>();
  const kept: Series[] = [];
  for (const s of usable) {
    const d = s.dates.find((x) => x >= commonStart);
    const b = d != null ? s.byDate.get(d) : undefined;
    if (b != null && b > 0) {
      base.set(s.key, b);
      kept.push(s);
    }
  }
  const dateSet = new Set<string>();
  for (const s of kept) for (const d of s.dates) if (d >= commonStart) dateSet.add(d);
  const dates = [...dateSet].sort();
  const chartData = dates.map((d) => {
    const row: Record<string, number | null> = { ts: Date.parse(d) };
    for (const s of kept) {
      const v = s.byDate.get(d);
      const b = base.get(s.key);
      row[s.key] = v != null && b ? (v / b) * 100 : null;
    }
    return row;
  });
  return { chartData, series: kept, from: dates[0] ?? null, to: dates[dates.length - 1] ?? null };
}

const fmtTick = (ts: number): string =>
  new Date(ts).toLocaleDateString("en-ZA", { month: "short", day: "numeric" });

export function StrategyPerfChart({ enabled = true }: { enabled?: boolean }) {
  const q = useQuery({
    queryKey: ["strategies-returns"],
    queryFn: async (): Promise<ApiResponse> => {
      const r = await fetch("/api/strategies/returns");
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return (await r.json()) as ApiResponse;
    },
    enabled,
    staleTime: 5 * 60_000,
  });

  const allSeries = React.useMemo(() => buildSeries(q.data), [q.data]);
  const [range, setRange] = React.useState<RangeKey>("ALL");
  const [hidden, setHidden] = React.useState<Set<string>>(() => new Set());

  const { chartData, series, from, to } = React.useMemo(() => {
    // Anchor ranges to the latest available data date, not "now".
    let endMs = 0;
    for (const s of allSeries) {
      const last = s.dates[s.dates.length - 1];
      if (last) {
        const t = Date.parse(last);
        if (t > endMs) endMs = t;
      }
    }
    const days = RANGES.find((r) => r.key === range)?.days ?? Infinity;
    const windowStart = days === Infinity || endMs === 0 ? "" : toDate(endMs - days * DAY_MS);
    return rebase(allSeries, windowStart);
  }, [allSeries, range]);

  const toggle = (key: string) =>
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  if (q.isLoading) {
    return (
      <div className="flex h-full items-center justify-center text-caption text-muted-foreground">
        Loading strategy performance…
      </div>
    );
  }
  if (q.isError || allSeries.filter((s) => !s.isBench).length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-1 px-4 text-center">
        <p className="text-caption text-muted-foreground">No strategy performance series available.</p>
        <p className="text-[10px] text-muted-foreground/70">
          Strategies need a populated daily returns history (strategies_returns_c) to compare against the JSE All Share.
        </p>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-1.5">
      {/* Range filter: windows anchor to the latest available data date. */}
      <div className="flex shrink-0 items-center gap-0.5">
        {RANGES.map((r) => (
          <button
            key={r.key}
            type="button"
            onClick={() => setRange(r.key)}
            className={cn(
              "rounded px-1.5 py-0.5 text-[9.5px] font-medium tabular-nums transition-colors",
              range === r.key ? "bg-primary/20 text-primary" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {r.key}
          </button>
        ))}
        {from && to && (
          <span className="ml-auto font-mono text-[9px] tabular-nums text-muted-foreground/70">
            {from} → {to} · rebased 100
          </span>
        )}
      </div>

      <div className="min-h-0 flex-1">
        {chartData.length < 2 ? (
          <div className="flex h-full items-center justify-center text-[10px] text-muted-foreground">
            Not enough data points in this window.
          </div>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={chartData} margin={{ top: 6, right: 8, bottom: 0, left: -12 }}>
              <CartesianGrid stroke="hsl(var(--border) / 0.35)" strokeDasharray="2 4" vertical={false} />
              <XAxis
                dataKey="ts"
                type="number"
                scale="time"
                domain={["dataMin", "dataMax"]}
                tickFormatter={fmtTick}
                tick={{ fontSize: 9, fill: "hsl(var(--muted-foreground))" }}
                minTickGap={40}
                tickLine={false}
                axisLine={false}
              />
              <YAxis
                tick={{ fontSize: 9, fill: "hsl(var(--muted-foreground))" }}
                tickFormatter={(v: number) => v.toFixed(0)}
                width={34}
                domain={["auto", "auto"]}
                tickLine={false}
                axisLine={false}
              />
              <ReferenceLine y={100} stroke="hsl(var(--muted-foreground) / 0.4)" strokeDasharray="3 3" />
              <Tooltip
                contentStyle={tooltipStyle}
                labelFormatter={(ts) =>
                  new Date(Number(ts)).toLocaleDateString("en-ZA", { year: "numeric", month: "short", day: "numeric" })
                }
                formatter={(value: number | string, _name, item) => {
                  const n = Number(value);
                  const label = (item as { name?: string })?.name ?? "";
                  return [`${n.toFixed(1)}  (${n - 100 >= 0 ? "+" : ""}${(n - 100).toFixed(1)}%)`, label];
                }}
              />
              {series
                .filter((s) => !hidden.has(s.key))
                .map((s) => (
                  <Line
                    key={s.key}
                    type="monotone"
                    dataKey={s.key}
                    name={s.name}
                    stroke={s.color}
                    strokeWidth={s.isBench ? 2.4 : 1.6}
                    strokeDasharray={s.isBench ? "5 3" : undefined}
                    dot={false}
                    connectNulls
                    isAnimationActive={false}
                  />
                ))}
            </LineChart>
          </ResponsiveContainer>
        )}
      </div>

      {/* Filter chips: click to show/hide each series. */}
      <div className="flex shrink-0 flex-wrap items-center gap-1">
        {series.map((s) => {
          const off = hidden.has(s.key);
          return (
            <button
              key={s.key}
              type="button"
              onClick={() => toggle(s.key)}
              className="inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[9.5px] transition-colors"
              style={{
                borderColor: off ? "hsl(var(--border))" : s.color,
                color: off ? "hsl(var(--muted-foreground))" : "hsl(var(--foreground))",
                background: off ? "transparent" : "hsl(var(--muted-foreground) / 0.06)",
                textDecoration: off ? "line-through" : "none",
              }}
              title={s.isBench ? "JSE All Share benchmark" : s.name}
            >
              <span
                className="h-1.5 w-1.5 shrink-0 rounded-full"
                style={{ background: off ? "hsl(var(--muted-foreground) / 0.4)" : s.color }}
              />
              <span className="max-w-[90px] truncate">{s.name}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
