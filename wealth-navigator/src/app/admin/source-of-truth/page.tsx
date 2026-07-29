"use client";

import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, DatabaseZap, RefreshCw, Search } from "lucide-react";

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
type TruthPosition = {
  key: string;
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
  formula: string;
};
type ClientTruth = {
  kind: "client";
  generatedAt: string;
  provider: string;
  profile: { first_name?: string; last_name?: string; email?: string; mint_number?: string };
  positions: TruthPosition[];
  totals: Record<string, number>;
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
};
type Truth = ClientTruth | StrategyTruth;

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

  const runTruth = async () => {
    if (!selected) return;
    setRunning(true);
    setError("");
    setTruth(null);
    try {
      const response = await fetch("/api/admin/source-of-truth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: mode, id: selected.id }),
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
      </header>

      <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_460px]">
        <section className="min-w-0 rounded-2xl border border-white/10 bg-card/70">
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
        </section>

        <aside className="rounded-2xl border border-violet-400/20 bg-card p-4 xl:sticky xl:top-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-xs font-semibold uppercase tracking-[0.18em] text-violet-300">
                Get truth
              </div>
              <h2 className="mt-1 text-lg font-semibold">{selected?.label || "Select a record"}</h2>
            </div>
            <Button disabled={!selected || running} onClick={runTruth}>
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
          {truth && <TruthResult truth={truth} />}
        </aside>
      </div>
    </main>
  );
}

function TruthResult({ truth }: { truth: Truth }) {
  if (truth.kind === "strategy") {
    const canonical = truth.canonical;
    return (
      <div className="mt-5 space-y-4">
        <div className="flex items-center gap-2 text-xs text-emerald-400">
          <CheckCircle2 className="h-4 w-4" />
          Computed {when(truth.generatedAt)}
        </div>
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
        <div className="rounded-xl border border-white/10 p-3 text-xs">
          <div className="font-semibold">Formula</div>
          <div className="mt-1 text-muted-foreground">
            {truth.live.formula}. CA belongs to this strategy model only.
          </div>
        </div>
        <HoldingRows rows={truth.holdings} />
      </div>
    );
  }
  const t = truth.totals;
  return (
    <div className="mt-5 space-y-4">
      <div className="flex items-center gap-2 text-xs text-emerald-400">
        <CheckCircle2 className="h-4 w-4" />
        Computed {when(truth.generatedAt)}
      </div>
      <div className="grid grid-cols-2 gap-2">
        <Stat label="Live value" value={money(t.liveValueCents)} />
        <Stat label="Invested basis" value={money(t.investedCents)} />
        <Stat label="Live P&L" value={money(t.livePnlCents)} />
        <Stat label="Securities" value={money(t.securitiesCents)} />
        <Stat label="Residual / CA" value={money(t.residualCents)} className="text-emerald-400" />
        <Stat label="Reserve / liability" value={`${money(t.reserveCents)} / ${money(t.liabilityCents)}`} />
      </div>
      {truth.positions.map((position) => (
        <details key={position.key} open className="rounded-xl border border-white/10 p-3">
          <summary className="cursor-pointer list-none">
            <div className="flex justify-between gap-3">
              <div>
                <div className="font-semibold">{position.strategy}</div>
                <div className="text-xs text-muted-foreground">
                  Canonical {position.asOf || "—"} · residual {when(position.residualUpdatedAt)}
                </div>
              </div>
              <div className="text-right text-sm">
                <div>{money(position.liveValueCents)}</div>
                <div className={tone(position.differenceCents)}>Δ {money(position.differenceCents)}</div>
              </div>
            </div>
          </summary>
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
          <HoldingRows rows={position.holdings} />
        </details>
      ))}
    </div>
  );
}
