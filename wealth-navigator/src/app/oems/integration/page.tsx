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
import { useWorkerHealth } from "@/lib/hooks/use-worker-health";
import { isRealDataOnlyClient } from "@/lib/data-policy";
import { EmptyDataState } from "@/components/oems/primitives/empty-data-state";
import { formatTime } from "@/lib/format";
import { cn } from "@/lib/cn";
import { queryOpts } from "@/lib/store/query-provider";

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
  const primaryWorker = workers[0];

  return (
    <div className="space-y-3">
      <header>
        <h1 className="text-lg font-semibold tracking-tight">Integration · IRESS V4</h1>
        <p className="text-xs text-muted-foreground">Adapter health · environment · method coverage · session model</p>
      </header>

      <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-4">
        <KpiTile
          icon={<Cable className="h-3.5 w-3.5" />}
          label="Adapter mode"
          value={iressConfig.mode.toUpperCase()}
          sub={iressConfig.baseUrl}
          tone={iressConfig.mode === "live" ? "positive" : "default"}
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
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border/60">
                    {workers.map((w) => (
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
                          {w.symbols_covered?.length ?? "—"}
                        </td>
                      </tr>
                    ))}
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
          title="Latency · p95 last 60 min"
          endpoint={realDataOnly ? "Not available without metrics store" : "INTERNAL · p95 window"}
          className="col-span-12 lg:col-span-4 h-[420px]"
        >
          {realDataOnly ? (
            <EmptyDataState message="Latency history requires observability backend." />
          ) : (
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart
              data={Array.from({ length: 60 }, (_, i) => ({ t: i, p95: 220 + Math.sin(i / 6) * 30 + Math.cos(i / 18) * 18 }))}
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
              <Area type="monotone" dataKey="p95" stroke="hsl(38 95% 56%)" fill="url(#lat)" strokeWidth={1.8} />
            </AreaChart>
          </ResponsiveContainer>
          )}
        </Panel>
      </div>

      <div className="grid grid-cols-12 gap-2.5">
        <Panel
          title="Session model · two-layer"
          endpoint="IRESSSessionStart + ServiceSessionStart"
          className="col-span-12 lg:col-span-6 h-[260px]"
        >
          <ul className="space-y-2.5 text-[12.5px]">
            <li className="flex items-start gap-3">
              <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded bg-primary/15 text-[10px] font-bold text-primary">1</span>
              <p>
                <span className="font-mono text-xs">IRESSSessionStart</span> opens a long-lived,
                machine-scoped bearer. Refreshed every 22h, never re-used across services.
              </p>
            </li>
            <li className="flex items-start gap-3">
              <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded bg-primary/15 text-[10px] font-bold text-primary">2</span>
              <p>
                <span className="font-mono text-xs">ServiceSessionStart</span> wraps the bearer in a
                service-scoped session (IRESS / IOS / IPS / FIX+). Used on every call; closed
                on <span className="font-mono text-xs">ServiceSessionEnd</span> or after a configurable idle window.
              </p>
            </li>
            <li className="flex items-start gap-3">
              <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded bg-primary/15 text-[10px] font-bold text-primary">3</span>
              <p>
                Idempotency via <span className="font-mono text-xs">OrderTag</span>. Retries safe on
                network errors; rejected on duplicate body with same tag.
              </p>
            </li>
            <li className="flex items-start gap-3">
              <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded bg-primary/15 text-[10px] font-bold text-primary">4</span>
              <p>
                Long-polling on <span className="font-mono text-xs">OrderPadGetByAccountUpdates</span> +
                <span className="font-mono text-xs">IPSTransactionGetByAccount5</span> for the live tape.
                Falls back to polling on session drops with exponential back-off.
              </p>
            </li>
          </ul>
        </Panel>

        <Panel
          title="Method coverage · V4 (this adapter)"
          endpoint="traced to iress-v4-docs/11-mint-oems"
          className="col-span-12 lg:col-span-6 h-[260px]"
          density="scroll"
        >
          <div className="grid grid-cols-1 gap-1.5 text-xs">
            {iressConfig.methods.map((m) => (
              <div key={m.group} className="rounded-md border border-border/60 bg-surface-2/30 p-2">
                <p className="font-mono text-[10.5px] font-semibold uppercase tracking-wider text-muted-foreground">{m.group}</p>
                <p className="mt-0.5 text-[10.5px] font-mono">{m.methods.join(" · ")}</p>
              </div>
            ))}
          </div>
        </Panel>
      </div>

      <Panel
        title="Build path · Mock → Live"
        endpoint="OPERATIONS"
        right={<Pill tone="info" size="xs">No live creds yet</Pill>}
      >
        <ol className="grid grid-cols-1 gap-2 text-[12.5px] md:grid-cols-4">
          {[
            { n: 1, title: "Mock adapter",  body: "IressClient interface with deterministic seed data and a simulated order book. Lets us build the full UI before any creds." },
            { n: 2, title: "Edge proxy",    body: "Bun HTTP server fronting IRESS V4 WSDL. Handles gzip, two-layer session, WSDL versioning, and SSE for long-polling." },
            { n: 3, title: "Reconciliation",body: "Daily 16:00 recon of open orders / positions / balances vs IRESS bookings. Pre-trade checks HALTED / SUSPENDED / NON-TRADEABLE." },
            { n: 4, title: "Cutover",       body: "Toggle IRESS_MODE=live, freeze mock, replay the same queries against IRESS, validate, and turn the desk on." },
          ].map((s) => (
            <li key={s.n} className="rounded-md border border-border/60 bg-surface-2/30 p-3">
              <p className="font-mono text-[10px] font-bold text-primary">Step {s.n}</p>
              <p className="mt-1 text-sm font-semibold">{s.title}</p>
              <p className="mt-1 text-muted-foreground">{s.body}</p>
            </li>
          ))}
        </ol>
      </Panel>
    </div>
  );
}
