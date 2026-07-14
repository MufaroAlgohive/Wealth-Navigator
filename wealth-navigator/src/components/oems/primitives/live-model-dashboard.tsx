"use client";

import { useQuery } from "@tanstack/react-query";
import * as React from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Activity, TrendingDown, TrendingUp } from "lucide-react";

import { cn } from "@/lib/cn";
import { EmptyDataState } from "@/components/oems/primitives/empty-data-state";
import { GlassKpi, GlassSection } from "@/components/oems/primitives/glass";
import { CHART_COLORS, tooltipStyle } from "@/components/research-lab/chart-theme";

/**
 * Live demo dashboard for the OEMS Model detail "Paper" view.
 *
 * Wires `/api/models/[id]/benchmark` (paper curve + STX40.JO benchmark +
 * aligned summary stats: alpha, beta, info ratio, up/down capture, drawdowns)
 * into a single composite block with range chips, equity-vs-benchmark line
 * chart, daily P&L bars, drawdown area, allocation donut and a per-holding
 * P&L attribution table.
 *
 * Honest empty states: any panel whose data is missing renders a labelled
 * empty card (PAPER · SUPABASE / STX40.JO · IRESS or YAHOO / STX40.JO ·
 * UNAVAILABLE) so the demo never shows fake lines.
 */

interface PaperPoint {
  ts: string;
  date: string;
  equity: number;
  day_pnl: number | null;
  day_pnl_pct: number | null;
  cash: number | null;
}
interface BenchPoint {
  ts: string;
  date: string;
  v: number;
}
interface Summary {
  days: number;
  from: string | null;
  to: string | null;
  paperReturn: number | null;
  benchReturn: number | null;
  alpha: number | null;
  beta: number | null;
  trackingError: number | null;
  infoRatio: number | null;
  upCapture: number | null;
  downCapture: number | null;
  maxDrawdown: number | null;
  maxDrawdownBench: number | null;
  alignedDays: number;
  startEquity: number | null;
  endEquity: number | null;
}
interface BenchPayload {
  code: string;
  name: string;
  currency?: string;
  source: "iress" | "yahoo";
  points: BenchPoint[];
}
interface BenchUnavailable {
  code: string;
  name: string;
  source: "unavailable";
  reason: string;
  points: [];
}
interface BenchmarkResponse {
  ok: boolean;
  error?: string;
  model?: { slug: string; currency: string };
  paper: PaperPoint[];
  benchmark: BenchPayload | BenchUnavailable | null;
  summary: Summary;
  asOf: string;
}

export interface PositionLite {
  symbol: string;
  side: string | null;
  qty: number | null;
  avg_entry_price: number | null;
  market_value: number | null;
  unrealized_pl: number | null;
  unrealized_plpc: number | null;
  weight: number | null;
}

interface Props {
  slug: string;
  positions: PositionLite[];
  paperCurveCount: number;
  currency: string;
  /**
   * Optional pre-fetched paper curve from the parent. When supplied we use it
   * directly instead of issuing our own `/api/models/[id]/benchmark` fetch —
   * this lets the parent (model-detail.tsx) drive a single shared fetch so
   * the Live Demo Snapshot, Demo Account KPI strip, and Paper Equity chart
   * all agree on `paper.length` even when the BFF's `/api/models/[id]`
   * equity payload has been truncated by the PostgREST 1000-row cap.
   */
  externalPaperCurve?: PaperPoint[];
}

type RangeKey = "1W" | "1M" | "3M" | "YTD" | "ALL";

const RANGES: Array<{ key: RangeKey; label: string; days: number | null }> = [
  { key: "1W", label: "1W", days: 7 },
  { key: "1M", label: "1M", days: 30 },
  { key: "3M", label: "3M", days: 91 },
  { key: "YTD", label: "YTD", days: null },
  { key: "ALL", label: "ALL", days: Infinity },
];
const DAY_MS = 86_400_000;

const n = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

const pct = (v: number | null | undefined, dp = 1) =>
  v == null ? "—" : `${(v * 100).toFixed(dp)}%`;
const pctSigned = (v: number | null | undefined, dp = 1) =>
  v == null ? "—" : `${v >= 0 ? "+" : ""}${(v * 100).toFixed(dp)}%`;
const num = (v: number | null | undefined, dp = 2) =>
  v == null ? "—" : v.toFixed(dp);
const fx = (v: number | null | undefined, dp = 2) =>
  v == null ? "—" : v.toFixed(dp);
const money = (v: number | null | undefined, ccy = "R") =>
  v == null
    ? "—"
    : `${ccy}${Math.round(v).toLocaleString("en-ZA")}`;

function toDate(ts: string | Date): string {
  if (typeof ts === "string") return ts.slice(0, 10);
  return ts.toISOString().slice(0, 10);
}

export function LiveModelDashboard({ slug, positions, paperCurveCount, currency, externalPaperCurve }: Props) {
  const ccy = currency === "USD" ? "$" : "R";
  const q = useQuery<BenchmarkResponse>({
    queryKey: ["model-benchmark", slug],
    queryFn: async () => (await fetch(`/api/models/${slug}/benchmark`)).json(),
    refetchInterval: 60_000,
  });

  const data = q.data;
  // Prefer the externally-supplied paper curve (e.g. from the parent) so
  // the paper-equity day count stays in sync with the Demo Account KPI
  // strip. Falls back to the locally-fetched benchmark response.
  const paper = externalPaperCurve && externalPaperCurve.length > 0
    ? externalPaperCurve
    : (data?.paper ?? []);
  const summary = data?.summary;
  const benchmark = data?.benchmark ?? null;
  const benchAvailable =
    benchmark != null && benchmark.source !== "unavailable" && benchmark.points.length >= 2;

  const [range, setRange] = React.useState<RangeKey>("ALL");
  const [showBench, setShowBench] = React.useState(true);

  // ── range filter (anchor to latest available paper date, not "now") ───────
  const lastPaperTs = paper.length ? new Date(paper[paper.length - 1]!.ts).getTime() : 0;
  const windowStartMs = React.useMemo(() => {
    if (!lastPaperTs) return 0;
    const cfg = RANGES.find((r) => r.key === range);
    if (!cfg || cfg.days == null) return 0;
    if (cfg.days === Infinity) return 0;
    if (cfg.key === "YTD") {
      const d = new Date(lastPaperTs);
      return Date.UTC(d.getUTCFullYear(), 0, 1);
    }
    return lastPaperTs - cfg.days * DAY_MS;
  }, [range, lastPaperTs]);
  const windowStartDate = windowStartMs
    ? new Date(windowStartMs).toISOString().slice(0, 10)
    : "";

  const inWindow = React.useMemo(
    () =>
      paper.filter((p) => {
        if (!windowStartDate) return true;
        return p.date >= windowStartDate;
      }),
    [paper, windowStartDate],
  );

  // ── equity-vs-bench series (rebased to 100 on window start) ──────────────
  const equitySeries = React.useMemo(() => {
    if (inWindow.length < 2) return [];
    const first = inWindow[0]!.equity;
    if (!first || first <= 0) return [];
    const out: Array<{ date: string; ts: number; paper: number; bench: number | null }> = inWindow.map((p) => ({
      date: p.date,
      ts: new Date(p.ts).getTime(),
      paper: (p.equity / first) * 100,
      bench: null,
    }));
    if (benchAvailable && showBench) {
      const bAll = (benchmark as BenchPayload).points;
      const firstOut = out[0];
      const bStart = firstOut ? bAll.find((b) => b.date >= firstOut.date)?.v : undefined;
      if (bStart && bStart > 0) {
        const bMap = new Map(bAll.map((b) => [b.date, b.v]));
        for (const row of out) {
          const v = bMap.get(row.date);
          row.bench = v != null ? (v / bStart) * 100 : null;
        }
      }
    }
    return out;
  }, [inWindow, benchAvailable, benchmark, showBench]);

  // ── daily P&L bars + drawdown ────────────────────────────────────────────
  const dailyPnl = React.useMemo(
    () =>
      inWindow.map((p) => ({
        date: p.date,
        pnl: p.day_pnl ?? null,
        pct: p.day_pnl_pct != null ? p.day_pnl_pct * 100 : null,
      })),
    [inWindow],
  );
  const drawdownSeries = React.useMemo(() => {
    if (inWindow.length < 2) return [];
    let peak = inWindow[0]!.equity;
    return inWindow.map((p) => {
      if (p.equity > peak) peak = p.equity;
      const dd = peak > 0 ? (p.equity / peak - 1) * 100 : 0;
      return { date: p.date, ts: new Date(p.ts).getTime(), drawdown: dd };
    });
  }, [inWindow]);

  // ── allocation donut (weighted by market value) ──────────────────────────
  const allocation = React.useMemo(() => {
    const totalMv = positions.reduce(
      (s, p) => s + (typeof p.market_value === "number" ? p.market_value : 0),
      0,
    );
    const items = positions
      .map((p, i) => ({
        symbol: p.symbol,
        side: (p.side ?? "long").toLowerCase(),
        mv: typeof p.market_value === "number" ? p.market_value : 0,
        pl: typeof p.unrealized_pl === "number" ? p.unrealized_pl : 0,
        plpc: typeof p.unrealized_plpc === "number" ? p.unrealized_plpc : null,
        color: CHART_COLORS[i % CHART_COLORS.length] ?? "hsl(var(--chart-1))",
        weight: totalMv > 0 ? (p.market_value ?? 0) / totalMv : null,
      }))
      .filter((x) => x.mv > 0)
      .sort((a, b) => b.mv - a.mv);
    return { items, totalMv };
  }, [positions]);

  const attribution = React.useMemo(() => {
    const totalPl = allocation.items.reduce((s, x) => s + x.pl, 0);
    return allocation.items.map((x) => ({
      ...x,
      contributionPct: totalPl !== 0 ? x.pl / totalPl : null,
    }));
  }, [allocation]);

  // ── render guards ────────────────────────────────────────────────────────
  if (q.isLoading) {
    return (
      <div className="grid gap-4">
        <div className="h-32 animate-pulse rounded-xl bg-muted/30" />
        <div className="h-72 animate-pulse rounded-xl bg-muted/30" />
      </div>
    );
  }
  if (!data?.ok) {
    return (
      <GlassSection
        title="Live Demo Dashboard"
        subtitle="paper-vs-benchmark + risk + attribution"
        endpoint="GET /api/models/[id]/benchmark"
        dataSource="supabase"
        db="institutional"
      >
        <EmptyDataState
          title="Benchmark bundle unavailable"
          message={data?.error ?? "The BFF rejected the request — check your admin session."}
          badgeLabel="supabase"
        />
      </GlassSection>
    );
  }
  if (paper.length < 2) {
    return (
      <GlassSection
        title="Live Demo Dashboard"
        subtitle="paper-vs-benchmark + risk + attribution"
        endpoint="GET /api/models/[id]/benchmark"
        dataSource="supabase"
        db="institutional"
      >
        <EmptyDataState
          title="Paper curve still warming up"
          message={`Only ${paperCurveCount} daily point${paperCurveCount === 1 ? "" : "s"} pushed so far. The full dashboard (benchmark overlay, drawdown, allocation, attribution) appears once the model has ≥2 days of marks.`}
          badgeLabel="supabase"
        />
      </GlassSection>
    );
  }

  return (
    <div className="space-y-4">
      {/* ── KPI strip ─────────────────────────────────────────────────────── */}
      <GlassSection
        title="Live Demo Snapshot"
        subtitle={summary?.from && summary?.to ? `${summary.from} → ${summary.to} · ${summary.days} trading days` : "paper-vs-benchmark"}
        endpoint="GET /api/models/[id]/benchmark"
        dataSource="supabase"
        db="institutional"
        right={
          <RangeChips
            value={range}
            onChange={setRange}
          />
        }
      >
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <GlassKpi
            label="Paper Return"
            value={pctSigned(summary?.paperReturn)}
            sub={summary?.startEquity != null && summary?.endEquity != null
              ? `${money(summary.startEquity, ccy)} → ${money(summary.endEquity, ccy)}`
              : undefined}
            accent={(summary?.paperReturn ?? 0) >= 0 ? "positive" : "negative"}
          />
          <GlassKpi
            label="Alpha vs STX40"
            value={pctSigned(summary?.alpha)}
            sub={summary?.benchReturn != null ? `bench ${pctSigned(summary.benchReturn)}` : undefined}
            accent={summary?.alpha == null ? "default" : summary.alpha >= 0 ? "positive" : "negative"}
          />
          <GlassKpi label="Beta vs STX40" value={num(summary?.beta)} />
          <GlassKpi label="Information Ratio" value={fx(summary?.infoRatio)} />
          <GlassKpi label="Tracking Error" value={summary?.trackingError != null ? `${(summary.trackingError * 100).toFixed(2)}%` : "—"} />
          <GlassKpi label="Max Drawdown" value={pct(summary?.maxDrawdown)} accent="negative" />
          <GlassKpi label="Up Capture" value={summary?.upCapture != null ? `${(summary.upCapture * 100).toFixed(0)}%` : "—"} />
          <GlassKpi label="Down Capture" value={summary?.downCapture != null ? `${(summary.downCapture * 100).toFixed(0)}%` : "—"} />
        </div>
      </GlassSection>

      {/* ── equity-vs-benchmark line chart ────────────────────────────────── */}
      <GlassSection
        title="Equity vs Benchmark"
        subtitle={
          benchAvailable
            ? `rebased to 100 on window start · ${(benchmark as BenchPayload).source.toUpperCase()}`
            : "benchmark unavailable — see note below"
        }
        endpoint="GET /api/models/[id]/benchmark"
        dataSource="supabase"
        db="institutional"
        right={
          benchAvailable ? (
            <button
              type="button"
              onClick={() => setShowBench((v) => !v)}
              className={cn(
                "rounded-full border px-2.5 py-0.5 text-[10px] font-medium uppercase tracking-wide transition",
                showBench
                  ? "border-primary/40 bg-primary/10 text-primary"
                  : "border-border/60 text-muted-foreground hover:text-foreground",
              )}
            >
              {showBench ? "STX40 on" : "STX40 off"}
            </button>
          ) : undefined
        }
      >
        {!benchAvailable ? (
          <EmptyDataState
            title="Benchmark line unavailable"
            message={
              benchmark && benchmark.source === "unavailable"
                ? benchmark.reason
                : "No benchmark series returned. The paper curve still draws — toggle STX40 off to see it alone."
            }
            badgeLabel="blocked-external"
          />
        ) : equitySeries.length < 2 ? (
          <EmptyDataState
            title="Not enough aligned points"
            message={`Window contains ${equitySeries.length} paper point${equitySeries.length === 1 ? "" : "s"}. Try a longer range or wait for more pushes.`}
            badgeLabel="supabase"
          />
        ) : (
          <div className="h-80 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={equitySeries} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
                <CartesianGrid stroke="hsl(var(--border) / 0.35)" strokeDasharray="2 4" vertical={false} />
                <XAxis
                  dataKey="date"
                  tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }}
                  stroke="hsl(var(--border))"
                  minTickGap={48}
                  tickLine={false}
                />
                <YAxis
                  tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }}
                  stroke="hsl(var(--border))"
                  width={56}
                  tickFormatter={(v: number) => v.toFixed(0)}
                  domain={["auto", "auto"]}
                  tickLine={false}
                />
                <ReferenceLine y={100} stroke="hsl(var(--muted-foreground) / 0.35)" strokeDasharray="3 3" />
                <Tooltip
                  contentStyle={tooltipStyle}
                  labelFormatter={(d) => `Date ${String(d)}`}
                  formatter={(value: number | string, name: string | number) => {
                    const v = Number(value);
                    const label = String(name);
                    return [`${v.toFixed(2)} (${v >= 100 ? "+" : ""}${(v - 100).toFixed(2)}%)`, label];
                  }}
                />
                {showBench && (
                  <Line
                    type="monotone"
                    dataKey="bench"
                    name="STX40.JO"
                    stroke="hsl(var(--muted-foreground))"
                    strokeWidth={1.4}
                    strokeDasharray="5 4"
                    dot={false}
                    connectNulls
                    isAnimationActive={false}
                  />
                )}
                <Line
                  type="monotone"
                  dataKey="paper"
                  name="Paper account"
                  stroke="hsl(var(--primary))"
                  strokeWidth={2.6}
                  dot={false}
                  isAnimationActive={false}
                />
                <Legend
                  verticalAlign="top"
                  height={24}
                  iconType="line"
                  wrapperStyle={{ fontSize: 11, color: "hsl(var(--muted-foreground))" }}
                  formatter={(value: string) =>
                    value === "Paper account" ? (
                      <span style={{ color: "hsl(var(--primary))", fontWeight: 600 }}>Paper account (us)</span>
                    ) : (
                      <span style={{ color: "hsl(var(--muted-foreground))" }}>STX40.JO benchmark</span>
                    )
                  }
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}
        <p className="mt-2 text-[10.5px] text-muted-foreground">
          {benchAvailable
            ? `Benchmark: ${(benchmark as BenchPayload).name} (${(benchmark as BenchPayload).source}). Rebased to 100 on window start so relative perf is comparable regardless of scale.`
            : "STX40.JO is the JSE Top 40 ETF the model was originally benchmarked to."}
        </p>
      </GlassSection>

      <div className="grid gap-4 lg:grid-cols-2">
        {/* ── daily P&L bars ─────────────────────────────────────────────── */}
        <GlassSection
          title="Daily P&L"
          subtitle="per-bar sign from `model_equity_point_c.day_pnl`"
          endpoint="GET /api/models/[id]/benchmark"
          dataSource="supabase"
          db="institutional"
        >
          {dailyPnl.every((p) => p.pnl == null) ? (
            <EmptyDataState
              title="No daily P&L recorded"
              message="The pusher doesn't write day_pnl on this run. The model still has an equity curve above."
              badgeLabel="supabase"
            />
          ) : (
            <div className="h-56 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={dailyPnl} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                  <CartesianGrid stroke="hsl(var(--border) / 0.35)" strokeDasharray="2 4" vertical={false} />
                  <XAxis dataKey="date" tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} stroke="hsl(var(--border))" minTickGap={48} tickLine={false} />
                  <YAxis
                    tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }}
                    stroke="hsl(var(--border))"
                    width={56}
                    tickFormatter={(v: number) => `${Math.round(v / 1000)}k`}
                    tickLine={false}
                  />
                  <Tooltip
                    contentStyle={tooltipStyle}
                    formatter={(value: number | string) => {
                      const v = Number(value);
                      return [`${v >= 0 ? "+" : "−"}${ccy}${Math.abs(Math.round(v)).toLocaleString("en-ZA")}`, "P&L"];
                    }}
                  />
                  <ReferenceLine y={0} stroke="hsl(var(--muted-foreground) / 0.4)" />
                  <Bar dataKey="pnl" isAnimationActive={false}>
                    {dailyPnl.map((d, i) => (
                      <Cell
                        key={i}
                        fill={(d.pnl ?? 0) >= 0 ? "hsl(var(--success, 142 71% 45%))" : "hsl(var(--destructive, 0 84% 60%))"}
                      />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </GlassSection>

        {/* ── drawdown area ──────────────────────────────────────────────── */}
        <GlassSection
          title="Drawdown"
          subtitle="peak-to-trough on the paper equity curve"
          endpoint="GET /api/models/[id]/benchmark"
          dataSource="supabase"
          db="institutional"
        >
          {drawdownSeries.length < 2 ? (
            <EmptyDataState title="Need at least 2 days" message="—" badgeLabel="supabase" />
          ) : (
            <div className="h-56 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={drawdownSeries} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                  <defs>
                    <linearGradient id="ddfill" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="hsl(var(--destructive, 0 84% 60%))" stopOpacity={0.45} />
                      <stop offset="100%" stopColor="hsl(var(--destructive, 0 84% 60%))" stopOpacity={0.02} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid stroke="hsl(var(--border) / 0.35)" strokeDasharray="2 4" vertical={false} />
                  <XAxis dataKey="date" tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} stroke="hsl(var(--border))" minTickGap={48} tickLine={false} />
                  <YAxis
                    tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }}
                    stroke="hsl(var(--border))"
                    width={56}
                    tickFormatter={(v: number) => `${v.toFixed(1)}%`}
                    tickLine={false}
                  />
                  <Tooltip
                    contentStyle={tooltipStyle}
                    formatter={(v: number | string) => [`${Number(v).toFixed(2)}%`, "Drawdown"]}
                  />
                  <Area type="monotone" dataKey="drawdown" stroke="hsl(var(--destructive, 0 84% 60%))" strokeWidth={1.5} fill="url(#ddfill)" isAnimationActive={false} />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          )}
        </GlassSection>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        {/* ── allocation donut ───────────────────────────────────────────── */}
        <GlassSection
          title="Allocation"
          subtitle={allocation.items.length ? `${allocation.items.length} holdings · weights by market value` : "no open holdings"}
          endpoint="GET /api/models/[id]/benchmark"
          dataSource="supabase"
          db="institutional"
        >
          {allocation.items.length === 0 ? (
            <EmptyDataState title="No open holdings" message="The model has no current positions to allocate." badgeLabel="supabase" />
          ) : (
            <div className="flex items-center gap-3">
              <div className="relative h-44 w-44 shrink-0">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Tooltip
                      contentStyle={tooltipStyle}
                      formatter={(v: number | string, _n, item) => {
                        const total = allocation.totalMv || 1;
                        const pct = (Number(v) / total) * 100;
                        return [`${ccy}${Math.round(Number(v)).toLocaleString("en-ZA")} (${pct.toFixed(1)}%)`, (item as { name?: string })?.name ?? ""];
                      }}
                    />
                    <Pie data={allocation.items} dataKey="mv" nameKey="symbol" innerRadius={48} outerRadius={78} stroke="hsl(var(--background))" strokeWidth={2} isAnimationActive={false}>
                      {allocation.items.map((entry, i) => (
                        <Cell key={i} fill={entry.color} />
                      ))}
                    </Pie>
                  </PieChart>
                </ResponsiveContainer>
                <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
                  <span className="text-[9.5px] uppercase tracking-wide text-muted-foreground">MV</span>
                  <span className="mt-0.5 font-mono text-sm font-semibold tabular-nums text-foreground">
                    {money(allocation.totalMv, ccy)}
                  </span>
                </div>
              </div>
              <ul className="min-w-0 flex-1 space-y-1 text-[11px]">
                {allocation.items.slice(0, 7).map((x) => (
                  <li key={x.symbol} className="flex items-center justify-between gap-2">
                    <span className="flex min-w-0 items-center gap-1.5">
                      <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: x.color }} />
                      <span className="truncate font-medium">{x.symbol}</span>
                    </span>
                    <span className="font-mono tabular-nums text-muted-foreground">
                      {x.weight != null ? `${(x.weight * 100).toFixed(1)}%` : "—"}
                    </span>
                  </li>
                ))}
                {allocation.items.length > 7 && (
                  <li className="text-[10px] text-muted-foreground">+{allocation.items.length - 7} more</li>
                )}
              </ul>
            </div>
          )}
        </GlassSection>

        {/* ── attribution table ──────────────────────────────────────────── */}
        <GlassSection
          title="P&L Attribution"
          subtitle="per-holding unrealised P&L and contribution to total"
          endpoint="GET /api/models/[id]/benchmark"
          dataSource="supabase"
          db="institutional"
          className="lg:col-span-2"
        >
          {attribution.length === 0 ? (
            <EmptyDataState title="No holdings to attribute" message="—" badgeLabel="supabase" />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[420px] text-left text-[12.5px]">
                <thead>
                  <tr className="border-b border-border/60 text-[10px] uppercase tracking-wide text-muted-foreground">
                    <th className="px-2 py-2 font-medium">Symbol</th>
                    <th className="px-2 py-2 font-medium">Side</th>
                    <th className="px-2 py-2 text-right font-medium">Mkt Value</th>
                    <th className="px-2 py-2 text-right font-medium">Unrealised</th>
                    <th className="px-2 py-2 text-right font-medium">% on Cost</th>
                    <th className="px-2 py-2 text-right font-medium">% of Total P&L</th>
                  </tr>
                </thead>
                <tbody>
                  {attribution.map((x) => (
                    <tr key={x.symbol} className="border-b border-border/30 last:border-0 hover:bg-muted/20">
                      <td className="px-2 py-1.5 align-top font-medium">
                        <span className="mr-1.5 inline-block h-2 w-2 rounded-full align-middle" style={{ background: x.color }} />
                        {x.symbol}
                      </td>
                      <td className={cn("px-2 py-1.5 align-top font-mono text-xs", x.side === "short" || x.side === "sell" ? "text-down" : "text-up")}>
                        {x.side.toUpperCase()}
                      </td>
                      <td className="px-2 py-1.5 text-right align-top font-mono tabular-nums">{money(x.mv, ccy)}</td>
                      <td className={cn("px-2 py-1.5 text-right align-top font-mono tabular-nums", x.pl >= 0 ? "text-up" : "text-down")}>
                        {x.pl >= 0 ? "+" : "−"}
                        {ccy}
                        {Math.abs(Math.round(x.pl)).toLocaleString("en-ZA")}
                      </td>
                      <td className={cn("px-2 py-1.5 text-right align-top font-mono tabular-nums", (x.plpc ?? 0) >= 0 ? "text-up" : "text-down")}>
                        {x.plpc == null ? "—" : `${(x.plpc * 100).toFixed(2)}%`}
                      </td>
                      <td className="px-2 py-1.5 text-right align-top font-mono tabular-nums">
                        {x.contributionPct == null ? "—" : `${(x.contributionPct * 100).toFixed(1)}%`}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </GlassSection>
      </div>

      {/* ── capture pair ────────────────────────────────────────────────── */}
      <div className="grid gap-3 sm:grid-cols-2">
        <CaptureCard
          title="Up Capture"
          value={summary?.upCapture}
          note="Paper vs STX40 on up-benchmark days"
          ccy={ccy}
        />
        <CaptureCard
          title="Down Capture"
          value={summary?.downCapture}
          note="Paper vs STX40 on down-benchmark days (lower is better)"
          ccy={ccy}
        />
      </div>
    </div>
  );
}

function RangeChips({ value, onChange }: { value: RangeKey; onChange: (k: RangeKey) => void }) {
  return (
    <div className="glass-inset inline-flex p-1">
      {RANGES.map((r) => (
        <button
          key={r.key}
          type="button"
          onClick={() => onChange(r.key)}
          className={cn(
            "rounded-lg px-2.5 py-1 text-[10.5px] font-medium tabular-nums transition-all duration-150",
            value === r.key ? "bg-primary text-primary-foreground shadow-[0_2px_8px_hsl(var(--primary)/0.3)]" : "text-muted-foreground hover:text-foreground",
          )}
        >
          {r.label}
        </button>
      ))}
    </div>
  );
}

function CaptureCard({ title, value, note, ccy: _ccy }: { title: string; value: number | null | undefined; note: string; ccy: string }) {
  const Icon = value != null && value < 1 ? TrendingDown : TrendingUp;
  const v = value == null ? "—" : `${(value * 100).toFixed(0)}%`;
  const accent =
    value == null
      ? "text-muted-foreground"
      : title === "Up Capture"
        ? value >= 1 ? "text-up" : "text-down"
        : value <= 1 ? "text-up" : "text-down";
  return (
    <div className="glass-kpi group">
      <p className="text-caption flex items-center gap-1.5">
        <Icon className="h-3 w-3" />
        {title}
      </p>
      <p className={cn("text-metric mt-1.5", accent)}>{v}</p>
      <p className="mt-1 text-[10.5px] text-muted-foreground">{note}</p>
    </div>
  );
}