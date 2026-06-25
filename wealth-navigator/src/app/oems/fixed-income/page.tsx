"use client";

import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Landmark, Search } from "lucide-react";

import { GlassBadge, GlassSection, PageCanvas } from "@/components/oems/primitives/glass";
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
  coupon: number | null;
  maturity: string;
  // null = not priced by the worker yet → renders "—" (never a fabricated 0).
  ytm: number | null;
  clean: number | null;
  dirty: number | null;
  modDur: number | null;
  dv01: number | null;
  convexity: number | null;
  spread: number | null;
  rating: string;
  liquidity: string;
  asOf: string;
}

/** Format a nullable metric, showing "—" when the value isn't available. */
function fx(v: number | null | undefined, dp = 2, suffix = ""): string {
  return v != null ? `${v.toFixed(dp)}${suffix}` : "—";
}

interface BondsResponse {
  bonds: BondRow[];
  source: string;
  message?: string;
}

const CHART_TOOLTIP_STYLE = {
  fontSize: 11,
  background: "hsl(var(--glass-bg-strong))",
  border: "1px solid hsl(var(--glass-border))",
  borderRadius: 12,
  backdropFilter: "blur(12px)",
} as const;

function GlassTableShell({ children }: { children: React.ReactNode }) {
  return <div className="glass-inset overflow-hidden">{children}</div>;
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
    // Needs real DV01 + convexity; if the bond isn't priced yet, return empty
    // so the panel shows its empty state rather than a fabricated curve.
    if (!bond || bond.dv01 == null || bond.convexity == null) return [];
    const dv01 = bond.dv01;
    const convexity = bond.convexity;
    return [-100, -50, -25, 0, 25, 50, 100].map((bp) => ({
      bp: `${bp >= 0 ? "+" : ""}${bp}`,
      pnl: -dv01 * bp - 0.5 * convexity * Math.pow(bp / 100, 2) * 10000,
    }));
  }, [bond]);

  return (
    <PageCanvas>
      <header className="glass-panel relative overflow-hidden p-5 md:p-6">
        <div className="pointer-events-none absolute -right-16 -top-16 h-40 w-40 rounded-full bg-primary/10 blur-3xl" />
        <div className="relative space-y-3">
          <GlassBadge tone="primary">
            <Landmark className="h-3.5 w-3.5" />
            ZAR bonds desk
          </GlassBadge>
          <h1 className="text-display text-2xl">Fixed Income</h1>
          <p className="text-caption max-w-2xl">
            Clean/dirty pricing · DV01 · convexity · spread to curve
          </p>
        </div>
      </header>

      {bondsQ.isLoading ? (
        <PanelSkeleton rows={8} height="h-[420px]" className="col-span-12" />
      ) : bonds.length === 0 ? (
        <GlassSection
          title="Bond screener"
          endpoint="GET /api/bonds"
          db="institutional"
          dataSource="blocked-vendor"
        >
          <EmptyDataState
            message="No bonds ingested yet."
            hint={bondsQ.data?.message ?? "No bonds available. Bond pricing requires appropriate entitlements."}
            badgeLabel="blocked-vendor"
          />
        </GlassSection>
      ) : (
        <div className="grid grid-cols-12 gap-3">
          <GlassSection
            title="Bond screener"
            endpoint="GET /api/bonds"
            db="institutional"
            dataSource="iress"
            className="col-span-12 flex h-[420px] flex-col lg:col-span-7"
            noPadding
            right={
              <div className="relative w-52">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  placeholder="ISIN / issuer / name"
                  className="glass-inset h-8 border-0 pl-8 text-xs shadow-none"
                />
              </div>
            }
          >
            <GlassTableShell>
              <div className="max-h-[360px] overflow-y-auto scrollbar-thin">
                <table className="w-full font-mono text-xs">
                  <thead className="sticky top-0 z-10 bg-[hsl(var(--glass-bg-strong))] backdrop-blur-md">
                    <tr className="border-b border-[hsl(var(--glass-border))] text-[9.5px] uppercase tracking-wider text-muted-foreground">
                      <th className="px-4 py-2.5 text-left font-medium">Name</th>
                      <th className="px-4 py-2.5 text-left font-medium">Issuer</th>
                      <th className="px-4 py-2.5 text-right font-medium">YTM</th>
                      <th className="px-4 py-2.5 text-right font-medium">Clean</th>
                      <th className="px-4 py-2.5 text-right font-medium">Mod Dur</th>
                      <th className="px-4 py-2.5 text-right font-medium">DV01</th>
                      <th className="px-4 py-2.5 text-right font-medium">Spd</th>
                      <th className="px-4 py-2.5 text-left font-medium">Rtg</th>
                      <th className="px-4 py-2.5 text-left font-medium">Liq</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map((b) => (
                      <tr
                        key={b.isin}
                        onClick={() => setSelected(b.isin)}
                        className={cn(
                          "cursor-pointer border-b border-[hsl(var(--glass-border))]/60 transition-colors last:border-0 hover:bg-[hsl(var(--primary)/0.04)]",
                          b.isin === effectiveSelected && "bg-[hsl(var(--primary)/0.08)]",
                        )}
                      >
                        <td className="px-4 py-2 font-semibold">{b.name}</td>
                        <td className="px-4 py-2 text-muted-foreground">{b.issuer}</td>
                        <td className="px-4 py-2 text-right tabular-nums">{fx(b.ytm, 2, "%")}</td>
                        <td className="px-4 py-2 text-right tabular-nums">{fx(b.clean, 2)}</td>
                        <td className="px-4 py-2 text-right tabular-nums">{fx(b.modDur, 2)}</td>
                        <td className="px-4 py-2 text-right tabular-nums">{fx(b.dv01, 2)}</td>
                        <td
                          className={cn(
                            "px-4 py-2 text-right tabular-nums",
                            (b.spread ?? 0) > 0 && "text-warning",
                          )}
                        >
                          {b.spread != null && b.spread > 0 ? `+${b.spread}` : "—"}
                        </td>
                        <td className="px-4 py-2">
                          <Pill
                            tone={b.rating.startsWith("AA") ? "success" : b.rating.startsWith("BB") ? "warning" : "neutral"}
                            size="xs"
                          >
                            {b.rating}
                          </Pill>
                        </td>
                        <td className="px-4 py-2 text-[9.5px] uppercase tracking-wider text-muted-foreground">
                          {b.liquidity}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </GlassTableShell>
          </GlassSection>

          {bond && (
            <div className="col-span-12 space-y-3 lg:col-span-5">
              <GlassSection
                title={`${bond.name} · ${bond.isin}`}
                endpoint="GET /api/bonds"
                db="institutional"
                dataSource="iress"
              >
                <div className="grid grid-cols-3 gap-2">
                  {[
                    ["Issuer", bond.issuer],
                    ["Coupon", bond.coupon != null ? `${bond.coupon}%` : "—"],
                    ["Maturity", bond.maturity],
                    ["YTM", fx(bond.ytm, 3, "%")],
                    ["Clean", fx(bond.clean, 3)],
                    ["Dirty", fx(bond.dirty, 3)],
                    ["Mod Dur", fx(bond.modDur, 2)],
                    ["DV01", bond.dv01 != null ? `R${bond.dv01.toFixed(2)}` : "—"],
                    ["Convexity", fx(bond.convexity, 1)],
                    ["Rating", bond.rating],
                    ["Spread", bond.spread != null ? `${bond.spread}bp` : "—"],
                    ["Liquidity", bond.liquidity],
                  ].map(([l, v]) => (
                    <div key={l} className="glass-inset p-2.5">
                      <p className="text-[9px] uppercase tracking-wider text-muted-foreground">{l}</p>
                      <p className="text-metric mt-1 text-sm">{v}</p>
                    </div>
                  ))}
                </div>
              </GlassSection>
            </div>
          )}
        </div>
      )}

      <div className="grid grid-cols-12 gap-3">
        <GlassSection
          title="ZAR govi · today vs 1D / 1W / 1M"
          endpoint="GET /api/curves/ZAR_GOVI"
          db="institutional"
          dataSource="blocked-external"
          className="col-span-12 flex h-[300px] flex-col lg:col-span-7"
        >
          <EntitlementRequired
            method="TimeSeriesGet2"
            codes={["ZAR_NSS", "ZAR_GOVI"]}
            note="Historical curve data requires additional entitlements. Contact your administrator."
          />
        </GlassSection>

        {bond && (
          <GlassSection
            title="P&L sensitivity · ±100bp"
            endpoint="GET /api/bonds"
            db="institutional"
            dataSource="iress"
            className="col-span-12 flex h-[300px] flex-col lg:col-span-5"
            noPadding
          >
            {sensitivity.length === 0 ? (
              <div className="p-5">
                <EmptyDataState
                  message="Sensitivity unavailable — bond not priced yet."
                  hint="DV01 and convexity must be written by the worker before the ±100bp P&L chart can render."
                />
              </div>
            ) : (
              <div className="flex min-h-0 flex-1 flex-col p-5">
                <div className="glass-inset min-h-0 flex-1 p-3">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={sensitivity} margin={{ top: 8, right: 8, left: -20, bottom: 0 }}>
                      <CartesianGrid stroke="hsl(var(--border))" strokeDasharray="2 4" vertical={false} />
                      <XAxis
                        dataKey="bp"
                        tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }}
                        stroke="hsl(var(--border))"
                      />
                      <YAxis
                        tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }}
                        stroke="hsl(var(--border))"
                        tickFormatter={(v: number) => `${(v / 1000).toFixed(1)}k`}
                      />
                      <Tooltip
                        contentStyle={CHART_TOOLTIP_STYLE}
                        formatter={(v: number) => `R${(v / 1000).toFixed(1)}k`}
                      />
                      <Bar dataKey="pnl" radius={[4, 4, 0, 0]}>
                        {sensitivity.map((d, i) => (
                          <Cell key={i} fill={d.pnl >= 0 ? "hsl(152 70% 50%)" : "hsl(351 90% 60%)"} />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </div>
            )}
          </GlassSection>
        )}
      </div>
    </PageCanvas>
  );
}
