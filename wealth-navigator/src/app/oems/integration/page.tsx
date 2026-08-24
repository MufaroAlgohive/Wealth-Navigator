"use client";

import { useQuery } from "@tanstack/react-query";
import { Activity, AlertTriangle, Cable, CheckCircle2, Globe2, Loader2, Server, XCircle } from "lucide-react";
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

import type { WorkerEvent } from "@/app/api/worker-health/route";
import { EmptyDataState } from "@/components/oems/primitives/empty-data-state";
import { LiveDataFlowPanel } from "@/components/oems/integration/live-data-flow-panel";
import { GlassBadge, GlassSection, PageCanvas } from "@/components/oems/primitives/glass";
import { PanelSkeleton } from "@/components/oems/primitives/panel-skeleton";
import { Pill } from "@/components/oems/primitives/pill";
import { cn } from "@/lib/cn";
import { isRealDataOnlyClient } from "@/lib/data-policy";
import { formatTime } from "@/lib/format";
import { pickPrimaryWorker, useWorkerHealth } from "@/lib/hooks/use-worker-health";
import { iressConfig } from "@/lib/iress";
import { useIress } from "@/lib/iress/provider";
import { queryOpts } from "@/lib/store/query-provider";

const STATUS_ICON = {
  ok: CheckCircle2,
  lag: Loader2,
  warn: AlertTriangle,
  error: XCircle,
};

const STATUS_TONE = {
  ok: "success",
  lag: "warning",
  warn: "warning",
  error: "destructive",
} as const;

const GLASS_TABLE_HEAD =
  "sticky top-0 z-10 border-b border-[hsl(var(--glass-border))] bg-[hsl(var(--foreground)/0.03)] backdrop-blur-md";

type IntegrationKpiAccent = "default" | "positive" | "negative" | "warning";

function IntegrationKpi({
  icon,
  label,
  value,
  sub,
  accent = "default",
}: {
  icon?: React.ReactNode;
  label: string;
  value: string;
  sub?: React.ReactNode;
  accent?: IntegrationKpiAccent;
}) {
  return (
    <div className="glass-kpi relative">
      <div className="flex items-center gap-2">
        {icon && (
          <div
            className={cn(
              "flex h-5 w-5 items-center justify-center rounded-lg",
              accent === "positive" && "bg-up/10 text-up",
              accent === "negative" && "bg-down/10 text-down",
              accent === "warning" && "bg-warning/10 text-warning",
              accent === "default" && "bg-primary/10 text-primary",
            )}
          >
            {icon}
          </div>
        )}
        <p className="text-caption">{label}</p>
      </div>
      <p
        className={cn(
          "text-metric mt-1.5",
          accent === "positive" && "text-up",
          accent === "negative" && "text-down",
          accent === "warning" && "text-warning",
        )}
      >
        {value}
      </p>
      {sub && (
        <p
          className={cn(
            "mt-1 font-mono text-xs tabular-nums",
            accent === "positive" && "text-up/80",
            accent === "negative" && "text-down/80",
            accent === "warning" && "text-warning/80",
            accent === "default" && "text-muted-foreground",
          )}
        >
          {sub}
        </p>
      )}
    </div>
  );
}

function GlassScrollBody({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={cn("min-h-0 flex-1 overflow-y-auto scrollbar-thin px-5 pb-5", className)}>{children}</div>
  );
}

/**
 * Derive a time-ordered latency series from the worker's `recent_events`
 * list. Only events whose `data` payload carries a numeric `elapsedMs`
 * (e.g. `timeseries_probe_complete`, future `pricing_quote_get_complete`,
 * order-pad polls) contribute. Returns newest-last `[{t, ms}, ...]`.
 */
function buildLatencySeries(
  events: ReadonlyArray<{ ts: string; data?: Record<string, unknown> }>,
): Array<{ t: string; ms: number }> {
  const samples = events
    .map((e) => {
      const ms = e.data?.elapsedMs;
      return typeof ms === "number" && Number.isFinite(ms) ? { t: e.ts, ms } : null;
    })
    .filter((x): x is { t: string; ms: number } => x !== null)
    .sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : 0));
  return samples;
}

export default function IntegrationPage() {
  const { data } = useIress();
  const realDataOnly = isRealDataOnlyClient();
  const workerQ = useWorkerHealth(realDataOnly);
  const healthQ = useQuery({
    queryKey: ["endpoints"],
    queryFn: () => data.endpoints(),
    enabled: !realDataOnly,
    ...queryOpts("reference"),
  });
  const endpoints = healthQ.data ?? [];
  const workers = workerQ.data?.workers ?? [];
  const primaryWorker = pickPrimaryWorker(workers);
  const workerAlive = primaryWorker
    ? Date.now() - new Date(primaryWorker.last_heartbeat_at).getTime() < 60_000
    : false;
  const effectiveMode =
    workerAlive && primaryWorker?.iress_mode ? primaryWorker.iress_mode : iressConfig.mode;
  const ghostRowsHidden = workerQ.data?.ghostRowsHidden ?? 0;

  return (
    <PageCanvas>
      <header className="glass-panel relative overflow-hidden p-6 md:p-8">
        <div className="pointer-events-none absolute -right-20 -top-20 h-56 w-56 rounded-full bg-primary/15 blur-3xl" />
        <div className="relative space-y-3">
          <GlassBadge tone="primary">
            <Cable className="h-3.5 w-3.5" />
            Market data adapter
          </GlassBadge>
          <h1 className="text-display">Integration</h1>
          <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">
            Adapter health · environment · method coverage · session model
          </p>
        </div>
      </header>

      {ghostRowsHidden > 0 ? (
        <div className="glass-inset flex items-center justify-between border-warning/30 bg-warning/5 px-3 py-2 text-[11px] text-warning">
          <span>
            <strong>{ghostRowsHidden}</strong> stale data records hidden by the stale data filter. Contact
            your administrator to clear stale records.
          </span>
        </div>
      ) : null}

      {/* Reduced top KPI strip: only the two actionable KPIs (Adapter mode +
          Worker status). Endpoint groups + Region moved into a small footer
          chip below — static info that doesn't need the prime real-estate. */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <IntegrationKpi
          icon={<Cable className="h-3.5 w-3.5" />}
          label="Adapter mode"
          value={(effectiveMode ?? "live").toUpperCase()}
          sub={workerAlive ? `via Railway ${primaryWorker?.worker_id ?? ""}` : iressConfig.baseUrl}
          accent={effectiveMode === "live" ? "positive" : "default"}
        />
        <IntegrationKpi
          icon={<Activity className="h-3.5 w-3.5" />}
          label="Worker status"
          value={primaryWorker?.status?.toUpperCase() ?? "—"}
          sub={
            primaryWorker
              ? `Last heartbeat ${formatTime(new Date(primaryWorker.last_heartbeat_at).getTime())}`
              : "No heartbeat row yet"
          }
          accent={
            primaryWorker?.status === "healthy"
              ? "positive"
              : primaryWorker
                ? "warning"
                : "default"
          }
        />
        <div className="hidden lg:flex glass-kpi group relative items-center">
          <div className="flex items-center gap-2">
            <span className="flex h-5 w-5 items-center justify-center rounded-lg bg-muted/30 text-muted-foreground">
              <Cable className="h-3.5 w-3.5" />
            </span>
            <p className="text-caption">Endpoint groups</p>
          </div>
          <p className="text-metric mt-1.5">{iressConfig.methods.length}</p>
          <p className="mt-1 font-mono text-xs tabular-nums text-muted-foreground/80">
            IRESSSession · ServiceSession scoped
          </p>
        </div>
        <div className="hidden lg:flex glass-kpi group relative items-center">
          <div className="flex items-center gap-2">
            <span className="flex h-5 w-5 items-center justify-center rounded-lg bg-muted/30 text-muted-foreground">
              <Globe2 className="h-3.5 w-3.5" />
            </span>
            <p className="text-caption">Region</p>
          </div>
          <p className="text-metric mt-1.5">{iressConfig.region}</p>
          <p className="mt-1 font-mono text-xs tabular-nums text-muted-foreground/80">
            ZA production
          </p>
        </div>
      </div>

      {/* Live Data Flow — the new headline panel: animated pipeline + live
          counter tiles + rolling worker-events ticker. Replaces the static
          info-card pattern that was on top. */}
      <LiveDataFlowPanel />

      <div className="grid grid-cols-12 gap-3">
        {realDataOnly ? (
          workerQ.isLoading ? (
            <PanelSkeleton
              rows={4}
              height="h-[420px]"
              className="col-span-12 glass-panel rounded-2xl lg:col-span-8"
            />
          ) : (
            <GlassSection
              title="Worker health"
              subtitle="Data sync service · health status"
              db="institutional"
              endpoint="GET /api/worker-health"
              dataSource="worker"
              className="col-span-12 flex h-[420px] flex-col lg:col-span-8"
              noPadding
            >
              <GlassScrollBody>
                {workers.length === 0 ? (
                  <EmptyDataState message="Data ingestion service is not active. Contact your administrator." />
                ) : (
                  <div className="glass-inset overflow-x-auto">
                    <table className="w-full font-mono text-[11px]">
                      <thead className={GLASS_TABLE_HEAD}>
                        <tr className="text-[9.5px] uppercase tracking-wider text-muted-foreground">
                          <th className="px-2.5 py-1.5 text-left">Worker</th>
                          <th className="px-2.5 py-1.5 text-left">Status</th>
                          <th className="px-2.5 py-1.5 text-left">IRESS mode</th>
                          <th className="px-2.5 py-1.5 text-left">Last quote sync</th>
                          <th className="px-2.5 py-1.5 text-left">Heartbeat</th>
                          <th className="px-2.5 py-1.5 text-right">Symbols</th>
                          <th className="px-2.5 py-1.5 text-left">Accounts</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-[hsl(var(--glass-border))]/60">
                        {workers.map((w) => {
                          const exchanges = w.symbol_exchanges ?? {};
                          const rateSymbols = Object.entries(exchanges)
                            .filter(([, ex]) => ex === "FX" || ex === "MM")
                            .map(([sym]) => sym);
                          const symCount = w.symbols_covered?.length ?? 0;
                          return (
                            <tr key={w.worker_id}>
                              <td className="px-2.5 py-1.5 font-semibold">{w.worker_id}</td>
                              <td className="px-2.5 py-1.5">
                                <Pill tone={w.status === "healthy" ? "success" : "warning"} size="xs" dot>
                                  {w.status}
                                </Pill>
                              </td>
                              <td className="px-2.5 py-1.5 text-muted-foreground">{w.iress_mode ?? "—"}</td>
                              <td className="px-2.5 py-1.5 text-muted-foreground">
                                {w.last_quote_sync_at
                                  ? formatTime(new Date(w.last_quote_sync_at).getTime())
                                  : "—"}
                              </td>
                              <td className="px-2.5 py-1.5 text-muted-foreground">
                                {formatTime(new Date(w.last_heartbeat_at).getTime())}
                              </td>
                              <td className="px-2.5 py-1.5 text-right tabular-nums">
                                {symCount || "—"}
                                {rateSymbols.length > 0 && (
                                  <span className="ml-1.5 text-[9.5px] text-muted-foreground">
                                    +{rateSymbols.length} rate
                                  </span>
                                )}
                              </td>
                              <td className="px-2.5 py-1.5">
                                {w.account_configured ? (
                                  <span className="text-foreground/90">{w.accounts?.join(", ")}</span>
                                ) : (
                                  <span className="text-warning">unset</span>
                                )}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </GlassScrollBody>
            </GlassSection>
          )
        ) : healthQ.isLoading ? (
          <PanelSkeleton
            rows={8}
            height="h-[420px]"
            className="col-span-12 glass-panel rounded-2xl lg:col-span-8"
          />
        ) : (
          <GlassSection
            title="Worker health"
            subtitle="Endpoint health · last 30 min"
            db="institutional"
            endpoint="GET /api/worker-health"
            dataSource="supabase"
            className="col-span-12 flex h-[420px] flex-col lg:col-span-8"
            noPadding
          >
            <GlassScrollBody>
              <div className="glass-inset overflow-x-auto">
                <table className="w-full font-mono text-[11px]">
                  <thead className={GLASS_TABLE_HEAD}>
                    <tr className="text-[9.5px] uppercase tracking-wider text-muted-foreground">
                      <th className="px-2.5 py-1.5 text-left">Endpoint</th>
                      <th className="px-2.5 py-1.5 text-left">Method</th>
                      <th className="px-2.5 py-1.5 text-right">p50</th>
                      <th className="px-2.5 py-1.5 text-right">p95</th>
                      <th className="px-2.5 py-1.5 text-right">Rate</th>
                      <th className="px-2.5 py-1.5 text-right">Err %</th>
                      <th className="px-2.5 py-1.5 text-left">Status</th>
                      <th className="px-2.5 py-1.5 text-left">Checked</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[hsl(var(--glass-border))]/60">
                    {endpoints.map((e) => {
                      const Icon = STATUS_ICON[e.status];
                      return (
                        <tr key={e.name}>
                          <td className="px-2.5 py-1.5 font-semibold">{e.name}</td>
                          <td className="px-2.5 py-1.5 text-muted-foreground">{e.method}</td>
                          <td className="px-2.5 py-1.5 text-right tabular-nums">{e.p50}ms</td>
                          <td className="px-2.5 py-1.5 text-right tabular-nums">{e.p95}ms</td>
                          <td className="px-2.5 py-1.5 text-right tabular-nums">{e.rps}/s</td>
                          <td
                            className={cn(
                              "px-2.5 py-1.5 text-right tabular-nums",
                              e.errPct > 1 && "text-destructive",
                            )}
                          >
                            {e.errPct.toFixed(2)}
                          </td>
                          <td className="px-2.5 py-1.5">
                            <Pill tone={STATUS_TONE[e.status]} size="xs" dot>
                              <Icon className="h-2.5 w-2.5" /> {e.status}
                            </Pill>
                          </td>
                          <td className="px-2.5 py-1.5 text-muted-foreground">{formatTime(e.lastCheck)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </GlassScrollBody>
          </GlassSection>
        )}

        <GlassSection
          title="Latency · IRESS calls"
          db="institutional"
          endpoint="GET /api/worker-health"
          dataSource={realDataOnly ? "worker" : "supabase"}
          className="col-span-12 h-[420px] lg:col-span-4"
        >
          <div className="glass-inset h-[calc(100%-0.5rem)] p-2">
            {realDataOnly ? (
              (() => {
                const series = buildLatencySeries(primaryWorker?.recent_events ?? []);
                if (series.length === 0) {
                  return (
                    <EmptyDataState
                      message="No IRESS call timings have been recorded yet."
                      hint="The Railway worker emits elapsedMs on probe + order-pad calls. Start the worker, run a probe, and the series will populate."
                    />
                  );
                }
                return (
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={series} margin={{ top: 8, right: 8, left: -20, bottom: 0 }}>
                      <defs>
                        <linearGradient id="lat" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%" stopColor="hsl(38 95% 56%)" stopOpacity={0.4} />
                          <stop offset="100%" stopColor="hsl(38 95% 56%)" stopOpacity={0} />
                        </linearGradient>
                      </defs>
                      <CartesianGrid stroke="hsl(var(--border))" strokeDasharray="2 4" vertical={false} />
                      <XAxis
                        dataKey="t"
                        tick={{ fontSize: 9, fill: "hsl(var(--muted-foreground))" }}
                        stroke="hsl(var(--border))"
                        tickFormatter={(v) => formatTime(String(v))}
                        interval={Math.max(1, Math.floor(series.length / 6))}
                      />
                      <YAxis
                        tick={{ fontSize: 9, fill: "hsl(var(--muted-foreground))" }}
                        stroke="hsl(var(--border))"
                        unit="ms"
                      />
                      <Tooltip
                        contentStyle={{
                          fontSize: 11,
                          background: "hsl(var(--popover))",
                          border: "1px solid hsl(var(--border))",
                          borderRadius: 6,
                        }}
                      />
                      <Area
                        type="monotone"
                        dataKey="ms"
                        stroke="hsl(38 95% 56%)"
                        fill="url(#lat)"
                        strokeWidth={1.8}
                      />
                    </AreaChart>
                  </ResponsiveContainer>
                );
              })()
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart
                  data={Array.from({ length: 60 }, (_, i) => ({
                    t: i,
                    ms: 220 + Math.sin(i / 6) * 30 + Math.cos(i / 18) * 18,
                  }))}
                  margin={{ top: 8, right: 8, left: -20, bottom: 0 }}
                >
                  <defs>
                    <linearGradient id="lat-mock" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="hsl(38 95% 56%)" stopOpacity={0.4} />
                      <stop offset="100%" stopColor="hsl(38 95% 56%)" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid stroke="hsl(var(--border))" strokeDasharray="2 4" vertical={false} />
                  <XAxis
                    dataKey="t"
                    tick={{ fontSize: 9, fill: "hsl(var(--muted-foreground))" }}
                    stroke="hsl(var(--border))"
                    tickFormatter={(v) => `${v}m`}
                    interval={9}
                  />
                  <YAxis
                    tick={{ fontSize: 9, fill: "hsl(var(--muted-foreground))" }}
                    stroke="hsl(var(--border))"
                    unit="ms"
                  />
                  <Tooltip
                    contentStyle={{
                      fontSize: 11,
                      background: "hsl(var(--popover))",
                      border: "1px solid hsl(var(--border))",
                      borderRadius: 6,
                    }}
                  />
                  <Area
                    type="monotone"
                    dataKey="ms"
                    stroke="hsl(38 95% 56%)"
                    fill="url(#lat-mock)"
                    strokeWidth={1.8}
                  />
                </AreaChart>
              </ResponsiveContainer>
            )}
          </div>
        </GlassSection>
      </div>

      <div className="grid grid-cols-12 gap-3">
        {realDataOnly ? (
          <>
            <GlassSection
              title="Environment checklist"
              subtitle="Order mirror · oems_order_audit"
              db="institutional"
              endpoint="GET /api/worker-health"
              dataSource="worker"
              className="col-span-12 h-[240px] lg:col-span-6"
            >
              {!primaryWorker ? (
                <p className="text-[12px] text-muted-foreground">
                  No worker heartbeat yet — start the Railway{" "}
                  <span className="font-mono text-foreground">background service</span> to begin syncing
                  orders.
                </p>
              ) : primaryWorker.account_configured ? (
                <ul className="space-y-2 text-[12px] text-muted-foreground">
                  <li>
                    Polling accounts:{" "}
                    <span className="font-mono text-foreground">
                      {primaryWorker.accounts?.join(", ") || "—"}
                    </span>{" "}
                    (configured account codes)
                  </li>
                  <li>
                    <span className="font-mono text-foreground">OrderPadGetByAccount</span> every{" "}
                    <span className="font-mono text-foreground">order polling interval</span> (default 60s) →
                    upserts into <span className="font-mono text-foreground">the order audit table</span>.
                    Cockpit Open Orders + Blotter read from this table.
                  </li>
                </ul>
              ) : (
                <div className="space-y-2 text-[12px]">
                  <div className="glass-inset border-warning/30 bg-warning/10 px-3 py-2 text-[12px]">
                    <p className="font-medium text-warning">
                      Configure account code to enable order tracking
                    </p>
                    <p className="mt-1 text-muted-foreground">
                      The order service is running but the account code is not configured yet, so order
                      tracking returns no rows. The Cockpit Open Orders panel will stay empty until this is
                      set.
                    </p>
                  </div>
                  <p className="text-muted-foreground">
                    Enter your account code in the quote service configuration as a comma-separated list of
                    account codes (e.g. <span className="font-mono text-foreground">Z12345,Z67890</span>),
                    then restart. Quote ingest keeps running independently of this env.
                  </p>
                </div>
              )}
            </GlassSection>
            <GlassSection
              title="Environment checklist"
              subtitle="Quote synchronization"
              db="institutional"
              endpoint="GET /api/worker-health"
              dataSource="worker"
              className="col-span-12 h-[240px] lg:col-span-6"
            >
              <ul className="space-y-2 text-[12px] text-muted-foreground">
                <li>
                  Vercel reads worker snapshots via{" "}
                  <span className="font-mono text-foreground">GET /api/quotes</span> (~15s poll) and optional
                  Realtime on <span className="font-mono text-foreground">the intraday quote table</span>.
                </li>
                <li>
                  Watchlist:{" "}
                  <span className="font-mono text-foreground">
                    {primaryWorker?.symbols_covered?.length ?? "—"}
                  </span>{" "}
                  (
                  {primaryWorker
                    ? `${(primaryWorker.symbols_covered ?? []).filter((s) => !["USDZAR", "JIBAR_3M"].includes(s)).length} JSE equities`
                    : "—"}
                  {" · "}
                  {primaryWorker
                    ? `${(primaryWorker.symbols_covered ?? []).filter((s) => ["USDZAR", "JIBAR_3M"].includes(s)).length} rate codes (FX/MM)`
                    : "—"}
                  ). Rate codes (USDZAR → <span className="font-mono text-foreground">FX</span>, JIBAR_3M →{" "}
                  <span className="font-mono text-foreground">MM</span>) ride the same{" "}
                  <span className="font-mono text-foreground">pricing update cycle</span>, no extra
                  entitlement needed.
                </li>
                <li>
                  Connection pill shows <span className="font-mono text-foreground">SUPABASE OK</span> when
                  the last quote tick is under 20s old;{" "}
                  <span className="font-mono text-foreground">/api/ticks</span> SSE is disabled in this mode.
                </li>
              </ul>
            </GlassSection>
          </>
        ) : null}

        <GlassSection
          title="IRESS status"
          subtitle="Production service health"
          db="institutional"
          endpoint="GET /api/worker-health"
          dataSource="worker"
          className="col-span-12 flex h-[260px] flex-col lg:col-span-6"
          noPadding
        >
          <GlassScrollBody>
            <ProductionStatusGrid primaryWorker={primaryWorker} events={primaryWorker?.recent_events ?? []} />
          </GlassScrollBody>
        </GlassSection>

        <GlassSection
          title="Method coverage · V4 (this adapter)"
          db="institutional"
          endpoint="static adapter config"
          dataSource="seed"
          className="col-span-12 flex h-[260px] flex-col lg:col-span-6"
          noPadding
        >
          <GlassScrollBody>
            <div className="grid grid-cols-1 gap-1.5 text-xs">
              {(iressConfig.methods.length > 0 ? iressConfig.methods : DEFAULT_V4_METHODS).map((m) => (
                <div key={m.group} className="glass-inset p-2">
                  <p className="font-mono text-[10.5px] font-semibold uppercase tracking-wider text-muted-foreground">
                    {m.group}
                  </p>
                  <p className="mt-0.5 text-[10.5px] font-mono">{m.methods.join(" · ")}</p>
                </div>
              ))}
            </div>
          </GlassScrollBody>
        </GlassSection>
      </div>

      {realDataOnly ? (
        <WorkerDiagnosticEventsPanel
          events={primaryWorker?.recent_events ?? []}
          hasWorker={Boolean(primaryWorker)}
        />
      ) : null}
    </PageCanvas>
  );
}

const DEFAULT_V4_METHODS: ReadonlyArray<{ group: string; methods: string[] }> = [
  {
    group: "iress",
    methods: [
      "IRESSSessionStart",
      "IRESSSessionEnd",
      "PricingQuoteGet",
      "InstrumentSearch",
      "StaticReferenceDataGet",
    ],
  },
  {
    group: "ios",
    methods: [
      "ServiceSessionStart",
      "ServiceSessionEnd",
      "OrderAdd",
      "OrderAmend",
      "OrderDelete",
      "OrderPadGetByAccount",
      "OrderPadGetByAccountUpdates",
    ],
  },
  { group: "ips", methods: ["IPSAccountGetAll1", "IPSPositionGetAll1", "IPSTransactionGetByAccount5"] },
  { group: "fix", methods: ["FixSessionStart", "FixSessionEnd", "FixOrderReplace"] },
];

function ProductionStatusGrid({
  primaryWorker,
  events,
}: {
  primaryWorker: ReturnType<typeof pickPrimaryWorker>;
  events: ReadonlyArray<WorkerEvent>;
}) {
  const lastByService = (svc: "iress" | "ios" | "ips" | "fix") => {
    const e = events.find((ev) => String(ev.data?.service ?? "").toLowerCase() === svc);
    if (!e) return { tone: "default" as const, msg: "No calls recorded yet." };
    if (e.level === "error")
      return { tone: "destructive" as const, msg: `Last error: ${e.event} — ${e.msg ?? ""}` };
    if (e.level === "warn")
      return { tone: "warning" as const, msg: `Last warn: ${e.event} — ${e.msg ?? ""}` };
    return { tone: "positive" as const, msg: `Last ok: ${e.event}${e.msg ? ` — ${e.msg}` : ""}` };
  };
  const svcs: Array<{ name: "iress" | "ios" | "ips" | "fix"; label: string }> = [
    { name: "iress", label: "IRESS" },
    { name: "ios", label: "IOS+" },
    { name: "ips", label: "IPS" },
    { name: "fix", label: "FIX+" },
  ];
  const seatCount = primaryWorker ? 1 : 0;
  return (
    <div className="grid grid-cols-2 gap-2 lg:grid-cols-2">
      {svcs.map((s) => {
        const st = lastByService(s.name);
        return (
          <div key={s.name} className="glass-inset p-2.5">
            <div className="flex items-center justify-between">
              <p className="font-mono text-[10.5px] font-semibold uppercase tracking-wider">{s.label}</p>
              <Pill
                tone={
                  st.tone === "default"
                    ? "neutral"
                    : st.tone === "positive"
                      ? "success"
                      : (st.tone as "warning" | "destructive")
                }
                size="xs"
                dot
              >
                {st.tone === "default"
                  ? "NO DATA"
                  : st.tone === "positive"
                    ? "OK"
                    : st.tone === "warning"
                      ? "WARN"
                      : "ERROR"}
              </Pill>
            </div>
            <p className="mt-1 text-[10.5px] text-muted-foreground">{st.msg}</p>
          </div>
        );
      })}
      <div className="glass-inset col-span-2 p-2.5">
        <div className="flex items-center justify-between">
          <p className="font-mono text-[10.5px] font-semibold uppercase tracking-wider">Last sync</p>
          <Pill tone="neutral" size="xs">
            IRESS single-seat
          </Pill>
        </div>
        <ul className="mt-1 grid grid-cols-3 gap-2 text-[10.5px] text-muted-foreground">
          <li>
            Quotes:{" "}
            <span className="font-mono text-foreground">
              {primaryWorker?.last_quote_sync_at
                ? formatTime(new Date(primaryWorker.last_quote_sync_at).getTime())
                : "—"}
            </span>
          </li>
          <li>
            Orders:{" "}
            <span className="font-mono text-foreground">
              {(primaryWorker?.metadata as Record<string, unknown> | undefined)?.last_order_sync_at
                ? formatTime(
                    new Date(
                      String((primaryWorker!.metadata as Record<string, unknown>).last_order_sync_at),
                    ).getTime(),
                  )
                : "—"}
            </span>
          </li>
          <li>
            IPS:{" "}
            <span className="font-mono text-foreground">
              {(primaryWorker?.metadata as Record<string, unknown> | undefined)?.last_ips_sync_at
                ? formatTime(
                    new Date(
                      String((primaryWorker!.metadata as Record<string, unknown>).last_ips_sync_at),
                    ).getTime(),
                  )
                : "—"}
            </span>
          </li>
        </ul>
        <p className="mt-1 text-[10.5px] text-muted-foreground">
          License seat: <span className="font-mono text-foreground">{seatCount}/1</span>. Only one concurrent
          connection is allowed; additional connections will return a licensing error.
        </p>
      </div>
    </div>
  );
}

function WorkerDiagnosticEventsPanel({
  events,
  hasWorker,
}: {
  events: WorkerEvent[];
  hasWorker: boolean;
}) {
  const ordered = events ?? [];
  const counts = ordered.reduce(
    (acc, e) => {
      acc[e.level] += 1;
      return acc;
    },
    { info: 0, warn: 0, error: 0 },
  );
  const hasEvents = ordered.length > 0;
  const lastWarnOrError = ordered.find((e) => e.level === "warn" || e.level === "error");
  const displayEvents =
    lastWarnOrError == null && ordered.length > 5 ? ordered.slice(0, 5) : ordered.slice(0, 25);

  return (
    <GlassSection
      title="Worker diagnostic events"
      db="institutional"
      endpoint="GET /api/worker-health"
      dataSource="worker"
      right={
        <div className="flex items-center gap-1.5">
          {counts.error > 0 && (
            <Pill tone="destructive" size="xs" dot>
              {counts.error} error{counts.error === 1 ? "" : "s"}
            </Pill>
          )}
          {counts.warn > 0 && (
            <Pill tone="warning" size="xs" dot>
              {counts.warn} warn{counts.warn === 1 ? "" : "s"}
            </Pill>
          )}
          {counts.info > 0 && (
            <Pill tone="info" size="xs">
              {counts.info} info
            </Pill>
          )}
        </div>
      }
    >
      {!hasWorker ? (
        <p className="text-[12px] text-muted-foreground">
          No worker heartbeat row yet — start the Railway{" "}
          <span className="font-mono text-foreground">Iress-Worker</span> service to begin ingesting.
        </p>
      ) : !hasEvents ? (
        <p className="text-[12px] text-muted-foreground">
          Worker has not emitted any structured events since the last restart — that usually means the IRESS
          session hasn&apos;t started yet, or the first quote sync is in flight.
        </p>
      ) : (
        <div className="glass-inset overflow-x-auto">
          <table className="w-full font-mono text-[11px]">
            <thead className={GLASS_TABLE_HEAD}>
              <tr className="text-[9.5px] uppercase tracking-wider text-muted-foreground">
                <th className="px-2.5 py-1.5 text-left">Time</th>
                <th className="px-2.5 py-1.5 text-left">Level</th>
                <th className="px-2.5 py-1.5 text-left">Event</th>
                <th className="px-2.5 py-1.5 text-left">Message</th>
                <th className="px-2.5 py-1.5 text-left">Data</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[hsl(var(--glass-border))]/60">
              {displayEvents.map((e, i) => (
                <tr key={`${e.ts}-${i}`}>
                  <td className="px-2.5 py-1.5 text-muted-foreground whitespace-nowrap">
                    {formatTime(new Date(e.ts).getTime())}
                  </td>
                  <td className="px-2.5 py-1.5">
                    <Pill
                      tone={e.level === "error" ? "destructive" : e.level === "warn" ? "warning" : "info"}
                      size="xs"
                      dot
                    >
                      {e.level}
                    </Pill>
                  </td>
                  <td className="px-2.5 py-1.5 font-semibold">{e.event}</td>
                  <td className="px-2.5 py-1.5 text-muted-foreground">{e.msg ?? ""}</td>
                  <td className="px-2.5 py-1.5 text-muted-foreground">
                    {e.data ? (
                      <pre className="whitespace-pre-wrap break-words">{JSON.stringify(e.data)}</pre>
                    ) : (
                      ""
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {lastWarnOrError == null && ordered.length > 0 && (
            <p className="mt-2 px-2.5 text-[11px] text-muted-foreground">
              Last 25 events · all <span className="font-mono text-foreground">info</span> · worker is
              healthy.
            </p>
          )}
          {ordered.length > displayEvents.length && (
            <p className="mt-2 px-2.5 text-[11px] text-muted-foreground">
              Showing {displayEvents.length} newest events of {ordered.length} total. Older events are still
              in
              <span className="font-mono text-foreground">
                {" "}
                integration_worker_health.metadata.recent_events
              </span>
              .
            </p>
          )}
        </div>
      )}
    </GlassSection>
  );
}
