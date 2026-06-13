"use client";

import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Search } from "lucide-react";

import { Panel } from "@/components/oems/primitives/panel";
import { Pill } from "@/components/oems/primitives/pill";
import { PanelSkeleton } from "@/components/oems/primitives/panel-skeleton";
import { EmptyDataState } from "@/components/oems/primitives/empty-data-state";
import { EntitlementRequired } from "@/components/oems/primitives/entitlement-required";
import { Input } from "@/components/ui/input";
import { isRealDataOnlyClient } from "@/lib/data-policy";
import { cn } from "@/lib/cn";
import { queryOpts } from "@/lib/store/query-provider";

interface BondRow {
  isin: string;
  code: string;
  name: string;
  issuer: string;
  coupon: number;
  maturity: string;
  ytm: number;
  clean: number;
  dirty: number;
  modDur: number;
  dv01: number;
  convexity: number;
  spread: number;
  rating: string;
  liquidity: string;
  asOf: string;
}

interface BondsResponse {
  bonds: BondRow[];
  source: string;
  message?: string;
}

export default function FixedIncomePage() {
  const realDataOnly = isRealDataOnlyClient();
  const bondsQ = useQuery<BondsResponse>({
    queryKey: ["bff-bonds"],
    queryFn: async () => {
      const r = await fetch("/api/bonds", { cache: "no-store" });
      if (!r.ok) throw new Error(`Bonds BFF ${r.status}`);
      return r.json();
    },
    enabled: realDataOnly,
    refetchInterval: 60_000,
    ...queryOpts("reference"),
  });
  const bonds = bondsQ.data?.bonds ?? [];
  const source = bondsQ.data?.source ?? "unavailable";

  const [selected, setSelected] = useState<string>("");
  const effectiveSelected = selected || bonds[0]?.isin || "";
  const bond = bonds.find((b) => b.isin === effectiveSelected) ?? bonds[0];
  const [q, setQ] = useState("");

  const filtered = useMemo(
    () =>
      bonds.filter(
        (b) =>
          !q ||
          b.name.toLowerCase().includes(q.toLowerCase()) ||
          b.isin.toLowerCase().includes(q.toLowerCase()) ||
          b.issuer.toLowerCase().includes(q.toLowerCase()),
      ),
    [bonds, q],
  );

  // Sensitivity uses the real bond's DV01 / convexity. The KRD bar chart
  // is rendered as "— " unless the worker also writes krd vector per
  // bond (no schema for that today) — we keep the panel as a
  // *sensitivity* view of DV01 + convexity only.
  const sensitivity = useMemo(() => {
    if (!bond) return [];
    return [-100, -50, -25, 0, 25, 50, 100].map((bp) => ({
      bp: `${bp >= 0 ? "+" : ""}${bp}`,
      pnl: -bond.dv01 * bp - 0.5 * bond.convexity * Math.pow(bp / 100, 2) * 10000,
    }));
  }, [bond]);

  return (
    <div className="space-y-3">
      <header>
        <h1 className="text-lg font-semibold tracking-tight">Fixed Income</h1>
        <p className="text-xs text-muted-foreground">Clean/dirty pricing · DV01 · convexity · spread to curve</p>
      </header>

      {bondsQ.isLoading ? (
        <PanelSkeleton rows={8} height="h-[420px]" className="col-span-12" />
      ) : bonds.length === 0 ? (
        <Panel
          title="Bond screener"
          endpoint="GET /api/bonds"
          dataSource={source === "supabase" ? "supabase" : "unconfigured"}
        >
          <EmptyDataState
            message="No bonds ingested yet."
            hint={bondsQ.data?.message ?? "bonds_c is empty. Bond pricing requires the IRESS bond entitlement (or an upstream vendor)."}
            badgeLabel="blocked-vendor"
          />
        </Panel>
      ) : (
        <div className="grid grid-cols-12 gap-2.5">
          <Panel
            title="Bond screener"
            endpoint="GET /api/bonds"
            dataSource="supabase"
            className="col-span-12 lg:col-span-7 h-[420px]"
            density="scroll"
            right={
              <div className="relative w-48">
                <Search className="pointer-events-none absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  placeholder="ISIN / issuer / name"
                  className="h-6 pl-6 text-[10.5px]"
                />
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
                    className={cn("cursor-pointer hover:bg-muted/30", b.isin === effectiveSelected && "bg-primary/10")}
                  >
                    <td className="px-2.5 py-1.5 font-semibold">{b.name}</td>
                    <td className="px-2.5 py-1.5 text-muted-foreground">{b.issuer}</td>
                    <td className="px-2.5 py-1.5 text-right tabular-nums">{b.ytm.toFixed(2)}%</td>
                    <td className="px-2.5 py-1.5 text-right tabular-nums">{b.clean.toFixed(2)}</td>
                    <td className="px-2.5 py-1.5 text-right tabular-nums">{b.modDur.toFixed(2)}</td>
                    <td className="px-2.5 py-1.5 text-right tabular-nums">{b.dv01.toFixed(2)}</td>
                    <td className={cn("px-2.5 py-1.5 text-right tabular-nums", b.spread > 0 && "text-warning")}>
                      {b.spread > 0 ? `+${b.spread}` : "—"}
                    </td>
                    <td className="px-2.5 py-1.5">
                      <Pill
                        tone={b.rating.startsWith("AA") ? "success" : b.rating.startsWith("BB") ? "warning" : "neutral"}
                        size="xs"
                      >
                        {b.rating}
                      </Pill>
                    </td>
                    <td className="px-2.5 py-1.5 text-[9.5px] uppercase tracking-wider text-muted-foreground">
                      {b.liquidity}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Panel>

          {bond && (
            <div className="col-span-12 lg:col-span-5 space-y-2.5">
              <Panel
                title={`${bond.name} · ${bond.isin}`}
                endpoint={`bonds_c[${bond.isin}]`}
                dataSource="supabase"
              >
                <div className="grid grid-cols-3 gap-2 text-xs">
                  {[
                    ["Issuer", bond.issuer],
                    ["Coupon", `${bond.coupon}%`],
                    ["Maturity", bond.maturity],
                    ["YTM", `${bond.ytm.toFixed(3)}%`],
                    ["Clean", bond.clean.toFixed(3)],
                    ["Dirty", bond.dirty.toFixed(3)],
                    ["Mod Dur", bond.modDur.toFixed(2)],
                    ["DV01", `R${bond.dv01.toFixed(2)}`],
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
              {/* Yellow #14 — the KRD placeholder panel was deleted
                  in this audit. The DV01 + convexity sensitivity
                  chart (rendered below) is the one we keep. */}
            </div>
          )}
        </div>
      )}

      <div className="grid grid-cols-12 gap-2.5">
        <Panel
          title="ZAR govi · today vs 1D / 1W / 1M"
          endpoint="GET /api/curves/ZAR_GOVI"
          dataSource="unconfigured"
          className="col-span-12 lg:col-span-7 h-[300px]"
        >
          {/* Yellow #16 — the same TimeSeriesGet2 entitlement story
              the Curves page tells, but here we use the shared
              EntitlementRequired primitive so the message is
              consistent across the three call-sites (Cockpit, Fixed
              Income, Curves). */}
          <EntitlementRequired
            method="TimeSeriesGet2"
            codes={["ZAR_NSS", "ZAR_GOVI"]}
            note="Curve history requires TimeSeriesGet2 on the production IRESS V4 profile. Ask Charles."
          />
        </Panel>

        {bond && (
          <Panel
            title="P&L sensitivity · ±100bp"
            endpoint="INTERNAL · DV01 + convexity"
            dataSource="code-gap"
            className="col-span-12 lg:col-span-5 h-[300px]"
          >
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={sensitivity} margin={{ top: 8, right: 8, left: -20, bottom: 0 }}>
                <CartesianGrid stroke="hsl(var(--border))" strokeDasharray="2 4" vertical={false} />
                <XAxis dataKey="bp" tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} stroke="hsl(var(--border))" />
                <YAxis
                  tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }}
                  stroke="hsl(var(--border))"
                  tickFormatter={(v: number) => `${(v / 1000).toFixed(1)}k`}
                />
                <Tooltip
                  contentStyle={{
                    fontSize: 11,
                    background: "hsl(var(--popover))",
                    border: "1px solid hsl(var(--border))",
                    borderRadius: 6,
                  }}
                  formatter={(v: number) => `R${(v / 1000).toFixed(1)}k`}
                />
                <Bar dataKey="pnl" radius={[2, 2, 0, 0]}>
                  {sensitivity.map((d, i) => (
                    <Cell key={i} fill={d.pnl >= 0 ? "hsl(152 70% 50%)" : "hsl(351 90% 60%)"} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </Panel>
        )}
      </div>
    </div>
  );
}
