"use client";

/**
 * LiveDataFlowPanel — animated pipeline visualisation for the OEMS
 * Integration page. Shows the live journey of price data through the
 * platform: IRESS → Worker → Supabase → Yahoo fallback → UI, with per-node
 * state (live / stale / down / fallback) and a rolling ticker of the most
 * recent worker diagnostic events.
 *
 * Different from `DataFlowDiagram` (cockpit-level static snapshot): this
 * panel is the systems-page equivalent that also surfaces per-symbol
 * fallback counts (Yahoo active count) and the worker's recent event log,
 * giving operators a live feed of what's flowing through the platform.
 *
 * Data sources:
 *   - `/api/worker-health` (60s poll) → primaryWorker.iress_mode + heartbeat
 *     + recent_events.
 *   - `/api/quotes` (5s poll) → yahooCount for the user's watchlist
 *     (how many symbols the live fallback fired for).
 *   - `/api/equities` (60s poll) → returnsCoverage + yahooFallback for the
 *     broader universe.
 */

import { useQuery } from "@tanstack/react-query";
import {
  Activity,
  AlertTriangle,
  ArrowDownUp,
  CheckCircle2,
  ChevronRight,
  Database,
  MonitorSmartphone,
  Radio,
  RefreshCw,
  Server,
} from "lucide-react";
import * as React from "react";

import { DataSourceBadge, type DataSourceKind } from "@/components/oems/primitives/data-source-badge";
import { cn } from "@/lib/cn";
import { isRealDataOnlyClient } from "@/lib/data-policy";
import { pickPrimaryWorker, useWorkerHealth } from "@/lib/hooks/use-worker-health";
import {
  deriveDbFresh,
  isIressServiceHealthy,
  isWorkerAlive,
  resolveActiveDataSource,
} from "@/lib/market-prices/active-source";

type NodeState = "live" | "stale" | "down" | "fallback" | "off";

interface FlowNodeProps {
  id: string;
  label: string;
  caption?: string;
  state: NodeState;
  icon?: React.ReactNode;
  hint?: string;
  asOf?: string | null;
  right?: React.ReactNode;
}

const NODE_BASE =
  "relative flex min-w-[140px] flex-col items-center gap-1 rounded-xl border bg-card/70 px-3 py-2.5 backdrop-blur-sm transition-all duration-500";

const STATE_STYLES: Record<NodeState, { container: string; dot: string; label: string }> = {
  live: {
    container: "border-success/40 shadow-[0_0_24px_-8px_hsl(var(--success)/0.45)]",
    dot: "bg-success",
    label: "LIVE",
  },
  stale: {
    container: "border-warning/40 shadow-[0_0_18px_-10px_hsl(var(--warning)/0.35)]",
    dot: "bg-warning",
    label: "STALE",
  },
  down: {
    container: "border-destructive/40 shadow-[0_0_18px_-10px_hsl(var(--destructive)/0.35)]",
    dot: "bg-destructive",
    label: "DOWN",
  },
  fallback: {
    container: "border-amber-400/50 shadow-[0_0_24px_-8px_hsl(38_95%_56%/0.45)]",
    dot: "bg-amber-400",
    label: "FALLBACK",
  },
  off: {
    container: "border-border/60 opacity-60",
    dot: "bg-muted-foreground",
    label: "OFF",
  },
};

function FlowNode({ label, caption, state, icon, hint, asOf, right }: FlowNodeProps) {
  const s = STATE_STYLES[state];
  return (
    <div
      className={cn(NODE_BASE, s.container)}
      title={hint ?? `${label} · ${s.label}${asOf ? ` · as of ${asOf}` : ""}`}
    >
      <div className="flex items-center gap-2">
        <span
          aria-hidden
          className={cn(
            "relative inline-flex h-2.5 w-2.5 rounded-full",
            s.dot,
            (state === "live" || state === "fallback") && "animate-pulse",
          )}
        />
        {icon ? <span className="text-muted-foreground">{icon}</span> : null}
        <span className="font-mono text-[10.5px] font-bold uppercase tracking-wider text-foreground">
          {label}
        </span>
      </div>
      {caption ? <span className="text-[9.5px] text-muted-foreground">{caption}</span> : null}
      <div className="mt-0.5 flex items-center gap-1">
        <span
          className={cn(
            "inline-flex items-center gap-1 rounded px-1.5 py-px font-mono text-[8.5px] font-bold uppercase tracking-wider border",
            state === "live" && "border-success/40 text-success",
            state === "stale" && "border-warning/40 text-warning",
            state === "down" && "border-destructive/40 text-destructive",
            state === "fallback" && "border-amber-400/50 text-amber-300",
            state === "off" && "border-border text-muted-foreground",
          )}
        >
          {s.label}
        </span>
        {right}
      </div>
      {asOf ? <span className="text-[8.5px] text-muted-foreground/80">as of {asOf}</span> : null}
    </div>
  );
}

function FlowConnector({ active }: { active: boolean }) {
  return (
    <div aria-hidden className="relative h-[2px] flex-1" style={{ marginTop: "44px" }}>
      <span
        className={cn(
          "absolute inset-0 rounded-full",
          active ? "bg-gradient-to-r from-transparent via-success/60 to-transparent" : "bg-border/40",
        )}
      />
      {active ? (
        <span
          className="pointer-events-none absolute left-0 top-1/2 h-[2px] w-1/3 -translate-y-1/2 rounded-full bg-success/80 blur-[1px]"
          style={{ animation: "live-flow-stream 1.4s linear infinite" }}
        />
      ) : null}
    </div>
  );
}

interface QuoteRow {
  symbol: string;
  source?: string;
  ts?: number;
}

interface QuotesPayload {
  mode: string;
  liveCount: number;
  fallbackCount: number;
  yahooCount?: number;
  supabaseCount: number;
}

interface EquitiesPayload {
  count: number;
  iressOverlay?: number;
  yahooFallback?: number;
  source: string;
}

function fmtTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const ms = new Date(iso).getTime();
  if (!Number.isFinite(ms)) return "—";
  return new Date(ms).toLocaleTimeString("en-ZA", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    timeZone: "Africa/Johannesburg",
  });
}

function fmtAgo(iso: string | null | undefined): string {
  if (!iso) return "—";
  const ms = new Date(iso).getTime();
  if (!Number.isFinite(ms)) return "—";
  const diff = Math.max(0, Date.now() - ms);
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s ago`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m ago`;
}

export function LiveDataFlowPanel() {
  const realDataOnly = isRealDataOnlyClient();
  const workerQ = useWorkerHealth(realDataOnly);
  const quotesQ = useQuery<QuotesPayload>({
    queryKey: ["bff-quotes-data-flow"],
    queryFn: async () => {
      const r = await fetch("/api/quotes?symbols=NPN,PRX,FSR,SBK,MTN,SOL,SHP,AGL,BHG", {
        cache: "no-store",
      });
      return r.json();
    },
    refetchInterval: 5_000,
    enabled: realDataOnly,
  });
  const equitiesQ = useQuery<EquitiesPayload>({
    queryKey: ["bff-equities-data-flow"],
    queryFn: async () => {
      const r = await fetch("/api/equities", { cache: "no-store" });
      return r.json();
    },
    refetchInterval: 15_000,
    enabled: realDataOnly,
  });

  // Inject the data-flow keyframes once. (Re-used for the live stream.)
  React.useEffect(() => {
    if (typeof document === "undefined") return;
    if (document.getElementById("live-flow-keyframes")) return;
    const style = document.createElement("style");
    style.id = "live-flow-keyframes";
    style.textContent = `
@keyframes live-flow-stream {
  0% { transform: translateX(-100%); }
  100% { transform: translateX(400%); }
}
@keyframes live-tick-pulse {
  0% { box-shadow: 0 0 0 0 hsl(var(--success) / 0.55); }
  70% { box-shadow: 0 0 0 8px hsl(var(--success) / 0); }
  100% { box-shadow: 0 0 0 0 hsl(var(--success) / 0); }
}
`.trim();
    document.head.appendChild(style);
  }, []);

  const workers = workerQ.data?.workers ?? [];
  const primaryWorker = pickPrimaryWorker(workers);
  const workerAlive = isWorkerAlive(primaryWorker?.last_heartbeat_at ?? null);
  const fallbackCount = quotesQ.data?.fallbackCount ?? 0;
  const yahooCount = quotesQ.data?.yahooCount ?? 0;
  const liveCount = quotesQ.data?.liveCount ?? 0;
  const supabaseCount = quotesQ.data?.supabaseCount ?? 0;
  const lastQuoteSyncAt = primaryWorker?.last_quote_sync_at ?? null;
  const universeYahooFallback = equitiesQ.data?.yahooFallback ?? 0;
  const universeCount = equitiesQ.data?.count ?? 0;
  const universeIressOverlay = equitiesQ.data?.iressOverlay ?? 0;

  const iressEvents = (primaryWorker?.recent_events ?? []) as Array<{
    ts: string;
    service?: string | null;
    level?: string | null;
    event?: string;
    msg?: string;
  }>;

  const activeSource = resolveActiveDataSource({
    iressMode: primaryWorker?.iress_mode ?? null,
    workerAlive,
    lastQuoteSyncAt,
    fallbackCount,
    iressEvents,
  });
  const kindToDataSourceKind: Record<string, DataSourceKind> = {
    iress: "iress",
    hybrid: "hybrid",
    yahoo: "yahoo",
    db: "supabase",
    off: "mock",
    down: "unavailable",
  };
  const activeKind = kindToDataSourceKind[activeSource.mode] ?? "unavailable";

  // Resolve node states.
  const iressServiceOk = isIressServiceHealthy(iressEvents);
  const iressState: NodeState =
    primaryWorker?.iress_mode === "uat"
      ? "fallback"
      : primaryWorker?.iress_mode === "live" && workerAlive && iressServiceOk
        ? "live"
        : !workerAlive && primaryWorker == null
          ? "off"
          : "down";
  const workerState: NodeState = primaryWorker ? (workerAlive ? "live" : "stale") : "off";
  const dbState: NodeState =
    liveCount > 0 || supabaseCount > 0 ? "live" : iressState === "live" ? "stale" : "down";
  const fallbackState: NodeState =
    activeSource.mode === "yahoo" ? "live" : fallbackCount > 0 ? "fallback" : "off";

  // Animated horizontal pipeline
  return (
    <div className="glass-panel relative overflow-hidden px-4 py-5 md:px-6">
      <div className="pointer-events-none absolute -right-16 -top-16 h-44 w-44 rounded-full bg-primary/10 blur-3xl" />
      <div className="relative mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <ArrowDownUp className="h-3.5 w-3.5 text-primary" />
          <h3 className="font-mono text-[11px] font-bold uppercase tracking-wider text-foreground">
            Live Data Flow
          </h3>
          <span className="font-mono text-[10px] text-muted-foreground">· 5s poll</span>
        </div>
        <div className="flex items-center gap-2">
          <span title={activeSource.reason} aria-label={activeSource.reason}>
            <DataSourceBadge source={activeKind} db="retail" />
          </span>
          {activeSource.yahooActive ? (
            <span className="font-mono text-[9.5px] font-semibold uppercase tracking-wider text-amber-300">
              + yahoo
            </span>
          ) : null}
        </div>
      </div>

      {/* Pipeline row */}
      <div className="relative flex flex-col items-stretch gap-2 lg:flex-row lg:items-center lg:gap-0">
        <FlowNode
          id="iress"
          label="IRESS"
          caption={primaryWorker ? `mode: ${primaryWorker.iress_mode ?? "—"}` : "no worker row yet"}
          state={iressState}
          icon={<Radio className="h-3 w-3" />}
          asOf={fmtAgo(primaryWorker?.last_heartbeat_at ?? null)}
        />
        <FlowConnector active={workerState === "live" || workerState === "stale"} />
        <FlowNode
          id="worker"
          label="Worker"
          caption={primaryWorker ? `${primaryWorker.symbols_covered?.length ?? 0} symbols` : "no heartbeat"}
          state={workerState}
          icon={<Server className="h-3 w-3" />}
          asOf={fmtAgo(primaryWorker?.last_quote_sync_at ?? null)}
        />
        <FlowConnector active={dbState === "live" || dbState === "stale"} />
        <FlowNode
          id="db"
          label="Supabase DB"
          caption={`${liveCount} live · ${supabaseCount} supabase`}
          state={dbState}
          icon={<Database className="h-3 w-3" />}
        />
        <FlowConnector active={fallbackState !== "off"} />
        <FlowNode
          id="yahoo"
          label="Yahoo Fallback"
          caption={`${yahooCount} on this call`}
          state={fallbackState}
          icon={<Activity className="h-3 w-3" />}
        />
        <FlowConnector active={true} />
        <FlowNode
          id="ui"
          label="UI"
          caption="Cockpit · equities"
          state={"live" as const}
          icon={<MonitorSmartphone className="h-3 w-3" />}
        />
      </div>

      {/* Live counters row */}
      <div className="relative mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <CounterTile
          label="IRESS ticks (5s)"
          value={liveCount}
          accent={liveCount > 0 ? "positive" : "default"}
          hint="Live quote count returned by /api/quotes for the watchlist in the last poll."
        />
        <CounterTile
          label="Yahoo fallback (5s)"
          value={yahooCount}
          accent={yahooCount > 0 ? "warning" : "default"}
          hint="Watchlist symbols the BFF served from Yahoo live because the DB row was stale or missing."
        />
        <CounterTile
          label="Universe fallback"
          value={universeYahooFallback}
          sub={`of ${universeCount} symbols`}
          accent={universeYahooFallback > 0 ? "warning" : "default"}
          hint="Total symbols the /api/equities board served from Yahoo live."
        />
        <CounterTile
          label="IRESS overlay (universe)"
          value={universeIressOverlay}
          accent={universeIressOverlay > 0 ? "positive" : "default"}
          hint="Universe rows whose price was overlaid from the institutional IRESS-PROD L1 feed."
        />
      </div>

      {/* Recent events ticker */}
      <div className="relative mt-4">
        <div className="mb-2 flex items-center justify-between">
          <h4 className="font-mono text-[10.5px] font-semibold uppercase tracking-wider text-muted-foreground">
            Recent worker events
          </h4>
          <span className="font-mono text-[9.5px] text-muted-foreground">
            <RefreshCw className="mr-1 inline h-2.5 w-2.5" /> live · 60s
          </span>
        </div>
        <div className="glass-inset max-h-[160px] overflow-y-auto scrollbar-thin">
          {iressEvents.length === 0 ? (
            <p className="px-3 py-4 text-[11px] text-muted-foreground">
              No worker events recorded yet. The worker emits events after the first successful quote sync.
            </p>
          ) : (
            <ul className="divide-y divide-[hsl(var(--glass-border))]/40">
              {iressEvents.slice(0, 8).map((e, idx) => {
                const level = (e.level ?? "info").toLowerCase();
                return (
                  <li
                    key={`${e.ts}-${idx}`}
                    className="flex items-center gap-3 px-3 py-1.5 font-mono text-[10.5px]"
                  >
                    <span
                      className={cn(
                        "h-1.5 w-1.5 shrink-0 rounded-full",
                        level === "error" && "bg-destructive",
                        level === "warn" && "bg-warning",
                        level === "info" && "bg-success",
                      )}
                      aria-hidden
                    />
                    <span className="w-16 shrink-0 tabular-nums text-muted-foreground">{fmtAgo(e.ts)}</span>
                    <span className="w-14 shrink-0 text-muted-foreground">
                      {e.service ? String(e.service).toUpperCase() : "—"}
                    </span>
                    <span className="flex-1 truncate text-foreground">
                      {e.event ?? "event"}
                      {e.msg ? <span className="text-muted-foreground"> · {e.msg}</span> : null}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

function CounterTile({
  label,
  value,
  sub,
  accent = "default",
  hint,
}: {
  label: string;
  value: number;
  sub?: string;
  accent?: "positive" | "warning" | "negative" | "default";
  hint?: string;
}) {
  return (
    <div
      title={hint ?? label}
      className={cn(
        "glass-inset flex flex-col gap-1 px-3 py-2",
        accent === "positive" && "border-success/30",
        accent === "warning" && "border-amber-400/30",
        accent === "negative" && "border-destructive/30",
      )}
    >
      <span className="font-mono text-[9.5px] uppercase tracking-wider text-muted-foreground">{label}</span>
      <span
        className={cn(
          "font-mono text-[20px] font-bold tabular-nums leading-none",
          accent === "positive" && "text-success",
          accent === "warning" && "text-amber-300",
          accent === "negative" && "text-destructive",
          accent === "default" && "text-foreground",
        )}
      >
        {value}
      </span>
      {sub ? <span className="font-mono text-[9px] text-muted-foreground">{sub}</span> : null}
    </div>
  );
}
