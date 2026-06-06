"use client";

import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Bar, BarChart, CartesianGrid, Cell, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Search, LineChart as LineIcon } from "lucide-react";

import { Panel } from "@/components/oems/primitives/panel";
import { Pill } from "@/components/oems/primitives/pill";
import { PanelSkeleton } from "@/components/oems/primitives/panel-skeleton";
import { Input } from "@/components/ui/input";
import { useIress } from "@/lib/iress/provider";
import { cn } from "@/lib/cn";
import { useTick } from "@/lib/store/tick-stream-provider";
import { queryOpts } from "@/lib/store/query-provider";

export default function FixedIncomePage() {
  const { data } = useIress();
  const bondsQ = useQuery({ queryKey: ["bonds"], queryFn: () => data.bonds(), ...queryOpts("reference") });
  const curveHistoryQ = useQuery({ queryKey: ["zar-govi"], queryFn: () => data.zarGoviCurve(), ...queryOpts("reference") });
  const bonds = bondsQ.data ?? [];
  const today = curveHistoryQ.data ?? [];

  const [selected, setSelected] = useState<string>(bonds[1]?.isin ?? "");
  const bond = bonds.find((b) => b.isin === selected) ?? bonds[1];
  const [q, setQ] = useState("");

  const filtered = useMemo(() => bonds.filter((b) => !q || b.name.toLowerCase().includes(q.toLowerCase()) || b.isin.includes(q) || b.issuer.toLowerCase().includes(q.toLowerCase())), [bonds, q]);

  const krd = [
    { tenor: "1Y", krd: 0.04 }, { tenor: "2Y", krd: 0.18 }, { tenor: "3Y", krd: 0.42 },
    { tenor: "5Y", krd: 1.21 }, { tenor: "7Y", krd: 2.18 }, { tenor: "10Y", krd: 2.84 },
    { tenor: "15Y", krd: 0.12 },
  ];
  const sensitivity = [-100, -50, -25, 0, 25, 50, 100].map((bp) => ({
    bp: `${bp >= 0 ? "+" : ""}${bp}`,
    pnl: bond ? -bond.dv01 * bp - 0.5 * bond.convexity * Math.pow(bp / 100, 2) * 10000 : 0,
  }));

  const overlay = useMemo(() => {
    // Build "today vs 1D / 1W / 1M" series by perturbing the current curve.
    if (today.length === 0) return [];
    return today.map((p, i) => ({
      tenor: p.tenor,
      today: p.yield,
      d1: +(p.yield + (Math.sin(i * 0.7) * 0.04 - 0.02)).toFixed(3),
      w1: +(p.yield + (Math.cos(i * 0.5) * 0.08 - 0.04)).toFixed(3),
      m1: +(p.yield + (Math.sin(i * 0.3) * 0.12 - 0.06)).toFixed(3),
    }));
  }, [today]);

  if (!bond) return null;

  return (
    <div className="space-y-3">
      <header>
        <h1 className="text-lg font-semibold tracking-tight">Fixed Income</h1>
        <p className="text-xs text-muted-foreground">Clean/dirty pricing · DV01 · convexity · KRD · spread to curve</p>
      </header>

      <div className="grid grid-cols-12 gap-2.5">
        {bondsQ.isLoading ? (
          <PanelSkeleton rows={8} height="h-[420px]" className="col-span-12 lg:col-span-7" />
        ) : (
          <Panel
            title="Bond screener"
            endpoint="GET /v1/bonds/screener"
            className="col-span-12 lg:col-span-7 h-[420px]"
            density="scroll"
            right={
              <div className="relative w-48">
                <Search className="pointer-events-none absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground" />
                <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="ISIN / issuer / name" className="h-6 pl-6 text-[10.5px]" />
              </div>
            }
          >
            <table className="w-full font-mono text-[11px]">
              <thead className="sticky top-0 z-10 bg-card/95 backdrop-blur">
                <tr className="text-[9.5px] uppercase tracking-wider text-muted-foreground">
                  <th className="px-2.5 py-1.5 text-left">Name</th>
                  <th className="px-2.5 py-1.5 text-left">Issuer</th>
                  <th className="px-2.5 py-1.5 text-right">YTM</th>
                  <th className="px-2.5 py-1.5 text-right">Clean</th>
                  <th className="px-2.5 py-1.5 text-right">Mod Dur</th>
                  <th className="px-2.5 py-1.5 text-right">DV01</th>
                  <th className="px-2.5 py-1.5 text-right">Spd</th>
                  <th className="px-2.5 py-1.5 text-left">Rtg</th>
                  <th className="px-2.5 py-1.5 text-left">Liq</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/60">
                {filtered.map((b) => (
                  <tr
                    key={b.isin}
                    onClick={() => setSelected(b.isin)}
                    className={cn("cursor-pointer hover:bg-muted/30", selected === b.isin && "bg-primary/10")}
                  >
                    <td className="px-2.5 py-1.5 font-semibold">{b.name}</td>
                    <td className="px-2.5 py-1.5 text-muted-foreground">{b.issuer}</td>
                    <td className="px-2.5 py-1.5 text-right tabular-nums">{b.ytm.toFixed(2)}%</td>
                    <td className="px-2.5 py-1.5 text-right tabular-nums">{b.clean.toFixed(2)}</td>
                    <td className="px-2.5 py-1.5 text-right tabular-nums">{b.modDur.toFixed(2)}</td>
                    <td className="px-2.5 py-1.5 text-right tabular-nums">{b.dv01}</td>
                    <td className={cn("px-2.5 py-1.5 text-right tabular-nums", b.spread > 0 && "text-warning")}>{b.spread > 0 ? `+${b.spread}` : "—"}</td>
                    <td className="px-2.5 py-1.5"><Pill tone={b.rating.startsWith("AA") ? "success" : b.rating.startsWith("BB") ? "warning" : "neutral"} size="xs">{b.rating}</Pill></td>
                    <td className="px-2.5 py-1.5 text-[9.5px] uppercase tracking-wider text-muted-foreground">{b.liquidity}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Panel>
        )}

        <div className="col-span-12 lg:col-span-5 space-y-2.5">
          <Panel title={`${bond.name} · ${bond.isin}`} endpoint={`GET /v1/bonds/${bond.isin}/pricing`}>
            <div className="grid grid-cols-3 gap-2 text-xs">
              {[
                ["Issuer", bond.issuer],
                ["Coupon", `${bond.coupon}%`],
                ["Maturity", bond.maturity],
                ["YTM", `${bond.ytm.toFixed(3)}%`],
                ["Clean", bond.clean.toFixed(3)],
                ["Dirty", bond.dirty.toFixed(3)],
                ["Mod Dur", bond.modDur.toFixed(2)],
                ["DV01", `R${bond.dv01}`],
                ["Convexity", bond.convexity.toFixed(1)],
                ["Rating", bond.rating],
                ["Spread", `${bond.spread}bp`],
                ["Liquidity", bond.liquidity],
              ].map(([l, v]) => (
                <div key={l} className="rounded-md border border-border/60 bg-surface-2/30 p-1.5">
                  <p className="text-[9px] uppercase tracking-wider text-muted-foreground">{l}</p>
                  <p className="mt-0.5 font-mono text-xs font-semibold">{v}</p>
                </div>
              ))}
            </div>
          </Panel>

          <Panel title="Key-rate duration" endpoint={`GET /v1/bonds/${bond.isin}/krd`} className="h-[200px]">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={krd} margin={{ top: 4, right: 8, left: -20, bottom: 0 }}>
                <CartesianGrid stroke="hsl(var(--border))" strokeDasharray="2 4" vertical={false} />
                <XAxis dataKey="tenor" tick={{ fontSize: 9, fill: "hsl(var(--muted-foreground))" }} stroke="hsl(var(--border))" />
                <YAxis tick={{ fontSize: 9, fill: "hsl(var(--muted-foreground))" }} stroke="hsl(var(--border))" />
                <Tooltip contentStyle={{ fontSize: 11, background: "hsl(var(--popover))", border: "1px solid hsl(var(--border))", borderRadius: 6 }} />
                <Bar dataKey="krd" fill="hsl(263 80% 65%)" radius={[2, 2, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </Panel>
        </div>
      </div>

      <div className="grid grid-cols-12 gap-2.5">
        <Panel
          title="ZAR govi · today vs 1D / 1W / 1M"
          endpoint="GET /v1/yieldcurve/zar/history"
          className="col-span-12 lg:col-span-7 h-[300px]"
        >
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={overlay} margin={{ top: 8, right: 12, left: -8, bottom: 0 }}>
              <CartesianGrid stroke="hsl(var(--border))" strokeDasharray="2 4" vertical={false} />
              <XAxis dataKey="tenor" tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} stroke="hsl(var(--border))" />
              <YAxis tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} stroke="hsl(var(--border))" unit="%" />
              <Tooltip contentStyle={{ fontSize: 11, background: "hsl(var(--popover))", border: "1px solid hsl(var(--border))", borderRadius: 6 }} formatter={(v: number) => `${v.toFixed(2)}%`} />
              <Line type="monotone" dataKey="today" name="Today" stroke="hsl(38 95% 56%)" strokeWidth={2.2} dot={{ r: 2 }} />
              <Line type="monotone" dataKey="d1" name="-1D" stroke="hsl(263 80% 65%)" strokeWidth={1.2} dot={false} strokeDasharray="3 3" />
              <Line type="monotone" dataKey="w1" name="-1W" stroke="hsl(220 9% 60%)" strokeWidth={1.2} dot={false} strokeDasharray="3 3" />
              <Line type="monotone" dataKey="m1" name="-1M" stroke="hsl(220 9% 30%)" strokeWidth={1.2} dot={false} strokeDasharray="2 6" />
            </LineChart>
          </ResponsiveContainer>
        </Panel>

        <Panel
          title="P&L sensitivity · ±100bp"
          endpoint="INTERNAL · price-yield grid"
          className="col-span-12 lg:col-span-5 h-[300px]"
        >
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={sensitivity} margin={{ top: 8, right: 8, left: -20, bottom: 0 }}>
              <CartesianGrid stroke="hsl(var(--border))" strokeDasharray="2 4" vertical={false} />
              <XAxis dataKey="bp" tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} stroke="hsl(var(--border))" />
              <YAxis tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} stroke="hsl(var(--border))" tickFormatter={(v) => `${v / 1000}k`} />
              <Tooltip contentStyle={{ fontSize: 11, background: "hsl(var(--popover))", border: "1px solid hsl(var(--border))", borderRadius: 6 }} formatter={(v: number) => `R${(v / 1000).toFixed(0)}k/R1m`} />
              <Bar dataKey="pnl" radius={[2, 2, 0, 0]}>
                {sensitivity.map((d, i) => <Cell key={i} fill={d.pnl >= 0 ? "hsl(152 70% 50%)" : "hsl(351 90% 60%)"} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </Panel>
      </div>
    </div>
  );
}
