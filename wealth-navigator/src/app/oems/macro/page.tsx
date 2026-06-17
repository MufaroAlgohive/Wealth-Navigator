"use client";

import { useQuery } from "@tanstack/react-query";
import { ArrowUpRight, ArrowDownRight, AlertCircle } from "lucide-react";

import { Panel } from "@/components/oems/primitives/panel";
import { KpiTile } from "@/components/oems/primitives/kpi-tile";
import { Pill } from "@/components/oems/primitives/pill";
import { PanelSkeleton, KpiTileSkeleton } from "@/components/oems/primitives/panel-skeleton";
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
      <div className="space-y-3">
        <header>
          <h1 className="text-lg font-semibold tracking-tight">Macro</h1>
          <p className="text-xs text-muted-foreground">SARB · StatsSA · G10 series · indicator surprise · upcoming releases</p>
        </header>
        <Panel title="Macro indicators" endpoint="macro_indicator_c + macro_release_c">
          <EmptyDataState
            message="Mock mode disables the macro module."
            hint="Switch to real-data mode and ensure the worker has written macro_indicator_c + macro_release_c rows."
            badgeLabel="mock"
          />
        </Panel>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <header>
        <h1 className="text-lg font-semibold tracking-tight">Macro</h1>
        <p className="text-xs text-muted-foreground">SARB · StatsSA · G10 series · indicator surprise · upcoming releases</p>
      </header>

      <div className="grid grid-cols-2 gap-2.5 md:grid-cols-4 lg:grid-cols-6">
        {isLoading ? (
          [0, 1, 2, 3, 4, 5].map((n) => <KpiTileSkeleton key={`macro-kpi-${n}`} />)
        ) : indicators.length === 0 ? (
          <div className="col-span-full">
            <Panel
              title="Macro indicators"
              endpoint="GET /api/sa-rates"
              dataSource="unconfigured"
            >
              <EmptyDataState
                message="SARB feed unavailable."
                hint={macroQ.data?.message ?? "Official SA rates + inflation come from the SARB public Web API (resbank.co.za); it returned no data this cycle."}
              />
            </Panel>
          </div>
        ) : (
          indicators.slice(0, 6).map((m) => (
            <KpiTile
              key={m.id}
              label={m.name}
              value={`${m.value}${m.unit}`}
              sub={<span className="flex items-center gap-1">prior {m.prior}</span>}
              icon={m.trend === "up" ? <ArrowUpRight className="h-3 w-3" /> : m.trend === "down" ? <ArrowDownRight className="h-3 w-3" /> : undefined}
              tone={m.trend === "up" ? "positive" : m.trend === "down" ? "negative" : "default"}
            />
          ))
        )}
      </div>

      {hasData && releases.length > 0 && (
        <Panel
          title="Upcoming releases · 14 days"
          endpoint="macro_release_c"
          dataSource="supabase"
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
                    <Pill
                      tone={r.importance === "high" ? "destructive" : r.importance === "medium" ? "warning" : "neutral"}
                      size="xs"
                      dot
                    >
                      {r.importance}
                    </Pill>
                  </td>
                  <td className="px-3 py-1.5 flex flex-wrap gap-1">
                    {r.tags.map((t) => (
                      <span key={t} className="rounded bg-muted/60 px-1.5 py-0.5 text-[9.5px] text-muted-foreground">
                        {t}
                      </span>
                    ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      )}

      <div className="rounded-md border border-info/30 bg-info/5 p-3 text-[11.5px] text-info">
        <p className="flex items-center gap-2 font-semibold">
          <AlertCircle className="h-3.5 w-3.5" />
          Indicators are live from SARB; the release calendar needs a vendor
        </p>
        <p className="mt-1 text-muted-foreground">
          Indicators (repo, prime, CPI, PPI, ZARONIA, Sabor, ZAR FX) come live from the{" "}
          <span className="font-mono">SARB public Web API</span> via <span className="font-mono">/api/sa-rates</span>.
          The <span className="font-mono">Upcoming releases</span> calendar still needs an economic-calendar vendor
          (StatsSA / Reuters) — it stays empty until <span className="font-mono">macro_release_c</span> is populated.
        </p>
      </div>
    </div>
  );
}
