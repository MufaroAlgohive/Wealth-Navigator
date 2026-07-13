"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { BrainCircuit, CircleDot, Cpu } from "lucide-react";

import { EmptyDataState } from "@/components/oems/primitives/empty-data-state";
import { GlassSection, PageCanvas } from "@/components/oems/primitives/glass";

interface Metric {
  cagr: number | null;
  sharpe: number | null;
  max_drawdown: number | null;
  total_return: number | null;
  final_equity: number | null;
  win_rate: number | null;
  alpha_cagr: number | null;
  as_of: string | null;
}
interface Model {
  slug: string;
  name: string;
  description: string | null;
  strategy_name: string | null;
  market: string | null;
  universe: string | null;
  data_source: string | null;
  currency: string | null;
  budget: number | null;
  mode: string;
  status: string;
  cadence: string | null;
  last_run_at: string | null;
  heartbeatFresh: boolean;
  heartbeatAgeMs: number | null;
  backtestMetric: Metric | null;
  liveMetric: Metric | null;
}

const pct = (v: number | null | undefined, dp = 1) =>
  v == null ? "—" : `${(v * 100).toFixed(dp)}%`;
const num = (v: number | null | undefined, dp = 2) => (v == null ? "—" : v.toFixed(dp));
const money = (v: number | null | undefined, ccy = "R") =>
  v == null ? "—" : `${ccy}${Math.round(v).toLocaleString("en-ZA")}`;

function ago(ms: number | null): string {
  if (ms == null) return "never";
  const h = ms / 3_600_000;
  if (h < 1) return `${Math.max(1, Math.round(ms / 60000))}m ago`;
  if (h < 48) return `${Math.round(h)}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

function StatusPill({ model }: { model: Model }) {
  const fresh = model.heartbeatFresh;
  const color = fresh ? "text-up" : model.heartbeatAgeMs == null ? "text-muted-foreground" : "text-down";
  const label = fresh ? "Live" : model.heartbeatAgeMs == null ? "No data" : "Stale";
  return (
    <span className={`inline-flex items-center gap-1.5 text-xs font-medium ${color}`}>
      <CircleDot className="h-3 w-3" />
      {label}
      <span className="text-[10px] text-muted-foreground">· {ago(model.heartbeatAgeMs)}</span>
    </span>
  );
}

export function ModelsList() {
  const q = useQuery<{ ok: boolean; models: Model[]; notice?: string }>({
    queryKey: ["models"],
    queryFn: async () => {
      const r = await fetch("/api/models");
      return r.json();
    },
    refetchInterval: 60_000,
  });

  const models = q.data?.models ?? [];

  return (
    <PageCanvas>
      <div className="mb-1 flex items-center gap-2">
        <BrainCircuit className="h-5 w-5 text-primary" />
        <h1 className="text-page-title">Models</h1>
      </div>
      <p className="mb-5 max-w-2xl text-sm text-muted-foreground">
        Quant models running in local Docker (Yahoo-fed paper simulation), pushing live metrics,
        predictions and equity to the desk. Backtest and live performance side by side.
      </p>

      <GlassSection
        title="Model Registry"
        subtitle={models.length ? `${models.length} model${models.length === 1 ? "" : "s"}` : undefined}
        endpoint="GET /api/models"
        dataSource="supabase"
        db="institutional"
      >
        {q.isLoading ? (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-44 animate-pulse rounded-xl border border-border/50 bg-muted/30" />
            ))}
          </div>
        ) : models.length === 0 ? (
          <EmptyDataState
            title="No models registered yet"
            message="Run the pusher from your local model Docker to register a model and stream its metrics."
            hint="scripts/push_to_supabase.py register && push-live  (see live/.env.supabase.example)"
            badgeLabel="supabase"
          />
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {models.map((m) => {
              const bt = m.backtestMetric;
              const lv = m.liveMetric;
              return (
                <Link
                  key={m.slug}
                  href={`/oems/models/${m.slug}`}
                  className="group flex flex-col rounded-xl border border-border/60 bg-glass-bg p-4 transition hover:border-primary/60 hover:bg-glass-bg-strong"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold text-foreground">{m.name}</p>
                      <p className="truncate text-[11px] text-muted-foreground">
                        {m.strategy_name ?? m.slug}
                      </p>
                    </div>
                    <StatusPill model={m} />
                  </div>

                  <div className="mt-3 flex flex-wrap gap-1.5">
                    {m.market && <Tag>{m.market.toUpperCase()}</Tag>}
                    <Tag>{m.mode}</Tag>
                    {m.data_source && <Tag>{m.data_source}</Tag>}
                    {m.universe && <Tag>{m.universe}</Tag>}
                  </div>

                  <div className="mt-4 grid grid-cols-3 gap-2 border-t border-border/40 pt-3">
                    <Mini label="CAGR" value={pct(bt?.cagr ?? lv?.cagr)} accent="up" />
                    <Mini label="Sharpe" value={num(bt?.sharpe ?? lv?.sharpe)} />
                    <Mini label="Max DD" value={pct(bt?.max_drawdown ?? lv?.max_drawdown)} accent="down" />
                  </div>

                  <div className="mt-auto flex items-center justify-between pt-3 text-[11px] text-muted-foreground">
                    <span className="inline-flex items-center gap-1">
                      <Cpu className="h-3 w-3" />
                      {lv?.final_equity != null
                        ? `Live ${money(lv.final_equity, m.currency === "USD" ? "$" : "R")}`
                        : m.budget != null
                          ? `Budget ${money(m.budget, m.currency === "USD" ? "$" : "R")}`
                          : "paper"}
                    </span>
                    <span className="text-primary opacity-0 transition group-hover:opacity-100">Open →</span>
                  </div>
                </Link>
              );
            })}
          </div>
        )}
      </GlassSection>
    </PageCanvas>
  );
}

function Tag({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded border border-border/60 bg-muted/40 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
      {children}
    </span>
  );
}

function Mini({ label, value, accent }: { label: string; value: string; accent?: "up" | "down" }) {
  return (
    <div>
      <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p
        className={`mt-0.5 font-mono text-sm tabular-nums ${accent === "up" ? "text-up" : accent === "down" ? "text-down" : "text-foreground"}`}
      >
        {value}
      </p>
    </div>
  );
}
