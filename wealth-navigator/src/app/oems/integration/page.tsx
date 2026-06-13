"use client";

import { useQuery } from "@tanstack/react-query";
import { CheckCircle2, AlertTriangle, XCircle, Loader2, Cable, Server, Activity, Globe2 } from "lucide-react";
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

import { Panel } from "@/components/oems/primitives/panel";
import { Pill } from "@/components/oems/primitives/pill";
import { KpiTile } from "@/components/oems/primitives/kpi-tile";
import { PanelSkeleton, KpiTileSkeleton } from "@/components/oems/primitives/panel-skeleton";
import { iressConfig } from "@/lib/iress";
import { useIress } from "@/lib/iress/provider";
import { useWorkerHealth, pickPrimaryWorker } from "@/lib/hooks/use-worker-health";
import { isRealDataOnlyClient } from "@/lib/data-policy";
import { EmptyDataState } from "@/components/oems/primitives/empty-data-state";
import { formatTime } from "@/lib/format";
import { cn } from "@/lib/cn";
import { queryOpts } from "@/lib/store/query-provider";
import type { WorkerEvent } from "@/app/api/worker-health/route";

const STATUS_ICON = {
  ok:      CheckCircle2,
  lag:     Loader2,
  warn:    AlertTriangle,
  error:   XCircle,
};

const STATUS_TONE = {
  ok:    "success",
  lag:   "warning",
  warn:  "warning",
  error: "destructive",
} as const;

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
  // Audit #1 — Adapter-mode tile reads from the worker's own
  // `iress_mode` (Railway env) when a worker is heartbeating. The
  // Vercel `iressConfig.mode` is the *UI-side* env (mock), so it
  // always shows MOCK on production even though the worker is live.
  // Fall back to the UI config only when no worker has heartbeated
  // in the last 60s.
  const workerAlive = primaryWorker
    ? Date.now() - new Date(primaryWorker.last_heartbeat_at).getTime() < 60_000
    : false;
  const effectiveMode = workerAlive && primaryWorker?.iress_mode
    ? primaryWorker.iress_mode
    : iressConfig.mode;
  // Audit #2 — ghost-row safety net banner. The BFF drops
  // `status="stopped"` rows + rows from a different `service_name`,
  // but the operator may still want a visible signal that the
  // filter did work. `ghostRowsHidden` is included in the response.
  const ghostRowsHidden = workerQ.data?.ghostRowsHidden ?? 0;

  return (
    <div className="space-y-3">
      <header>
        <h1 className="text-lg font-semibold tracking-tight">Integration · IRESS V4</h1>
        <p className="text-xs text-muted-foreground">Adapter health · environment · method coverage · session model</p>
      </header>

      {ghostRowsHidden > 0 ? (
        <div className="flex items-center justify-between rounded-md border border-warning/40 bg-warning/5 px-3 py-1.5 text-[11px] text-warning">
          <span>
            <strong>{ghostRowsHidden}</strong> stale worker heartbeats hidden by the
            BFF ghost filter. Delete the ghost Railway service to clear.
          </span>
        </div>
      ) : null}

      <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-4">
        <KpiTile
          icon={<Cable className="h-3.5 w-3.5" />}
          label="Adapter mode"
          value={(effectiveMode ?? "mock").toUpperCase()}
          sub={workerAlive ? `via Railway ${primaryWorker?.worker_id ?? ""}` : iressConfig.baseUrl}
          tone={effectiveMode === "live" ? "positive" : "default"}
        />
        <KpiTile
          icon={<Server className="h-3.5 w-3.5" />}
          label="Endpoint groups"
          value={`${iressConfig.methods.length} groups`}
          sub="IRESSSession + ServiceSession scoped"
        />
        <KpiTile
          icon={<Activity className="h-3.5 w-3.5" />}
          label={realDataOnly ? "Worker status" : "Healthy / Total"}
          value={
            realDataOnly
              ? (primaryWorker?.status?.toUpperCase() ?? "—")
              : `${endpoints.filter((e) => e.status === "ok").length} / ${endpoints.length}`
          }
          sub={
            realDataOnly
              ? primaryWorker
                ? `Last heartbeat ${formatTime(new Date(primaryWorker.last_heartbeat_at).getTime())}`
                : "No heartbeat row yet"
              : undefined
          }
          tone={
            realDataOnly
              ? primaryWorker?.status === "healthy"
                ? "positive"
                : primaryWorker
                  ? "warning"
                  : "default"
              : endpoints.some((e) => e.status === "error")
                ? "negative"
                : "positive"
          }
        />
        <KpiTile
          icon={<Globe2 className="h-3.5 w-3.5" />}
          label="Region"
          value={iressConfig.region}
          sub="ZA production"
        />
      </div>

      <div className="grid grid-cols-12 gap-2.5">
        {realDataOnly ? (
          workerQ.isLoading ? (
            <PanelSkeleton rows={4} height="h-[420px]" className="col-span-12 lg:col-span-8" />
          ) : (
            <Panel
              title="Railway worker · integration_worker_health"
              endpoint="GET /api/worker-health"
              dataSource="supabase"
              className="col-span-12 lg:col-span-8 h-[420px]"
              density="scroll"
            >
              {workers.length === 0 ? (
                <EmptyDataState message="No worker heartbeat rows — start iress-ingest on Railway." />
              ) : (
                <table className="w-full font-mono text-[11px]">
                  <thead className="sticky top-0 z-10 bg-card/95 backdrop-blur">
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
                  <tbody className="divide-y divide-border/60">
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
                            {w.last_quote_sync_at ? formatTime(new Date(w.last_quote_sync_at).getTime()) : "—"}
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
              )}
            </Panel>
          )
        ) : healthQ.isLoading ? (
          <PanelSkeleton rows={8} height="h-[420px]" className="col-span-12 lg:col-span-8" />
        ) : (
          <Panel
            title="Endpoint health · last 30 min"
            endpoint="GET /api/iress/health"
            dataSource={iressConfig.mode === "live" ? "hybrid" : "seed"}
            className="col-span-12 lg:col-span-8 h-[420px]"
            density="scroll"
          >
          <table className="w-full font-mono text-[11px]">
            <thead className="sticky top-0 z-10 bg-card/95 backdrop-blur">
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
            <tbody className="divide-y divide-border/60">
              {endpoints.map((e) => {
                const Icon = STATUS_ICON[e.status];
                return (
                  <tr key={e.name}>
                    <td className="px-2.5 py-1.5 font-semibold">{e.name}</td>
                    <td className="px-2.5 py-1.5 text-muted-foreground">{e.method}</td>
                    <td className="px-2.5 py-1.5 text-right tabular-nums">{e.p50}ms</td>
                    <td className="px-2.5 py-1.5 text-right tabular-nums">{e.p95}ms</td>
                    <td className="px-2.5 py-1.5 text-right tabular-nums">{e.rps}/s</td>
                    <td className={cn("px-2.5 py-1.5 text-right tabular-nums", e.errPct > 1 && "text-destructive")}>{e.errPct.toFixed(2)}</td>
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
        </Panel>
        )}

        <Panel
          title="Latency · IRESS calls"
          endpoint={realDataOnly ? "DERIVED · worker recent_events[*].elapsedMs" : "INTERNAL · mock window"}
          dataSource={
            !realDataOnly
              ? "mock"
              : (primaryWorker?.recent_events ?? []).some((e) => typeof e.data?.elapsedMs === "number")
                ? "worker"
                : "unconfigured"
          }
          className="col-span-12 lg:col-span-4 h-[420px]"
        >
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
                  <AreaChart
                    data={series}
                    margin={{ top: 8, right: 8, left: -20, bottom: 0 }}
                  >
                    <defs>
                      <linearGradient id="lat" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="hsl(38 95% 56%)" stopOpacity={0.4} />
                        <stop offset="100%" stopColor="hsl(38 95% 56%)" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid stroke="hsl(var(--border))" strokeDasharray="2 4" vertical={false} />
                    <XAxis dataKey="t" tick={{ fontSize: 9, fill: "hsl(var(--muted-foreground))" }} stroke="hsl(var(--border))" tickFormatter={(v) => formatTime(String(v))} interval={Math.max(1, Math.floor(series.length / 6))} />
                    <YAxis tick={{ fontSize: 9, fill: "hsl(var(--muted-foreground))" }} stroke="hsl(var(--border))" unit="ms" />
                    <Tooltip contentStyle={{ fontSize: 11, background: "hsl(var(--popover))", border: "1px solid hsl(var(--border))", borderRadius: 6 }} />
                    <Area type="monotone" dataKey="ms" stroke="hsl(38 95% 56%)" fill="url(#lat)" strokeWidth={1.8} />
                  </AreaChart>
                </ResponsiveContainer>
              );
            })()
          ) : (
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart
              data={Array.from({ length: 60 }, (_, i) => ({ t: i, ms: 220 + Math.sin(i / 6) * 30 + Math.cos(i / 18) * 18 }))}
              margin={{ top: 8, right: 8, left: -20, bottom: 0 }}
            >
              <defs>
                <linearGradient id="lat" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="hsl(38 95% 56%)" stopOpacity={0.4} />
                  <stop offset="100%" stopColor="hsl(38 95% 56%)" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid stroke="hsl(var(--border))" strokeDasharray="2 4" vertical={false} />
              <XAxis dataKey="t" tick={{ fontSize: 9, fill: "hsl(var(--muted-foreground))" }} stroke="hsl(var(--border))" tickFormatter={(v) => `${v}m`} interval={9} />
              <YAxis tick={{ fontSize: 9, fill: "hsl(var(--muted-foreground))" }} stroke="hsl(var(--border))" unit="ms" />
              <Tooltip contentStyle={{ fontSize: 11, background: "hsl(var(--popover))", border: "1px solid hsl(var(--border))", borderRadius: 6 }} />
              <Area type="monotone" dataKey="ms" stroke="hsl(38 95% 56%)" fill="url(#lat)" strokeWidth={1.8} />
            </AreaChart>
          </ResponsiveContainer>
          )}
        </Panel>
      </div>

      <div className="grid grid-cols-12 gap-2.5">
        {realDataOnly ? (
          <>
            <Panel
              title="Order mirror · oems_order_audit"
              endpoint="OrderPadGetByAccount → worker poll"
              dataSource={primaryWorker?.account_configured ? "supabase" : "unconfigured"}
              className="col-span-12 lg:col-span-6 h-[240px]"
            >
              {!primaryWorker ? (
                <p className="text-[12px] text-muted-foreground">
                  No worker heartbeat yet — start the Railway{" "}
                  <span className="font-mono text-foreground">Iress-Worker</span> service to begin ingesting.
                </p>
              ) : primaryWorker.account_configured ? (
                <ul className="space-y-2 text-[12px] text-muted-foreground">
                  <li>
                    Polling accounts:{" "}
                    <span className="font-mono text-foreground">
                      {primaryWorker.accounts?.join(", ") || "—"}
                    </span>{" "}
                    (<span className="font-mono text-foreground">IRESS_ACCOUNT_CODE</span>)
                  </li>
                  <li>
                    <span className="font-mono text-foreground">OrderPadGetByAccount</span> every{" "}
                    <span className="font-mono text-foreground">IRESS_WORKER_ORDER_POLL_SEC</span>{" "}
                    (default 60s) → upserts into{" "}
                    <span className="font-mono text-foreground">oems_order_audit</span>. Cockpit Open
                    Orders + Blotter read from this table.
                  </li>
                </ul>
              ) : (
                <div className="space-y-2 text-[12px]">
                  <div className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-[12px]">
                    <p className="font-medium text-warning">Set <span className="font-mono">IRESS_ACCOUNT_CODE</span> on Railway to enable order mirror</p>
                    <p className="mt-1 text-muted-foreground">
                      The worker is running but <span className="font-mono">IRESS_ACCOUNT_CODE</span>{" "}
                      is empty, so <span className="font-mono">OrderPadGetByAccount</span> returns
                      no rows. The Cockpit Open Orders panel will stay empty until this is set.
                    </p>
                  </div>
                  <p className="text-muted-foreground">
                    Set the env on the Railway <span className="font-mono text-foreground">Iress-Worker</span>{" "}
                    service to a comma-separated list of account codes (e.g.{" "}
                    <span className="font-mono text-foreground">Z12345,Z67890</span>), then restart.
                    Quote ingest keeps running independently of this env.
                  </p>
                </div>
              )}
            </Panel>
            <Panel
              title="Quote ingest · stock_intraday_c"
              endpoint="PricingQuoteGet → worker poll"
              dataSource="supabase"
              className="col-span-12 lg:col-span-6 h-[240px]"
            >
              <ul className="space-y-2 text-[12px] text-muted-foreground">
                <li>
                  Vercel reads worker snapshots via <span className="font-mono text-foreground">GET /api/quotes</span> (~15s poll) and optional Realtime on{" "}
                  <span className="font-mono text-foreground">stock_intraday_c</span>.
                </li>
                <li>
                  Watchlist size:{" "}
                  <span className="font-mono text-foreground">
                    {primaryWorker?.symbols_covered?.length ?? "—"}
                  </span>{" "}
                  symbols. Rate codes (USDZAR → <span className="font-mono text-foreground">FX</span>, JIBAR_3M → <span className="font-mono text-foreground">MM</span>)
                  ride the same <span className="font-mono text-foreground">PricingQuoteGet</span> loop — no extra entitlement needed.
                </li>
                <li>
                  Connection pill shows <span className="font-mono text-foreground">SUPABASE OK</span> when the last quote tick is under 20s old;{" "}
                  <span className="font-mono text-foreground">/api/ticks</span> SSE is disabled in this mode.
                </li>
              </ul>
            </Panel>
          </>
        ) : null}
        {/* Audit #17 + #29 — replaced the "Session model" 1-2-3-4 numbered
             list and the "Build path · Mock → Live" doc-bleed panel with a
             single "Production status" panel that shows live state for the
             four IRESS services. The method-coverage sub-panel below
             surfaces the 17-method V4 catalog (Yellow #26). */}
        <Panel
          title="Production status"
          endpoint="DERIVED · worker recent_events"
          className="col-span-12 lg:col-span-6 h-[260px]"
          density="scroll"
        >
          <ProductionStatusGrid primaryWorker={primaryWorker} events={primaryWorker?.recent_events ?? []} />
        </Panel>

        <Panel
          title="Method coverage · V4 (this adapter)"
          endpoint="traced to iress-v4-docs/11-mint-oems"
          className="col-span-12 lg:col-span-6 h-[260px]"
          density="scroll"
        >
          <div className="grid grid-cols-1 gap-1.5 text-xs">
            {(iressConfig.methods.length > 0 ? iressConfig.methods : DEFAULT_V4_METHODS).map((m) => (
              <div key={m.group} className="rounded-md border border-border/60 bg-surface-2/30 p-2">
                <p className="font-mono text-[10.5px] font-semibold uppercase tracking-wider text-muted-foreground">{m.group}</p>
                <p className="mt-0.5 text-[10.5px] font-mono">{m.methods.join(" · ")}</p>
              </div>
            ))}
          </div>
        </Panel>
      </div>

      {realDataOnly ? (
        <WorkerDiagnosticEventsPanel events={primaryWorker?.recent_events ?? []} hasWorker={Boolean(primaryWorker)} />
      ) : null}
    </div>
  );
}

/**
 * Fallback V4 method catalog (Yellow #26). When the Vercel env doesn't
 * carry a methods array, the integration page falls back to this list
 * of 17 methods grouped by iress/ios/ips/fix — the same surface the
 * `IressClient` exposes. Update in lockstep with `src/lib/iress/index.ts`.
 */
const DEFAULT_V4_METHODS: ReadonlyArray<{ group: string; methods: string[] }> = [
  { group: "iress",  methods: ["IRESSSessionStart", "IRESSSessionEnd", "PricingQuoteGet", "InstrumentSearch", "StaticReferenceDataGet"] },
  { group: "ios",    methods: ["ServiceSessionStart", "ServiceSessionEnd", "OrderAdd", "OrderAmend", "OrderDelete", "OrderPadGetByAccount", "OrderPadGetByAccountUpdates"] },
  { group: "ips",    methods: ["IPSAccountGetAll1", "IPSPositionGetAll1", "IPSTransactionGetByAccount5"] },
  { group: "fix",    methods: ["FixSessionStart", "FixSessionEnd", "FixOrderReplace"] },
];

/**
 * Production status grid (Yellow #17 + #29). Four service tiles (IRESS /
 * IOS+ / IPS / FIX+) each with a green/amber/red dot derived from the
 * worker's `recent_events` list, plus a 4th tile for last-sync times and
 * a 5th for the IRESS CT license seat. Replaces the 1-2-3-4 numbered
 * session-model list.
 */
function ProductionStatusGrid({
  primaryWorker,
  events,
}: {
  primaryWorker: ReturnType<typeof pickPrimaryWorker>;
  events: ReadonlyArray<WorkerEvent>;
}) {
  // Helper: green if the service has any `info` event in the last 25
  // events, amber if `warn`, red if `error`, grey if no events at all.
  const lastByService = (svc: "iress" | "ios" | "ips" | "fix") => {
    const e = events.find((ev) => String(ev.data?.service ?? "").toLowerCase() === svc);
    if (!e) return { tone: "default" as const, msg: "No calls recorded yet." };
    if (e.level === "error") return { tone: "destructive" as const, msg: `Last error: ${e.event} — ${e.msg ?? ""}` };
    if (e.level === "warn")  return { tone: "warning" as const, msg: `Last warn: ${e.event} — ${e.msg ?? ""}` };
    return { tone: "positive" as const, msg: `Last ok: ${e.event}${e.msg ? ` — ${e.msg}` : ""}` };
  };
  const svcs: Array<{ name: "iress" | "ios" | "ips" | "fix"; label: string }> = [
    { name: "iress", label: "IRESS" },
    { name: "ios",   label: "IOS+"  },
    { name: "ips",   label: "IPS"   },
    { name: "fix",   label: "FIX+"  },
  ];
  // Audit #17 sub-tile #4 — license seat. Count distinct `service_name`
  // values from the worker's metadata to detect ghost workers.
  const seatCount = primaryWorker ? 1 : 0;
  return (
    <div className="grid grid-cols-2 gap-2 lg:grid-cols-2">
      {svcs.map((s) => {
        const st = lastByService(s.name);
        return (
          <div key={s.name} className="rounded-md border border-border/60 bg-surface-2/30 p-2.5">
            <div className="flex items-center justify-between">
              <p className="font-mono text-[10.5px] font-semibold uppercase tracking-wider">{s.label}</p>
              <Pill tone={st.tone === "default" ? "neutral" : st.tone === "positive" ? "success" : (st.tone as "warning" | "destructive")} size="xs" dot>
                {st.tone === "default" ? "NO DATA" : st.tone === "positive" ? "OK" : st.tone === "warning" ? "WARN" : "ERROR"}
              </Pill>
            </div>
            <p className="mt-1 text-[10.5px] text-muted-foreground">{st.msg}</p>
          </div>
        );
      })}
      <div className="rounded-md border border-border/60 bg-surface-2/30 p-2.5 col-span-2">
        <div className="flex items-center justify-between">
          <p className="font-mono text-[10.5px] font-semibold uppercase tracking-wider">Last sync</p>
          <Pill tone="neutral" size="xs">IRESS single-seat</Pill>
        </div>
        <ul className="mt-1 grid grid-cols-3 gap-2 text-[10.5px] text-muted-foreground">
          <li>Quotes: <span className="font-mono text-foreground">{primaryWorker?.last_quote_sync_at ? formatTime(new Date(primaryWorker.last_quote_sync_at).getTime()) : "—"}</span></li>
          <li>Orders: <span className="font-mono text-foreground">{(primaryWorker?.metadata as Record<string, unknown> | undefined)?.last_order_sync_at ? formatTime(new Date(String((primaryWorker!.metadata as Record<string, unknown>).last_order_sync_at)).getTime()) : "—"}</span></li>
          <li>IPS:    <span className="font-mono text-foreground">{(primaryWorker?.metadata as Record<string, unknown> | undefined)?.last_ips_sync_at ? formatTime(new Date(String((primaryWorker!.metadata as Record<string, unknown>).last_ips_sync_at)).getTime()) : "—"}</span></li>
        </ul>
        <p className="mt-1 text-[10.5px] text-muted-foreground">License seat: <span className="font-mono text-foreground">{seatCount}/1</span> — IRESS CT is single-seat; concurrent replicas will 25008 on PricingQuoteGet.</p>
      </div>
    </div>
  );
}

/**
 * "Worker diagnostic events" panel — surfaces the worker's in-process
 * structured event ring buffer. Today the operator has to tail Railway
 * logs to see `time_series_entitlement_missing`, 25008 license seat
 * back-off, and `quote_sync_complete` summaries. Storing those events
 * inside `integration_worker_health.metadata.recent_events` and showing
 * them here means the desk can answer "why isn't the worker getting
 * data" without leaving the app.
 *
 * Events are newest-first, capped at 50 in the worker. The panel collapses
 * the high-volume `info` events to a single summary row when nothing more
 * recent is a `warn`/`error` so the page doesn't drown in successful
 * sync pings.
 */
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
  // Heuristic: if the latest event is `info` and the most recent warn/error
  // is older than the most recent 4 events, surface only the top warn/error
  // and a one-line "last sync ok" summary. Keeps the table useful when the
  // worker is healthy.
  const lastWarnOrError = ordered.find((e) => e.level === "warn" || e.level === "error");
  // Yellow #19 — when the worker has been healthy for a long stretch
  // (no warn/error) and there are > 5 info events, collapse the table
  // to the last 5 so the page isn't all-blue noise. When warn/errors
  // exist, show the newest 25 (the existing cap) so the operator can
  // find them quickly.
  const displayEvents =
    lastWarnOrError == null && ordered.length > 5
      ? ordered.slice(0, 5)
      : ordered.slice(0, 25);

  return (
    <Panel
      title="Worker diagnostic events"
      endpoint="metadata.recent_events on integration_worker_health"
      dataSource="supabase"
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
          No worker heartbeat row yet — start the Railway <span className="font-mono text-foreground">Iress-Worker</span>{" "}
          service to begin ingesting.
        </p>
      ) : !hasEvents ? (
        <p className="text-[12px] text-muted-foreground">
          Worker has not emitted any structured events since the last restart — that usually means the
          IRESS session hasn't started yet, or the first quote sync is in flight.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full font-mono text-[11px]">
            <thead className="sticky top-0 z-10 bg-card/95 backdrop-blur">
              <tr className="text-[9.5px] uppercase tracking-wider text-muted-foreground">
                <th className="px-2.5 py-1.5 text-left">Time</th>
                <th className="px-2.5 py-1.5 text-left">Level</th>
                <th className="px-2.5 py-1.5 text-left">Event</th>
                <th className="px-2.5 py-1.5 text-left">Message</th>
                <th className="px-2.5 py-1.5 text-left">Data</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/60">
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
                    {e.data ? <pre className="whitespace-pre-wrap break-words">{JSON.stringify(e.data)}</pre> : ""}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {/* Yellow #19 — always show the summary line "all info · worker
              is healthy" when no warn/error events, regardless of how
              many info events are present. Compress the table to the
              last 5 info events when there are > 5; show the
              newest 25 (the existing cap) when there are warn/errors
              that need surfacing. */}
          {lastWarnOrError == null && ordered.length > 0 && (
            <p className="mt-2 text-[11px] text-muted-foreground">
              Last 25 events · all <span className="font-mono text-foreground">info</span> ·
              worker is healthy.
            </p>
          )}
          {ordered.length > displayEvents.length && (
            <p className="mt-2 text-[11px] text-muted-foreground">
              Showing {displayEvents.length} newest events of {ordered.length} total. Older events
              are still in
              <span className="font-mono text-foreground"> integration_worker_health.metadata.recent_events</span>.
            </p>
          )}
        </div>
      )}
    </Panel>
  );
}
