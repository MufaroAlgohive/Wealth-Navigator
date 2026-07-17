"use client";

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { LineChart as LineChartIcon } from "lucide-react";
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis, Legend } from "recharts";

import {
  GlassBadge,
  GlassKpi,
  GlassSection,
  PageCanvas,
} from "@/components/oems/primitives/glass";
import { PanelSkeleton, KpiTileSkeleton } from "@/components/oems/primitives/panel-skeleton";
import { EmptyDataState } from "@/components/oems/primitives/empty-data-state";
import { EntitlementRequired } from "@/components/oems/primitives/entitlement-required";
import { isRealDataOnlyClient } from "@/lib/data-policy";
import { mapSource } from "@/lib/data-source";
import { queryOpts } from "@/lib/store/query-provider";

interface CurveResponse {
  code: string;
  points: Array<{ tenor: string; years: number; yield: number; asOf: string }>;
  source: string;
  message?: string;
}

interface CurveMetricsResponse {
  code: string;
  metrics: Array<{
    metric: string;
    tenorLabel: string | null;
    value: number;
    unit: "bp" | "%";
    asOf: string;
  }>;
  pca: { level: number | null; slope: number | null; curvature: number | null; residual: number | null } | null;
  source: string;
  message?: string;
}

const CURVE_CODES = ["ZAR_GOVI", "ZAR_NSS", "ZAR_REAL", "ZAR_BREAKEVEN"] as const;

const CHART_TOOLTIP_STYLE = {
  fontSize: 11,
  background: "hsl(var(--glass-bg-strong))",
  border: "1px solid hsl(var(--glass-border))",
  borderRadius: 12,
  backdropFilter: "blur(12px)",
} as const;

export default function CurvesPage() {
  const realDataOnly = isRealDataOnlyClient();

  const curves = CURVE_CODES.map((code) =>
    // hooks must be called unconditionally — we gate fetch via `enabled`
    // eslint-disable-next-line react-hooks/rules-of-hooks
    useQuery<CurveResponse>({
      queryKey: ["bff-curve", code],
      queryFn: async () => {
        const r = await fetch(`/api/curves/${code}`, { cache: "no-store" });
        if (!r.ok) throw new Error(`Curve BFF ${code} ${r.status}`);
        return r.json();
      },
      enabled: realDataOnly,
      refetchInterval: 60_000,
      ...queryOpts("reference"),
    }),
  );
  // The map above always produces a 4-tuple (one per CURVE_CODE entry);
  // destructure with non-null assertions to satisfy strict TS without
  // changing the runtime shape.
  const [goviQ, nssQ, realQ, beQ] = curves as [
    ReturnType<typeof useQuery<CurveResponse>>,
    ReturnType<typeof useQuery<CurveResponse>>,
    ReturnType<typeof useQuery<CurveResponse>>,
    ReturnType<typeof useQuery<CurveResponse>>,
  ];

  const metricsQ = useQuery<CurveMetricsResponse>({
    queryKey: ["bff-curve-metrics", "ZAR_NSS"],
    queryFn: async () => {
      const r = await fetch("/api/curves/ZAR_NSS/metrics", { cache: "no-store" });
      if (!r.ok) throw new Error(`Metrics BFF ${r.status}`);
      return r.json();
    },
    enabled: realDataOnly,
    refetchInterval: 60_000,
    ...queryOpts("reference"),
  });

  const govi = goviQ.data?.points ?? [];
  const nss = nssQ.data?.points ?? [];
  const real = realQ.data?.points ?? [];
  const be = beQ.data?.points ?? [];

  // Align the four series on the *same* tenor list so the LineChart has a
  // consistent x-axis. We use the NSS canonical tenors as the spine; series
  // with shorter tenor lists leave the unmatched indices as `undefined`
  // (recharts gaps the line). Declared BEFORE the mock-mode early return
  // below so this hook always runs (Rules of Hooks).
  const combined = useMemo(() => {
    if (nss.length === 0) return [];
    return nss.map((p, i) => ({
      tenor: p.tenor,
      govi: govi[i]?.yield,
      swap: nss[i]?.yield,
      real: real[i]?.yield,
      breakeven: be[i]?.yield,
    }));
  }, [govi, nss, real, be]);

  if (!realDataOnly) {
    return (
      <PageCanvas>
        <header className="glass-panel relative overflow-hidden p-6 md:p-8">
          <div className="pointer-events-none absolute -right-20 -top-20 h-56 w-56 rounded-full bg-primary/15 blur-3xl" />
          <div className="relative space-y-3">
            <GlassBadge tone="primary">
              <LineChartIcon className="h-3.5 w-3.5" />
              ZAR rates desk
            </GlassBadge>
            <h1 className="text-display">Yield Curves · ZAR</h1>
            <p className="text-caption max-w-2xl">
              Nelson-Siegel-Svensson fitted · ZAR govi · swap · real · breakeven · PCA decomposition
            </p>
          </div>
        </header>
        <GlassSection title="ZAR yield curves" endpoint="GET /api/curves/{code}" db="institutional" dataSource="mock">
          <EmptyDataState
            message="Mock mode disables the curves module."
            hint="Switch to real-data mode and ensure the worker has written yield_curve_history_c rows for ZAR_NSS."
            badgeLabel="mock"
          />
        </GlassSection>
      </PageCanvas>
    );
  }

  const pca = metricsQ.data?.pca;
  const move = pca
    ? {
        level: pca.level ?? 0,
        slope: pca.slope ?? 0,
        curvature: pca.curvature ?? 0,
        residual: pca.residual ?? 0,
      }
    : null;

  const ois3m = metricsQ.data?.metrics.find((m) => m.metric === "ois_spread_3m")?.value;
  const ois12m = metricsQ.data?.metrics.find((m) => m.metric === "ois_spread_12m")?.value;
  const carry3m = metricsQ.data?.metrics.find((m) => m.metric === "carry_3m")?.value;
  const carry12m = metricsQ.data?.metrics.find((m) => m.metric === "carry_12m")?.value;
  const rolldown3m = metricsQ.data?.metrics.find((m) => m.metric === "rolldown_3m")?.value;
  const rolldown12m = metricsQ.data?.metrics.find((m) => m.metric === "rolldown_12m")?.value;

  const latestNss = nss[nss.length - 1]?.yield ?? 0;
  const latestGovi = govi[govi.length - 1]?.yield ?? 0;
  const latestReal = real[real.length - 1]?.yield ?? 0;
  const latestBE = be[be.length - 1]?.yield ?? 0;
  const isLoadingCurves = goviQ.isLoading || nssQ.isLoading || realQ.isLoading || beQ.isLoading;

  return (
    <PageCanvas>
      <header className="glass-panel relative overflow-hidden p-6 md:p-8">
        <div className="pointer-events-none absolute -right-20 -top-20 h-56 w-56 rounded-full bg-primary/15 blur-3xl" />
        <div className="relative space-y-3">
          <GlassBadge tone="primary">
            <LineChartIcon className="h-3.5 w-3.5" />
            ZAR rates desk
          </GlassBadge>
          <h1 className="text-display">Yield Curves · ZAR</h1>
          <p className="text-caption max-w-2xl">
            Nelson-Siegel-Svensson fitted · ZAR govi · swap · real · breakeven · PCA decomposition
          </p>
        </div>
      </header>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {isLoadingCurves ? (
          [0, 1, 2, 3].map((n) => <KpiTileSkeleton key={`curves-kpi-${n}`} />)
        ) : (
          <>
            <GlassKpi
              label="ZAR govi 10Y"
              value={latestGovi > 0 ? `${latestGovi.toFixed(2)}%` : "—"}
              sub={move ? `${move.level >= 0 ? "+" : ""}${move.level}bp today` : "no PCA"}
              accent={move ? (move.level > 0 ? "negative" : "positive") : "default"}
            />
            <GlassKpi
              label="ZAR NSS 10Y"
              value={latestNss > 0 ? `${latestNss.toFixed(2)}%` : "—"}
              sub={move ? `${move.slope >= 0 ? "+" : ""}${move.slope}bp slope` : "no PCA"}
            />
            <GlassKpi
              label="ZAR real 10Y"
              value={latestReal > 0 ? `${latestReal.toFixed(2)}%` : "—"}
              sub="ILB yield"
            />
            <GlassKpi
              label="Breakeven 10Y"
              value={latestBE > 0 ? `${latestBE.toFixed(2)}%` : "—"}
              sub="expected CPI"
            />
          </>
        )}
      </div>

      <div className="grid grid-cols-12 gap-3">
        {isLoadingCurves ? (
          <PanelSkeleton rows={4} height="h-[380px]" className="col-span-12 lg:col-span-8" />
        ) : nss.length === 0 ? (
          <GlassSection
            title="Combined · govi · NSS · real · breakeven"
            endpoint="GET /api/curves/{code}"
            db="institutional"
            dataSource="blocked-external"
            className="col-span-12 flex h-[380px] flex-col lg:col-span-8"
          >
            {/* Yellow #16 — shared EntitlementRequired primitive. The
                same TimeSeriesGet2 message is on the Cockpit
                ALSI/J203 panel and the Fixed Income page. */}
            <EntitlementRequired
              method="TimeSeriesGet2"
              codes={["J200", "J203", "R2030", "R2035", "R2040"]}
              note="Contact your administrator to enable historical data. Until available, the ALSI panel will remain empty."
            />
          </GlassSection>
        ) : (
          <GlassSection
            title="Combined · govi · NSS · real · breakeven"
            endpoint="GET /api/curves/{code}"
            db="institutional"
            dataSource={mapSource(goviQ.data?.source)}
            className="col-span-12 flex h-[380px] flex-col lg:col-span-8"
            noPadding
          >
            {/* Yellow #28 — the combined chart and the Cockpit's
                J203 ALSI intraday panel share the same ZAR index
                series (separate BFF: `/api/indices/J203`). Add a
                small help tooltip so the operator doesn't think
                these are two different things. */}
            <div className="flex min-h-0 flex-1 flex-col p-5">
              <p className="mb-2 text-[10px] text-muted-foreground">
                <span className="font-mono">ⓘ</span> ALSI intraday (separate source) is the same series on the Cockpit&apos;s J203 panel.
              </p>
              <div className="glass-inset min-h-0 flex-1 p-3">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={combined} margin={{ top: 8, right: 12, left: -8, bottom: 0 }}>
                    <CartesianGrid stroke="hsl(var(--border))" strokeDasharray="2 4" vertical={false} />
                    <XAxis dataKey="tenor" tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} stroke="hsl(var(--border))" />
                    <YAxis tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} stroke="hsl(var(--border))" unit="%" domain={["dataMin - 0.5", "dataMax + 0.5"]} />
                    <Tooltip contentStyle={CHART_TOOLTIP_STYLE} formatter={(v: number) => `${v.toFixed(2)}%`} />
                    <Legend wrapperStyle={{ fontSize: 10, paddingTop: 4 }} />
                    <Line type="monotone" dataKey="govi" name="Govi" stroke="hsl(38 95% 56%)" strokeWidth={2.2} dot={{ r: 2 }} />
                    <Line type="monotone" dataKey="swap" name="NSS" stroke="hsl(263 80% 65%)" strokeWidth={1.6} dot={false} />
                    <Line type="monotone" dataKey="real" name="Real (ILB)" stroke="hsl(180 60% 50%)" strokeWidth={1.4} dot={false} strokeDasharray="4 4" />
                    <Line type="monotone" dataKey="breakeven" name="Breakeven" stroke="hsl(351 90% 60%)" strokeWidth={1.2} dot={false} strokeDasharray="2 4" />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>
          </GlassSection>
        )}

        <GlassSection
          title="PCA · today's curve move"
          endpoint="GET /api/curves/ZAR_NSS/metrics"
          db="institutional"
          dataSource={mapSource(metricsQ.data?.source)}
          className="col-span-12 flex h-[380px] flex-col lg:col-span-4"
          right={<span className="font-mono text-[10px] text-muted-foreground">3-factors + residual</span>}
        >
          {move ? (
            <div className="grid grid-cols-1 gap-2 text-xs">
              {[
                { k: "Level (parallel)", v: move.level, help: "whole curve shift" },
                { k: "Slope (2s10s)", v: move.slope, help: "short vs long" },
                { k: "Curvature (fly)", v: move.curvature, help: "belly twist" },
                { k: "Residual", v: move.residual, help: "unexplained" },
              ].map((row) => (
                <div key={row.k} className="glass-inset p-2.5">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="font-semibold">{row.k}</p>
                      <p className="text-[9.5px] text-muted-foreground">{row.help}</p>
                    </div>
                    <p className={`font-mono text-base font-semibold ${row.v >= 0 ? "text-up" : "text-down"}`}>
                      {row.v >= 0 ? "+" : ""}{row.v}bp
                    </p>
                  </div>
                  <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-muted/60">
                    <div
                      className={row.v >= 0 ? "h-full bg-success" : "h-full bg-destructive"}
                      style={{ width: `${Math.min(100, Math.abs(row.v) * 6)}%` }}
                    />
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <EmptyDataState
              message="PCA decomposition requires fitted yield curve + derived metrics."
              hint={metricsQ.data?.message ?? "PCA metrics are not available yet. Historical price data and curve calculations will enable this analysis."}
            />
          )}
        </GlassSection>
      </div>

      <div className="grid grid-cols-12 gap-3">
        <GlassSection
          title="ZAR-OIS spread · 3M · 12M"
          endpoint="GET /api/curves/ZAR_NSS/metrics?metric=ois_spread_*"
          db="institutional"
          dataSource={mapSource(metricsQ.data?.source)}
          className="col-span-12 h-[300px] lg:col-span-6"
        >
          {ois3m !== undefined || ois12m !== undefined ? (
            <div className="grid grid-cols-2 gap-2 text-xs">
              {[
                ["OIS spread (3M)", ois3m !== undefined ? `${ois3m.toFixed(2)}%` : "—"],
                ["OIS spread (12M)", ois12m !== undefined ? `${ois12m.toFixed(2)}%` : "—"],
                ["OIS spread (5Y)", "—"],
                ["OIS spread (10Y)", "—"],
                ["OIS spread (delta 3M→12M)", ois3m !== undefined && ois12m !== undefined ? `${(ois12m - ois3m).toFixed(2)}%` : "—"],
                ["Source", "oems_curve_metric_c"],
              ].map(([l, v]) => (
                <div key={l} className="glass-inset flex items-center justify-between p-2">
                  <p className="text-[10px] uppercase tracking-wider text-muted-foreground">{l}</p>
                  <p className="font-mono font-semibold">{v}</p>
                </div>
              ))}
            </div>
          ) : (
            <EmptyDataState
              message="No OIS spread metrics recorded."
              hint="The worker's curve-derived metrics loop writes ois_spread_3m and ois_spread_12m to oems_curve_metric_c. Run the loop to populate."
            />
          )}
        </GlassSection>

        <GlassSection
          title="Carry & rolldown · key 5Y vertex"
          endpoint="GET /api/curves/ZAR_NSS/metrics?metric=carry_*"
          db="institutional"
          dataSource={mapSource(metricsQ.data?.source)}
          className="col-span-12 h-[300px] lg:col-span-6"
          right={
            carry3m !== undefined && rolldown3m !== undefined ? (
              <GlassBadge tone="success">
                {((carry3m + rolldown3m) >= 0 ? "+" : "") + (carry3m + rolldown3m).toFixed(2)}% T+3M
              </GlassBadge>
            ) : (
              <GlassBadge>—</GlassBadge>
            )
          }
        >
          {carry3m !== undefined || carry12m !== undefined ? (
            <div className="flex h-full flex-col gap-2">
              <div className="grid grid-cols-2 gap-2 text-xs">
              {[
                ["Carry (3M)", carry3m !== undefined ? `${carry3m >= 0 ? "+" : ""}${carry3m.toFixed(2)}%` : "—"],
                ["Rolldown (3M)", rolldown3m !== undefined ? `${rolldown3m >= 0 ? "+" : ""}${rolldown3m.toFixed(2)}%` : "—"],
                ["Total (3M)", carry3m !== undefined && rolldown3m !== undefined ? `${(carry3m + rolldown3m) >= 0 ? "+" : ""}${(carry3m + rolldown3m).toFixed(2)}%` : "—"],
                ["Carry (12M)", carry12m !== undefined ? `${carry12m >= 0 ? "+" : ""}${carry12m.toFixed(2)}%` : "—"],
                ["Rolldown (12M)", rolldown12m !== undefined ? `${rolldown12m >= 0 ? "+" : ""}${rolldown12m.toFixed(2)}%` : "—"],
                ["Total (12M)", carry12m !== undefined && rolldown12m !== undefined ? `${(carry12m + rolldown12m) >= 0 ? "+" : ""}${(carry12m + rolldown12m).toFixed(2)}%` : "—"],
                ["Annualised (3M)", carry3m !== undefined && rolldown3m !== undefined ? `${((carry3m + rolldown3m) * 4).toFixed(2)}%` : "—"],
                ["Annualised (12M)", carry12m !== undefined && rolldown12m !== undefined ? `${(carry12m + rolldown12m).toFixed(2)}%` : "—"],
              ].map(([l, v]) => (
                <div key={l} className="glass-inset flex items-center justify-between p-2">
                  <p className="text-[10px] uppercase tracking-wider text-muted-foreground">{l}</p>
                  <p className="font-mono font-semibold">{v}</p>
                </div>
              ))}
              </div>
              <p className="mt-auto text-[9.5px] leading-relaxed text-muted-foreground/70">
                Convention: 5Y key vertex (interpolated). Carry = (y₅ − front-of-curve funding) × horizon;
                rolldown = ModDur₅ × (y₅ − y₅₋ₕ); Total = carry + rolldown. Derived from the single fitted
                ZAR_NSS curve (no history needed).
              </p>
            </div>
          ) : (
            <EmptyDataState
              message="No carry/rolldown metrics recorded yet."
              hint="Computed by the worker each curve cycle (carry/rolldown @ 5Y → oems_curve_metric_c). If this stays empty, apply migration 20260613000003_oems_curve_metric_c.sql on the institutional DB."
            />
          )}
        </GlassSection>
      </div>
    </PageCanvas>
  );
}
