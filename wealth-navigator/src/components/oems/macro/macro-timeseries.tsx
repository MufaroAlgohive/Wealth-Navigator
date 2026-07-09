"use client";

/**
 * A7.7 — 3-year line chart of the headline SA macro series: SARB repo,
 * prime, ZARONIA, and household-debt-to-GDP. Each series renders as its
 * own line; the household-debt-to-GDP series is a `code-gap` placeholder
 * until a vendor (or SARB data portal key) lands, so the chart draws it
 * as a dashed stub and surfaces an honest explanatory empty state below
 * the chart.
 *
 * The chart merges the series onto a common time axis: one row per
 * observation date, with `null` where a series didn't observe on that
 * date (recharts draws a gap by default).
 */

import { useQuery } from "@tanstack/react-query";
import { ArrowDownRight, ArrowUpRight, Calendar, Loader2 } from "lucide-react";
import { useMemo, useState } from "react";
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

import { EmptyDataState } from "@/components/oems/primitives/empty-data-state";
import { GlassSection } from "@/components/oems/primitives/glass";
import { cn } from "@/lib/cn";
import { queryOpts } from "@/lib/store/query-provider";

interface TimeseriesPoint {
  date: string;
  value: number;
}

interface TimeseriesSeries {
  id: "repo" | "prime" | "zaronia" | "household_debt_to_gdp";
  label: string;
  code: string;
  unit: "%";
  source: "sarb" | "code-gap";
  points: TimeseriesPoint[];
  asOf: string | null;
  error?: string;
}

interface TimeseriesResponse {
  source: "sarb" | "unavailable";
  reason?: string;
  series: TimeseriesSeries[];
}

interface MergedRow {
  date: string;
  repo?: number;
  prime?: number;
  zaronia?: number;
  household_debt_to_gdp?: number;
}

function pctFmt(v: number | string | null | undefined): string {
  if (v == null) return "—";
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return "—";
  return `${n.toFixed(2)}%`;
}

function pctDelta(a: number | null, b: number | null): number | null {
  if (a == null || b == null) return null;
  return a - b;
}

function rowForSeries(latest: number | null, prior: number | null, asOf: string | null) {
  const delta = pctDelta(latest, prior);
  return { latest, prior, delta, asOf };
}

export function MacroTimeseries() {
  const q = useQuery<TimeseriesResponse>({
    queryKey: ["bff-sa-rates-timeseries"],
    queryFn: async () => {
      const r = await fetch("/api/sa-rates/timeseries", { cache: "no-store" });
      if (!r.ok) throw new Error(`sa-rates/timeseries ${r.status}`);
      return r.json();
    },
    refetchInterval: 3_600_000,
    ...queryOpts("reference"),
  });

  const series = q.data?.series ?? [];
  const [active, setActive] = useState<Record<string, boolean>>({
    repo: true,
    prime: true,
    zaronia: false,
    household_debt_to_gdp: false,
  });

  const merged = useMemo<MergedRow[]>(() => {
    const byDate = new Map<string, MergedRow>();
    for (const s of series) {
      for (const p of s.points) {
        const row = byDate.get(p.date) ?? { date: p.date };
        row[s.id] = p.value;
        byDate.set(p.date, row);
      }
    }
    return Array.from(byDate.values()).sort((a, b) => a.date.localeCompare(b.date));
  }, [series]);

  const latestById: Record<string, { latest: number | null; prior: number | null; asOf: string | null }> =
    useMemo(() => {
      const out: Record<string, { latest: number | null; prior: number | null; asOf: string | null }> = {};
      for (const s of series) {
        const len = s.points.length;
        const latest = len > 0 ? s.points[len - 1]!.value : null;
        const prior = len > 1 ? s.points[len - 2]!.value : null;
        const asOf = len > 0 ? s.points[len - 1]!.date : null;
        out[s.id] = { latest, prior, asOf };
      }
      return out;
    }, [series]);

  const anyData = merged.length > 0;
  const hasGap = series.some((s) => s.source === "code-gap" || s.error === "code-gap");
  const lines: Array<{ id: keyof MergedRow; label: string; color: string; dashed: boolean; unit: string }> = [
    { id: "repo", label: "SARB Repo", color: "hsl(var(--primary))", dashed: false, unit: "%" },
    { id: "prime", label: "Prime", color: "hsl(var(--info))", dashed: false, unit: "%" },
    { id: "zaronia", label: "ZARONIA", color: "hsl(var(--up))", dashed: false, unit: "%" },
    {
      id: "household_debt_to_gdp",
      label: "Household debt / GDP",
      color: "hsl(var(--muted-foreground))",
      dashed: true,
      unit: "%",
    },
  ];

  return (
    <GlassSection
      title="Macro time-series · 3 years"
      subtitle="SARB repo, prime, ZARONIA, household debt-to-GDP"
      endpoint="GET /api/sa-rates/timeseries"
      db="institutional"
      dataSource="external"
      right={<Calendar className="h-3.5 w-3.5 text-muted-foreground" />}
    >
      {q.isLoading ? (
        <div className="flex h-[280px] items-center justify-center text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
        </div>
      ) : !anyData ? (
        <EmptyDataState
          message="SARB time-series feed returned no data."
          hint="The SARB public Web API endpoint for these series either rejected the request or returned an empty result. The single-snapshot indicators still load via /api/sa-rates."
          badgeLabel="external"
        />
      ) : (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
            {lines.map((l) => {
              const stat = rowForSeries(
                latestById[l.id]?.latest ?? null,
                latestById[l.id]?.prior ?? null,
                latestById[l.id]?.asOf ?? null,
              );
              const enabled = active[l.id];
              return (
                <button
                  key={l.id}
                  type="button"
                  onClick={() => setActive((s) => ({ ...s, [l.id]: !s[l.id] }))}
                  className={cn(
                    "glass-inset rounded-xl px-3 py-2 text-left transition-all duration-150 ease-out",
                    enabled ? "ring-1 ring-primary/40" : "opacity-60 hover:opacity-90",
                  )}
                  aria-pressed={enabled}
                >
                  <div className="flex items-center gap-2">
                    <span className="h-2 w-2 rounded-full" style={{ background: l.color }} />
                    <span className="text-[10.5px] font-medium uppercase tracking-wider text-muted-foreground">
                      {l.label}
                    </span>
                    {l.dashed ? (
                      <span className="font-mono text-[9px] text-muted-foreground/70">code-gap</span>
                    ) : null}
                  </div>
                  <div className="mt-1.5 flex items-baseline gap-1.5">
                    <span className="font-mono text-lg font-semibold tabular-nums">
                      {pctFmt(stat.latest)}
                    </span>
                    {stat.delta != null ? (
                      <span
                        className={cn(
                          "inline-flex items-center gap-0.5 font-mono text-[10px]",
                          stat.delta > 0 ? "text-up" : stat.delta < 0 ? "text-down" : "text-muted-foreground",
                        )}
                      >
                        {stat.delta > 0 ? (
                          <ArrowUpRight className="h-3 w-3" />
                        ) : stat.delta < 0 ? (
                          <ArrowDownRight className="h-3 w-3" />
                        ) : null}
                        {stat.delta > 0 ? "+" : ""}
                        {stat.delta.toFixed(2)}pp
                      </span>
                    ) : null}
                  </div>
                  <div className="text-[9.5px] text-muted-foreground/80">
                    {stat.asOf ? `as of ${stat.asOf}` : "no recent obs"}
                    {stat.prior != null ? ` · prior ${pctFmt(stat.prior)}` : ""}
                  </div>
                </button>
              );
            })}
          </div>

          <div className="glass-inset rounded-xl p-3">
            <div className="h-[260px] w-full">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={merged} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
                  <CartesianGrid stroke="hsl(var(--glass-border))" strokeDasharray="3 3" vertical={false} />
                  <XAxis
                    dataKey="date"
                    stroke="hsl(var(--muted-foreground))"
                    tick={{ fontSize: 10 }}
                    minTickGap={32}
                  />
                  <YAxis
                    stroke="hsl(var(--muted-foreground))"
                    tick={{ fontSize: 10 }}
                    width={56}
                    tickFormatter={(v) => `${v}%`}
                  />
                  <Tooltip
                    contentStyle={{
                      background: "hsl(var(--background))",
                      border: "1px solid hsl(var(--glass-border))",
                      fontSize: 11,
                    }}
                    formatter={
                      ((v: unknown) =>
                        v == null ? "—" : `${(typeof v === "number" ? v : Number(v)).toFixed(2)}%`) as never
                    }
                    labelStyle={{ fontSize: 11, color: "hsl(var(--muted-foreground))" }}
                  />
                  <Legend wrapperStyle={{ fontSize: 10 }} />
                  {lines.map((l) =>
                    active[l.id] ? (
                      <Line
                        key={l.id}
                        type="monotone"
                        dataKey={l.id}
                        name={l.label}
                        stroke={l.color}
                        strokeWidth={2}
                        strokeDasharray={l.dashed ? "5 4" : undefined}
                        dot={false}
                        connectNulls={false}
                        isAnimationActive={false}
                      />
                    ) : null,
                  )}
                </LineChart>
              </ResponsiveContainer>
            </div>
            <p className="mt-2 text-[10.5px] leading-snug text-muted-foreground/80">
              Source: SARB public Web API (<code>resbank.co.za</code>). Cached 1h. Last refreshed by the daily
              cron — see <code>vercel.json</code> <code>/api/cron/sa-rates</code>.
            </p>
          </div>

          {hasGap ? (
            <div className="glass-inset rounded-xl p-3 text-[11px] text-muted-foreground">
              <strong className="text-foreground">Household debt / GDP</strong> isn't in the SARB public Web
              API — it's published through the SARB data portal (no free public key). The chart draws it as a
              dashed
              <code>code-gap</code> stub so the line is visible. A paid vendor or a SARB data portal key is
              required to populate the actual series.
            </div>
          ) : null}
        </div>
      )}
    </GlassSection>
  );
}
