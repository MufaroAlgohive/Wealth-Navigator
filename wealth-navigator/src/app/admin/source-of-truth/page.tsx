"use client";

import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  DatabaseZap,
  Download,
  RefreshCw,
  Search,
  Sparkles,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type Position = {
  key: string;
  userId: string;
  familyMemberId?: string;
  strategyId: string;
  client: string;
  email?: string;
  mintNumber?: string;
  strategy: string;
  asOf?: string;
  currentCents: number;
  securitiesCents: number;
  residualCents: number;
  reserveCents: number;
  liabilityCents: number;
  pnlCents: number;
  inceptionPct?: number;
  ytdPct?: number;
};
type Strategy = {
  id: string;
  name: string;
  minInvestment: number;
  status?: string;
  investedPositions: number;
};
type Quote = {
  yahooSymbol: string;
  exchangeTime: string;
  fetchedAt: string;
  source: string;
};
type LiveHolding = {
  symbol: string;
  security?: string;
  name?: string;
  quantity: number;
  livePriceCents: number;
  marketValueCents: number;
  costPriceCents?: number;
  costValueCents?: number;
  fillDate?: string;
  createdAt?: string;
  transactionId?: string;
  rebalanceBatchId?: string;
  formula: string;
  quote: Quote;
};
type SurfaceCheck = {
  surface: string;
  status: "ok" | "warning" | "urgent";
  latencyMs: number;
  actual: string;
  expected: string;
  difference?: string;
  evidence: string[];
  comparisons: Array<{
    metric: string;
    actual: number | null;
    expected: number | null;
    difference: number | null;
    unit: "percent" | "cents";
    status: "ok" | "warning" | "urgent";
  }>;
};
type TruthPosition = {
  key: string;
  strategyId: string;
  strategy: string;
  familyMemberId?: string;
  asOf?: string;
  holdings: LiveHolding[];
  securitiesCents: number;
  residualCents: number;
  residualUpdatedAt?: string;
  reserveCents: number;
  liabilityCents: number;
  liveValueCents: number;
  investedCents: number;
  livePnlCents: number;
  liveReturnPct?: number;
  canonicalValueCents: number;
  canonicalPnlCents: number;
  differenceCents: number;
  appDisplayedValueCents: number;
  appDisplayedPnlCents: number;
  severity: "ok" | "warning" | "urgent";
  reasons: string[];
  returns: { fiveDayPct?: number; mtdPct?: number; ytdPct?: number; allTimePct?: number };
  history: Array<{
    date: string;
    valueCents: number;
    securitiesCents: number;
    residualCents: number;
    reserveCents: number;
    pnlCents: number;
    ytdPct: number;
    allTimePct: number;
  }>;
  ledger: Array<{ cell: string; label: string; formula: string; cents: number }>;
  formula: string;
};
type ClientTruth = {
  kind: "client";
  generatedAt: string;
  provider: string;
  profile: { first_name?: string; last_name?: string; email?: string; mint_number?: string };
  positions: TruthPosition[];
  strategyBenchmarks: Record<
    string,
    { asOf?: string; ytdPct?: number; allTimePct?: number; caCents?: number; completeValueCents?: number }
  >;
  totals: Record<string, number>;
  audit: { severity: "ok" | "warning" | "urgent"; urgent: number; warnings: number };
  activity: Array<{
    id: string;
    date: string;
    direction?: string;
    name?: string;
    description?: string;
    status?: string;
    amountCents: number;
    reserveCents: number;
    reserveConsumedCents: number;
    reversed?: boolean;
  }>;
  surfaceChecks: SurfaceCheck[];
};
type StrategyTruth = {
  kind: "strategy";
  generatedAt: string;
  provider: string;
  strategy: { name?: string; short_name?: string; updated_at?: string };
  holdings: LiveHolding[];
  live: {
    securitiesCents: number;
    modelCapitalCents: number;
    strategyCaCents: number;
    caWeightPct: number;
    formula: string;
  };
  canonical?: Record<string, string | number | null>;
  differences: Record<string, number>;
  severity: "ok" | "warning" | "urgent";
  reasons: string[];
  returns: { fiveDayPct?: number; mtdPct?: number; ytdPct?: number; allTimePct?: number };
  history: Array<{
    date: string;
    valueCents: number;
    securitiesCents: number;
    caCents: number;
    ytdPct: number;
    allTimePct: number;
  }>;
  surfaceChecks: SurfaceCheck[];
};
type GeneralTruth = {
  kind: "general";
  generatedAt: string;
  auditedClients: number;
  auditedStrategies: number;
  summary: { urgent: number; warning: number; ok: number };
  findings: Array<{
    kind: string;
    id: string;
    label: string;
    severity: "ok" | "warning" | "urgent";
    differenceCents: number;
    message: string;
  }>;
  surfaceChecks: SurfaceCheck[];
};
type Truth = ClientTruth | StrategyTruth | GeneralTruth;

const money = (cents: number | null | undefined) =>
  new Intl.NumberFormat("en-ZA", { style: "currency", currency: "ZAR" }).format(Number(cents ?? 0) / 100);
const pct = (value: number | null | undefined) =>
  value == null ? "—" : `${value >= 0 ? "+" : ""}${Number(value).toFixed(2)}%`;
const when = (value: string | null | undefined) =>
  value ? new Date(value).toLocaleString("en-ZA", { dateStyle: "medium", timeStyle: "short" }) : "—";
const tone = (value: number | null | undefined) =>
  Number(value ?? 0) === 0 ? "text-emerald-400" : "text-amber-400";

function Stat({ label, value, className = "" }: { label: string; value: string; className?: string }) {
  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.035] p-3">
      <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
        {label}
      </div>
      <div className={`mt-1 text-sm font-semibold tabular-nums ${className}`}>{value}</div>
    </div>
  );
}

function HoldingRows({ rows }: { rows: LiveHolding[] }) {
  return (
    <div className="space-y-2">
      {rows.map((row, index) => (
        <details key={`${row.symbol}-${index}`} className="rounded-lg border border-white/10 bg-black/10 p-3">
          <summary className="cursor-pointer list-none">
            <div className="flex items-center justify-between gap-3">
              <div>
                <span className="font-semibold">{row.symbol}</span>
                <span className="ml-2 text-xs text-muted-foreground">{row.security || row.name}</span>
              </div>
              <div className="text-right text-sm tabular-nums">
                <div>{money(row.marketValueCents)}</div>
                <div className="text-xs text-muted-foreground">
                  {row.quantity} × {money(row.livePriceCents)}
                </div>
              </div>
            </div>
          </summary>
          <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 border-t border-white/10 pt-3 text-xs">
            <dt className="text-muted-foreground">Yahoo instrument</dt>
            <dd>{row.quote.yahooSymbol}</dd>
            <dt className="text-muted-foreground">Exchange price time</dt>
            <dd>{when(row.quote.exchangeTime)}</dd>
            <dt className="text-muted-foreground">Fetched by OEM</dt>
            <dd>{when(row.quote.fetchedAt)}</dd>
            <dt className="text-muted-foreground">Cost price / value</dt>
            <dd>
              {row.costPriceCents == null
                ? "Model holding"
                : `${money(row.costPriceCents)} / ${money(row.costValueCents)}`}
            </dd>
            <dt className="text-muted-foreground">Fill / created</dt>
            <dd>{when(row.fillDate || row.createdAt)}</dd>
            <dt className="text-muted-foreground">Transaction</dt>
            <dd className="break-all">{row.transactionId || "—"}</dd>
            <dt className="text-muted-foreground">Rebalance batch</dt>
            <dd className="break-all">{row.rebalanceBatchId || "—"}</dd>
            <dt className="text-muted-foreground">Formula</dt>
            <dd>{row.formula}</dd>
          </dl>
        </details>
      ))}
    </div>
  );
}

export default function SourceOfTruthPage() {
  const [mode, setMode] = useState<"client" | "strategy">("client");
  const [positions, setPositions] = useState<Position[]>([]);
  const [strategies, setStrategies] = useState<Strategy[]>([]);
  const [selected, setSelected] = useState<{ id: string; label: string } | null>(null);
  const [truth, setTruth] = useState<Truth | null>(null);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    void fetch("/api/admin/source-of-truth", { cache: "no-store" })
      .then(async (response) => {
        const body = await response.json();
        if (!response.ok || !body.ok) throw new Error(body.error || "Could not load canonical index");
        setPositions(body.positions ?? []);
        setStrategies(body.strategies ?? []);
      })
      .catch((reason) => setError(reason instanceof Error ? reason.message : "Could not load source data"))
      .finally(() => setLoading(false));
  }, []);

  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (mode === "strategy") {
      return strategies.filter(
        (row) => !needle || `${row.name} ${row.status}`.toLowerCase().includes(needle),
      );
    }
    return positions.filter(
      (row) =>
        !needle ||
        `${row.client} ${row.email} ${row.mintNumber} ${row.strategy}`.toLowerCase().includes(needle),
    );
  }, [mode, positions, query, strategies]);

  const preflight = useMemo(() => {
    const now = Date.now();
    const enriched = positions.map((row) => {
      const equationCents =
        Number(row.securitiesCents) +
        Number(row.residualCents) +
        Number(row.reserveCents) -
        Number(row.liabilityCents);
      const differenceCents = equationCents - Number(row.currentCents);
      const ageDays = row.asOf ? Math.floor((now - new Date(row.asOf).getTime()) / 86_400_000) : 999;
      return { ...row, differenceCents, ageDays };
    });
    const warnings = enriched.filter((row) => Math.abs(row.differenceCents) > 1 || row.ageDays > 3);
    const uniqueClients = new Set(positions.map((row) => row.userId)).size;
    const strategyExposure = new Map<string, number>();
    for (const row of positions) {
      strategyExposure.set(
        row.strategy,
        (strategyExposure.get(row.strategy) ?? 0) + Number(row.currentCents),
      );
    }
    return {
      uniqueClients,
      warnings,
      stale: enriched.filter((row) => row.ageDays > 3).length,
      currentCents: positions.reduce((sum, row) => sum + Number(row.currentCents), 0),
      residualCents: positions.reduce((sum, row) => sum + Number(row.residualCents), 0),
      reserveCents: positions.reduce((sum, row) => sum + Number(row.reserveCents), 0),
      topAffected: [...warnings]
        .sort(
          (a, b) =>
            Math.abs(b.differenceCents) + b.ageDays * 100 - (Math.abs(a.differenceCents) + a.ageDays * 100),
        )
        .slice(0, 5),
      strategyExposure: [...strategyExposure].map(([name, cents]) => ({ name, cents })),
    };
  }, [positions]);

  const runTruth = async (general = false) => {
    if (!general && !selected) return;
    setRunning(true);
    setError("");
    setTruth(null);
    try {
      const response = await fetch("/api/admin/source-of-truth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(general ? { kind: "general" } : { kind: mode, id: selected?.id }),
      });
      const body = await response.json();
      if (!response.ok || !body.ok) throw new Error(body.error || "Live truth calculation failed");
      setTruth(body.truth);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Live truth calculation failed");
    } finally {
      setRunning(false);
    }
  };

  const switchMode = (next: "client" | "strategy") => {
    setMode(next);
    setSelected(null);
    setTruth(null);
    setError("");
  };

  return (
    <main className="mx-auto max-w-[1700px] space-y-5 p-4 md:p-6">
      <header className="rounded-2xl border border-violet-400/20 bg-gradient-to-br from-violet-500/10 to-transparent p-5">
        <div className="flex flex-col justify-between gap-4 md:flex-row md:items-start">
          <div className="flex items-start gap-3">
            <div className="rounded-xl bg-violet-500/15 p-2.5 text-violet-300">
              <DatabaseZap className="h-5 w-5" />
            </div>
            <div>
              <h1 className="text-2xl font-semibold">Source of Truth</h1>
              <p className="mt-1 max-w-4xl text-sm text-muted-foreground">
                Inspect canonical client and strategy records, then independently revalue every priced holding
                from Yahoo Finance. Live runs are calculated on demand and never overwrite canonical data.
              </p>
            </div>
          </div>
          <Button variant="outline" disabled={running} onClick={() => void runTruth(true)}>
            <DatabaseZap className="mr-2 h-4 w-4" />
            Run general health audit
          </Button>
        </div>
      </header>

      <section className="relative overflow-hidden rounded-2xl border border-violet-400/20 bg-card/70 p-4">
        <div className="pointer-events-none absolute inset-x-0 top-0 h-px animate-pulse bg-gradient-to-r from-transparent via-cyan-300 to-transparent" />
        <div className="mb-4 flex items-center justify-between">
          <div>
            <div className="flex items-center gap-2 text-sm font-semibold">
              <Sparkles className="h-4 w-4 text-cyan-300" />
              Canonical command centre
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              Immediate preflight from stored canonical records. Run health audit for live Yahoo, IRESS and
              page-contract verification.
            </p>
          </div>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span className="relative flex h-3 w-3">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-50" />
              <span className="relative inline-flex h-3 w-3 rounded-full bg-emerald-400" />
            </span>
            Canonical index loaded
          </div>
        </div>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-6">
          {[
            ["Invested clients", String(preflight.uniqueClients), "text-cyan-300"],
            ["Strategy positions", String(positions.length), "text-violet-300"],
            ["Canonical book", money(preflight.currentCents), ""],
            ["CA / residual", money(preflight.residualCents), "text-emerald-400"],
            ["Execution reserve", money(preflight.reserveCents), "text-sky-300"],
            [
              "Preflight flags",
              String(preflight.warnings.length),
              preflight.warnings.length ? "text-red-400" : "text-emerald-400",
            ],
          ].map(([label, value, colour]) => (
            <div
              key={label}
              className="group rounded-xl border border-white/10 bg-gradient-to-br from-white/[0.06] to-transparent p-4 transition-all duration-300 hover:-translate-y-1 hover:border-violet-400/35 hover:shadow-[0_12px_40px_-20px_rgba(139,92,246,.8)]"
            >
              <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                {label}
              </div>
              <div className={`mt-2 text-xl font-semibold tabular-nums ${colour}`}>{value}</div>
            </div>
          ))}
        </div>
      </section>

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1.65fr)_minmax(360px,.85fr)]">
        <details open className="group rounded-2xl border border-white/10 bg-card/70">
          <summary className="flex cursor-pointer list-none items-center justify-between p-4">
            <div>
              <div className="font-semibold">Book exposure</div>
              <div className="text-xs text-muted-foreground">Canonical value by invested strategy</div>
            </div>
            <ChevronDown className="h-4 w-4 transition-transform duration-300 group-open:rotate-180" />
          </summary>
          <div className="h-72 border-t border-white/10 p-4">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={preflight.strategyExposure}>
                <CartesianGrid strokeDasharray="3 3" stroke="#ffffff12" />
                <XAxis dataKey="name" tick={{ fontSize: 10 }} />
                <YAxis tick={{ fontSize: 10 }} tickFormatter={(value) => `R${Math.round(value / 100)}`} />
                <Tooltip formatter={(value) => money(Number(value))} />
                <Bar
                  dataKey="cents"
                  name="Canonical value"
                  fill="#8b5cf6"
                  radius={[6, 6, 0, 0]}
                  animationDuration={1200}
                />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </details>

        <details open className="group rounded-2xl border border-white/10 bg-card/70">
          <summary className="flex cursor-pointer list-none items-center justify-between p-4">
            <div>
              <div className="flex items-center gap-2 font-semibold">
                Preflight watchlist
                <span
                  className={`rounded-full px-2 py-0.5 text-xs ${preflight.warnings.length ? "bg-red-500/15 text-red-300" : "bg-emerald-500/15 text-emerald-300"}`}
                >
                  {preflight.warnings.length}
                </span>
              </div>
              <div className="text-xs text-muted-foreground">Most affected clients before a live run</div>
            </div>
            <ChevronDown className="h-4 w-4 transition-transform duration-300 group-open:rotate-180" />
          </summary>
          <div className="space-y-2 border-t border-white/10 p-4">
            {preflight.topAffected.length ? (
              preflight.topAffected.map((row) => (
                <button
                  type="button"
                  key={row.key}
                  onClick={() => {
                    setMode("client");
                    setSelected({ id: row.userId, label: row.client });
                  }}
                  className="flex w-full items-center justify-between rounded-xl border border-red-400/15 bg-red-500/[0.06] p-3 text-left transition hover:border-red-400/35 hover:bg-red-500/10"
                >
                  <div>
                    <div className="text-sm font-medium">{row.client}</div>
                    <div className="text-xs text-muted-foreground">
                      {row.strategy} · canonical age {row.ageDays}d
                    </div>
                  </div>
                  <div className="text-right text-xs text-red-300">
                    <div>{money(row.differenceCents)} equation delta</div>
                    <div>Inspect →</div>
                  </div>
                </button>
              ))
            ) : (
              <div className="rounded-xl border border-emerald-400/15 bg-emerald-400/[0.06] p-6 text-center text-sm text-emerald-300">
                No canonical equation or freshness flags. Run the live audit to verify providers.
              </div>
            )}
          </div>
        </details>
      </div>

      <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_380px]">
        <details open className="group min-w-0 rounded-2xl border border-white/10 bg-card/70">
          <summary className="flex cursor-pointer list-none items-center justify-between border-b border-white/10 p-4">
            <div>
              <div className="font-semibold">Invested book directory</div>
              <div className="text-xs text-muted-foreground">
                Select a client or strategy for forensic truth
              </div>
            </div>
            <ChevronDown className="h-4 w-4 transition-transform duration-300 group-open:rotate-180" />
          </summary>
          <div className="flex flex-col gap-3 border-b border-white/10 p-4 md:flex-row md:items-center md:justify-between">
            <div className="flex rounded-lg border border-white/10 bg-black/15 p-1">
              {(["client", "strategy"] as const).map((item) => (
                <button
                  key={item}
                  type="button"
                  onClick={() => switchMode(item)}
                  className={`rounded-md px-4 py-2 text-sm capitalize ${mode === item ? "bg-violet-500 text-white" : "text-muted-foreground hover:text-foreground"}`}
                >
                  {item === "client" ? "Invested clients" : "Strategies"}
                </button>
              ))}
            </div>
            <div className="relative w-full md:w-80">
              <Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search…"
                className="pl-9"
              />
            </div>
          </div>

          <div className="overflow-x-auto">
            {loading ? (
              <div className="p-10 text-center text-sm text-muted-foreground">Loading canonical records…</div>
            ) : mode === "client" ? (
              <table className="w-full min-w-[1100px] text-left text-xs">
                <thead className="border-b border-white/10 text-[10px] uppercase tracking-wider text-muted-foreground">
                  <tr>
                    {[
                      "Client / strategy",
                      "As of",
                      "Current",
                      "Securities",
                      "Residual",
                      "Reserve",
                      "Liability",
                      "P&L",
                      "YTD",
                      "",
                    ].map((h) => (
                      <th key={h} className="p-3">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {(rows as Position[]).map((row) => (
                    <tr key={row.key} className="border-b border-white/5 hover:bg-white/[0.025]">
                      <td className="p-3">
                        <div className="font-medium">{row.client}</div>
                        <div className="text-muted-foreground">
                          {row.strategy} · {row.mintNumber || row.email}
                        </div>
                      </td>
                      <td className="p-3">{when(row.asOf)}</td>
                      <td className="p-3 tabular-nums">{money(row.currentCents)}</td>
                      <td className="p-3 tabular-nums">{money(row.securitiesCents)}</td>
                      <td className="p-3 tabular-nums text-emerald-400">{money(row.residualCents)}</td>
                      <td className="p-3 tabular-nums">{money(row.reserveCents)}</td>
                      <td className="p-3 tabular-nums">{money(row.liabilityCents)}</td>
                      <td className="p-3 tabular-nums">{money(row.pnlCents)}</td>
                      <td className="p-3 tabular-nums">{pct(row.ytdPct)}</td>
                      <td className="p-3">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => {
                            setSelected({ id: row.userId, label: row.client });
                            setTruth(null);
                          }}
                        >
                          Select
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <table className="w-full min-w-[680px] text-left text-sm">
                <thead className="border-b border-white/10 text-[10px] uppercase tracking-wider text-muted-foreground">
                  <tr>
                    <th className="p-3">Strategy</th>
                    <th className="p-3">Status</th>
                    <th className="p-3">Model capital</th>
                    <th className="p-3">Invested positions</th>
                    <th className="p-3" />
                  </tr>
                </thead>
                <tbody>
                  {(rows as Strategy[]).map((row) => (
                    <tr key={row.id} className="border-b border-white/5 hover:bg-white/[0.025]">
                      <td className="p-3 font-medium">{row.name}</td>
                      <td className="p-3">{row.status || "—"}</td>
                      <td className="p-3 tabular-nums">{money(row.minInvestment * 100)}</td>
                      <td className="p-3">{row.investedPositions}</td>
                      <td className="p-3 text-right">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => {
                            setSelected({ id: row.id, label: row.name });
                            setTruth(null);
                          }}
                        >
                          Select
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </details>

        <aside className="rounded-2xl border border-violet-400/20 bg-card p-4 xl:sticky xl:top-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-xs font-semibold uppercase tracking-[0.18em] text-violet-300">
                Get truth
              </div>
              <h2 className="mt-1 text-lg font-semibold">{selected?.label || "Select a record"}</h2>
            </div>
            <Button disabled={!selected || running} onClick={() => void runTruth(false)}>
              <RefreshCw className={`mr-2 h-4 w-4 ${running ? "animate-spin" : ""}`} />
              {running ? "Computing…" : "Get truth"}
            </Button>
          </div>
          <p className="mt-3 text-xs text-muted-foreground">
            Fresh Yahoo requests only. Missing quotes stop the entire run; no cached price is silently
            substituted.
          </p>
          {error && (
            <div className="mt-4 flex gap-2 rounded-xl border border-amber-400/25 bg-amber-400/10 p-3 text-xs text-amber-200">
              <AlertTriangle className="h-4 w-4 shrink-0" />
              {error}
            </div>
          )}
          {truth && (
            <div className="mt-4 rounded-xl border border-emerald-400/20 bg-emerald-400/[0.06] p-3 text-xs text-emerald-300">
              Truth run complete. The full forensic report is open below.
            </div>
          )}
        </aside>
      </div>

      {truth && (
        <details
          open
          className="group overflow-hidden rounded-2xl border border-violet-400/25 bg-card/80 shadow-[0_24px_80px_-45px_rgba(139,92,246,.9)]"
        >
          <summary className="flex cursor-pointer list-none items-center justify-between bg-gradient-to-r from-violet-500/10 to-cyan-500/5 p-5">
            <div>
              <div className="flex items-center gap-2 font-semibold">
                <Sparkles className="h-4 w-4 animate-pulse text-cyan-300" />
                Live forensic report
              </div>
              <div className="mt-1 text-xs text-muted-foreground">
                {truth.kind === "general" ? "Whole-book health audit" : selected?.label} · generated{" "}
                {when(truth.generatedAt)}
              </div>
            </div>
            <ChevronDown className="h-5 w-5 transition-transform duration-300 group-open:rotate-180" />
          </summary>
          <div className="border-t border-white/10 p-4 md:p-5">
            <TruthResult truth={truth} />
          </div>
        </details>
      )}
    </main>
  );
}

const severityStyle = {
  ok: "border-emerald-400/30 bg-emerald-400/10 text-emerald-300",
  warning: "border-amber-400/30 bg-amber-400/10 text-amber-200",
  urgent: "border-red-500/40 bg-red-500/15 text-red-300",
};

function StatusLight({ severity }: { severity: "ok" | "warning" | "urgent" }) {
  return (
    <span
      className={`inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-bold uppercase ${severityStyle[severity]}`}
    >
      <span
        className={`h-2.5 w-2.5 rounded-full ${severity === "ok" ? "bg-emerald-400" : severity === "warning" ? "bg-amber-400" : "animate-pulse bg-red-500"}`}
      />
      {severity}
    </span>
  );
}

function ReturnStrip({
  returns,
}: { returns: { fiveDayPct?: number; mtdPct?: number; ytdPct?: number; allTimePct?: number } }) {
  return (
    <div className="grid grid-cols-4 gap-2">
      <Stat label="5D" value={pct(returns.fiveDayPct)} />
      <Stat label="MTD" value={pct(returns.mtdPct)} />
      <Stat label="YTD" value={pct(returns.ytdPct)} />
      <Stat label="All time" value={pct(returns.allTimePct)} />
    </div>
  );
}

function HistoryChart({
  data,
}: {
  data: Array<{
    date: string;
    valueCents: number;
    securitiesCents: number;
    residualCents?: number;
    caCents?: number;
  }>;
}) {
  return (
    <div className="h-64 rounded-xl border border-white/10 bg-black/10 p-3">
      <div className="mb-2 text-xs font-semibold">Canonical basket history</div>
      <ResponsiveContainer width="100%" height="90%">
        <AreaChart data={data}>
          <CartesianGrid strokeDasharray="3 3" stroke="#ffffff12" />
          <XAxis dataKey="date" tick={{ fontSize: 9 }} minTickGap={28} />
          <YAxis tick={{ fontSize: 9 }} tickFormatter={(value) => `R${Math.round(value / 100)}`} />
          <Tooltip formatter={(value) => money(Number(value))} />
          <Legend />
          <Area type="monotone" dataKey="valueCents" name="Total" stroke="#8b5cf6" fill="#8b5cf633" />
          <Line type="monotone" dataKey="securitiesCents" name="Securities" stroke="#38bdf8" dot={false} />
          <Line type="monotone" dataKey="residualCents" name="CA" stroke="#22c55e" dot={false} />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

async function exportWorkbook(truth: ClientTruth) {
  const XLSX = await import("xlsx");
  const book = XLSX.utils.book_new();
  for (const position of truth.positions) {
    XLSX.utils.book_append_sheet(
      book,
      XLSX.utils.json_to_sheet(
        position.ledger.map((row) => ({
          Cell: row.cell,
          Description: row.label,
          Formula: row.formula,
          Cents: row.cents,
          Rands: row.cents / 100,
        })),
      ),
      position.strategy.slice(0, 28),
    );
  }
  XLSX.writeFile(
    book,
    `truth-${truth.profile.mint_number || "client"}-${truth.generatedAt.slice(0, 10)}.xlsx`,
  );
}

function DeveloperLog({ lines }: { lines: string[] }) {
  return (
    <details className="rounded-xl border border-white/10 bg-black/40 p-3">
      <summary className="cursor-pointer font-mono text-xs text-cyan-300">Developer evidence log</summary>
      <pre className="mt-3 max-h-52 overflow-auto whitespace-pre-wrap font-mono text-[10px] leading-5 text-cyan-100/70">
        {lines.join("\n")}
      </pre>
    </details>
  );
}

function SurfaceMatrix({ checks }: { checks: SurfaceCheck[] }) {
  return (
    <div className="rounded-xl border border-white/10 bg-black/10 p-3">
      <div className="mb-3 flex items-center justify-between">
        <div>
          <div className="text-sm font-semibold">Live surface accuracy matrix</div>
          <div className="text-xs text-muted-foreground">
            What each page/provider is showing versus what its contract must supply
          </div>
        </div>
        <div className="flex gap-1">
          {checks.map((check) => (
            <span
              key={check.surface}
              title={`${check.surface}: ${check.status}`}
              className={`h-3 w-3 rounded-full ${
                check.status === "ok"
                  ? "bg-emerald-400"
                  : check.status === "warning"
                    ? "bg-amber-400"
                    : "animate-pulse bg-red-500"
              }`}
            />
          ))}
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[620px] text-xs">
          <thead className="border-b border-white/10 text-left text-[10px] uppercase text-muted-foreground">
            <tr>
              <th className="p-2">Surface</th>
              <th className="p-2">Now showing</th>
              <th className="p-2">Should show</th>
              <th className="p-2">Result</th>
              <th className="p-2">Latency</th>
            </tr>
          </thead>
          <tbody>
            {checks.map((check) => (
              <tr key={check.surface} className="border-b border-white/5 align-top">
                <td className="p-2 font-semibold">{check.surface}</td>
                <td className="p-2">{check.actual}</td>
                <td className="p-2 text-muted-foreground">{check.expected}</td>
                <td className="p-2">
                  <StatusLight severity={check.status} />
                  {check.difference && <div className="mt-1 max-w-48 text-red-300">{check.difference}</div>}
                </td>
                <td className="p-2 tabular-nums">{check.latencyMs ? `${check.latencyMs} ms` : "inline"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="mt-4 space-y-3">
        {checks
          .filter((check) => check.comparisons.length > 0)
          .map((check) => (
            <details
              key={`${check.surface}-comparisons`}
              open
              className="group rounded-lg border border-white/10"
            >
              <summary className="flex cursor-pointer list-none items-center justify-between p-3 text-xs font-semibold">
                <span>{check.surface} accuracy comparisons</span>
                <ChevronDown className="h-3.5 w-3.5 transition-transform group-open:rotate-180" />
              </summary>
              <div className="overflow-x-auto border-t border-white/10">
                <table className="w-full min-w-[560px] text-xs">
                  <thead className="bg-white/[0.035] text-left text-[10px] uppercase text-muted-foreground">
                    <tr>
                      <th className="p-2">Metric</th>
                      <th className="p-2 text-right">Page currently shows</th>
                      <th className="p-2 text-right">Canonical should show</th>
                      <th className="p-2 text-right">Difference</th>
                      <th className="p-2">Accuracy</th>
                    </tr>
                  </thead>
                  <tbody>
                    {check.comparisons.map((row) => {
                      const format = (value: number | null) =>
                        value == null ? "Not available" : row.unit === "cents" ? money(value) : pct(value);
                      return (
                        <tr key={row.metric} className="border-t border-white/5">
                          <td className="p-2 font-medium">{row.metric}</td>
                          <td className="p-2 text-right tabular-nums">{format(row.actual)}</td>
                          <td className="p-2 text-right tabular-nums">{format(row.expected)}</td>
                          <td
                            className={`p-2 text-right tabular-nums ${row.status === "urgent" ? "text-red-400" : row.status === "warning" ? "text-amber-400" : "text-emerald-400"}`}
                          >
                            {format(row.difference)}
                          </td>
                          <td className="p-2">
                            <StatusLight severity={row.status} />
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </details>
          ))}
      </div>
      <details className="mt-3 rounded-lg border border-white/10 p-2">
        <summary className="cursor-pointer font-mono text-[10px] text-cyan-300">
          Surface probe evidence
        </summary>
        <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap font-mono text-[10px] text-cyan-100/70">
          {checks
            .flatMap((check) => [`[${check.surface}] status=${check.status}`, ...check.evidence])
            .join("\n")}
        </pre>
      </details>
    </div>
  );
}

function ClientAppCardAccuracy({ truth }: { truth: ClientTruth }) {
  const checks = useMemo(
    () => truth.surfaceChecks.filter((check) => check.surface.startsWith("Client app ")),
    [truth.surfaceChecks],
  );
  const [changes, setChanges] = useState<string[]>([]);
  const [hadPrevious, setHadPrevious] = useState(false);
  const strategyId = truth.positions[0]?.strategyId ?? "all";
  const snapshotKey = `mint-truth-card:${truth.profile.email || truth.profile.mint_number}:${strategyId}`;

  useEffect(() => {
    const current = checks.map((check) => ({
      surface: check.surface,
      actual: check.actual,
      comparisons: check.comparisons.map((row) => ({
        metric: row.metric,
        actual: row.actual,
        expected: row.expected,
      })),
    }));
    try {
      const previous = JSON.parse(window.localStorage.getItem(snapshotKey) || "null") as
        | typeof current
        | null;
      const detected: string[] = [];
      setHadPrevious(Boolean(previous));
      if (previous) {
        for (const surface of current) {
          const oldSurface = previous.find((row) => row.surface === surface.surface);
          if (!oldSurface) {
            detected.push(`${surface.surface} appeared for the first time.`);
            continue;
          }
          for (const row of surface.comparisons) {
            const old = oldSurface.comparisons.find((item) => item.metric === row.metric);
            if (old?.actual !== row.actual) {
              const format = (value: number | null | undefined) =>
                value == null
                  ? "not available"
                  : row.metric.includes("YTD")
                    ? `${value.toFixed(4)}%`
                    : money(value);
              detected.push(
                `${surface.surface} · ${row.metric}: ${format(old?.actual)} → ${format(row.actual)}`,
              );
            }
          }
        }
      }
      setChanges(detected);
      window.localStorage.setItem(snapshotKey, JSON.stringify(current));
    } catch {
      setChanges(["This browser could not persist the previous card fingerprint."]);
    }
  }, [checks, snapshotKey]);

  if (!checks.length) return null;
  return (
    <details open className="group rounded-xl border border-cyan-400/20 bg-cyan-400/[0.035]">
      <summary className="flex cursor-pointer list-none items-center justify-between p-4">
        <div>
          <div className="flex items-center gap-2 font-semibold">
            Client App Card Accuracy
            <span className="rounded-full bg-cyan-400/10 px-2 py-0.5 text-[10px] uppercase text-cyan-300">
              Dev + Live
            </span>
          </div>
          <div className="mt-1 text-xs text-muted-foreground">
            Actual app card payloads versus this client&apos;s canonical position, including CA
          </div>
        </div>
        <ChevronDown className="h-4 w-4 transition-transform group-open:rotate-180" />
      </summary>
      <div className="space-y-4 border-t border-white/10 p-4">
        <div className="grid gap-3 lg:grid-cols-2">
          {checks.map((check) => (
            <div key={check.surface} className={`rounded-xl border p-4 ${severityStyle[check.status]}`}>
              <div className="flex items-center justify-between gap-2">
                <div className="font-semibold">{check.surface}</div>
                <StatusLight severity={check.status} />
              </div>
              <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
                <div>
                  <div className="text-[10px] uppercase opacity-60">App currently shows</div>
                  <div className="mt-1 font-medium">{check.actual}</div>
                </div>
                <div>
                  <div className="text-[10px] uppercase opacity-60">Canonical should show</div>
                  <div className="mt-1 font-medium">{check.expected}</div>
                </div>
              </div>
              {check.difference && (
                <div className="mt-3 rounded-lg bg-black/15 p-2 text-xs">{check.difference}</div>
              )}
            </div>
          ))}
        </div>
        <div className="rounded-xl border border-white/10 bg-black/15 p-3">
          <div className="text-xs font-semibold">Card change detector</div>
          {changes.length ? (
            <ul className="mt-2 list-disc space-y-1 pl-4 text-xs text-amber-200">
              {changes.map((change) => (
                <li key={change}>{change}</li>
              ))}
            </ul>
          ) : hadPrevious ? (
            <div className="mt-2 text-xs text-emerald-300">
              No card-field change detected since the previous truth run in this browser.
            </div>
          ) : (
            <div className="mt-2 text-xs text-cyan-300">
              Initial dev/live card baseline recorded. The next truth run will show field-level changes.
            </div>
          )}
          <div className="mt-2 text-[10px] text-muted-foreground">
            Fingerprint recorded at {when(truth.generatedAt)}. Expected market-value movement is shown as a
            change, while accuracy status still depends on the canonical comparison.
          </div>
        </div>
      </div>
    </details>
  );
}

function TruthResult({ truth }: { truth: Truth }) {
  if (truth.kind === "general") {
    const order = { urgent: 0, warning: 1, ok: 2 };
    return (
      <div className="mt-5 space-y-4">
        <div className="grid grid-cols-3 gap-2">
          <Stat label="Urgent" value={String(truth.summary.urgent)} className="text-red-400" />
          <Stat label="Warnings" value={String(truth.summary.warning)} className="text-amber-400" />
          <Stat label="Healthy" value={String(truth.summary.ok)} className="text-emerald-400" />
        </div>
        <p className="text-xs text-muted-foreground">
          Freshly audited {truth.auditedClients} clients and {truth.auditedStrategies} strategies at{" "}
          {when(truth.generatedAt)}.
        </p>
        <div className="max-h-[640px] space-y-2 overflow-y-auto">
          {[...truth.findings]
            .sort((a, b) => order[a.severity] - order[b.severity])
            .map((finding) => (
              <div
                key={`${finding.kind}-${finding.id}`}
                className={`rounded-xl border p-3 ${severityStyle[finding.severity]}`}
              >
                <div className="flex items-center justify-between gap-2">
                  <strong>{finding.label}</strong>
                  <StatusLight severity={finding.severity} />
                </div>
                <div className="mt-1 text-xs">
                  {finding.kind} · absolute variance {money(finding.differenceCents)}
                </div>
                <div className="mt-1 text-xs opacity-80">{finding.message}</div>
              </div>
            ))}
        </div>
        <SurfaceMatrix checks={truth.surfaceChecks} />
        <DeveloperLog
          lines={[
            `generated_at=${truth.generatedAt}`,
            `audited_clients=${truth.auditedClients}`,
            `audited_strategies=${truth.auditedStrategies}`,
            `urgent=${truth.summary.urgent}`,
            `warnings=${truth.summary.warning}`,
          ]}
        />
      </div>
    );
  }
  if (truth.kind === "strategy") {
    const canonical = truth.canonical;
    return (
      <div className="mt-5 space-y-4">
        <div className="flex items-center gap-2 text-xs text-emerald-400">
          <CheckCircle2 className="h-4 w-4" />
          Computed {when(truth.generatedAt)}
          <StatusLight severity={truth.severity} />
        </div>
        <ReturnStrip returns={truth.returns} />
        <SurfaceMatrix checks={truth.surfaceChecks} />
        <div className="grid grid-cols-2 gap-2">
          <Stat label="Live securities" value={money(truth.live.securitiesCents)} />
          <Stat
            label="Live CA"
            value={`${money(truth.live.strategyCaCents)} · ${pct(truth.live.caWeightPct)}`}
          />
          <Stat label="Model capital" value={money(truth.live.modelCapitalCents)} />
          <Stat label="Canonical date" value={String(canonical?.as_of_date || "—")} />
          <Stat
            label="Securities variance"
            value={money(truth.differences.securitiesCents)}
            className={tone(truth.differences.securitiesCents)}
          />
          <Stat
            label="CA variance"
            value={money(truth.differences.caCents)}
            className={tone(truth.differences.caCents)}
          />
        </div>
        <div className="grid gap-3 md:grid-cols-2">
          <HistoryChart data={truth.history} />
          <div className="h-64 rounded-xl border border-white/10 p-3">
            <div className="text-xs font-semibold">What makes up the strategy</div>
            <ResponsiveContainer width="100%" height="90%">
              <PieChart>
                <Pie
                  data={[
                    { name: "Securities", value: truth.live.securitiesCents },
                    { name: "CA", value: truth.live.strategyCaCents },
                  ]}
                  dataKey="value"
                  nameKey="name"
                  innerRadius={45}
                  outerRadius={75}
                >
                  <Cell fill="#8b5cf6" />
                  <Cell fill="#22c55e" />
                </Pie>
                <Tooltip formatter={(value) => money(Number(value))} />
                <Legend />
              </PieChart>
            </ResponsiveContainer>
          </div>
        </div>
        <div className={`rounded-xl border p-3 ${severityStyle[truth.severity]}`}>
          <div className="font-semibold">Possible reasons for the difference</div>
          <ul className="mt-2 list-disc space-y-1 pl-4 text-xs">
            {truth.reasons.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
        </div>
        <div className="rounded-xl border border-white/10 p-3 text-xs">
          <div className="font-semibold">Formula</div>
          <div className="mt-1 text-muted-foreground">
            {truth.live.formula}. CA belongs to this strategy model only.
          </div>
        </div>
        <HoldingRows rows={truth.holdings} />
        <DeveloperLog
          lines={[
            `provider=${truth.provider}`,
            `generated_at=${truth.generatedAt}`,
            `canonical_as_of=${truth.canonical?.as_of_date}`,
            `formula=${truth.live.formula}`,
            `complete_variance_cents=${truth.differences.completeCents}`,
          ]}
        />
      </div>
    );
  }
  const t = truth.totals;
  return (
    <div className="mt-5 space-y-4">
      <div className="flex items-center gap-2 text-xs text-emerald-400">
        <CheckCircle2 className="h-4 w-4" />
        Computed {when(truth.generatedAt)}
        <StatusLight severity={truth.audit.severity} />
        <Button size="sm" variant="outline" onClick={() => void exportWorkbook(truth)}>
          <Download className="mr-1 h-3.5 w-3.5" /> Excel ledger
        </Button>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <Stat label="Live value" value={money(t.liveValueCents)} />
        <Stat label="Invested basis" value={money(t.investedCents)} />
        <Stat label="Live P&L" value={money(t.livePnlCents)} />
        <Stat label="Securities" value={money(t.securitiesCents)} />
        <Stat label="Residual / CA" value={money(t.residualCents)} className="text-emerald-400" />
        <Stat label="Reserve / liability" value={`${money(t.reserveCents)} / ${money(t.liabilityCents)}`} />
      </div>
      <SurfaceMatrix checks={truth.surfaceChecks} />
      <div className="h-60 rounded-xl border border-white/10 p-3">
        <div className="text-xs font-semibold">Every cent of live value</div>
        <ResponsiveContainer width="100%" height="90%">
          <PieChart>
            <Pie
              data={[
                { name: "Securities", value: t.securitiesCents },
                { name: "CA / residual", value: t.residualCents },
                { name: "Reserve", value: t.reserveCents },
                { name: "Liability", value: t.liabilityCents },
              ]}
              dataKey="value"
              nameKey="name"
              innerRadius={45}
              outerRadius={72}
            >
              <Cell fill="#8b5cf6" />
              <Cell fill="#22c55e" />
              <Cell fill="#38bdf8" />
              <Cell fill="#ef4444" />
            </Pie>
            <Tooltip formatter={(value) => money(Number(value))} />
            <Legend />
          </PieChart>
        </ResponsiveContainer>
      </div>
      {truth.positions.map((position) => (
        <details
          key={position.key}
          open
          className={`rounded-xl border p-3 ${severityStyle[position.severity]}`}
        >
          <summary className="cursor-pointer list-none">
            <div className="flex justify-between gap-3">
              <div>
                <div className="font-semibold">{position.strategy}</div>
                <div className="text-xs text-muted-foreground">
                  Canonical {position.asOf || "—"} · residual {when(position.residualUpdatedAt)}
                </div>
              </div>
              <div className="text-right text-sm">
                <StatusLight severity={position.severity} />
                <div>{money(position.liveValueCents)}</div>
                <div className={tone(position.differenceCents)}>Δ {money(position.differenceCents)}</div>
              </div>
            </div>
          </summary>
          <div className="mt-3">
            <ReturnStrip returns={position.returns} />
          </div>
          <div className="mt-3">
            <HistoryChart data={position.history} />
          </div>
          <div className="mt-3 grid grid-cols-2 gap-2">
            <Stat
              label="Live P&L / return"
              value={`${money(position.livePnlCents)} · ${pct(position.liveReturnPct)}`}
            />
            <Stat label="Canonical P&L" value={money(position.canonicalPnlCents)} />
            <Stat label="Residual" value={money(position.residualCents)} className="text-emerald-400" />
            <Stat label="Reserve" value={money(position.reserveCents)} />
            <Stat label="Liability" value={money(position.liabilityCents)} />
            <Stat label="Securities" value={money(position.securitiesCents)} />
          </div>
          <div className="my-3 rounded-lg bg-white/[0.035] p-2 text-xs text-muted-foreground">
            {position.formula}. Invested basis = canonical value − canonical inception P&amp;L.
          </div>
          <div className="mb-3 grid gap-3 md:grid-cols-2">
            <div className="rounded-xl border border-white/10 bg-black/10 p-3 text-xs">
              <div className="font-semibold">Plain-English calculation</div>
              <p className="mt-2 leading-5 text-muted-foreground">
                Every active quantity is multiplied by its fresh Yahoo price. We add this strategy&apos;s own
                CA/residual and unused execution reserve, subtract open fee liabilities, then compare the
                result with the canonical value currently supplied to the app.
              </p>
              <ul className="mt-2 list-disc space-y-1 pl-4">
                {position.reasons.map((reason) => (
                  <li key={reason}>{reason}</li>
                ))}
              </ul>
            </div>
            <div className="overflow-hidden rounded-xl border border-white/10">
              <table className="w-full text-xs">
                <thead className="bg-white/5">
                  <tr>
                    <th className="p-2 text-left">Cell</th>
                    <th className="p-2 text-left">Line</th>
                    <th className="p-2 text-left">Formula</th>
                    <th className="p-2 text-right">Value</th>
                  </tr>
                </thead>
                <tbody>
                  {position.ledger.map((row) => (
                    <tr key={row.cell} className="border-t border-white/5">
                      <td className="p-2 font-mono text-violet-300">{row.cell}</td>
                      <td className="p-2">{row.label}</td>
                      <td className="p-2 font-mono text-[10px]">{row.formula}</td>
                      <td className="p-2 text-right">{money(row.cents)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
          <HoldingRows rows={position.holdings} />
        </details>
      ))}
      <div className="rounded-xl border border-white/10 p-3">
        <div className="text-xs font-semibold">Client activity timeline</div>
        <div className="mt-3 max-h-64 space-y-3 overflow-y-auto">
          {truth.activity.map((event) => (
            <div
              key={event.id}
              className="grid grid-cols-[105px_1fr_auto] gap-2 border-l-2 border-violet-500/40 pl-3 text-xs"
            >
              <div className="text-muted-foreground">{when(event.date)}</div>
              <div>
                <div className="font-medium">{event.name || event.direction || "Activity"}</div>
                <div className="text-muted-foreground">
                  {event.description} · {event.status}
                  {event.reversed ? " · REVERSED" : ""}
                </div>
              </div>
              <div>{money(event.amountCents)}</div>
            </div>
          ))}
        </div>
      </div>
      <DeveloperLog
        lines={[
          `provider=${truth.provider}`,
          `generated_at=${truth.generatedAt}`,
          `positions=${truth.positions.length}`,
          `urgent=${truth.audit.urgent}`,
          `warnings=${truth.audit.warnings}`,
          ...truth.positions.flatMap((position) => [
            `${position.strategy}.canonical_as_of=${position.asOf}`,
            `${position.strategy}.difference_cents=${position.differenceCents}`,
            `${position.strategy}.residual_updated_at=${position.residualUpdatedAt}`,
          ]),
        ]}
      />
      <ClientAppCardAccuracy truth={truth} />
    </div>
  );
}
