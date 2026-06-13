"use client";

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Area, AreaChart, Bar, BarChart, CartesianGrid, Line, LineChart, ResponsiveContainer,
  Tooltip, XAxis, YAxis, Cell, ReferenceLine,
} from "recharts";
import {
  Layers, Activity, Lock, AlertTriangle, Banknote, TrendingUp, Globe2,
  Newspaper, ArrowUpRight, ArrowDownRight,
} from "lucide-react";

import { Panel } from "@/components/oems/primitives/panel";
import { KpiTile } from "@/components/oems/primitives/kpi-tile";
import { NumberCell } from "@/components/oems/primitives/number-cell";
import { DataSourceBadge } from "@/components/oems/primitives/data-source-badge";
import { Pill } from "@/components/oems/primitives/pill";
import { Sparkline } from "@/components/oems/primitives/sparkline";
import { SectorHeatmap } from "@/components/oems/primitives/sector-heatmap";
import { PanelSkeleton, KpiTileSkeleton, PanelErrorShell } from "@/components/oems/primitives/panel-skeleton";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useIress } from "@/lib/iress/provider";
import { formatPct, formatTime, formatZAR, formatBps, formatPctAbs } from "@/lib/format";
import { cn } from "@/lib/cn";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { queryOpts } from "@/lib/store/query-provider";
import { useLiveQuotes } from "@/lib/hooks/use-live-quotes";
import { useAuditOrders } from "@/lib/hooks/use-audit-orders";
import { useWorkerHealth } from "@/lib/hooks/use-worker-health";
import { usePortfolio } from "@/lib/hooks/use-portfolio";
import { isRealDataOnlyClient, FEED_NOT_CONFIGURED } from "@/lib/data-policy";
import { EmptyDataState } from "@/components/oems/primitives/empty-data-state";

/**
 * SSR-safe intraday x-axis labels.
 *
 * `Date.now()` at render time is the classic SSR/CSR hydration landmine: the
 * server renders e.g. "08:42" and the client re-renders "08:45" three seconds
 * later, flashing. Instead, the timestamps are pre-computed once at module
 * scope from a deterministic seed (a synthetic JSE trading day starting at
 * 09:00 SAST on 2026-06-06, one minute apart). Both server and client see the
 * exact same strings — no hydration mismatch, no console warning.
 *
 * Trade-off: the labels don't reflect the actual current time, but for a
 * mock trading desk a synthetic day is even desirable (the demo doesn't
 * decay the chart as the clock moves). When this becomes a real-time feed
 * we'll move the chart into a <ClientOnly> wrapper and use wall-clock time.
 */
const INTRADAY_TS: readonly number[] = (() => {
  // 2026-06-06 was a Saturday in real life, but for a mock we don't care.
  // 09:00 SAST is the JSE cash-equity open.
  const open = new Date(2026, 5, 6, 9, 0, 0).getTime();
  return Array.from({ length: 78 }, (_, i) => open + (i - 77) * 60_000);
})();

const INTRADAY_LABELS: readonly string[] = INTRADAY_TS.map((ts) =>
  new Date(ts).toLocaleTimeString("en-ZA", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "Africa/Johannesburg",
  }),
);

interface CockpitClientProps {
  /** Pre-formatted masthead date string computed on the server. */
  mastheadDate: string;
}

/**
 * Symbols the Cockpit polls once per quote interval. The mover set sits on
 * the existing JSE Top-40; the FX / money-market entries (USDZAR, JIBAR_3M)
 * ride the same `/api/quotes` call so the KPI tiles update without
 * triggering a second BFF request.
 */
const MOVER_SYMBOLS = ["NPN", "PRX", "FSR", "SBK", "AGL", "MTN", "SOL", "USDZAR", "JIBAR_3M"];

export function CockpitClient({ mastheadDate }: CockpitClientProps) {
  const { data } = useIress();
  const realDataOnly = isRealDataOnlyClient();
  const [range, setRange] = useState<"1D" | "5D" | "1M" | "3M">("1D");
  const liveQuotes = useLiveQuotes(MOVER_SYMBOLS);

  const strategiesQ = useQuery({ queryKey: ["strategies"], queryFn: () => data.strategies(), enabled: !realDataOnly, ...queryOpts("live") });
  const indicesQ = useQuery({ queryKey: ["indices"], queryFn: () => data.indices(), enabled: !realDataOnly, ...queryOpts("reference") });
  const sectorsQ = useQuery({ queryKey: ["sectors"], queryFn: () => data.sectors(), enabled: !realDataOnly, ...queryOpts("reference") });
  const curveQ = useQuery({ queryKey: ["zar-govi"], queryFn: () => data.zarGoviCurve(), enabled: !realDataOnly, ...queryOpts("reference") });
  const jibarQ = useQuery({ queryKey: ["jibar"], queryFn: () => data.jibarFixings(), enabled: !realDataOnly, ...queryOpts("reference") });
  const macroQ = useQuery({ queryKey: ["macro"], queryFn: () => data.macroIndicators(), enabled: !realDataOnly, ...queryOpts("reference") });
  const seedOrdersQ = useQuery({ queryKey: ["orders"], queryFn: () => data.orders(), enabled: !realDataOnly, ...queryOpts("live") });
  const auditOrdersQ = useAuditOrders("ALL", realDataOnly);
  const workerQ = useWorkerHealth(realDataOnly);
  const portfolioQ = usePortfolio(realDataOnly);
  const primaryWorker = workerQ.data?.workers[0];
  const moversQ = useQuery({ queryKey: ["movers"], queryFn: () => data.jseEquities(), ...queryOpts("reference") });
  const newsQ = useQuery({ queryKey: ["news"], queryFn: () => data.news(), enabled: !realDataOnly, ...queryOpts("reference") });
  const sensQ = useQuery({ queryKey: ["sens"], queryFn: () => data.sens(), enabled: !realDataOnly, ...queryOpts("reference") });

  // Tier 2 BFFs — DB-first when realDataOnly. Falls back to seed in
  // mock/dev (realDataOnly=false). The BFF returns `source` so the panel
  // can show a precise "TimeSeriesGet2 entitlement required" message when
  // the table is empty.
  const sectorsBffQ = useQuery({
    queryKey: ["bff-sectors"],
    queryFn: () =>
      fetchJson<{
        sectors: Array<{
          code: string;
          name: string;
          changePct: number;
          last: number;
          asOf?: string;
          sector: string;
          weight: number;
          change: number;
        }>;
        source: string;
        message?: string;
      }>("/api/sectors"),
    enabled: realDataOnly,
    refetchInterval: 30_000,
  });
  const curveBffQ = useQuery({
    queryKey: ["bff-curve-zar-nss"],
    queryFn: () => fetchJson<{ code: string; points: Array<{ tenor: string; years: number; yield: number; asOf: string }>; source: string; message?: string }>("/api/curves/ZAR_NSS"),
    enabled: realDataOnly,
    refetchInterval: 60_000,
  });
  const alsiBffQ = useQuery({
    queryKey: ["bff-index-J203"],
    queryFn: () => fetchJson<{ code: string; points: Array<{ t: number; v: number }>; source: string; message?: string }>("/api/indices/J203"),
    enabled: realDataOnly,
    refetchInterval: 30_000,
  });

  const strategies = strategiesQ.data ?? [];
  const indices = indicesQ.data ?? [];
  const sectors = sectorsQ.data ?? [];
  const curve = curveQ.data ?? [];
  const jibar = jibarQ.data ?? [];
  const macro = macroQ.data ?? [];
  const orders = realDataOnly ? (auditOrdersQ.data?.orders ?? []) : (seedOrdersQ.data ?? []);
  const ordersLoading = realDataOnly ? auditOrdersQ.isLoading : seedOrdersQ.isLoading;
  const movers = moversQ.data ?? [];
  const news = newsQ.data ?? [];
  const sens = sensQ.data ?? [];

  const totalAum = strategies.reduce((s, x) => s + x.aum, 0);
  const livePnl = strategies.reduce((s, x) => s + x.dayPnl, 0);
  const liveStrats = strategies.filter((s) => s.status === "live").length;
  const blocked = strategies.filter((s) => s.investorCount === 0 || s.status === "halted").length;
  const openOrders = orders.filter((o) => o.state === "WORKING" || o.state === "PARTIAL");
  const rejected = orders.filter((o) => o.state === "REJECTED").length;

  const intraday = useMemo(() => {
    const base = indices.find((i) => i.code === "J203")?.last ?? 87412;
    return INTRADAY_LABELS.map((label, i) => {
      const drift = (i / 78) * 380;
      const noise = Math.sin(i / 5) * 90 + Math.cos(i / 11) * 60;
      return { t: label, v: +(base + drift + noise).toFixed(2) };
    });
  }, [indices]);

  const alsi = indices.find((i) => i.code === "J203");
  const pca = [
    { factor: "Level (parallel)", bp: 12 },
    { factor: "Slope (2s10s)", bp: -8 },
    { factor: "Curvature (butterfly)", bp: 3 },
    { factor: "Residual", bp: 1 },
  ];

  return (
    <div className="space-y-3">
      {/* Page header */}
      <header className="flex flex-wrap items-end justify-between gap-3 pb-1">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">Cockpit</h1>
          <p className="text-xs text-muted-foreground">
            Institutional trading desk · JSE + ZAR + SARB · {mastheadDate}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <DataSourceBadge source={liveQuotes.dataSource} />
          <Tabs value={range} onValueChange={(v) => setRange(v as typeof range)}>
            <TabsList className="h-7 bg-muted">
              <TabsTrigger value="1D" className="h-5 px-2 text-[10.5px]">1D</TabsTrigger>
              <TabsTrigger value="5D" className="h-5 px-2 text-[10.5px]">5D</TabsTrigger>
              <TabsTrigger value="1M" className="h-5 px-2 text-[10.5px]">1M</TabsTrigger>
              <TabsTrigger value="3M" className="h-5 px-2 text-[10.5px]">3M</TabsTrigger>
            </TabsList>
          </Tabs>
        </div>
      </header>

      {/* KPI strip */}
      <div className="grid grid-cols-2 gap-2.5 md:grid-cols-3 lg:grid-cols-6">
        {strategiesQ.isLoading || jibarQ.isLoading ? (
          [0, 1, 2, 3, 4, 5].map((n) => <KpiTileSkeleton key={`cockpit-kpi-${n}`} />)
        ) : realDataOnly ? (
          <>
            <KpiTile
              icon={<Layers className="h-3.5 w-3.5" />}
              label="Platform AUM"
              value={portfolioQ.data?.source === "supabase" ? formatZAR(portfolioQ.data.aum) : "—"}
              sub={
                portfolioQ.data?.source === "supabase"
                  ? `${portfolioQ.data.accounts.length} accounts · IPS`
                  : FEED_NOT_CONFIGURED
              }
            />
            <KpiTile
              icon={<Activity className="h-3.5 w-3.5" />}
              label="Day P&L"
              value={portfolioQ.data?.source === "supabase" ? formatZAR(portfolioQ.data.dayPnl) : "—"}
              sub={
                portfolioQ.data?.source === "supabase"
                  ? portfolioQ.data.positions.length > 0
                    ? `MTM on ${portfolioQ.data.positions.length} positions`
                    : `MTM via IPS`
                  : FEED_NOT_CONFIGURED
              }
              tone={
                portfolioQ.data?.source === "supabase"
                  ? portfolioQ.data.dayPnl >= 0
                    ? "positive"
                    : "negative"
                  : "default"
              }
            />
            <KpiTile
              icon={<Lock className="h-3.5 w-3.5" />}
              label="Rebalance Locked"
              value={portfolioQ.data?.source === "supabase" ? (portfolioQ.data.rebalanceLocked ? "Yes" : "No") : "—"}
              sub={
                portfolioQ.data?.source === "supabase"
                  ? `max drift ${portfolioQ.data.rebalanceDrift.toFixed(2)}%`
                  : FEED_NOT_CONFIGURED
              }
              tone={
                portfolioQ.data?.source === "supabase"
                  ? portfolioQ.data.rebalanceLocked
                    ? "warning"
                    : "positive"
                  : "default"
              }
            />
            <KpiTile
              icon={<AlertTriangle className="h-3.5 w-3.5" />}
              label="Open Orders"
              value={openOrders.length.toString()}
              sub={`${rejected} rejected · audit`}
              tone={openOrders.length > 0 ? "warning" : "default"}
            />
            {/*
              JIBAR 3M + USD/ZAR wire through the worker → stock_intraday_c
              path when the watchlist contains `JIBAR_3M` (exchange MM) and
              `USDZAR` (exchange FX). The BFF serves the most recent intraday
              tick for both. NumberCell renders "—" if no live tick is in
              the stream yet; the sub-line is the honest diagnostic.
            */}
            <KpiTile
              icon={<Banknote className="h-3.5 w-3.5" />}
              label="JIBAR 3M"
              live={{ sym: "JIBAR_3M", fallback: 0, decimals: 3, suffix: "%" }}
              value=""
              sub={
                <span>
                  IRESS <span className="font-mono">MM · JIBAR_3M</span>
                </span>
              }
            />
            <KpiTile
              icon={<TrendingUp className="h-3.5 w-3.5" />}
              label="USD/ZAR"
              live={{ sym: "USDZAR", fallback: 0, decimals: 4, showChange: true }}
              value=""
              sub={
                <span>
                  IRESS <span className="font-mono">FX · USDZAR</span>
                </span>
              }
            />
          </>
        ) : (
          <>
            <KpiTile
              icon={<Layers className="h-3.5 w-3.5" />}
              label="Platform AUM"
              value={formatZAR(totalAum)}
              sub={`${strategies.length} strategies · ${liveStrats} live`}
            />
            <KpiTile
              icon={<Activity className="h-3.5 w-3.5" />}
              label="Day P&L"
              value={formatZAR(livePnl)}
              sub={formatPct((livePnl / (totalAum || 1)) * 100, 3)}
              tone={livePnl >= 0 ? "positive" : "negative"}
            />
            <KpiTile
              icon={<Lock className="h-3.5 w-3.5" />}
              label="Rebalance Locked"
              value={blocked.toString()}
              sub="no investors / halted"
              tone={blocked > 0 ? "warning" : "default"}
            />
            <KpiTile
              icon={<AlertTriangle className="h-3.5 w-3.5" />}
              label="Open Orders"
              value={openOrders.length.toString()}
              sub={`${rejected} rejected`}
              tone={openOrders.length > 0 ? "warning" : "default"}
            />
            <KpiTile
              icon={<Banknote className="h-3.5 w-3.5" />}
              label="JIBAR 3M"
              live={{ sym: "JIBAR_3M", fallback: 8.11, decimals: 3, suffix: "%" }}
              value={`${jibar[2]?.rate.toFixed(2) ?? "—"}%`}
              sub={
                jibar[2] ? (
                  <span>Δ {jibar[2].change >= 0 ? "+" : ""}{(jibar[2].change * 100).toFixed(0)}bp</span>
                ) : <span>—</span>
              }
            />
            <KpiTile
              icon={<TrendingUp className="h-3.5 w-3.5" />}
              label="USD/ZAR"
              live={{ sym: "USDZAR", fallback: 18.452, decimals: 4, showChange: false }}
              value=""
              sub={<span className="flex items-center gap-1"><NumberCell sym="USDZAR" fallback={18.452} decimals={4} size="xs" showChange /></span>}
            />
          </>
        )}
      </div>

      {/* Row 1: heatmap | govi | movers */}
      <div className="grid grid-cols-12 gap-2.5">
        {realDataOnly ? (
          sectorsBffQ.isLoading ? (
            <PanelSkeleton rows={6} height="h-[300px]" className="col-span-12 lg:col-span-5" />
          ) : sectorsBffQ.isError || (sectorsBffQ.data?.source === "entitlement-required") ? (
            <Panel
              title="Sector Heatmap"
              endpoint="GET /api/sectors"
              dataSource={sectorsBffQ.data?.source === "entitlement-required" ? "unconfigured" : "unavailable"}
              className="col-span-12 lg:col-span-5 h-[300px]"
            >
              <EmptyDataState
                title={sectorsBffQ.data?.source === "entitlement-required" ? "TimeSeriesGet2 entitlement required" : "Sector data unavailable"}
                message={
                  sectorsBffQ.data?.message ??
                  "Sector index quotes require TimeSeriesGet2 entitlement (J200 / sector codes). Ask Charles to enable on the production account."
                }
              />
            </Panel>
          ) : sectorsBffQ.data && sectorsBffQ.data.sectors.length > 0 ? (
            <SectorHeatmap
              data={sectorsBffQ.data.sectors.map((s) => ({
                sector: s.sector,
                weight: s.weight,
                change: s.change,
              }))}
              dataSource="supabase"
              className="col-span-12 lg:col-span-5 h-[300px]"
            />
          ) : (
            <Panel
              title="Sector Heatmap"
              endpoint="GET /api/sectors"
              dataSource="unconfigured"
              className="col-span-12 lg:col-span-5 h-[300px]"
            >
              <EmptyDataState message="Sector index data not yet populated — worker has not synced a J200 series." />
            </Panel>
          )
        ) : sectorsQ.isLoading ? (
          <PanelSkeleton rows={6} height="h-[300px]" className="col-span-12 lg:col-span-5" />
        ) : sectorsQ.isError ? (
          <PanelErrorShell title="Sector Heatmap" className="col-span-12 lg:col-span-5 h-[300px]" />
        ) : (
          <SectorHeatmap
            data={sectors}
            dataSource="seed"
            className="col-span-12 lg:col-span-5 h-[300px]"
          />
        )}

        {realDataOnly ? (
          curveBffQ.isLoading ? (
            <PanelSkeleton rows={4} height="h-[300px]" className="col-span-12 lg:col-span-4" />
          ) : curveBffQ.isError || (curveBffQ.data?.source === "entitlement-required") ? (
            <Panel
              title="ZAR Sovereign Curve · NSS"
              endpoint="GET /api/curves/ZAR_NSS"
              dataSource={curveBffQ.data?.source === "entitlement-required" ? "unconfigured" : "unavailable"}
              className="col-span-12 lg:col-span-4 h-[300px]"
            >
              <EmptyDataState
                title={curveBffQ.data?.source === "entitlement-required" ? "TimeSeriesGet2 entitlement required" : "Curve data unavailable"}
                message={
                  curveBffQ.data?.message ??
                  "Yield curve feed requires TimeSeriesGet2 entitlement. Ask Charles to enable on the production account."
                }
              />
            </Panel>
          ) : curveBffQ.data && curveBffQ.data.points.length > 0 ? (
            <Panel
              title="ZAR Sovereign Curve · NSS"
              endpoint="GET /api/curves/ZAR_NSS"
              dataSource="supabase"
              className="col-span-12 lg:col-span-4 h-[300px]"
              right={
                <span className="font-mono">
                  10Y ·{" "}
                  {curveBffQ.data.points.find((p) => Math.round(p.years) === 10)?.yield.toFixed(2) ?? "—"}%
                </span>
              }
            >
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={curveBffQ.data.points} margin={{ top: 8, right: 12, left: -8, bottom: 0 }}>
                  <defs>
                    <linearGradient id="goviGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="hsl(263 80% 65%)" stopOpacity={0.4} />
                      <stop offset="100%" stopColor="hsl(263 80% 65%)" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid stroke="hsl(var(--border))" strokeDasharray="2 4" vertical={false} />
                  <XAxis dataKey="tenor" tick={{ fontSize: 9, fill: "hsl(var(--muted-foreground))" }} stroke="hsl(var(--border))" />
                  <YAxis tick={{ fontSize: 9, fill: "hsl(var(--muted-foreground))" }} stroke="hsl(var(--border))" domain={["dataMin - 0.3", "dataMax + 0.3"]} tickFormatter={(v) => `${v}%`} />
                  <Tooltip
                    contentStyle={{ fontSize: 11, background: "hsl(var(--popover))", border: "1px solid hsl(var(--border))", borderRadius: 6 }}
                    formatter={(v: number) => [`${v.toFixed(2)}%`, "Yield"]}
                    labelStyle={{ color: "hsl(var(--muted-foreground))" }}
                  />
                  <Line type="monotone" dataKey="yield" stroke="hsl(38 95% 56%)" strokeWidth={2} dot={{ r: 2, fill: "hsl(38 95% 56%)" }} />
                </LineChart>
              </ResponsiveContainer>
            </Panel>
          ) : (
            <Panel
              title="ZAR Sovereign Curve · NSS"
              endpoint="GET /api/curves/ZAR_NSS"
              dataSource="unconfigured"
              className="col-span-12 lg:col-span-4 h-[300px]"
            >
              <EmptyDataState message="Yield curve feed not yet populated — worker has not synced a NSS series." />
            </Panel>
          )
        ) : curveQ.isLoading ? (
          <PanelSkeleton rows={4} height="h-[300px]" className="col-span-12 lg:col-span-4" />
        ) : (
          <Panel
            title="ZAR Sovereign Curve · NSS"
            endpoint="GET /v1/yieldcurve/zar?model=nss"
            className="col-span-12 lg:col-span-4 h-[300px]"
            right={
              <span className="font-mono">
                10Y · <NumberCell sym="R2035" fallback={11.42} decimals={3} />%
              </span>
            }
          >
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={curve} margin={{ top: 8, right: 12, left: -8, bottom: 0 }}>
                <defs>
                  <linearGradient id="goviGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="hsl(263 80% 65%)" stopOpacity={0.4} />
                    <stop offset="100%" stopColor="hsl(263 80% 65%)" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid stroke="hsl(var(--border))" strokeDasharray="2 4" vertical={false} />
                <XAxis dataKey="tenor" tick={{ fontSize: 9, fill: "hsl(var(--muted-foreground))" }} stroke="hsl(var(--border))" />
                <YAxis tick={{ fontSize: 9, fill: "hsl(var(--muted-foreground))" }} stroke="hsl(var(--border))" domain={["dataMin - 0.3", "dataMax + 0.3"]} tickFormatter={(v) => `${v}%`} />
                <Tooltip
                  contentStyle={{ fontSize: 11, background: "hsl(var(--popover))", border: "1px solid hsl(var(--border))", borderRadius: 6 }}
                  formatter={(v: number) => [`${v.toFixed(2)}%`, "Yield"]}
                  labelStyle={{ color: "hsl(var(--muted-foreground))" }}
                />
                <Line type="monotone" dataKey="yield" stroke="hsl(38 95% 56%)" strokeWidth={2} dot={{ r: 2, fill: "hsl(38 95% 56%)" }} />
              </LineChart>
            </ResponsiveContainer>
          </Panel>
        )}

        {moversQ.isLoading ? (
          <PanelSkeleton rows={7} height="h-[300px]" className="col-span-12 lg:col-span-3" />
        ) : (
          <Panel
            title="Top Movers · JSE"
            endpoint="PricingQuoteGet"
            dataSource={liveQuotes.dataSource}
            className="col-span-12 lg:col-span-3 h-[300px]"
            density="scroll"
            right={
              <Link href="/oems/equities" className="text-[10px] text-primary hover:underline">
                All →
              </Link>
            }
          >
            <ul className="divide-y divide-border/70">
              {movers.slice(0, 7).map((m) => (
                <li key={m.symbol} className="flex items-center gap-2 px-3 py-1.5 transition-colors hover:bg-muted/30">
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-mono text-xs font-semibold">{m.symbol}</p>
                    <p className="truncate text-[9.5px] text-muted-foreground">{m.name}</p>
                  </div>
                  <Sparkline sym={m.symbol} fallback={0} width={48} height={20} points={24} />
                  <NumberCell sym={m.symbol} fallback={0} decimals={2} size="xs" />
                  <NumberCell sym={m.symbol} fallback={0} decimals={2} size="xs" showChange className="ml-1" />
                </li>
              ))}
            </ul>
          </Panel>
        )}
      </div>

      {/* Row 2: ALSI intraday | SENS feed */}
      <div className="grid grid-cols-12 gap-2.5">
        {realDataOnly ? (
          alsiBffQ.isLoading ? (
            <PanelSkeleton rows={5} height="h-[320px]" className="col-span-12 lg:col-span-8" />
          ) : alsiBffQ.isError || (alsiBffQ.data?.source === "entitlement-required") ? (
            <Panel
              title="JSE All Share · Intraday"
              endpoint="GET /api/indices/J203"
              dataSource={alsiBffQ.data?.source === "entitlement-required" ? "unconfigured" : "unavailable"}
              className="col-span-12 lg:col-span-8 h-[320px]"
            >
              <EmptyDataState
                title={alsiBffQ.data?.source === "entitlement-required" ? "TimeSeriesGet2 entitlement required" : "ALSI data unavailable"}
                message={
                  alsiBffQ.data?.message ??
                  "ALSI intraday requires TimeSeriesGet2 entitlement. Ask Charles to enable on the production account."
                }
              />
            </Panel>
          ) : alsiBffQ.data && alsiBffQ.data.points.length > 0 ? (
            <Panel
              title="JSE All Share · Intraday"
              endpoint="GET /api/indices/J203"
              dataSource="supabase"
              className="col-span-12 lg:col-span-8 h-[320px]"
              right={(() => {
                const pts = alsiBffQ.data.points;
                if (pts.length === 0) return null;
                const last = pts[pts.length - 1];
                const first = pts[0];
                if (!last || !first) return null;
                const change = last.v - first.v;
                const changePct = first.v > 0 ? (change / first.v) * 100 : 0;
                return (
                  <div className="font-mono text-right">
                    <span className="text-sm font-semibold">
                      {last.v.toLocaleString("en-ZA", { maximumFractionDigits: 0 })}
                    </span>
                    <span className={cn("ml-2 text-xs", changePct >= 0 ? "text-up" : "text-down")}>
                      {changePct >= 0 ? "+" : ""}{change.toFixed(2)} ({formatPct(changePct)})
                    </span>
                  </div>
                );
              })()}
            >
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={alsiBffQ.data.points} margin={{ top: 8, right: 12, left: -8, bottom: 0 }}>
                  <defs>
                    <linearGradient id="alsiGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="hsl(263 80% 65%)" stopOpacity={0.4} />
                      <stop offset="100%" stopColor="hsl(263 80% 65%)" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid stroke="hsl(var(--border))" strokeDasharray="2 4" vertical={false} />
                  <XAxis
                    dataKey="t"
                    tick={{ fontSize: 9, fill: "hsl(var(--muted-foreground))" }}
                    stroke="hsl(var(--border))"
                    interval={Math.max(1, Math.floor(alsiBffQ.data.points.length / 8))}
                    tickFormatter={(v) => new Date(v).toLocaleTimeString("en-ZA", { hour: "2-digit", minute: "2-digit", timeZone: "Africa/Johannesburg" })}
                  />
                  <YAxis tick={{ fontSize: 9, fill: "hsl(var(--muted-foreground))" }} stroke="hsl(var(--border))" domain={["dataMin - 40", "dataMax + 40"]} />
                  <Tooltip
                    contentStyle={{ fontSize: 11, background: "hsl(var(--popover))", border: "1px solid hsl(var(--border))", borderRadius: 6 }}
                    labelStyle={{ color: "hsl(var(--muted-foreground))" }}
                    labelFormatter={(v) => new Date(v as number).toLocaleTimeString("en-ZA", { hour: "2-digit", minute: "2-digit", timeZone: "Africa/Johannesburg" })}
                  />
                  <ReferenceLine y={alsiBffQ.data.points[0]?.v ?? 0} stroke="hsl(var(--muted-foreground))" strokeDasharray="3 3" label={{ value: "Open", fontSize: 9, fill: "hsl(var(--muted-foreground))", position: "insideTopLeft" }} />
                  <Area type="monotone" dataKey="v" stroke="hsl(263 80% 65%)" strokeWidth={1.8} fill="url(#alsiGrad)" />
                </AreaChart>
              </ResponsiveContainer>
            </Panel>
          ) : (
            <Panel
              title="JSE All Share · Intraday"
              endpoint="GET /api/indices/J203"
              dataSource="unconfigured"
              className="col-span-12 lg:col-span-8 h-[320px]"
            >
              <EmptyDataState message="ALSI intraday not yet populated — worker has not synced a J203 series." />
            </Panel>
          )
        ) : indicesQ.isLoading ? (
          <PanelSkeleton rows={5} height="h-[320px]" className="col-span-12 lg:col-span-8" />
        ) : (
          <Panel
            title="JSE All Share · Intraday"
            endpoint="WS /v1/indices/J203/stream"
            className="col-span-12 lg:col-span-8 h-[320px]"
            right={
              alsi ? (
                <div className="font-mono text-right">
                  <span className="text-sm font-semibold">
                    {alsi.last.toLocaleString("en-ZA", { maximumFractionDigits: 0 })}
                  </span>
                  <span className={cn("ml-2 text-xs", alsi.changePct >= 0 ? "text-up" : "text-down")}>
                    {alsi.changePct >= 0 ? "+" : ""}{alsi.change.toFixed(2)} ({formatPct(alsi.changePct)})
                  </span>
                </div>
              ) : null
            }
          >
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={intraday} margin={{ top: 8, right: 12, left: -8, bottom: 0 }}>
                <defs>
                  <linearGradient id="alsiGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="hsl(263 80% 65%)" stopOpacity={0.4} />
                    <stop offset="100%" stopColor="hsl(263 80% 65%)" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid stroke="hsl(var(--border))" strokeDasharray="2 4" vertical={false} />
                <XAxis dataKey="t" tick={{ fontSize: 9, fill: "hsl(var(--muted-foreground))" }} stroke="hsl(var(--border))" interval={11} />
                <YAxis tick={{ fontSize: 9, fill: "hsl(var(--muted-foreground))" }} stroke="hsl(var(--border))" domain={["dataMin - 40", "dataMax + 40"]} />
                <Tooltip
                  contentStyle={{ fontSize: 11, background: "hsl(var(--popover))", border: "1px solid hsl(var(--border))", borderRadius: 6 }}
                  labelStyle={{ color: "hsl(var(--muted-foreground))" }}
                />
                <ReferenceLine y={intraday[0]?.v ?? 0} stroke="hsl(var(--muted-foreground))" strokeDasharray="3 3" label={{ value: "Prev close", fontSize: 9, fill: "hsl(var(--muted-foreground))", position: "insideTopLeft" }} />
                <Area type="monotone" dataKey="v" stroke="hsl(263 80% 65%)" strokeWidth={1.8} fill="url(#alsiGrad)" />
              </AreaChart>
            </ResponsiveContainer>
          </Panel>
        )}

        {realDataOnly ? (
          <Panel title="SENS · Live" endpoint="External vendor required" className="col-span-12 lg:col-span-4 h-[320px]">
            <EmptyDataState message="SENS feed not configured." />
          </Panel>
        ) : sensQ.isLoading ? (
          <PanelSkeleton rows={5} height="h-[320px]" className="col-span-12 lg:col-span-4" />
        ) : (
          <Panel
            title="SENS · Live"
            endpoint="WS /v1/news/sens/stream"
            className="col-span-12 lg:col-span-4 h-[320px]"
            density="scroll"
            right={
              <Link href="/oems/news" className="text-[10px] text-primary hover:underline">
                News →
              </Link>
            }
          >
            <SensTape items={sens} limit={5} />
          </Panel>
        )}
      </div>

      {/* Row 3: open orders | macro pulse */}
      <div className="grid grid-cols-12 gap-2.5">
        {ordersLoading ? (
          <PanelSkeleton rows={8} height="h-[340px]" className="col-span-12 lg:col-span-8" />
        ) : (
          <Panel
            title={`Open Orders · ${openOrders.length}`}
            endpoint="OrderPadGetByAccount → oems_order_audit"
            dataSource={realDataOnly ? "supabase" : "seed"}
            className="col-span-12 lg:col-span-8 h-[340px]"
            density="scroll"
            right={
              <Link href="/oems/blotter" className="text-[10px] text-primary hover:underline">
                Blotter →
              </Link>
            }
          >
            {openOrders.length === 0 ? (
              <EmptyDataState
                title="No open orders"
                message={
                  realDataOnly
                    ? primaryWorker
                      ? `Worker ${primaryWorker.status} · last quote sync ${
                          primaryWorker.last_quote_sync_at
                            ? formatTime(new Date(primaryWorker.last_quote_sync_at).getTime())
                            : "never"
                        }. Orders mirror when Railway has IRESS_ACCOUNT_CODE and SUPABASE_ALLOW_WRITES=1.`
                      : "No worker heartbeat yet. Set IRESS_ACCOUNT_CODE on Railway iress-ingest and enable writes to populate oems_order_audit."
                    : FEED_NOT_CONFIGURED
                }
              />
            ) : (
            <table className="w-full font-mono text-[11px]">
              <thead className="sticky top-0 z-10 bg-card/95 backdrop-blur">
                <tr className="text-[9.5px] uppercase tracking-wider text-muted-foreground">
                  <th className="px-2.5 py-1.5 text-left">Time</th>
                  <th className="px-2.5 py-1.5 text-left">Strategy</th>
                  <th className="px-2.5 py-1.5 text-left">Side</th>
                  <th className="px-2.5 py-1.5 text-left">Sym</th>
                  <th className="px-2.5 py-1.5 text-right">Qty</th>
                  <th className="px-2.5 py-1.5 text-right">Filled</th>
                  <th className="px-2.5 py-1.5 text-right">Limit</th>
                  <th className="px-2.5 py-1.5 text-right">Last</th>
                  <th className="px-2.5 py-1.5 text-right">VWAP</th>
                  <th className="px-2.5 py-1.5 text-right">Slip</th>
                  <th className="px-2.5 py-1.5 text-left">State</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/60">
                {openOrders.map((o) => (
                  <tr key={o.id} className="hover:bg-muted/30">
                    <td className="px-2.5 py-1.5 text-muted-foreground">{formatTime(o.ts)}</td>
                    <td className="px-2.5 py-1.5">{o.strategy}</td>
                    <td className={cn("px-2.5 py-1.5 font-semibold", o.side === "BUY" ? "text-up" : "text-down")}>{o.side}</td>
                    <td className="px-2.5 py-1.5 font-semibold">{o.symbol}</td>
                    <td className="px-2.5 py-1.5 text-right tabular-nums">{o.qty.toLocaleString()}</td>
                    <td className="px-2.5 py-1.5 text-right tabular-nums">
                      {o.filled.toLocaleString()} <span className="text-muted-foreground/70">({Math.round((o.filled / o.qty) * 100)}%)</span>
                    </td>
                    <td className="px-2.5 py-1.5 text-right tabular-nums">{o.limit?.toFixed(2) ?? "MKT"}</td>
                    <td className="px-2.5 py-1.5 text-right tabular-nums">
                      <NumberCell sym={o.symbol} fallback={o.arrivalMid} decimals={2} />
                    </td>
                    <td className="px-2.5 py-1.5 text-right tabular-nums">{o.vwap.toFixed(2)}</td>
                    <td className={cn("px-2.5 py-1.5 text-right tabular-nums", o.slippageBps >= 0 ? "text-up" : "text-down")}>
                      {o.slippageBps.toFixed(1)}bp
                    </td>
                    <td className="px-2.5 py-1.5">
                      <OrderStatePill state={o.state} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            )}
          </Panel>
        )}

        {realDataOnly ? (
          <Panel title="Macro Pulse" endpoint="External vendor required" className="col-span-12 lg:col-span-4 h-[340px]">
            <EmptyDataState message="Macro data feed not configured." />
          </Panel>
        ) : macroQ.isLoading ? (
          <PanelSkeleton rows={4} height="h-[340px]" className="col-span-12 lg:col-span-4" />
        ) : (
          <Panel
            title="Macro Pulse"
            endpoint="GET /v1/macro/series"
            className="col-span-12 lg:col-span-4 h-[340px]"
            density="scroll"
            right={
              <Link href="/oems/macro" className="text-[10px] text-primary hover:underline">
                Macro →
              </Link>
            }
          >
            <div className="grid grid-cols-2 gap-1.5">
              {macro.map((m) => (
                <div key={m.name} className="rounded-md border border-border/60 bg-surface-2/30 p-2.5">
                  <div className="flex items-center justify-between">
                    <p className="text-[9.5px] uppercase tracking-wider text-muted-foreground">{m.name}</p>
                    {m.trend === "up" ? <ArrowUpRight className="h-3 w-3 text-up" /> :
                      m.trend === "down" ? <ArrowDownRight className="h-3 w-3 text-down" /> :
                      <span className="text-muted-foreground/50">—</span>}
                  </div>
                  <p className="mt-1 font-mono text-sm font-semibold tabular-nums">
                    {m.value}<span className="ml-1 text-[10px] text-muted-foreground">{m.unit}</span>
                  </p>
                  <p className="font-mono text-[10px] text-muted-foreground">prior {m.prior}</p>
                </div>
              ))}
            </div>
          </Panel>
        )}
      </div>

      {/* Row 4: News flash strip + curve move decomposition */}
      <div className="grid grid-cols-12 gap-2.5">
        {realDataOnly ? (
          <Panel title="News Flow · Last 60 min" endpoint="External vendor required" className="col-span-12 lg:col-span-8 h-[260px]">
            <EmptyDataState message="News feed not configured." />
          </Panel>
        ) : newsQ.isLoading ? (
          <PanelSkeleton rows={5} height="h-[260px]" className="col-span-12 lg:col-span-8" />
        ) : (
          <Panel
            title="News Flow · Last 60 min"
            endpoint="WS /v1/news/stream"
            className="col-span-12 lg:col-span-8 h-[260px]"
            density="scroll"
          >
            <ul className="divide-y divide-border/60">
              {news.slice(0, 5).map((n) => (
                <li key={n.id} className="flex items-start gap-3 px-3 py-2.5 hover:bg-muted/30">
                  {n.priority === "high" && <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-destructive" />}
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-medium leading-snug">{n.headline}</p>
                    <div className="mt-1.5 flex flex-wrap items-center gap-1.5 font-mono text-[9.5px] text-muted-foreground">
                      <span>{formatTime(n.ts)}</span>
                      <span className="text-muted-foreground/50">·</span>
                      <Pill tone="neutral" size="xs">{n.source}</Pill>
                      <Pill tone="neutral" size="xs">{n.category}</Pill>
                      {n.tickers.map((t) => (
                        <span key={t} className="rounded bg-primary/10 px-1.5 py-0.5 text-primary">{t}</span>
                      ))}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          </Panel>
        )}

        <Panel
          title="Curve Move · PCA"
          endpoint="INTERNAL · PCA on ZAR curve"
          className="col-span-12 lg:col-span-4 h-[260px]"
          right={<span className="font-mono text-[10px]">today vs 1D</span>}
        >
          {realDataOnly ? (
            <EmptyDataState message="PCA decomposition requires live curve feed." />
          ) : (
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={pca} layout="vertical" margin={{ top: 8, right: 8, left: 8, bottom: 0 }}>
              <CartesianGrid stroke="hsl(var(--border))" strokeDasharray="2 4" horizontal={false} />
              <XAxis type="number" tick={{ fontSize: 9, fill: "hsl(var(--muted-foreground))" }} stroke="hsl(var(--border))" unit="bp" />
              <YAxis type="category" dataKey="factor" tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} stroke="hsl(var(--border))" width={130} />
              <Tooltip contentStyle={{ fontSize: 11, background: "hsl(var(--popover))", border: "1px solid hsl(var(--border))", borderRadius: 6 }} />
              <Bar dataKey="bp" radius={[0, 2, 2, 0]}>
                {pca.map((p, i) => (
                  <Cell key={i} fill={p.bp >= 0 ? "hsl(var(--warning))" : "hsl(var(--success))"} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
          )}
        </Panel>
      </div>

      {/* Row 4: Portfolio (IPS) — accounts + positions, only on real-data */}
      {realDataOnly && (
        <div className="grid grid-cols-12 gap-2.5">
          {portfolioQ.isLoading ? (
            <PanelSkeleton rows={5} height="h-[340px]" className="col-span-12 lg:col-span-4" />
          ) : (
            <Panel
              title="Portfolio · Accounts"
              endpoint="GET /api/portfolio"
              dataSource={portfolioQ.data?.source === "supabase" ? "supabase" : "unconfigured"}
              className="col-span-12 lg:col-span-4 h-[340px]"
              right={
                portfolioQ.data?.source === "supabase" ? (
                  <span className="font-mono text-[10px]">{portfolioQ.data.accounts.length} accts</span>
                ) : undefined
              }
            >
              {portfolioQ.data?.source === "supabase" ? (
                <ul className="divide-y divide-border/70">
                  {portfolioQ.data.accounts.map((a) => (
                    <li key={a.account_code} className="px-3.5 py-2.5">
                      <div className="flex items-center justify-between gap-2">
                        <p className="truncate text-xs font-medium">{a.account_name ?? a.account_code}</p>
                        <Pill tone="neutral" size="xs">{a.account_type ?? "—"}</Pill>
                      </div>
                      <div className="mt-1 flex items-center justify-between font-mono text-[10px] text-muted-foreground">
                        <span>{a.account_code}</span>
                        <span>{a.currency ?? "ZAR"}</span>
                      </div>
                      <div className="mt-1.5 flex items-center justify-between">
                        <span className="font-mono text-[11px]">NAV {formatZAR(Number(a.nav_value ?? 0))}</span>
                        <span className="font-mono text-[10px] text-muted-foreground">cash {formatZAR(Number(a.cash_balance ?? 0))}</span>
                      </div>
                    </li>
                  ))}
                </ul>
              ) : (
                <EmptyDataState
                  title="IPS portfolio not yet populated"
                  message="Ask Charles to enable IPSAccountGetAll1 + IPSPositionGetAll1 + IPSTransactionGetByAccount5 on the production IRESS profile, then run `bun run worker`."
                />
              )}
            </Panel>
          )}

          {portfolioQ.isLoading ? (
            <PanelSkeleton rows={6} height="h-[340px]" className="col-span-12 lg:col-span-8" />
          ) : (
            <Panel
              title="Portfolio · Positions"
              endpoint="GET /api/portfolio"
              dataSource={portfolioQ.data?.source === "supabase" ? "supabase" : "unconfigured"}
              className="col-span-12 lg:col-span-8 h-[340px]"
              right={
                portfolioQ.data?.source === "supabase" ? (
                  <span className="font-mono text-[10px]">{portfolioQ.data.positions.length} positions · MV {formatZAR(portfolioQ.data.positions.reduce((acc, p) => acc + Number(p.market_value ?? 0), 0))}</span>
                ) : undefined
              }
            >
              {portfolioQ.data?.source === "supabase" && portfolioQ.data.positions.length > 0 ? (
                <div className="h-full overflow-auto">
                  <table className="w-full text-[11px]">
                    <thead className="sticky top-0 bg-card/90 backdrop-blur-sm">
                      <tr className="text-left text-[9.5px] uppercase tracking-wider text-muted-foreground">
                        <th className="px-3.5 py-1.5 font-medium">Symbol</th>
                        <th className="px-3 py-1.5 font-medium">Account</th>
                        <th className="px-3 py-1.5 text-right font-medium">Qty</th>
                        <th className="px-3 py-1.5 text-right font-medium">Avg Cost</th>
                        <th className="px-3 py-1.5 text-right font-medium">MV</th>
                        <th className="px-3 py-1.5 text-right font-medium">P&amp;L</th>
                      </tr>
                    </thead>
                    <tbody className="font-mono">
                      {portfolioQ.data.positions.map((p) => {
                        const pl = Number(p.open_pl ?? 0);
                        return (
                          <tr key={p.id} className="border-t border-border/60">
                            <td className="px-3.5 py-1.5 font-medium text-foreground">{p.security_code}</td>
                            <td className="px-3 py-1.5 text-muted-foreground">{p.account_code}</td>
                            <td className="px-3 py-1.5 text-right">{p.quantity.toLocaleString("en-ZA")}</td>
                            <td className="px-3 py-1.5 text-right">{p.open_average_price != null ? p.open_average_price.toFixed(2) : "—"}</td>
                            <td className="px-3 py-1.5 text-right">{p.market_value != null ? formatZAR(Number(p.market_value)) : "—"}</td>
                            <td className={cn("px-3 py-1.5 text-right", pl >= 0 ? "text-success" : "text-destructive")}>
                              {pl >= 0 ? "+" : ""}{formatZAR(pl)}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              ) : (
                <EmptyDataState
                  title="IPS positions not yet populated"
                  message={
                    portfolioQ.data?.source === "supabase"
                      ? "Worker has synced 0 positions. Either the IPS entitlement is off or the account has no holdings yet."
                      : "Ask Charles to enable IPSPositionGetAll1 on the production IRESS profile, then run `bun run worker`."
                  }
                />
              )}
            </Panel>
          )}
        </div>
      )}
    </div>
  );
}

function OrderStatePill({ state }: { state: string }) {
  const tone =
    state === "FILLED"   ? "success" :
    state === "PARTIAL"  ? "warning" :
    state === "WORKING"  ? "primary" :
    state === "REJECTED" ? "destructive" :
                            "neutral";
  return (
    <Badge variant={tone as never} className="text-[9.5px]">
      {state}
    </Badge>
  );
}

/**
 * Tiny JSON fetch helper for BFF endpoints. The standard `fetch` call is
 * enough — we don't need to thread headers, cookies, or retries through
 * React Query for these read-only polls. On non-2xx we throw so the
 * `useQuery` flips to `isError` and the panel renders the error shell.
 */
async function fetchJson<T>(path: string): Promise<T> {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`${path} ${res.status}`);
  return (await res.json()) as T;
}

const SENS_TONE: Record<string, "primary" | "info" | "success" | "neutral" | "warning" | "destructive"> = {
  RESULTS: "primary",
  TRADING: "info",
  DIVIDEND: "success",
  DIRECTORATE: "neutral",
  "RELATED PARTY": "neutral",
  "CORP ACTION": "warning",
  CAUTIONARY: "destructive",
};

function SensTape({ items, limit = 6 }: { items: { id: string; ts: number; ticker: string; issuer: string; category: string; severity: string; headline: string }[]; limit?: number }) {
  return (
    <ul className="divide-y divide-border/60">
      {items.slice(0, limit).map((s) => (
        <li key={s.id} className="px-3 py-2.5 hover:bg-muted/30">
          <div className="flex items-center gap-1.5">
            <Pill tone={SENS_TONE[s.category] ?? "neutral"} size="xs">{s.category}</Pill>
            {s.severity === "regulatory" && <Pill tone="destructive" size="xs">REG</Pill>}
            <span className="ml-auto font-mono text-[9.5px] text-muted-foreground">{formatTime(s.ts)}</span>
          </div>
          <p className="mt-1 text-xs font-medium leading-snug">{s.headline}</p>
          <div className="mt-0.5 flex items-center gap-1.5 font-mono text-[9.5px] text-muted-foreground">
            <span className="text-primary">{s.ticker}</span>
            <span className="text-muted-foreground/50">·</span>
            <span>{s.issuer}</span>
          </div>
        </li>
      ))}
    </ul>
  );
}
