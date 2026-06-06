"use client";

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis, Legend, Area, AreaChart } from "recharts";

import { Panel } from "@/components/oems/primitives/panel";
import { KpiTile } from "@/components/oems/primitives/kpi-tile";
import { Pill } from "@/components/oems/primitives/pill";
import { PanelSkeleton, KpiTileSkeleton } from "@/components/oems/primitives/panel-skeleton";
import { useIress } from "@/lib/iress/provider";
import { formatBps } from "@/lib/format";
import { queryOpts } from "@/lib/store/query-provider";

export default function CurvesPage() {
  const { data } = useIress();
  const goviQ = useQuery({ queryKey: ["govi"], queryFn: () => data.zarGoviCurve(), ...queryOpts("reference") });
  const swapQ = useQuery({ queryKey: ["swap"], queryFn: () => data.zarSwapCurve(), ...queryOpts("reference") });
  const realQ = useQuery({ queryKey: ["real"], queryFn: () => data.zarRealCurve(), ...queryOpts("reference") });
  const breakevenQ = useQuery({ queryKey: ["breakeven"], queryFn: () => data.zarBreakeven(), ...queryOpts("reference") });

  const govi = goviQ.data ?? [];
  const swap = swapQ.data ?? [];
  const real = realQ.data ?? [];
  const breakeven = breakevenQ.data ?? [];

  const combined = useMemo(() => govi.map((p, i) => ({
    tenor: p.tenor,
    govi: p.yield,
    swap: swap[i]?.yield,
    real: real[i]?.yield,
    breakeven: breakeven[i]?.breakeven,
  })), [govi, swap, real, breakeven]);

  const move = govi.length > 1 ? {
    level: 12,
    slope: -8,
    curvature: 3,
    residual: 1,
  } : { level: 0, slope: 0, curvature: 0, residual: 0 };

  const latestGovi = govi[govi.length - 1]?.yield ?? 0;
  const latestSwap = swap[swap.length - 1]?.yield ?? 0;
  const latestReal = real[real.length - 1]?.yield ?? 0;
  const latestBE = breakeven[breakeven.length - 1]?.breakeven ?? 0;

  return (
    <div className="space-y-3">
      <header>
        <h1 className="text-lg font-semibold tracking-tight">Yield Curves · ZAR</h1>
        <p className="text-xs text-muted-foreground">
          Nelson-Siegel-Svensson fitted · ZAR govi · swap · real · breakeven · PCA decomposition
        </p>
      </header>

      <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-4">
        {goviQ.isLoading ? (
          [0, 1, 2, 3].map((n) => <KpiTileSkeleton key={`curves-kpi-${n}`} />)
        ) : (
          <>
            <KpiTile label="ZAR govi 10Y" value={`${latestGovi.toFixed(2)}%`} sub={formatBps(move.level)} tone={move.level > 0 ? "warning" : "positive"} />
            <KpiTile label="ZAR swap 10Y" value={`${latestSwap.toFixed(2)}%`} sub="vs govi" />
            <KpiTile label="ZAR real 10Y" value={`${latestReal.toFixed(2)}%`} sub="ILB yield" />
            <KpiTile label="Breakeven 10Y" value={`${latestBE.toFixed(2)}%`} sub="expected CPI" />
          </>
        )}
      </div>

      <div className="grid grid-cols-12 gap-2.5">
        {goviQ.isLoading || swapQ.isLoading || realQ.isLoading || breakevenQ.isLoading ? (
          <PanelSkeleton rows={4} height="h-[380px]" className="col-span-12 lg:col-span-8" />
        ) : (
          <Panel
            title="Combined · govi · swap · real · breakeven"
            endpoint="GET /v1/yieldcurve/zar?bundled"
            className="col-span-12 lg:col-span-8 h-[380px]"
          >
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={combined} margin={{ top: 8, right: 12, left: -8, bottom: 0 }}>
                <CartesianGrid stroke="hsl(var(--border))" strokeDasharray="2 4" vertical={false} />
                <XAxis dataKey="tenor" tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} stroke="hsl(var(--border))" />
                <YAxis tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} stroke="hsl(var(--border))" unit="%" domain={["dataMin - 0.5", "dataMax + 0.5"]} />
                <Tooltip contentStyle={{ fontSize: 11, background: "hsl(var(--popover))", border: "1px solid hsl(var(--border))", borderRadius: 6 }} formatter={(v: number) => `${v.toFixed(2)}%`} />
                <Legend wrapperStyle={{ fontSize: 10, paddingTop: 4 }} />
                <Line type="monotone" dataKey="govi" name="Govi" stroke="hsl(38 95% 56%)" strokeWidth={2.2} dot={{ r: 2 }} />
                <Line type="monotone" dataKey="swap" name="Swap" stroke="hsl(263 80% 65%)" strokeWidth={1.6} dot={false} />
                <Line type="monotone" dataKey="real" name="Real (ILB)" stroke="hsl(180 60% 50%)" strokeWidth={1.4} dot={false} strokeDasharray="4 4" />
                <Line type="monotone" dataKey="breakeven" name="Breakeven" stroke="hsl(351 90% 60%)" strokeWidth={1.2} dot={false} strokeDasharray="2 4" />
              </LineChart>
            </ResponsiveContainer>
          </Panel>
        )}

        <Panel
          title="PCA · today's curve move"
          endpoint="INTERNAL · PCA on ZAR curve"
          className="col-span-12 lg:col-span-4 h-[380px]"
          right={<span className="font-mono text-[10px]">3-factors + residual</span>}
        >
          <div className="grid grid-cols-1 gap-1.5 text-xs">
            {[
              { k: "Level (parallel)", v: move.level, help: "whole curve shift" },
              { k: "Slope (2s10s)", v: move.slope, help: "short vs long" },
              { k: "Curvature (fly)", v: move.curvature, help: "belly twist" },
              { k: "Residual", v: move.residual, help: "unexplained" },
            ].map((row) => (
              <div key={row.k} className="rounded-md border border-border/60 bg-surface-2/30 p-2.5">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="font-semibold">{row.k}</p>
                    <p className="text-[9.5px] text-muted-foreground">{row.help}</p>
                  </div>
                  <p className={`font-mono text-base font-semibold ${row.v >= 0 ? "text-up" : "text-down"}`}>
                    {row.v >= 0 ? "+" : ""}{row.v}bp
                  </p>
                </div>
                <div className="mt-1.5 h-1 overflow-hidden rounded bg-muted">
                  <div
                    className={row.v >= 0 ? "h-full bg-success" : "h-full bg-destructive"}
                    style={{ width: `${Math.min(100, Math.abs(row.v) * 6)}%` }}
                  />
                </div>
              </div>
            ))}
          </div>
        </Panel>
      </div>

      <div className="grid grid-cols-12 gap-2.5">
        <Panel
          title="ZAR-OIS spread · 3M · 12M · 5Y"
          endpoint="GET /v1/yieldcurve/zar/ois?spread=irs"
          className="col-span-12 lg:col-span-6 h-[300px]"
        >
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={Array.from({ length: 60 }, (_, i) => ({ t: i, spread: 0.45 + Math.sin(i / 6) * 0.12 + Math.cos(i / 18) * 0.08 }))} margin={{ top: 8, right: 8, left: -8, bottom: 0 }}>
              <defs>
                <linearGradient id="oisGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="hsl(263 80% 65%)" stopOpacity={0.4} />
                  <stop offset="100%" stopColor="hsl(263 80% 65%)" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid stroke="hsl(var(--border))" strokeDasharray="2 4" vertical={false} />
              <XAxis dataKey="t" tick={{ fontSize: 9, fill: "hsl(var(--muted-foreground))" }} stroke="hsl(var(--border))" tickFormatter={(v) => `${v}m`} interval={9} />
              <YAxis tick={{ fontSize: 9, fill: "hsl(var(--muted-foreground))" }} stroke="hsl(var(--border))" unit="%" />
              <Tooltip contentStyle={{ fontSize: 11, background: "hsl(var(--popover))", border: "1px solid hsl(var(--border))", borderRadius: 6 }} />
              <Area type="monotone" dataKey="spread" stroke="hsl(263 80% 65%)" fill="url(#oisGrad)" strokeWidth={1.6} />
            </AreaChart>
          </ResponsiveContainer>
        </Panel>

        <Panel
          title="Carry & rolldown · key 5Y vertex"
          endpoint="INTERNAL · carry rolldown"
          className="col-span-12 lg:col-span-6 h-[300px]"
          right={<Pill tone="success" size="xs">+0.62% T+3M</Pill>}
        >
          <div className="grid grid-cols-2 gap-2 text-xs">
            {[
              ["Carry (3M)", "+0.55%"],
              ["Rolldown (3M)", "+0.07%"],
              ["Total (3M)", "+0.62%"],
              ["Carry (12M)", "+2.18%"],
              ["Rolldown (12M)", "+0.31%"],
              ["Total (12M)", "+2.49%"],
              ["Annualized (3M)", "+2.47%"],
              ["Annualized (12M)", "+2.49%"],
            ].map(([l, v]) => (
              <div key={l} className="flex items-center justify-between rounded-md border border-border/60 bg-surface-2/30 p-2">
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground">{l}</p>
                <p className="font-mono font-semibold">{v}</p>
              </div>
            ))}
          </div>
        </Panel>
      </div>
    </div>
  );
}
