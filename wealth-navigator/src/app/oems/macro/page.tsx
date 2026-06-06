"use client";

import { useQuery } from "@tanstack/react-query";
import { Area, AreaChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { ArrowUpRight, ArrowDownRight, Calendar, AlertCircle } from "lucide-react";

import { Panel } from "@/components/oems/primitives/panel";
import { KpiTile } from "@/components/oems/primitives/kpi-tile";
import { Pill } from "@/components/oems/primitives/pill";
import { PanelSkeleton, KpiTileSkeleton } from "@/components/oems/primitives/panel-skeleton";
import { useIress } from "@/lib/iress/provider";
import { formatPct } from "@/lib/format";
import { cn } from "@/lib/cn";
import { queryOpts } from "@/lib/store/query-provider";

const SERIES: Array<{ id: string; label: string; color: string; unit: string }> = [
  { id: "cpi",        label: "Headline CPI YoY",   color: "hsl(263 80% 65%)", unit: "%" },
  { id: "rates",      label: "Repo rate",          color: "hsl(38 95% 56%)",  unit: "%" },
  { id: "usdzar",     label: "USD/ZAR",            color: "hsl(180 60% 50%)", unit: "" },
  { id: "pmi",        label: "Absa PMI",           color: "hsl(152 70% 50%)", unit: "" },
];

function makeSeries(seed: number, base: number, vol: number, n = 60) {
  return Array.from({ length: n }, (_, i) => ({
    t: i,
    v: +(base + Math.sin(i / 5 + seed) * vol + Math.cos(i / 17 + seed) * vol * 0.4).toFixed(3),
  }));
}

export default function MacroPage() {
  const { data } = useIress();
  const indicatorsQ = useQuery({ queryKey: ["macro"], queryFn: () => data.macroIndicators(), ...queryOpts("reference") });
  const releasesQ = useQuery({ queryKey: ["releases"], queryFn: () => data.macroReleases(), ...queryOpts("reference") });
  const indicators = indicatorsQ.data ?? [];
  const releases = releasesQ.data ?? [];

  return (
    <div className="space-y-3">
      <header>
        <h1 className="text-lg font-semibold tracking-tight">Macro</h1>
        <p className="text-xs text-muted-foreground">SARB · StatsSA · G10 series · indicator surprise · upcoming releases</p>
      </header>

      <div className="grid grid-cols-2 gap-2.5 md:grid-cols-4 lg:grid-cols-6">
        {indicatorsQ.isLoading ? (
          Array.from({ length: 6 }).map((_, i) => <KpiTileSkeleton key={i} />)
        ) : (
          indicators.slice(0, 6).map((m) => (
            <KpiTile
              key={m.name}
              label={m.name}
              value={`${m.value}${m.unit}`}
              sub={<span className="flex items-center gap-1">prior {m.prior}</span>}
              icon={m.trend === "up" ? <ArrowUpRight className="h-3 w-3" /> : m.trend === "down" ? <ArrowDownRight className="h-3 w-3" /> : undefined}
              tone={m.trend === "up" ? "positive" : m.trend === "down" ? "negative" : "default"}
            />
          ))
        )}
      </div>

      <div className="grid grid-cols-12 gap-2.5">
        {SERIES.map((s, i) => (
          <Panel
            key={s.id}
            title={s.label}
            endpoint={`GET /v1/macro/series/${s.id}`}
            className="col-span-12 lg:col-span-6 h-[260px]"
            right={<span className="font-mono text-[10px]">5Y monthly</span>}
          >
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={makeSeries(i, 5.0, 0.8)} margin={{ top: 8, right: 8, left: -16, bottom: 0 }}>
                <defs>
                  <linearGradient id={`grad-${s.id}`} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={s.color} stopOpacity={0.4} />
                    <stop offset="100%" stopColor={s.color} stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid stroke="hsl(var(--border))" strokeDasharray="2 4" vertical={false} />
                <XAxis dataKey="t" tick={{ fontSize: 9, fill: "hsl(var(--muted-foreground))" }} stroke="hsl(var(--border))" tickFormatter={(v) => `${v}m`} interval={9} />
                <YAxis tick={{ fontSize: 9, fill: "hsl(var(--muted-foreground))" }} stroke="hsl(var(--border))" unit={s.unit} domain={["dataMin - 0.5", "dataMax + 0.5"]} />
                <Tooltip contentStyle={{ fontSize: 11, background: "hsl(var(--popover))", border: "1px solid hsl(var(--border))", borderRadius: 6 }} />
                <Area type="monotone" dataKey="v" stroke={s.color} fill={`url(#grad-${s.id})`} strokeWidth={1.8} />
              </AreaChart>
            </ResponsiveContainer>
          </Panel>
        ))}
      </div>

      <Panel
        title="Upcoming releases · 14 days"
        endpoint="GET /v1/macro/calendar?range=14d"
        right={<span className="font-mono text-[10px]">{releases.length} scheduled</span>}
        density="scroll"
        className="h-[380px]"
      >
        <table className="w-full font-mono text-xs">
          <thead>
            <tr className="text-[9.5px] uppercase tracking-wider text-muted-foreground">
              <th className="px-3 py-2 text-left">Date / Time</th>
              <th className="px-3 py-2 text-left">Series</th>
              <th className="px-3 py-2 text-left">Source</th>
              <th className="px-3 py-2 text-left">Country</th>
              <th className="px-3 py-2 text-right">Consensus</th>
              <th className="px-3 py-2 text-right">Prior</th>
              <th className="px-3 py-2 text-left">Importance</th>
              <th className="px-3 py-2 text-left">Tags</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/60">
            {releases.map((r) => (
              <tr key={r.id} className="hover:bg-muted/30">
                <td className="px-3 py-1.5">
                  <p className="font-semibold">{new Date(r.ts).toLocaleDateString("en-ZA", { weekday: "short", day: "2-digit", month: "short" })}</p>
                  <p className="text-[9.5px] text-muted-foreground">
                    {new Date(r.ts).toLocaleTimeString("en-ZA", { hour: "2-digit", minute: "2-digit", timeZone: "Africa/Johannesburg" })} SAST
                  </p>
                </td>
                <td className="px-3 py-1.5">{r.name}</td>
                <td className="px-3 py-1.5 text-muted-foreground">{r.source}</td>
                <td className="px-3 py-1.5 text-muted-foreground">{r.country}</td>
                <td className="px-3 py-1.5 text-right tabular-nums font-semibold">{r.consensus}</td>
                <td className="px-3 py-1.5 text-right tabular-nums text-muted-foreground">{r.prior}</td>
                <td className="px-3 py-1.5">
                  <Pill tone={r.importance === "high" ? "destructive" : r.importance === "medium" ? "warning" : "neutral"} size="xs" dot>
                    {r.importance}
                  </Pill>
                </td>
                <td className="px-3 py-1.5 flex flex-wrap gap-1">
                  {r.tags.map((t) => <span key={t} className="rounded bg-muted/60 px-1.5 py-0.5 text-[9.5px] text-muted-foreground">{t}</span>)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>
    </div>
  );
}
