"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { ArrowLeft, CircleDot, FlaskConical, RefreshCw } from "lucide-react";

import { EmptyDataState } from "@/components/oems/primitives/empty-data-state";
import { GlassKpi, GlassSection, GlassSegment, PageCanvas } from "@/components/oems/primitives/glass";
import { LiveModelDashboard } from "@/components/oems/primitives/live-model-dashboard";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import { isSupabaseAuthConfigured } from "@/lib/supabase/config";

/* ── types (loose; server sends the model_*_c rows through) ───────────────── */
type Row = Record<string, unknown>;
interface Detail {
  ok: boolean;
  error?: string;
  model?: Row & {
    slug: string; name: string; strategy_name: string | null; description: string | null;
    market: string | null; universe: string | null; data_source: string | null; currency: string | null;
    budget: number | null; mode: string; status: string; cadence: string | null;
    last_run_at: string | null; heartbeatFresh: boolean; heartbeatAgeMs: number | null; params: Row | null;
  };
  metrics?: Row[];
  derivedLive?: Row | null;
  effectiveLive?: Row | null;
  equity?: Row[];
  latestPredictions?: Row[];
  latestPredictedAt?: string | null;
  positions?: Row[];
  positionSnapshotAt?: string | null;
  trades?: Row[];
  runs?: Row[];
}

const n = (v: unknown): number | null => (typeof v === "number" && isFinite(v) ? v : null);
const pct = (v: unknown, dp = 1) => (n(v) == null ? "—" : `${(n(v)! * 100).toFixed(dp)}%`);
const fx = (v: unknown, dp = 2) => (n(v) == null ? "—" : n(v)!.toFixed(dp));
const money = (v: unknown, ccy = "R") =>
  n(v) == null ? "—" : `${ccy}${Math.round(n(v)!).toLocaleString("en-ZA")}`;
const dt = (v: unknown) => (typeof v === "string" ? v.slice(0, 10) : "—");
function ago(ms: number | null): string {
  if (ms == null) return "never";
  const h = ms / 3_600_000;
  if (h < 1) return `${Math.max(1, Math.round(ms / 60000))}m ago`;
  if (h < 48) return `${Math.round(h)}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

export function ModelDetail({ slug }: { slug: string }) {
  const q = useQuery<Detail>({
    queryKey: ["model", slug],
    queryFn: async () => (await fetch(`/api/models/${slug}`)).json(),
    refetchInterval: 60_000,
  });

  // Push-driven refresh: a fresh `model_run_c` row from the pusher triggers an
  // immediate refetch of the model bundle so KPIs / equity curve / run log
  // update with sub-second latency instead of waiting on the 60s poll. The
  // realtime channel is silent on local dev where Supabase Auth isn't wired.
  useEffect(() => {
    if (!isSupabaseAuthConfigured()) return;
    const supabase = createSupabaseBrowserClient();
    const channel = supabase.channel(`model-run-${slug}`);
    const sub = channel.on(
      "postgres_changes",
      {
        event: "INSERT",
        schema: "public",
        table: "model_run_c",
        filter: `model_slug=eq.${slug}`,
      },
      () => {
        q.refetch();
      },
    );
    void channel.subscribe();
    return () => {
      void supabase.removeChannel(channel);
    };
    // We intentionally subscribe once per slug; q.refetch is stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug]);

  const d = q.data;
  const model = d?.model;
  const ccy = model?.currency === "USD" ? "$" : "R";

  const backtest = useMemo(() => (d?.metrics ?? []).find((m) => m.kind === "backtest"), [d]);
  const live = useMemo(
    () =>
      (d?.metrics ?? []).find((m) => m.kind === "live" || m.kind === "paper") ??
      d?.effectiveLive ??
      null,
    [d],
  );

  // equity: group by kind, choose the richest label per kind
  const equityByKind = useMemo(() => {
    const out: Record<string, { ts: string; equity: number }[]> = {};
    const counts: Record<string, Record<string, number>> = {};
    for (const p of d?.equity ?? []) {
      const kind = String(p.kind);
      const label = String(p.label);
      const bucket = (counts[kind] ??= {});
      bucket[label] = (bucket[label] ?? 0) + 1;
    }
    const bestLabel: Record<string, string> = {};
    for (const [kind, labels] of Object.entries(counts)) {
      const top = Object.entries(labels).sort((a, b) => b[1] - a[1])[0];
      if (top) bestLabel[kind] = top[0];
    }
    for (const p of d?.equity ?? []) {
      const kind = String(p.kind);
      if (String(p.label) !== bestLabel[kind]) continue;
      const eq = n(p.equity);
      if (eq == null) continue;
      (out[kind] ??= []).push({ ts: String(p.ts).slice(0, 10), equity: eq });
    }
    return out;
  }, [d]);

  const [view, setView] = useState<"backtest" | "paper">("backtest");
  const backtestCurve = equityByKind["backtest"] ?? [];
  const paperCurve = equityByKind["live"] ?? equityByKind["paper"] ?? [];
  const allTrades = d?.trades ?? [];
  const backtestTrades = allTrades.filter((t) => t.kind === "backtest");
  const paperTrades = allTrades.filter((t) => t.kind === "live" || t.kind === "paper");
  const positions = d?.positions ?? [];
  const preds = d?.latestPredictions ?? [];

  const equityPanel = (title: string, series: { ts: string; equity: number }[], note?: string) => (
    <GlassSection title={title} subtitle={note} endpoint="GET /api/models/[id]" dataSource="supabase" db="institutional">
      {series.length < 2 ? (
        <EmptyDataState title="No equity curve yet" message="Appears once there is a daily series to plot." badgeLabel="supabase" />
      ) : (
        <div className="h-72 w-full">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={series} margin={{ top: 8, right: 12, left: 4, bottom: 0 }}>
              <defs>
                <linearGradient id="eqfill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="hsl(var(--primary))" stopOpacity={0.28} />
                  <stop offset="100%" stopColor="hsl(var(--primary))" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid stroke="hsl(var(--border))" strokeDasharray="2 4" vertical={false} />
              <XAxis dataKey="ts" tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} stroke="hsl(var(--border))" minTickGap={40} />
              <YAxis
                tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }}
                stroke="hsl(var(--border))"
                width={64}
                domain={["dataMin", "dataMax"]}
                tickFormatter={(v) => `${ccy}${Math.round(Number(v) / 1000)}k`}
              />
              <Tooltip
                contentStyle={{ background: "hsl(var(--glass-bg-strong))", border: "1px solid hsl(var(--glass-border))", borderRadius: 8, fontSize: 12 }}
                formatter={(v) => [money(v, ccy), "Equity"]}
              />
              <Area type="monotone" dataKey="equity" stroke="hsl(var(--primary))" strokeWidth={2} fill="url(#eqfill)" />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      )}
    </GlassSection>
  );

  const tradesPanel = (title: string, subtitle: string, rows: Row[]) => (
    <GlassSection title={title} subtitle={subtitle} endpoint="GET /api/models/[id]" dataSource="supabase" db="institutional">
      {rows.length === 0 ? (
        <EmptyDataState title="No trades yet" message="The trade ledger fills as the model transacts." badgeLabel="supabase" />
      ) : (
        <Table
          head={["Date", "Symbol", "Side", "Qty", "Price", "P&L", "Reason"]}
          rows={rows.slice(0, 80).map((t) => [
            dt(t.exit_at ?? t.trade_date ?? t.entry_at),
            <span className="font-medium">{String(t.symbol)}</span>,
            <Side side={String(t.side ?? "")} />,
            n(t.qty) != null ? String(Math.round(n(t.qty)!)) : "—",
            money(t.exit_price ?? t.price ?? t.entry_price, ccy),
            <Pnl v={n(t.realized_pnl ?? t.pnl)} ccy={ccy} />,
            <span className="text-muted-foreground">{t.reason ? String(t.reason) : "—"}</span>,
          ])}
        />
      )}
    </GlassSection>
  );

  if (q.isLoading) {
    return (
      <PageCanvas>
        <div className="h-8 w-56 animate-pulse rounded bg-muted/40" />
        <div className="mt-4 h-64 animate-pulse rounded-xl bg-muted/30" />
      </PageCanvas>
    );
  }
  if (!d?.ok || !model) {
    return (
      <PageCanvas>
        <BackLink />
        <EmptyDataState
          title="Model not found"
          message={d?.error ?? `No model '${slug}'. It may not have been pushed yet.`}
          badgeLabel="supabase"
        />
      </PageCanvas>
    );
  }

  const currentValue = live?.final_equity ?? paperCurve.at(-1)?.equity ?? null;
  const startCapital = live?.budget ?? null;
  const totRet = n(live?.total_return);

  return (
    <PageCanvas>
      <BackLink />
      {/* header */}
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2.5">
            <h1 className="text-page-title">{model.name}</h1>
            <PaperBadge />
          </div>
          <p className="text-sm text-muted-foreground">{model.strategy_name ?? model.slug}</p>
          {model.description && (
            <p className="mt-1 max-w-2xl text-[13px] text-muted-foreground/90">{model.description}</p>
          )}
        </div>
        <div className="text-right">
          <span
            className={`inline-flex items-center gap-1.5 text-sm font-medium ${
              model.heartbeatFresh ? "text-up" : model.heartbeatAgeMs == null ? "text-muted-foreground" : "text-down"
            }`}
          >
            <CircleDot className="h-3.5 w-3.5" />
            {model.heartbeatFresh ? "Active" : model.heartbeatAgeMs == null ? "No data" : "Idle"}
          </span>
          <p className="text-[11px] text-muted-foreground">last push {ago(model.heartbeatAgeMs)}</p>
        </div>
      </div>
      <div className="mb-5 flex flex-wrap gap-1.5">
        {model.market && <Tag>{model.market.toUpperCase()}</Tag>}
        <Tag>{model.mode}</Tag>
        {model.data_source && <Tag>data · {model.data_source}</Tag>}
        {model.universe && <Tag>{model.universe}</Tag>}
        {model.cadence && <Tag>{model.cadence}</Tag>}
      </div>

      <p className="mb-4 text-xs text-muted-foreground">
        Own demo account (no broker): the model runs on real Yahoo prices, holdings are marked daily
        and fees are charged, 1:1 with a real account, but fully simulated. No real trades or money.
        Switch to the <span className="font-medium text-foreground">Paper account</span> tab for the
        live demo dashboard — equity vs STX40.JO benchmark, daily P&amp;L, drawdown, allocation and
        per-holding attribution. Pushes flow into Supabase and trigger an immediate refresh.
      </p>

      {/* sync bar */}
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border/50 bg-glass-bg px-3 py-2 text-xs">
        <span className="text-muted-foreground">
          Synced from Supabase · read {q.dataUpdatedAt ? new Date(q.dataUpdatedAt).toLocaleTimeString() : "—"} · pushed {ago(model.heartbeatAgeMs)}
        </span>
        <button
          type="button"
          onClick={() => q.refetch()}
          disabled={q.isFetching}
          className="inline-flex items-center gap-1.5 rounded-md border border-border/60 px-2.5 py-1 font-medium text-foreground transition hover:border-primary/60 hover:text-primary disabled:opacity-50"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${q.isFetching ? "animate-spin" : ""}`} />
          {q.isFetching ? "Syncing…" : "Refresh"}
        </button>
      </div>

      {/* Backtest | Paper */}
      <div className="mb-4">
        <GlassSegment
          value={view}
          options={[
            { id: "backtest", label: "Backtest" },
            { id: "paper", label: "Paper account" },
          ]}
          onChange={(v) => setView(v as "backtest" | "paper")}
        />
      </div>

      {view === "backtest" ? (
        <div className="space-y-4">
          <GlassSection
            title="Backtest Performance"
            subtitle={backtest ? `${dt(backtest.start_date)} → ${dt(backtest.end_date)} · historical` : "historical validation"}
            endpoint="GET /api/models/[id]"
            dataSource="supabase"
            db="institutional"
          >
            {!backtest ? (
              <EmptyDataState title="No backtest yet" message="Push a backtest run to populate performance." badgeLabel="supabase" />
            ) : (
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <GlassKpi label="CAGR" value={pct(backtest.cagr)} accent="positive" />
                <GlassKpi label="Total Return" value={pct(backtest.total_return)} accent="positive" />
                <GlassKpi label="Sharpe" value={fx(backtest.sharpe)} accent="primary" />
                <GlassKpi label="Max Drawdown" value={pct(backtest.max_drawdown)} accent="negative" />
                <GlassKpi label="Volatility" value={pct(backtest.volatility)} />
                <GlassKpi label="RoMaD" value={fx(backtest.romad)} />
                <GlassKpi label="Win Rate" value={pct(backtest.win_rate)} />
                <GlassKpi
                  label="Alpha vs Bench"
                  value={pct(backtest.alpha_cagr)}
                  sub={n(backtest.benchmark_cagr) != null ? `bench ${pct(backtest.benchmark_cagr)}` : undefined}
                  accent="positive"
                />
                <GlassKpi label="Final Equity" value={money(backtest.final_equity, ccy)} />
                <GlassKpi label="Trades" value={n(backtest.n_trades) != null ? String(backtest.n_trades) : "—"} sub={n(backtest.n_round_trips) != null ? `${backtest.n_round_trips} round-trips` : undefined} />
                <GlassKpi label="Avg P&L / trade" value={money(backtest.avg_pnl_per_trade, ccy)} />
                <GlassKpi label="Fees" value={n(backtest.fees_bps) != null ? `${backtest.fees_bps} bps` : "—"} />
              </div>
            )}
          </GlassSection>

          {equityPanel(
            "Backtest Equity Curve",
            backtestCurve,
            backtest ? `${dt(backtest.start_date)} → ${dt(backtest.end_date)}` : undefined,
          )}
          {tradesPanel("Backtest Trades", "historical fills", backtestTrades)}
        </div>
      ) : (
        <div className="space-y-4">
          <LiveModelDashboard
            slug={slug}
            positions={positions.map((p) => ({
              symbol: String(p.symbol ?? ""),
              side: p.side == null ? null : String(p.side),
              qty: n(p.qty),
              avg_entry_price: n(p.avg_entry_price),
              market_value: n(p.market_value),
              unrealized_pl: n(p.unrealized_pl),
              unrealized_plpc: n(p.unrealized_plpc),
              weight: n(p.weight),
            }))}
            paperCurveCount={paperCurve.length}
            currency={ccy}
          />
          <GlassSection
            title="Demo Account"
            subtitle="paper · our own account tracked daily on real prices, no broker"
            endpoint="GET /api/models/[id]"
            dataSource="supabase"
            db="institutional"
          >
            {live == null && paperCurve.length === 0 && positions.length === 0 ? (
              <EmptyDataState
                title="Paper account not started yet"
                message="Once the daily simulator runs, the demo account (holdings, equity, next target) appears here."
                badgeLabel="supabase"
              />
            ) : (
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <GlassKpi label="Starting Capital" value={money(startCapital, ccy)} />
                <GlassKpi label="Current Value" value={money(currentValue, ccy)} accent="primary" />
                <GlassKpi label="Total Return" value={pct(totRet)} accent={totRet != null && totRet < 0 ? "negative" : "positive"} />
                <GlassKpi label="Max Drawdown" value={pct(live?.max_drawdown)} accent="negative" />
                <GlassKpi label="Holdings" value={String(positions.length)} />
                <GlassKpi label="Days Tracked" value={String(paperCurve.length)} />
                <GlassKpi label="Since" value={live?.start_date ? dt(live.start_date) : (paperCurve[0]?.ts ?? "—")} />
                <GlassKpi label="Fees" value={n(live?.fees_bps) != null ? `${live?.fees_bps} bps` : "7 bps"} />
              </div>
            )}
          </GlassSection>

          {equityPanel("Paper Equity (daily)", paperCurve, "marked daily on Yahoo closes")}

          <GlassSection
            title="Current Holdings"
            subtitle={d?.positionSnapshotAt ? `as of ${dt(d.positionSnapshotAt)}` : "paper"}
            endpoint="GET /api/models/[id]"
            dataSource="supabase"
            db="institutional"
          >
            {positions.length === 0 ? (
              <EmptyDataState title="No open positions" message="Holdings appear once the paper account is running." badgeLabel="supabase" />
            ) : (
              <Table
                head={["Symbol", "Side", "Qty", "Avg Entry", "Mkt Value", "Unreal. P&L", "Weight"]}
                rows={positions.map((p) => [
                  <span className="font-medium">{String(p.symbol)}</span>,
                  <Side side={String(p.side ?? "long")} />,
                  n(p.qty) != null ? String(Math.round(n(p.qty)!)) : "—",
                  money(p.avg_entry_price, ccy),
                  money(p.market_value, ccy),
                  <Pnl v={n(p.unrealized_pl)} ccy={ccy} pc={n(p.unrealized_plpc)} />,
                  pct(p.weight),
                ])}
              />
            )}
          </GlassSection>

          <GlassSection
            title="Next Rebalance Target"
            subtitle={d?.latestPredictedAt ? `what the model plans to hold · ${dt(d.latestPredictedAt)}` : "the model's target basket"}
            endpoint="GET /api/models/[id]"
            dataSource="supabase"
            db="institutional"
          >
            {preds.length === 0 ? (
              <EmptyDataState title="No target yet" message="The model publishes its next target basket each run." badgeLabel="supabase" />
            ) : (
              <Table
                head={["Symbol", "Side", "Exp. Entry", "Qty"]}
                rows={preds.map((p) => [
                  <span className="font-medium">{String(p.symbol)}</span>,
                  <Side side={String(p.side ?? "")} />,
                  money(p.expected_entry_price, ccy),
                  n(p.quantity) != null ? String(Math.round(n(p.quantity)!)) : "—",
                ])}
              />
            )}
          </GlassSection>

          {tradesPanel("Paper Trades", "simulated fills, fees included", paperTrades)}
        </div>
      )}

      {/* data sync / push log (shared) */}
      <div className="mt-4">
        <GlassSection
          title="Data Sync"
          subtitle="push log from the model container (model_run_c)"
          endpoint="GET /api/models/[id]"
          dataSource="supabase"
          db="institutional"
        >
          {(d?.runs ?? []).length === 0 ? (
            <EmptyDataState title="No pushes recorded" message="Each pusher run logs here (register / backtest / live / heartbeat)." badgeLabel="supabase" />
          ) : (
            <Table
              head={["When", "Kind", "Status", "Rows", "Message"]}
              rows={(d?.runs ?? []).map((r) => [
                <span className="text-muted-foreground">{typeof r.created_at === "string" ? new Date(r.created_at).toLocaleString() : "—"}</span>,
                String(r.kind ?? "—"),
                <span className={r.status === "error" ? "text-down" : r.status === "ok" ? "text-up" : ""}>{String(r.status ?? "—")}</span>,
                n(r.rows_pushed) != null ? String(r.rows_pushed) : "—",
                <span className="text-muted-foreground">{r.message ? String(r.message) : "—"}</span>,
              ])}
            />
          )}
        </GlassSection>
      </div>
    </PageCanvas>
  );
}

/* ── small bits ──────────────────────────────────────────────────────────── */
function PaperBadge() {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-500/40 bg-amber-500/10 px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-amber-600 dark:text-amber-400">
      <FlaskConical className="h-3 w-3" />
      Paper · Simulation
    </span>
  );
}

function BackLink() {
  return (
    <Link href="/oems/models" className="mb-3 inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground">
      <ArrowLeft className="h-3.5 w-3.5" /> All models
    </Link>
  );
}
function Tag({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded border border-border/60 bg-muted/40 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
      {children}
    </span>
  );
}
function Side({ side }: { side: string }) {
  const s = side.toLowerCase();
  const sell = s === "sell" || s === "short";
  return <span className={sell ? "text-down" : "text-up"}>{side ? side.toUpperCase() : "—"}</span>;
}
function Pnl({ v, ccy, pc }: { v: number | null; ccy: string; pc?: number | null }) {
  if (v == null) return <span>—</span>;
  const cls = v >= 0 ? "text-up" : "text-down";
  return (
    <span className={`font-mono tabular-nums ${cls}`}>
      {v >= 0 ? "+" : "−"}
      {ccy}
      {Math.abs(Math.round(v)).toLocaleString("en-ZA")}
      {pc != null ? ` (${(pc * 100).toFixed(1)}%)` : ""}
    </span>
  );
}
function Table({ head, rows }: { head: string[]; rows: React.ReactNode[][] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[560px] text-left text-[13px]">
        <thead>
          <tr className="border-b border-border/60 text-[10px] uppercase tracking-wide text-muted-foreground">
            {head.map((h) => (
              <th key={h} className="px-2 py-2 font-medium">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-b border-border/30 last:border-0 hover:bg-muted/20">
              {r.map((c, j) => (
                <td key={j} className="px-2 py-2 align-top font-mono tabular-nums">{c}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
