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
  const indicators = macroQ.data?.indicators ?? [];
  const releases = macroQ.data?.releases ?? [];
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
        {macroQ.isLoading ? (
          [0, 1, 2, 3, 4, 5].map((n) => <KpiTileSkeleton key={`macro-kpi-${n}`} />)
        ) : indicators.length === 0 ? (
          <div className="col-span-full">
            <Panel
              title="Macro indicators"
              endpoint="GET /api/macro"
              dataSource="unconfigured"
            >
              <EmptyDataState
                message="No macro indicators ingested."
                hint={macroQ.data?.message ?? "macro_indicator_c is empty. Macro requires a vendor contract (SARB / StatsSA / Reuters)."}
                badgeLabel="blocked-vendor"
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
          Macro is a derived read, not a feed
        </p>
        <p className="mt-1 text-muted-foreground">
          The Macro page reads <span className="font-mono">macro_indicator_c</span> (time series) and <span className="font-mono">macro_release_c</span> (calendar). Both are populated by a vendor ingest (SARB / StatsSA / Reuters) — v1 has no contracted vendor, so the panel renders the honest <span className="font-mono">BLOCKED-VENDOR</span> state.
        </p>
      </div>
    </div>
  );
}
