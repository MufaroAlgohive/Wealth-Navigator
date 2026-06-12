"use client";

import { useQuery } from "@tanstack/react-query";
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Banknote, TrendingUp, ShieldCheck, Lock, Activity } from "lucide-react";

import { Panel } from "@/components/oems/primitives/panel";
import { KpiTile } from "@/components/oems/primitives/kpi-tile";
import { Pill } from "@/components/oems/primitives/pill";
import { PanelSkeleton, KpiTileSkeleton } from "@/components/oems/primitives/panel-skeleton";
import { EmptyDataState } from "@/components/oems/primitives/empty-data-state";
import { Button } from "@/components/ui/button";
import { useIress } from "@/lib/iress/provider";
import { isRealDataOnlyClient } from "@/lib/data-policy";
import { formatZAR, formatPct } from "@/lib/format";
import { cn } from "@/lib/cn";
import { queryOpts } from "@/lib/store/query-provider";

export default function MoneyMarketPage() {
  const { data } = useIress();
  const realDataOnly = isRealDataOnlyClient();
  const strategiesQ = useQuery({
    queryKey: ["strategies"],
    queryFn: () => data.strategies(),
    enabled: !realDataOnly,
    ...queryOpts("live"),
  });
  const mmQ = useQuery({
    queryKey: ["mm"],
    queryFn: () => data.mmInstruments(),
    enabled: !realDataOnly,
    ...queryOpts("reference"),
  });
  const jibarQ = useQuery({
    queryKey: ["jibar"],
    queryFn: () => data.jibarFixings(),
    enabled: !realDataOnly,
    ...queryOpts("reference"),
  });
  const curveQ = useQuery({
    queryKey: ["zar-govi"],
    queryFn: () => data.zarGoviCurve(),
    enabled: !realDataOnly,
    ...queryOpts("reference"),
  });

  if (realDataOnly) {
    return (
      <div className="space-y-3">
        <header>
          <h1 className="text-lg font-semibold tracking-tight">Money Market</h1>
          <p className="text-xs text-muted-foreground">JIBAR · ZARONIA · NCD · T-Bill · FRN universe · weighted yield & duration</p>
        </header>
        <Panel title="Money market universe" endpoint="IRESS + SARB fixings">
          <EmptyDataState message="JIBAR fixings and MM instrument yields require IRESS rate entitlement." />
        </Panel>
      </div>
    );
  }

  const mm = (strategiesQ.data ?? []).filter((s) => s.kind === "money_market");
  const instruments = mmQ.data ?? [];
  const jibar = jibarQ.data ?? [];
  const curve = curveQ.data ?? [];

  const totalAum = mm.reduce((s, x) => s + x.aum, 0);
  const wYield = totalAum ? mm.reduce((s, x) => s + (x.weightedAvgYield ?? 0) * x.aum, 0) / totalAum : 0;
  const wDur = totalAum ? mm.reduce((s, x) => s + (x.weightedAvgDuration ?? 0) * x.aum, 0) / totalAum : 0;

  return (
    <div className="space-y-3">
      <header>
        <h1 className="text-lg font-semibold tracking-tight">Money Market</h1>
        <p className="text-xs text-muted-foreground">JIBAR · ZARONIA · NCD · T-Bill · FRN universe · weighted yield & duration</p>
      </header>

      <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-5">
        {strategiesQ.isLoading || jibarQ.isLoading ? (
          [0, 1, 2, 3, 4].map((n) => <KpiTileSkeleton key={`mm-kpi-${n}`} />)
        ) : (
          <>
            <KpiTile icon={<Banknote className="h-3.5 w-3.5" />} label="MM AUM" value={formatZAR(totalAum)} sub={`${mm.length} mandates`} />
            <KpiTile icon={<TrendingUp className="h-3.5 w-3.5" />} label="Weighted yield" value={`${wYield.toFixed(2)}%`} sub="net of fees" />
            <KpiTile icon={<TrendingUp className="h-3.5 w-3.5" />} label="Weighted duration" value={`${wDur.toFixed(2)}y`} sub="effective" />
            <KpiTile icon={<Banknote className="h-3.5 w-3.5" />} label="JIBAR 3M" value={`${jibar[2]?.rate.toFixed(2) ?? "—"}%`} sub="SARB fixing 11:00" />
            <KpiTile icon={<ShieldCheck className="h-3.5 w-3.5" />} label="Credit limits" value="OK" sub="all issuers within band" />
          </>
        )}
      </div>

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        {mm.map((s) => {
          const rebal = s.investorCount > 0 && s.status !== "halted";
          return (
            <Panel
              key={s.id}
              title={s.name}
              endpoint="GET /v1/positions?strategy={id}&kind=mm"
              className="border-l-2 border-l-warning"
              right={
                <Pill tone={s.status === "live" ? "success" : "neutral"} size="xs" dot>
                  {s.status}
                </Pill>
              }
            >
              <div className="grid grid-cols-4 gap-2 text-xs">
                <Stat label="AUM" value={s.aum > 0 ? formatZAR(s.aum) : "—"} />
                <Stat label="YTD" value={formatPct(s.ytd)} positive={s.ytd >= 0} />
                <Stat label="Yield" value={`${s.weightedAvgYield?.toFixed(2)}%`} />
                <Stat label="Duration" value={`${s.weightedAvgDuration?.toFixed(2)}y`} />
                <Stat label="Investors" value={s.investorCount.toString()} />
                <Stat label="Cash" value={`${s.cashWeight}%`} />
                <Stat label="Sharpe" value={s.sharpe.toFixed(2)} />
                <Stat label="Max DD" value={formatPct(s.maxDD)} negative />
              </div>
              <div className="mt-3 flex items-center justify-between border-t border-border/60 pt-2.5 text-[10.5px]">
                <span className="font-mono text-muted-foreground">
                  Last rebal {s.lastRebalanced} · NAV strikes 16:00 SAST
                </span>
                <Button size="sm" variant={rebal ? "default" : "outline"} disabled={!rebal} className="h-6 px-2 text-[10px]">
                  {rebal ? <><Activity className="h-2.5 w-2.5" /> Rebalance</> : <><Lock className="h-2.5 w-2.5" /> Locked</>}
                </Button>
              </div>
            </Panel>
          );
        })}
      </div>

      <div className="grid grid-cols-12 gap-2.5">
        <Panel title="JIBAR fixings" endpoint="GET /v1/rates/jibar" className="col-span-12 lg:col-span-4">
          <table className="w-full font-mono text-xs">
            <tbody className="divide-y divide-border/60">
              {jibar.map((f) => (
                <tr key={f.tenor}>
                  <td className="px-3 py-2 font-semibold">{f.tenor}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{f.rate.toFixed(2)}%</td>
                  <td className={cn("px-3 py-2 text-right font-mono text-[10px]", f.change > 0 ? "text-success" : f.change < 0 ? "text-destructive" : "text-muted-foreground")}>
                    {f.change > 0 ? "+" : ""}{(f.change * 100).toFixed(0)}bp
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
        <Panel title="ZAR sovereign yield curve" endpoint="GET /v1/yieldcurve/zar?model=nss" className="col-span-12 lg:col-span-8 h-[300px]">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={curve} margin={{ top: 8, right: 12, left: -8, bottom: 0 }}>
              <CartesianGrid stroke="hsl(var(--border))" strokeDasharray="2 4" vertical={false} />
              <XAxis dataKey="tenor" tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} stroke="hsl(var(--border))" />
              <YAxis tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} stroke="hsl(var(--border))" unit="%" domain={["dataMin - 0.5", "dataMax + 0.5"]} />
              <Tooltip contentStyle={{ fontSize: 11, background: "hsl(var(--popover))", border: "1px solid hsl(var(--border))", borderRadius: 6 }} formatter={(v: number) => `${v.toFixed(2)}%`} />
              <Line type="monotone" dataKey="yield" stroke="hsl(38 95% 56%)" strokeWidth={2} dot={{ r: 3, fill: "hsl(38 95% 56%)" }} />
            </LineChart>
          </ResponsiveContainer>
        </Panel>
      </div>

      <Panel
        title="Eligible money-market instruments"
        endpoint="GET /v1/securities?type=ncd,tb,frn,reponame"
        right={<Pill tone="primary" size="xs">{instruments.length} ELIGIBLE</Pill>}
      >
        <table className="w-full font-mono text-xs">
          <thead>
            <tr className="text-[9.5px] uppercase tracking-wider text-muted-foreground">
              <th className="px-3 py-2 text-left">Ticker</th>
              <th className="px-3 py-2 text-left">Instrument</th>
              <th className="px-3 py-2 text-left">Type</th>
              <th className="px-3 py-2 text-left">Issuer</th>
              <th className="px-3 py-2 text-left">Tenor</th>
              <th className="px-3 py-2 text-left">Rating</th>
              <th className="px-3 py-2 text-right">Yield</th>
              <th className="px-3 py-2 text-right">Duration</th>
              <th className="px-3 py-2 text-right">Notional</th>
              <th className="px-3 py-2 text-left">Maturity</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/60">
            {instruments.map((i) => (
              <tr key={i.ticker} className="hover:bg-muted/30">
                <td className="px-3 py-1.5 font-semibold">{i.ticker}</td>
                <td className="px-3 py-1.5 text-muted-foreground">{i.name}</td>
                <td className="px-3 py-1.5"><Pill tone="neutral" size="xs">{i.type}</Pill></td>
                <td className="px-3 py-1.5 text-muted-foreground">{i.issuer}</td>
                <td className="px-3 py-1.5">{i.tenor}</td>
                <td className="px-3 py-1.5"><Pill tone={i.rating.startsWith("AA") ? "success" : "warning"} size="xs">{i.rating}</Pill></td>
                <td className="px-3 py-1.5 text-right font-semibold tabular-nums">{i.yield.toFixed(2)}%</td>
                <td className="px-3 py-1.5 text-right text-muted-foreground tabular-nums">{i.duration.toFixed(2)}y</td>
                <td className="px-3 py-1.5 text-right tabular-nums">{formatZAR(i.notional)}</td>
                <td className="px-3 py-1.5 text-muted-foreground">{i.maturity}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>
    </div>
  );
}

function Stat({ label, value, positive, negative }: { label: string; value: string; positive?: boolean; negative?: boolean }) {
  return (
    <div>
      <p className="text-[9.5px] uppercase tracking-wider text-muted-foreground">{label}</p>
      <p className={cn("mt-0.5 font-mono text-xs font-semibold", positive && "text-up", negative && "text-down")}>{value}</p>
    </div>
  );
}
