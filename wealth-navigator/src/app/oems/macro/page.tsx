"use client";

import { useQuery } from "@tanstack/react-query";
import { ArrowUpRight, ArrowDownRight, AlertCircle } from "lucide-react";

import { GlassSection, GlassKpi, PageCanvas } from "@/components/oems/primitives/glass";
import { Pill } from "@/components/oems/primitives/pill";
import { EmptyDataState } from "@/components/oems/primitives/empty-data-state";
import { isRealDataOnlyClient } from "@/lib/data-policy";
import { cn } from "@/lib/cn";
import { queryOpts } from "@/lib/store/query-provider";

interface IndicatorRow {
  id: string;
  name: string;
  country: string;
  value: number;
  unit: string;
  prior: number;
  trend: "up" | "down" | "flat";
  asOf: string;
  source: string;
}

interface ReleaseRow {
  id: string;
  indicatorId: string;
  name: string;
  ts: number;
  country: string;
  source: string;
  consensus: number;
  prior: number;
  importance: "low" | "medium" | "high" | string;
  tags: string[];
}

interface MacroResponse {
  indicators: IndicatorRow[];
  releases: ReleaseRow[];
  source: string;
  message?: string;
}

function trendAccent(trend: IndicatorRow["trend"]): "default" | "positive" | "negative" {
  if (trend === "up") return "positive";
  if (trend === "down") return "negative";
  return "default";
}

export default function MacroPage() {
  const realDataOnly = isRealDataOnlyClient();
  const macroQ = useQuery<MacroResponse>({
    queryKey: ["bff-macro"],
    queryFn: async () => {
      const r = await fetch("/api/macro", { cache: "no-store" });
      if (!r.ok) throw new Error(`Macro BFF ${r.status}`);
      return r.json();
    },
    enabled: realDataOnly,
    refetchInterval: 60_000,
    ...queryOpts("reference"),
  });
  // SARB public Web API — official SA rates + inflation (repo / prime / CPI /
  // PPI / ZARONIA / Sabor). IRESS V4 has no macro feed and there's no vendor
  // ingest into macro_indicator_c, so SARB is the real indicator source.
  type SaRate = { label: string; value: number | null; asOf: string | null } | null;
  const saRatesQ = useQuery<{ source: string; sourceLabel?: string; rates: Record<string, SaRate> }>({
    queryKey: ["bff-sa-rates"],
    queryFn: async () => {
      const r = await fetch("/api/sa-rates", { cache: "no-store" });
      if (!r.ok) throw new Error(`sa-rates ${r.status}`);
      return r.json();
    },
    enabled: realDataOnly,
    refetchInterval: 3_600_000,
    ...queryOpts("reference"),
  });
  const sa = saRatesQ.data?.rates;
  const mk = (id: string, name: string, r: SaRate | undefined, unit: string): IndicatorRow | null =>
    r && r.value != null
      ? { id, name, country: "ZA", value: r.value, unit, prior: r.value, trend: "flat", asOf: r.asOf ?? "", source: "SARB" }
      : null;
  const saIndicators: IndicatorRow[] = sa
    ? ([
        mk("repo", "SARB Repo", sa.repo, "%"),
        mk("prime", "Prime", sa.prime, "%"),
        mk("cpi", "CPI y/y", sa.cpi, "%"),
        mk("ppi", "PPI y/y", sa.ppi, "%"),
        mk("zaronia", "ZARONIA", sa.zaronia, "%"),
        mk("sabor", "Sabor", sa.sabor, "%"),
        mk("usdzar", "USD/ZAR", sa.usdzar, ""),
        mk("neer", "NEER", sa.neer, ""),
      ].filter(Boolean) as IndicatorRow[])
    : [];

  // Prefer a real vendor ingest if it ever lands; otherwise SARB.
  const indicators = (macroQ.data?.indicators?.length ? macroQ.data.indicators : saIndicators) ?? [];
  const releases = macroQ.data?.releases ?? [];
  const isLoading = macroQ.isLoading || saRatesQ.isLoading;
  const hasData = indicators.length > 0 || releases.length > 0;

  if (!realDataOnly) {
    return (
      <PageCanvas>
        <header>
          <h1 className="text-display">Macro</h1>
          <p className="text-caption mt-1">SARB · StatsSA · G10 series · indicator surprise · upcoming releases</p>
        </header>
        <GlassSection title="Macro indicators" endpoint="GET /api/macro" db="institutional" dataSource="mock">
          <EmptyDataState
            message="Mock mode disables the macro module."
            hint="Switch to real-data mode and ensure the worker has written macro_indicator_c + macro_release_c rows."
            badgeLabel="mock"
          />
        </GlassSection>
      </PageCanvas>
    );
  }

  return (
    <PageCanvas>
      <header>
        <h1 className="text-display">Macro</h1>
        <p className="text-caption mt-1">SARB · StatsSA · G10 series · indicator surprise · upcoming releases</p>
      </header>

      <GlassSection
        title="Macro indicators"
        subtitle="SARB repo · prime · inflation · FX"
        endpoint="GET /api/macro"
        dataSource="external"
      >
        {isLoading ? (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-4">
            {Array.from({ length: 8 }).map((_, n) => (
              <div key={`macro-kpi-${n}`} className="h-20 animate-pulse rounded-2xl bg-[hsl(var(--foreground)/0.05)]" />
            ))}
          </div>
        ) : indicators.length === 0 ? (
          <EmptyDataState
            message="SARB feed unavailable."
            hint={macroQ.data?.message ?? "Official SA rates + inflation come from the SARB public Web API (resbank.co.za); it returned no data this cycle."}
          />
        ) : (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-4">
              {indicators.map((m) => (
                <GlassKpi
                  key={m.id}
                  label={m.name}
                  value={`${m.value}${m.unit}`}
                  sub={`prior ${m.prior}${m.unit}`}
                  accent={trendAccent(m.trend)}
                />
              ))}
            </div>

            <div className="glass-inset overflow-hidden">
              <div className="overflow-x-auto scrollbar-thin">
                <table className="w-full min-w-[640px] font-mono text-xs">
                  <thead>
                    <tr className="border-b border-[hsl(var(--glass-border))] bg-[hsl(var(--foreground)/0.02)]">
                      <th className="px-4 py-2.5 text-left text-caption font-medium">Indicator</th>
                      <th className="px-4 py-2.5 text-left text-caption font-medium">Country</th>
                      <th className="px-4 py-2.5 text-right text-caption font-medium">Value</th>
                      <th className="px-4 py-2.5 text-right text-caption font-medium">Prior</th>
                      <th className="px-4 py-2.5 text-left text-caption font-medium">Trend</th>
                      <th className="px-4 py-2.5 text-left text-caption font-medium">As of</th>
                      <th className="px-4 py-2.5 text-left text-caption font-medium">Source</th>
                    </tr>
                  </thead>
                  <tbody>
                    {indicators.map((m) => (
                      <tr
                        key={m.id}
                        className="border-b border-[hsl(var(--glass-border))]/60 transition-colors hover:bg-[hsl(var(--primary)/0.04)]"
                      >
                        <td className="px-4 py-2 font-semibold">{m.name}</td>
                        <td className="px-4 py-2 text-muted-foreground">{m.country}</td>
                        <td className="px-4 py-2 text-right tabular-nums font-semibold">
                          {m.value}
                          {m.unit}
                        </td>
                        <td className="px-4 py-2 text-right tabular-nums text-muted-foreground">
                          {m.prior}
                          {m.unit}
                        </td>
                        <td className="px-4 py-2">
                          <span
                            className={cn(
                              "inline-flex items-center gap-1 text-[11px] font-medium",
                              m.trend === "up" && "text-up",
                              m.trend === "down" && "text-down",
                              m.trend === "flat" && "text-muted-foreground",
                            )}
                          >
                            {m.trend === "up" && <ArrowUpRight className="h-3 w-3" />}
                            {m.trend === "down" && <ArrowDownRight className="h-3 w-3" />}
                            {m.trend}
                          </span>
                        </td>
                        <td className="px-4 py-2 text-muted-foreground">{m.asOf || "—"}</td>
                        <td className="px-4 py-2 text-muted-foreground">{m.source}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}
      </GlassSection>

      {hasData && releases.length > 0 && (
        <GlassSection
          title="Upcoming releases · 14 days"
          endpoint="GET /api/macro"
          db="institutional"
          dataSource="supabase"
          right={<span className="font-mono text-[10px] text-muted-foreground">{releases.length} scheduled</span>}
          noPadding
          className="flex flex-col"
        >
          <div className="p-5 pt-0">
            <div className="glass-inset max-h-[320px] overflow-hidden">
              <div className="max-h-[320px] overflow-y-auto scrollbar-thin">
                <table className="w-full font-mono text-xs">
                  <thead className="sticky top-0 z-10 bg-[hsl(var(--foreground)/0.03)] backdrop-blur-sm">
                    <tr className="border-b border-[hsl(var(--glass-border))]">
                      <th className="px-4 py-2.5 text-left text-caption font-medium">Date / Time</th>
                      <th className="px-4 py-2.5 text-left text-caption font-medium">Series</th>
                      <th className="px-4 py-2.5 text-left text-caption font-medium">Source</th>
                      <th className="px-4 py-2.5 text-left text-caption font-medium">Country</th>
                      <th className="px-4 py-2.5 text-right text-caption font-medium">Consensus</th>
                      <th className="px-4 py-2.5 text-right text-caption font-medium">Prior</th>
                      <th className="px-4 py-2.5 text-left text-caption font-medium">Importance</th>
                      <th className="px-4 py-2.5 text-left text-caption font-medium">Tags</th>
                    </tr>
                  </thead>
                  <tbody>
                    {releases.map((r) => (
                      <tr
                        key={r.id}
                        className="border-b border-[hsl(var(--glass-border))]/60 transition-colors hover:bg-[hsl(var(--primary)/0.04)]"
                      >
                        <td className="px-4 py-2">
                          <p className="font-semibold">
                            {new Date(r.ts).toLocaleDateString("en-ZA", { weekday: "short", day: "2-digit", month: "short" })}
                          </p>
                          <p className="text-[9.5px] text-muted-foreground">
                            {new Date(r.ts).toLocaleTimeString("en-ZA", { hour: "2-digit", minute: "2-digit", timeZone: "Africa/Johannesburg" })}{" "}
                            SAST
                          </p>
                        </td>
                        <td className="px-4 py-2">{r.name}</td>
                        <td className="px-4 py-2 text-muted-foreground">{r.source}</td>
                        <td className="px-4 py-2 text-muted-foreground">{r.country}</td>
                        <td className="px-4 py-2 text-right tabular-nums font-semibold">{r.consensus}</td>
                        <td className="px-4 py-2 text-right tabular-nums text-muted-foreground">{r.prior}</td>
                        <td className="px-4 py-2">
                          <Pill
                            tone={r.importance === "high" ? "destructive" : r.importance === "medium" ? "warning" : "neutral"}
                            size="xs"
                            dot
                          >
                            {r.importance}
                          </Pill>
                        </td>
                        <td className="px-4 py-2">
                          <div className="flex flex-wrap gap-1">
                            {r.tags.map((t) => (
                              <span
                                key={t}
                                className="rounded-md bg-[hsl(var(--foreground)/0.06)] px-1.5 py-0.5 text-[9.5px] text-muted-foreground"
                              >
                                {t}
                              </span>
                            ))}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </GlassSection>
      )}

      <div className="glass-inset p-4 text-[11.5px]">
        <p className="flex items-center gap-2 font-semibold text-info">
          <AlertCircle className="h-3.5 w-3.5 shrink-0" />
          Indicators are live from SARB; the release calendar needs a vendor
        </p>
        <p className="mt-1.5 text-caption leading-relaxed">
          Indicators (repo, prime, CPI, PPI, ZARONIA, Sabor, ZAR FX) come live from the{" "}
          <span className="font-mono">SARB public Web API</span> via <span className="font-mono">/api/sa-rates</span>.
          The <span className="font-mono">Upcoming releases</span> calendar still needs an economic-calendar vendor
          (StatsSA / Reuters) — it stays empty until <span className="font-mono">macro_release_c</span> is populated.
        </p>
      </div>
    </PageCanvas>
  );
}
