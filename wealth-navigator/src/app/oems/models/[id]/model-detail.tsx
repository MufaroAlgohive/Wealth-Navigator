"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useMemo, useState } from "react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { ArrowLeft, CircleDot } from "lucide-react";

import { EmptyDataState } from "@/components/oems/primitives/empty-data-state";
import { GlassKpi, GlassSection, GlassSegment, PageCanvas } from "@/components/oems/primitives/glass";

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

  const d = q.data;
  const model = d?.model;
  const ccy = model?.currency === "USD" ? "$" : "R";

  // metrics: pick backtest + live
  const backtest = useMemo(() => (d?.metrics ?? []).find((m) => m.kind === "backtest"), [d]);
  const live = useMemo(
    () => (d?.metrics ?? []).find((m) => m.kind === "live" || m.kind === "paper"),
    [d],
  );

  // equity: group by kind, choose the richest label per kind
  const equityByKind = useMemo(() => {
    const out: Record<string, { ts: string; equity: number }[]> = {};
    const counts: Record<string, Record<string, number>> = {};
    for (const p of d?.equity ?? []) {
      const kind = String(p.kind);
      const label = String(p.label);
      counts[kind] = counts[kind] ?? {};
      counts[kind][label] = (counts[kind][label] ?? 0) + 1;
    }
    const bestLabel: Record<string, string> = {};
    for (const kind of Object.keys(counts)) {
      bestLabel[kind] = Object.entries(counts[kind]).sort((a, b) => b[1] - a[1])[0][0];
    }
    for (const p of d?.equity ?? []) {
      const kind = String(p.kind);
      if (String(p.label) !== bestLabel[kind]) continue;
      const eq = n(p.equity);
      if (eq == null) continue;
      (out[kind] = out[kind] ?? []).push({ ts: String(p.ts).slice(0, 10), equity: eq });
    }
    return out;
  }, [d]);

  const equityKinds = Object.keys(equityByKind);
  const [curveKind, setCurveKind] = useState<string>("");
  const activeKind = curveKind && equityByKind[curveKind] ? curveKind : (equityKinds.includes("backtest") ? "backtest" : equityKinds[0] ?? "");
  const curve = activeKind ? equityByKind[activeKind] : [];
  const [metricView, setMetricView] = useState<"backtest" | "live">("backtest");
  const activeMetric = (metricView === "live" ? live : backtest) ?? backtest ?? live;

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

  return (
    <PageCanvas>
      <BackLink />
      {/* header */}
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-page-title">{model.name}</h1>
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
            {model.heartbeatFresh ? "Live" : model.heartbeatAgeMs == null ? "No data" : "Stale"}
          </span>
          <p className="text-[11px] text-muted-foreground">heartbeat {ago(model.heartbeatAgeMs)}</p>
        </div>
      </div>
      <div className="mb-5 flex flex-wrap gap-1.5">
        {model.market && <Tag>{model.market.toUpperCase()}</Tag>}
        <Tag>{model.mode}</Tag>
        {model.data_source && <Tag>data · {model.data_source}</Tag>}
        {model.universe && <Tag>{model.universe}</Tag>}
        {model.cadence && <Tag>{model.cadence}</Tag>}
        {model.budget != null && <Tag>budget {money(model.budget, ccy)}</Tag>}
      </div>

      {/* metrics */}
      <GlassSection
        title="Performance"
        subtitle={activeMetric ? `${dt(activeMetric.start_date)} → ${dt(activeMetric.end_date)}` : undefined}
        endpoint="GET /api/models/[id]"
        dataSource="supabase"
        db="institutional"
        right={
          backtest && live ? (
            <GlassSegment
              value={metricView}
              options={[
                { id: "backtest", label: "Backtest" },
                { id: "live", label: "Live" },
              ]}
              onChange={(v) => setMetricView(v as "backtest" | "live")}
            />
          ) : undefined
        }
      >
        {!activeMetric ? (
          <EmptyDataState title="No metrics yet" message="Push a backtest or live rollup to populate performance." badgeLabel="supabase" />
        ) : (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <GlassKpi label="CAGR" value={pct(activeMetric.cagr)} accent="positive" />
            <GlassKpi label="Total Return" value={pct(activeMetric.total_return)} accent="positive" />
            <GlassKpi label="Sharpe" value={fx(activeMetric.sharpe)} accent="primary" />
            <GlassKpi label="Max Drawdown" value={pct(activeMetric.max_drawdown)} accent="negative" />
            <GlassKpi label="Volatility" value={pct(activeMetric.volatility)} />
            <GlassKpi label="RoMaD" value={fx(activeMetric.romad)} />
            <GlassKpi label="Win Rate" value={pct(activeMetric.win_rate)} />
            <GlassKpi
              label="Alpha vs Bench"
              value={pct(activeMetric.alpha_cagr)}
              sub={n(activeMetric.benchmark_cagr) != null ? `bench ${pct(activeMetric.benchmark_cagr)}` : undefined}
              accent="positive"
            />
            <GlassKpi label="Final Equity" value={money(activeMetric.final_equity, ccy)} />
            <GlassKpi label="Trades" value={n(activeMetric.n_trades) != null ? String(activeMetric.n_trades) : "—"} sub={n(activeMetric.n_round_trips) != null ? `${activeMetric.n_round_trips} round-trips` : undefined} />
            <GlassKpi label="Avg P&L / trade" value={money(activeMetric.avg_pnl_per_trade, ccy)} />
            <GlassKpi label="Fees" value={n(activeMetric.fees_bps) != null ? `${activeMetric.fees_bps} bps` : "—"} />
          </div>
        )}
      </GlassSection>

      {/* equity curve */}
      <GlassSection
        title="Equity Curve"
        endpoint="GET /api/models/[id]"
        dataSource="supabase"
        db="institutional"
        right={
          equityKinds.length > 1 ? (
            <GlassSegment
              value={activeKind}
              options={equityKinds.map((k) => ({ id: k, label: k[0].toUpperCase() + k.slice(1) }))}
              onChange={setCurveKind}
            />
          ) : undefined
        }
      >
        {curve.length < 2 ? (
          <EmptyDataState title="No equity curve" message="Push a backtest or live equity series to plot it." badgeLabel="supabase" />
        ) : (
          <div className="h-72 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={curve} margin={{ top: 8, right: 12, left: 4, bottom: 0 }}>
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
                  contentStyle={{
                    background: "hsl(var(--glass-bg-strong))",
                    border: "1px solid hsl(var(--glass-border))",
                    borderRadius: 8,
                    fontSize: 12,
                  }}
                  formatter={(v) => [money(v, ccy), "Equity"]}
                />
                <Area type="monotone" dataKey="equity" stroke="hsl(var(--primary))" strokeWidth={2} fill="url(#eqfill)" />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        )}
      </GlassSection>

      {/* predictions */}
      <GlassSection
        title="Latest Predictions & Reasoning"
        subtitle={d?.latestPredictedAt ? `as of ${dt(d.latestPredictedAt)}` : undefined}
        endpoint="GET /api/models/[id]"
        dataSource="supabase"
        db="institutional"
      >
        {(d?.latestPredictions ?? []).length === 0 ? (
          <EmptyDataState title="No predictions yet" message="The model pushes its signal batch each run." badgeLabel="supabase" />
        ) : (
          <Table
            head={["Symbol", "Side", "Prob ↑", "Score", "Exp. Entry", "Qty", "Reasoning"]}
            rows={(d?.latestPredictions ?? []).map((p) => [
              <span className="font-medium">{String(p.symbol)}</span>,
              <Side side={String(p.side ?? "")} />,
              pct(p.ml_prob_up, 0),
              fx(p.score),
              money(p.expected_entry_price, ccy),
              n(p.quantity) != null ? String(Math.round(n(p.quantity)!)) : "—",
              <span className="text-muted-foreground">{p.reason ? String(p.reason) : "—"}</span>,
            ])}
          />
        )}
      </GlassSection>

      {/* positions */}
      <GlassSection
        title="Current Positions"
        subtitle={d?.positionSnapshotAt ? `snapshot ${dt(d.positionSnapshotAt)}` : undefined}
        endpoint="GET /api/models/[id]"
        dataSource="supabase"
        db="institutional"
      >
        {(d?.positions ?? []).length === 0 ? (
          <EmptyDataState title="No open positions" message="Position snapshots appear once the model is running paper/live." badgeLabel="supabase" />
        ) : (
          <Table
            head={["Symbol", "Side", "Qty", "Avg Entry", "Mkt Value", "Unreal. P&L", "Weight"]}
            rows={(d?.positions ?? []).map((p) => [
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

      {/* trades */}
      <GlassSection
        title="Recent Trades"
        endpoint="GET /api/models/[id]"
        dataSource="supabase"
        db="institutional"
      >
        {(d?.trades ?? []).length === 0 ? (
          <EmptyDataState title="No trades yet" message="The trade ledger fills as the model transacts." badgeLabel="supabase" />
        ) : (
          <Table
            head={["Date", "Symbol", "Side", "Qty", "Price", "P&L", "Reason"]}
            rows={(d?.trades ?? []).slice(0, 60).map((t) => [
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
    </PageCanvas>
  );
}

/* ── small bits ──────────────────────────────────────────────────────────── */
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
