"use client";

import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  Clock3,
  DatabaseZap,
  Download,
  ExternalLink,
  FileSpreadsheet,
  Info,
  RefreshCw,
  Search,
  Sparkles,
  Upload,
} from "lucide-react";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import type { CellValue } from "exceljs";
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
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/cn";
import {
  Tooltip as HelpTooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

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
  modelValueCents?: number | null;
  modelSecuritiesCents?: number | null;
  modelCaCents?: number | null;
  modelAsOf?: string | null;
};
type LedgerRow = {
  strategyId: string;
  strategy: string;
  strategyCreatedAt?: string | null;
  asOf: string;
  certificationStatus: string;
  securitiesCents: number;
  continuityCashCents: number;
  completeValueCents: number;
  currentAppOneMonthPct?: number | null;
  legs: Array<Record<string, unknown>>;
  periods: Record<string, {
    return_pct?: number;
    numerator_cents?: number;
    numerator_value_cents?: number;
    denominator_cents?: number;
    pnl_cents?: number;
    reference_date?: string;
    leg_trace?: Array<Record<string, unknown>>;
  }>;
  evidence: Record<string, unknown>;
  notes: Record<string, unknown>;
};
type PriceProofResult = {
  readOnly: boolean;
  evidenceSha256: string;
  summary: { total: number; matched: number; mismatched: number; missing: number; pass: boolean };
  comparisons: Array<{
    ticker: string;
    date: string;
    closeCents: number;
    storedCloseCents: number | null;
    differenceCents: number | null;
    status: "MATCH" | "MISMATCH" | "MISSING_STORED_CLOSE";
    sourceFile: string;
  }>;
};
type Quote = {
  yahooSymbol: string;
  exchangeTime: string;
  fetchedAt: string;
  source: string;
  previousCloseCents?: number | null;
  dailyChangeCents?: number | null;
  dailyChangePct?: number | null;
};
type LiveHolding = {
  symbol: string;
  security?: string;
  name?: string;
  quantity: number;
  livePriceCents: number;
  previousCloseCents?: number | null;
  todayPnlCents?: number | null;
  marketValueCents: number;
  costPriceCents?: number;
  costValueCents?: number;
  fillDate?: string;
  createdAt?: string;
  transactionId?: string;
  rebalanceBatchId?: string;
  formula: string;
  quote: Quote;
  iress?: {
    available: boolean;
    rawLast: number | null;
    normalisedCents: number | null;
    scale: "rands-x100" | "already-cents" | "unavailable";
    differenceCents: number | null;
    differencePct: number | null;
    status: "ok" | "warning" | "urgent";
    outcome?: string;
    marketState?: string | null;
    error?: string | null;
  };
};
type SurfaceCheck = {
  surface: string;
  sourcePage?: string;
  sourceEndpoint?: string;
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
type PricingSnapshot = {
  id: string;
  provider: string;
  startedAt: string;
  completedAt: string;
  instruments: number;
  earliestExchangeTime: string | null;
  latestExchangeTime: string | null;
  frozenWithinRun: boolean;
};
type ValuationComparison = {
  kind: "timestamp-aligned" | "market-movement" | "provider-stale" | "timestamp-unavailable";
  severity: "ok" | "warning" | "urgent";
  accountingComparable: boolean;
  message: string;
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
  valuationComparison: ValuationComparison;
  appDisplayedValueCents: number;
  appDisplayedPnlCents: number;
  severity: "ok" | "warning" | "urgent";
  reasons: string[];
  returns: { fiveDayPct?: number; mtdPct?: number; ytdPct?: number; allTimePct?: number };
  performance: {
    definition: string;
    storedYtdPct: number | null;
    independentYtdPct: number | null;
    ytdDifferencePp: number | null;
    ytdStatus: "ok" | "warning" | "urgent";
    returnChainAudit: {
      complete: boolean;
      observedRows: number;
      anchorAvailable: boolean;
      missingDailyDates: string[];
      missingExpectedDates: string[];
      duplicateDates: string[];
      largestCalendarGapDays: number;
      returnPct: number | null;
    };
    performancePnlCents: number;
    openingPerformanceNavCents: number;
    previousSecuritiesCents: number | null;
    todayStrategyPnlCents: number | null;
    todayStrategyPct: number | null;
    feeTreatment: string;
    iressStatus: "ok" | "warning" | "urgent";
    iressMode: string;
    iressCovered: number;
    iressRequested: number;
    iressProbedAt?: string | null;
  };
  rebalanceDiagnostics: Array<{
    id: string;
    date: string;
    status?: string;
    settlementState?: string;
    beforeValueCents: number | null;
    afterValueCents: number | null;
    rawNavChangePct: number | null;
    canonicalDailyPct: number | null;
    canonicalYtdPct: number | null;
    neutralisedDifferencePp: number | null;
    protected: boolean;
  }>;
  history: Array<{
    date: string;
    valueCents: number;
    securitiesCents: number;
    residualCents: number;
    reserveCents: number;
    pnlCents: number;
    ytdPct: number;
    allTimePct: number;
    reconstructedCents: number | null;
    reconstructionProvable?: boolean;
  }>;
  rawHistory: Array<{ date: string; valueCents: number; dailyPnlCents?: number; ytdPnlCents?: number }>;
  ledger: Array<{ cell: string; label: string; formula: string; cents: number }>;
  formula: string;
};
type ClientTruth = {
  kind: "client";
  generatedAt: string;
  provider: string;
  pricingSnapshot: PricingSnapshot;
  profile: {
    id: string;
    first_name?: string;
    last_name?: string;
    email?: string;
    mint_number?: string;
  };
  positions: TruthPosition[];
  strategyBenchmarks: Record<
    string,
    { asOf?: string; ytdPct?: number; allTimePct?: number; caCents?: number; completeValueCents?: number }
  >;
  strategyModelHistory: Record<
    string,
    Array<{
      date: string;
      valueCents: number;
      securitiesCents: number;
      caCents: number;
      ytdPct: number;
      allTimePct: number;
      dailyPct: number;
      reconstructedCents: number | null;
      reconstructionProvable?: boolean;
    }>
  >;
  rawStrategyHistory: Record<string, Array<{ date: string; valueCents: number; ytdPct?: number }>>;
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
  rebalances: Array<{
    id: string;
    strategyId: string;
    strategy?: string;
    date: string;
    status?: string;
    settlementState?: string;
    reversedAt?: string;
    reversedReason?: string;
    events?: Array<{
      id: string;
      date: string;
      side: string;
      securityId: string;
      quantity: number;
      priceCents: number;
      reason?: string;
    }>;
  }>;
  surfaceChecks: SurfaceCheck[];
};
type StrategyTruth = {
  kind: "strategy";
  generatedAt: string;
  provider: string;
  pricingSnapshot: PricingSnapshot;
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
  valuationComparison: ValuationComparison;
  returnChainAudit: {
    complete: boolean;
    observedRows: number;
    anchorAvailable: boolean;
    missingDailyDates: string[];
    missingExpectedDates: string[];
    duplicateDates: string[];
    largestCalendarGapDays: number;
    returnPct: number | null;
  };
  storedYtdPct: number | null;
  rebuiltYtdPct: number | null;
  ytdDifferencePp: number | null;
  ytdStatus: "ok" | "warning" | "urgent";
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
    reconstructedCents: number | null;
    reconstructionProvable?: boolean;
  }>;
  rawHistory: Array<{ date: string; valueCents: number; ytdPct?: number }>;
  rebalances: Array<{
    id: string;
    strategyId: string;
    strategy?: string;
    date: string;
    status?: string;
    settlementState?: string;
    reversedAt?: string;
    reversedReason?: string;
    events?: Array<{
      id: string;
      date: string;
      side: string;
      securityId: string;
      quantity: number;
      priceCents: number;
      reason?: string;
    }>;
  }>;
  surfaceChecks: SurfaceCheck[];
};
type GeneralTruth = {
  kind: "general";
  generatedAt: string;
  auditedClients: number;
  auditedStrategies: number;
  pricingSnapshot: PricingSnapshot;
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

function InfoHint({ label, children }: { label: string; children: ReactNode }) {
  return (
    <HelpTooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={`About ${label}`}
          onClick={(event) => event.stopPropagation()}
          className="inline-flex h-5 w-5 shrink-0 cursor-help items-center justify-center rounded-full border border-white/15 bg-white/[0.04] text-muted-foreground transition hover:border-cyan-300/40 hover:text-cyan-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/50"
        >
          <Info className="h-3 w-3" />
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-80 text-xs leading-relaxed">
        {children}
      </TooltipContent>
    </HelpTooltip>
  );
}

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

function TimeAlignmentRibbon({
  snapshot,
  canonicalDates = [],
  comparison,
}: {
  snapshot: PricingSnapshot;
  canonicalDates?: Array<string | null | undefined>;
  comparison?: ValuationComparison;
}) {
  const dates = [...new Set(canonicalDates.filter(Boolean).map((value) => String(value).slice(0, 10)))];
  const aligned = comparison?.accountingComparable ?? false;
  return (
    <section className={cn(
      "rounded-xl border p-3",
      aligned ? "border-emerald-400/25 bg-emerald-400/[0.045]" : "border-amber-400/25 bg-amber-400/[0.045]",
    )}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-xs font-semibold">
          <Clock3 className={cn("h-4 w-4", aligned ? "text-emerald-300" : "text-amber-300")} />
          Valuation-time alignment
          <InfoHint label="Valuation-time alignment">
            An accounting mismatch is only escalated when provider prices and canonical values share a
            valuation date. Newer live prices are reported as market movement, not as broken accounting.
          </InfoHint>
        </div>
        <span className={cn(
          "rounded-full border px-2 py-1 text-[9px] font-bold uppercase tracking-wider",
          aligned ? "border-emerald-400/25 text-emerald-300" : "border-amber-400/25 text-amber-300",
        )}>
          {comparison ? comparison.kind.replaceAll("-", " ") : "frozen run snapshot"}
        </span>
      </div>
      <div className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
        <Stat label="Canonical date" value={dates.length ? dates.join(", ") : "Multiple / book audit"} />
        <Stat label="Yahoo exchange window" value={`${when(snapshot.earliestExchangeTime)} → ${when(snapshot.latestExchangeTime)}`} />
        <Stat label="Frozen instruments" value={`${snapshot.instruments} · one price per symbol`} />
        <Stat label="Audit run ID" value={snapshot.id.slice(0, 13)} className="font-mono text-cyan-300" />
      </div>
      {comparison ? <p className="mt-2 text-[10px] text-muted-foreground">{comparison.message}</p> : null}
    </section>
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
            <dt className="text-muted-foreground">Previous close / today</dt>
            <dd>
              {row.previousCloseCents == null
                ? "Unavailable"
                : `${money(row.previousCloseCents)} / ${money(row.todayPnlCents ?? 0)}`}
            </dd>
            <dt className="text-muted-foreground">IRESS comparison</dt>
            <dd>
              {row.iress?.normalisedCents == null ? (
                <span className="text-amber-300">Unavailable · {row.iress?.outcome || "not probed"}</span>
              ) : (
                <span
                  className={
                    row.iress.status === "urgent"
                      ? "text-red-300"
                      : row.iress.status === "warning"
                        ? "text-amber-300"
                        : "text-emerald-300"
                  }
                >
                  {money(row.iress.normalisedCents)} · Δ {money(row.iress.differenceCents ?? 0)} ·{" "}
                  {row.iress.scale}
                </span>
              )}
            </dd>
            <dt className="text-muted-foreground">IRESS state / probe</dt>
            <dd>{row.iress?.marketState || "—"} · {row.iress?.outcome || "—"}</dd>
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
  const [surface, setSurface] = useState<"overview" | "ledger">("overview");
  const [mode, setMode] = useState<"client" | "strategy">("client");
  const [positions, setPositions] = useState<Position[]>([]);
  const [strategies, setStrategies] = useState<Strategy[]>([]);
  const [ledger, setLedger] = useState<LedgerRow[]>([]);
  const [selected, setSelected] = useState<{ id: string; label: string } | null>(null);
  const [truth, setTruth] = useState<Truth | null>(null);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");
  const [exposureView, setExposureView] = useState<"clients" | "model">("clients");

  useEffect(() => {
    void fetch("/api/admin/source-of-truth", { cache: "no-store" })
      .then(async (response) => {
        const body = await response.json();
        if (!response.ok || !body.ok) throw new Error(body.error || "Could not load canonical index");
        setPositions(body.positions ?? []);
        setStrategies(body.strategies ?? []);
        setLedger(body.ledger ?? []);
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
      modelExposure: strategies
        .filter((strategy) => Number(strategy.modelValueCents) > 0)
        .map((strategy) => ({
          name: strategy.name,
          cents: Number(strategy.modelValueCents),
          caCents: Number(strategy.modelCaCents ?? 0),
          asOf: strategy.modelAsOf,
        })),
      modelLatestAsOf: strategies
        .map((strategy) => strategy.modelAsOf)
        .filter((value): value is string => Boolean(value))
        .sort()
        .at(-1),
    };
  }, [positions, strategies]);

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
        <div className="mt-5 flex w-fit rounded-xl border border-white/10 bg-black/15 p-1">
          {([
            ["overview", "Overview", DatabaseZap],
            ["ledger", "Ledger", FileSpreadsheet],
          ] as const).map(([item, label, Icon]) => (
            <button
              key={item}
              type="button"
              onClick={() => setSurface(item)}
              className={`inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm transition ${surface === item ? "bg-violet-500 text-white shadow-lg shadow-violet-500/20" : "text-muted-foreground hover:text-foreground"}`}
            >
              <Icon className="h-4 w-4" />
              {label}
            </button>
          ))}
        </div>
      </header>

      {surface === "ledger" ? (
        <LedgerWorkbook rows={ledger} loading={loading} />
      ) : (
        <>
      <section className="relative overflow-hidden rounded-2xl border border-violet-400/20 bg-card/70 p-4">
        <div className="pointer-events-none absolute inset-x-0 top-0 h-px animate-pulse bg-gradient-to-r from-transparent via-cyan-300 to-transparent" />
        <div className="mb-4 flex items-center justify-between">
          <div>
            <div className="flex items-center gap-2 text-sm font-semibold">
              <Sparkles className="h-4 w-4 text-cyan-300" />
              Canonical command centre
              <InfoHint label="Canonical command centre">
                A stored-data overview of the invested book before any live checks run. It separates
                securities, client residual cash, and execution reserve so the totals can be understood.
              </InfoHint>
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
              <div className="flex items-center gap-2 font-semibold">
                {exposureView === "clients" ? "Total client exposure" : "Actual basket model value"}
                <InfoHint label="Book exposure">
                  Client exposure adds every investor position in a strategy. Basket model value shows one
                  strategy model unit only, including that strategy&apos;s CA. These are different scopes and
                  should not have the same value.
                </InfoHint>
              </div>
              <div className="text-xs text-muted-foreground">
                {exposureView === "clients"
                  ? "Sum of every client position by strategy"
                  : "Latest canonical complete value for one strategy basket, including model CA"}
              </div>
            </div>
            <ChevronDown className="h-4 w-4 transition-transform duration-300 group-open:rotate-180" />
          </summary>
          <div className="border-t border-white/10 p-4">
            <div className="mb-3 flex items-center justify-between gap-3">
              <div className="flex rounded-lg border border-white/10 bg-black/15 p-1">
                {(["clients", "model"] as const).map((view) => (
                  <button
                    key={view}
                    type="button"
                    onClick={() => setExposureView(view)}
                    className={`rounded-md px-3 py-1.5 text-xs transition ${
                      exposureView === view
                        ? "bg-violet-500 text-white shadow-lg shadow-violet-500/20"
                        : "text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    {view === "clients" ? "Client exposure" : "Basket model value"}
                  </button>
                ))}
              </div>
              <div className="text-right text-[10px] text-muted-foreground">
                {exposureView === "clients"
                  ? "Includes each client’s residual and reserve"
                  : `Model securities + strategy CA · latest ${preflight.modelLatestAsOf || "unavailable"}`}
              </div>
            </div>
            <div className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart
                  data={exposureView === "clients" ? preflight.strategyExposure : preflight.modelExposure}
                >
                  <CartesianGrid strokeDasharray="3 3" stroke="#ffffff12" />
                  <XAxis dataKey="name" tick={{ fontSize: 10 }} />
                  <YAxis tick={{ fontSize: 10 }} tickFormatter={(value) => `R${Math.round(value / 100)}`} />
                  <Tooltip formatter={(value) => money(Number(value))} />
                  <Bar
                    dataKey="cents"
                    name={exposureView === "clients" ? "Total client exposure" : "Basket model value"}
                    fill="#8b5cf6"
                    radius={[6, 6, 0, 0]}
                    animationDuration={1200}
                  />
                  {exposureView === "model" && (
                    <Bar
                      dataKey="caCents"
                      name="Strategy CA included"
                      fill="#22c55e"
                      radius={[6, 6, 0, 0]}
                      animationDuration={1200}
                    />
                  )}
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>
        </details>

        <details open className="group rounded-2xl border border-white/10 bg-card/70">
          <summary className="flex cursor-pointer list-none items-center justify-between p-4">
            <div>
              <div className="flex items-center gap-2 font-semibold">
                Preflight watchlist
                <InfoHint label="Preflight watchlist">
                  Quick warnings found in stored canonical records, such as an old valuation date or an
                  accounting equation that does not balance. Live prices and page checks only run after Get
                  Truth or the general health audit.
                </InfoHint>
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
              <div className="flex items-center gap-2 font-semibold">
                Invested book directory
                <InfoHint label="Invested book directory">
                  Every real invested client and strategy available for inspection. Client rows separate
                  securities, residual CA, reserve, liabilities, P&amp;L, and personal YTD.
                </InfoHint>
              </div>
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
              <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.18em] text-violet-300">
                Get truth
                <InfoHint label="Get Truth">
                  Reprices the selected record now using fresh Yahoo requests, rebuilds the accounting
                  equation, and compares the answer with canonical records and connected application pages.
                  It does not change client data.
                </InfoHint>
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
                <InfoHint label="Live forensic report">
                  The expandable result of the latest live calculation. Green means within tolerance, amber
                  needs review, and red means a material mismatch or unavailable required source.
                </InfoHint>
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
        </>
      )}
    </main>
  );
}

const severityStyle = {
  ok: "border-emerald-400/30 bg-emerald-400/10 text-emerald-300",
  warning: "border-amber-400/30 bg-amber-400/10 text-amber-200",
  urgent: "border-red-500/40 bg-red-500/15 text-red-300",
};

function LedgerWorkbook({ rows, loading }: { rows: LedgerRow[]; loading: boolean }) {
  const latest = useMemo(() => {
    const byStrategy = new Map<string, LedgerRow>();
    for (const row of rows) if (!byStrategy.has(row.strategyId)) byStrategy.set(row.strategyId, row);
    return [...byStrategy.values()].sort((a, b) => a.strategy.localeCompare(b.strategy));
  }, [rows]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedAsOf, setSelectedAsOf] = useState<string | null>(null);
  const [proof, setProof] = useState<PriceProofResult | null>(null);
  const [proofBusy, setProofBusy] = useState(false);
  const [proofError, setProofError] = useState("");
  const selectedStrategy = latest.find((row) => row.strategyId === selectedId) ?? latest[0] ?? null;
  const history = useMemo(
    () => rows
      .filter((row) => row.strategyId === selectedStrategy?.strategyId)
      .sort((a, b) => b.asOf.localeCompare(a.asOf)),
    [rows, selectedStrategy?.strategyId],
  );
  const selected = history.find((row) => row.asOf === selectedAsOf) ?? history[0] ?? selectedStrategy;
  const chartRows = useMemo(
    () => [...history].reverse().map((row) => ({
      date: row.asOf,
      complete: row.completeValueCents / 100,
      securities: row.securitiesCents / 100,
      cash: row.continuityCashCents / 100,
    })),
    [history],
  );
  const status = selected?.certificationStatus === "CERTIFIED" ? "ok" : "warning";
  const unresolvedSource = Array.isArray(selected?.notes?.unresolved_evidence)
    ? selected.notes.unresolved_evidence
    : Array.isArray(selected?.notes?.certification_requirements)
      ? selected.notes.certification_requirements
      : [];
  const unresolved = unresolvedSource.map(String);
  const periods = ["1D", "1W", "WTD", "1M", "3M", "YTD", "SI"];

  const exportExactReturnEngineWorkbook = async () => {
    if (!selectedStrategy) return;
    const { buildStrategyReturnEngineWorkbook, strategyReturnEngineFilename } = await import(
      "@/lib/returns/strategy-return-engine-workbook"
    );
    const strategyRows = rows
      .filter((row) => row.strategyId === selectedStrategy.strategyId)
      .sort((a, b) => a.asOf.localeCompare(b.asOf));
    const bytes = await buildStrategyReturnEngineWorkbook({
      strategyName: selectedStrategy.strategy,
      strategyCreatedAt: selectedStrategy.strategyCreatedAt,
      rows: strategyRows,
    });
    const workbookBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    const blob = new Blob([workbookBuffer], {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = strategyReturnEngineFilename(selectedStrategy.strategy);
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const exportCeoWorkbook = async () => {
    const ExcelJS = await import("exceljs");
    const book = new ExcelJS.Workbook();
    book.creator = "MINT Source of Truth";
    book.company = "MINT Platforms (Pty) Ltd";
    book.calcProperties.fullCalcOnLoad = true;
    const usedNames = new Set<string>();
    const safeSheetName = (name: string) => {
      const base = name.replace(/[\\/?*:[\]]/g, " ").trim().slice(0, 31) || "Strategy";
      let candidate = base;
      let suffix = 2;
      while (usedNames.has(candidate)) {
        const tail = ` ${suffix++}`;
        candidate = `${base.slice(0, 31 - tail.length)}${tail}`;
      }
      usedNames.add(candidate);
      return candidate;
    };
    const headings = [
      "Ticker", "Leg", "Source_Ref", "Entry_Date", "Exit_Date", "Units_Per_Lot", "Entry_Price",
      "Entry_Cost_Per_Lot", "Exit_or_Latest_Price", "Exit_or_Current_Value_Per_Lot",
      "Counts_In_Current_Strategy", "Current_Strategy_Value_Per_Lot", "Leg_SI_P/L_Per_Lot",
      "Why_It_Exists", "Formula_Trace",
      "1W_Ref_Date", "1W_Benchmark", "1W_Numerator", "1W_P/L",
      "WTD_Ref_Date", "WTD_Benchmark", "WTD_Numerator", "WTD_P/L",
      "1M_Ref_Date", "1M_Benchmark", "1M_Numerator", "1M_P/L",
      "3M_Ref_Date", "3M_Benchmark", "3M_Numerator", "3M_P/L",
      "YTD_Ref_Date", "YTD_Benchmark", "YTD_Numerator", "YTD_P/L",
      "SI_Ref_Date", "SI_Benchmark", "SI_Numerator", "SI_P/L",
    ];
    const exportPeriods = ["1W", "WTD", "1M", "3M", "YTD", "SI"];
    const toDate = (value: unknown) => {
      if (!value) return null;
      const parsed = new Date(`${String(value).slice(0, 10)}T00:00:00Z`);
      return Number.isNaN(parsed.getTime()) ? null : parsed;
    };
    const inRands = (value: unknown) => Number(value ?? 0) / 100;

    for (const ledgerRow of latest) {
      const sheet = book.addWorksheet(safeSheetName(ledgerRow.strategy), {
        views: [{ state: "frozen", xSplit: 2, ySplit: 3 }],
        pageSetup: { orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
      });
      sheet.mergeCells("A1:AM1");
      const title = sheet.getCell("A1");
      title.value = `MINT STRATEGY LEDGER — ${ledgerRow.strategy}`;
      title.font = { bold: true, color: { argb: "FFFFFFFF" }, size: 14 };
      title.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF7030A0" } };
      title.alignment = { vertical: "middle", horizontal: "left" };
      sheet.getRow(1).height = 24;
      sheet.mergeCells("A2:AM2");
      const subtitle = sheet.getCell("A2");
      subtitle.value = `As of ${ledgerRow.asOf} | ${ledgerRow.certificationStatus} | securities R ${(ledgerRow.securitiesCents / 100).toFixed(2)} + continuity cash R ${(ledgerRow.continuityCashCents / 100).toFixed(2)} = complete value R ${(ledgerRow.completeValueCents / 100).toFixed(2)}`;
      subtitle.font = { italic: true, color: { argb: ledgerRow.certificationStatus === "CERTIFIED" ? "FF216E39" : "FF9C6500" } };
      sheet.getRow(3).values = headings;
      sheet.getRow(3).eachCell((cell) => {
        cell.font = { bold: true, color: { argb: "FF000000" } };
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFD9D9D9" } };
        cell.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
        cell.border = { bottom: { style: "thin", color: { argb: "FF808080" } } };
      });
      sheet.getRow(3).height = 42;

      ledgerRow.legs.forEach((leg, index) => {
        const excelRow = index + 4;
        const ticker = String(leg.ticker ?? "");
        const legName = String(leg.leg ?? `LEG-${index + 1}`);
        const isCurrent = Boolean(leg.counts_in_current_strategy);
        const units = Number(leg.units ?? 0);
        const entryPrice = inRands(leg.entry_price_cents);
        const currentValue = inRands(leg.current_or_exit_value_cents);
        const latestPrice = units ? currentValue / units : 0;
        const values: unknown[] = [
          ticker, legName, String(leg.source_ref ?? leg.source ?? "DATABASE_CANONICAL_LEDGER"),
          toDate(leg.entry_date), toDate(leg.exit_date), units, entryPrice, null, latestPrice, null,
          isCurrent ? "Yes" : "No", null, null,
          isCurrent ? "Open model leg included in the current strategy" : "Closed model leg retained for audit continuity",
          `Entry cost = units × entry price; current value = units × exit/latest price; source close ${ledgerRow.asOf}`,
        ];
        for (const period of exportPeriods) {
          const metric = ledgerRow.periods[period] ?? {};
          const traces = Array.isArray(metric.leg_trace) ? metric.leg_trace : [];
          const trace = traces.find((item) => String(item.ticker ?? "") === ticker && String(item.leg ?? "") === legName)
            ?? traces.find((item) => String(item.ticker ?? "") === ticker);
          const benchmark = inRands(trace?.benchmark_cents);
          const numerator = inRands(trace?.numerator_cents);
          values.push(toDate(trace?.reference_date ?? metric.reference_date), benchmark, numerator, numerator - benchmark);
        }
        const row = sheet.addRow(values);
        row.getCell(8).value = { formula: `F${excelRow}*G${excelRow}`, result: units * entryPrice };
        row.getCell(10).value = { formula: `F${excelRow}*I${excelRow}`, result: currentValue };
        row.getCell(11).value = { formula: `IF(E${excelRow}="","Yes","No")`, result: isCurrent ? "Yes" : "No" };
        row.getCell(12).value = { formula: `IF(K${excelRow}="Yes",J${excelRow},0)`, result: isCurrent ? currentValue : 0 };
        row.getCell(13).value = { formula: `J${excelRow}-H${excelRow}`, result: currentValue - units * entryPrice };
        exportPeriods.forEach((_, periodIndex) => {
          const benchmarkColumn = 17 + periodIndex * 4;
          const numeratorColumn = benchmarkColumn + 1;
          const pnlColumn = benchmarkColumn + 2;
          const cached = Number(row.getCell(pnlColumn).value ?? 0);
          row.getCell(pnlColumn).value = { formula: `${sheet.getColumn(numeratorColumn).letter}${excelRow}-${sheet.getColumn(benchmarkColumn).letter}${excelRow}`, result: cached };
        });
        [4, 5, 16, 20, 24, 28, 32, 36].forEach((column) => { row.getCell(column).numFmt = "dd-mmm-yyyy"; });
        [6, 7, 8, 9, 10, 12, 13, 17, 18, 19, 21, 22, 23, 25, 26, 27, 29, 30, 31, 33, 34, 35, 37, 38, 39].forEach((column) => {
          row.getCell(column).numFmt = "#,##0.00;[Red](#,##0.00);-";
        });
        [3, 4, 5, 6, 7, 14, 15].forEach((column) => { row.getCell(column).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFF2CC" } }; });
        [8, 10, 11, 12, 13, 19, 23, 27, 31, 35, 39].forEach((column) => { row.getCell(column).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE4DFEC" } }; });
      });

      const firstLegRow = 4;
      const lastLegRow = Math.max(firstLegRow, ledgerRow.legs.length + 3);
      const totalRowNumber = lastLegRow + 2;
      const totalRow = sheet.getRow(totalRowNumber);
      totalRow.getCell(1).value = "Current open strategy value per lot";
      totalRow.getCell(2).value = { formula: `SUM(L${firstLegRow}:L${lastLegRow})`, result: ledgerRow.securitiesCents / 100 };
      totalRow.getCell(4).value = "Continuity cash per lot";
      totalRow.getCell(5).value = ledgerRow.continuityCashCents / 100;
      totalRow.getCell(7).value = "Complete value per lot";
      totalRow.getCell(8).value = { formula: `B${totalRowNumber}+E${totalRowNumber}`, result: ledgerRow.completeValueCents / 100 };
      totalRow.getCell(10).value = "Leg-level since inception P/L per lot";
      totalRow.getCell(11).value = { formula: `SUM(M${firstLegRow}:M${lastLegRow})`, result: 0 };
      totalRow.eachCell((cell) => { cell.font = { bold: true }; cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE4DFEC" } }; });
      [2, 5, 8, 11].forEach((column) => { totalRow.getCell(column).numFmt = "#,##0.00;[Red](#,##0.00);-"; });
      const widths = [10, 20, 22, 12, 12, 21, 12, 18, 18, 22, 18, 22, 19, 42, 32];
      for (let column = 1; column <= 39; column += 1) sheet.getColumn(column).width = widths[column - 1] ?? (column % 4 === 0 ? 12 : 16);
      sheet.autoFilter = { from: { row: 3, column: 1 }, to: { row: lastLegRow, column: 39 } };
      sheet.properties.defaultRowHeight = 18;
      sheet.pageSetup.printTitlesRow = "1:3";
      sheet.headerFooter.oddFooter = "MINT canonical ledger | &A | Page &P of &N";
    }
    const buffer = await book.xlsx.writeBuffer();
    const blob = new Blob([new Uint8Array(buffer)], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `MINT-CEO-style-strategy-ledgers-${new Date().toISOString().slice(0, 10)}.xlsx`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const exportPublicStrategyWorkbook = async () => {
    const ExcelJS = await import("exceljs");
    const book = new ExcelJS.Workbook();
    book.creator = "MINT Source of Truth";
    book.company = "MINT Platforms (Pty) Ltd";
    book.calcProperties.fullCalcOnLoad = true;
    const usedNames = new Set<string>();
    const sheetName = (raw: string) => {
      const base = raw.replace(/[\\/?*:[\]]/g, " ").trim().slice(0, 31) || "Strategy";
      let name = base;
      let suffix = 2;
      while (usedNames.has(name)) {
        const tail = ` ${suffix++}`;
        name = `${base.slice(0, 31 - tail.length)}${tail}`;
      }
      usedNames.add(name);
      return name;
    };
    const dateValue = (value: unknown) => value ? new Date(`${String(value).slice(0, 10)}T00:00:00Z`) : null;
    const rands = (value: unknown) => Number(value ?? 0) / 100;
    const moneyFormat = "#,##0.00;[Red](#,##0.00);-";
    const unitsFormat = "#,##0.0000;[Red](#,##0.0000);-";
    const percentFormat = "0.0%;[Red](0.0%);-";
    const purple = "FF7030A0";
    const grey = "FFD9D9D9";

    for (const current of latest) {
      const publicName = sheetName(current.strategy);
      const supportName = sheetName(`_${current.strategy.slice(0, 27)}`);
      const support = book.addWorksheet(supportName);
      support.state = "veryHidden";
      const strategyHistory = rows.filter((row) => row.strategyId === current.strategyId).sort((a, b) => a.asOf.localeCompare(b.asOf));
      const tickers = [...new Set(strategyHistory.flatMap((row) => row.legs.map((leg) => String(leg.ticker ?? "")).filter(Boolean)))];
      support.addRow(["Date", ...tickers.map((ticker) => `${ticker}_Units_Per_Lot`), "Securities", "Continuity_Cash", "Complete_Value", "SI_P/L", "What_Changed", "Status"]);
      let previousSignature = "";
      strategyHistory.forEach((ledgerRow, index) => {
        const active = ledgerRow.legs.filter((leg) => Boolean(leg.counts_in_current_strategy));
        const unitMap = new Map(active.map((leg) => [String(leg.ticker ?? ""), Number(leg.units ?? 0)]));
        const signature = active.map((leg) => `${String(leg.ticker)}:${Number(leg.units ?? 0)}`).sort().join("|");
        const changed = index === 0 ? "Initial basket" : signature === previousSignature ? "No composition change" : "Composition changed / rebalance boundary";
        previousSignature = signature;
        support.addRow([
          dateValue(ledgerRow.asOf), ...tickers.map((ticker) => unitMap.get(ticker) ?? 0),
          ledgerRow.securitiesCents / 100, ledgerRow.continuityCashCents / 100, ledgerRow.completeValueCents / 100,
          rands(ledgerRow.periods.SI?.pnl_cents ?? ledgerRow.periods.SI?.numerator_cents), changed, ledgerRow.certificationStatus,
        ]);
      });
      const dailyLastRow = strategyHistory.length + 1;
      const legHeaderRow = dailyLastRow + 3;
      support.getRow(legHeaderRow).values = ["Ticker", "Leg", "Entry_Date", "Exit_Date", "Units", "Entry_Price", "Entry_Cost", "Exit_or_Current_Value", "SI_P/L", "Is_Current"];
      current.legs.forEach((leg) => {
        const units = Number(leg.units ?? 0);
        const entryPrice = rands(leg.entry_price_cents);
        const exitOrCurrent = rands(leg.current_or_exit_value_cents);
        support.addRow([
          String(leg.ticker ?? ""), String(leg.leg ?? ""), dateValue(leg.entry_date), dateValue(leg.exit_date), units,
          entryPrice, units * entryPrice, exitOrCurrent, exitOrCurrent - units * entryPrice, Boolean(leg.counts_in_current_strategy) ? "Yes" : "No",
        ]);
      });
      const legFirstRow = legHeaderRow + 1;
      const legLastRow = legHeaderRow + current.legs.length;
      const metricHeaderRow = legLastRow + 3;
      support.getRow(metricHeaderRow).values = ["Period", "Benchmark", "Numerator", "P/L", "Return", "Reference_Date"];
      ["1W", "WTD", "1M", "3M", "YTD", "SI"].forEach((period) => {
        const metric = current.periods[period] ?? {};
        const benchmark = rands(metric.denominator_cents);
        const pnl = rands(metric.pnl_cents ?? metric.numerator_cents);
        const numerator = rands(metric.numerator_value_cents) || benchmark + pnl;
        support.addRow([period, benchmark, numerator, pnl, metric.return_pct == null ? null : Number(metric.return_pct) / 100, dateValue(metric.reference_date)]);
      });

      const view = book.addWorksheet(publicName, { pageSetup: { orientation: "portrait", fitToWidth: 1, fitToHeight: 1 } });
      view.mergeCells("A1:B1");
      view.getCell("A1").value = "PUBLIC STRATEGY VIEW - WHAT THE STRATEGY PAGE SHOULD SHOW";
      view.getCell("A1").fill = { type: "pattern", pattern: "solid", fgColor: { argb: purple } };
      view.getCell("A1").font = { bold: true, color: { argb: "FFFFFFFF" }, size: 11 };
      view.getCell("A1").alignment = { horizontal: "left", vertical: "middle" };
      const creationDate = String(strategyHistory[0]?.evidence?.strategy_created_at ?? strategyHistory[0]?.asOf ?? current.asOf).slice(0, 10);
      const firstCloseDate = strategyHistory[0]?.asOf ?? current.asOf;
      view.getCell("A2").value = "Inception_to_Latest_Coverage";
      view.getCell("B2").value = {
        formula: `TEXT(DATE(${creationDate.slice(0, 4)},${Number(creationDate.slice(5, 7))},${Number(creationDate.slice(8, 10))}),"dd-mmm-yyyy")&" to "&TEXT(MAX(${`'${supportName.replaceAll("'", "''")}'`}!$A$2:$A$${dailyLastRow}),"dd-mmm-yyyy")`,
        result: `${creationDate} to ${current.asOf}`,
      };
      view.getCell("C2").value = creationDate === firstCloseDate
        ? "Daily market-close history begins on the strategy creation date and continues to the latest available close."
        : `Created ${creationDate}; the first legitimate market close is ${firstCloseDate} because the creation date was not a trading day.`;
      for (let column = 1; column <= 3; column += 1) view.getCell(2, column).alignment = { vertical: "top", wrapText: true };
      view.getRow(2).height = 32.1;
      view.getRow(3).values = ["Metric", "Formula / Value", "Why it matters"];
      const supportRef = `'${supportName.replaceAll("'", "''")}'`;
      const completeColumn = tickers.length + 4;
      const cashColumn = tickers.length + 3;
      const siPnlColumn = tickers.length + 5;
      const col = (number: number) => support.getColumn(number).letter;
      const firstComplete = Number(strategyHistory[0]?.completeValueCents ?? 0) / 100;
      const latestComplete = current.completeValueCents / 100;
      const initialCash = Number(strategyHistory[0]?.continuityCashCents ?? 0) / 100;
      const latestCash = current.continuityCashCents / 100;
      const closedProceeds = current.legs.filter((leg) => Boolean(leg.exit_date)).reduce((sum, leg) => sum + rands(leg.current_or_exit_value_cents), 0);
      const replacementCost = current.legs.filter((leg) => Boolean(leg.counts_in_current_strategy) && String(leg.entry_date ?? "") > String(strategyHistory[0]?.asOf ?? ""))
        .reduce((sum, leg) => sum + Number(leg.units ?? 0) * rands(leg.entry_price_cents), 0);
      const metricRows: Array<[string, { formula: string; result: string | number | null } | Date | number, string]> = [
        ["As_Of_Date", { formula: `MAX(${supportRef}!$A$2:$A$${dailyLastRow})`, result: current.asOf }, "Latest date in the canonical daily ledger."],
        ["Current_Open_Strategy_Value_Per_Lot", { formula: `${supportRef}!$${col(completeColumn)}$${dailyLastRow}`, result: latestComplete }, "Open securities plus valid strategy-level continuity cash."],
        ["Starting_Capital_Per_Lot", { formula: `${supportRef}!$${col(completeColumn)}$2`, result: firstComplete }, "The strategy's first canonical complete value per lot."],
        ["New_Cash_Added_Per_Lot", { formula: `${supportRef}!$${col(cashColumn)}$${dailyLastRow}-${supportRef}!$${col(cashColumn)}$2`, result: latestCash - initialCash }, "Net change in strategy-level continuity cash; owner reserve and residual are excluded."],
        ["Closed_Leg_Proceeds_Per_Lot", { formula: `SUMIFS(${supportRef}!$H$${legFirstRow}:$H$${legLastRow},${supportRef}!$D$${legFirstRow}:$D$${legLastRow},"<>")`, result: closedProceeds }, "Exit value retained for closed legs in the audit trail."],
        ["Replacement_Leg_Cost_Per_Lot", { formula: `SUMIFS(${supportRef}!$G$${legFirstRow}:$G$${legLastRow},${supportRef}!$C$${legFirstRow}:$C$${legLastRow},">"&${supportRef}!$A$2,${supportRef}!$J$${legFirstRow}:$J$${legLastRow},"Yes")`, result: replacementCost }, "Entry cost of post-inception open model legs, retained to explain rebalance funding."],
        ["Current_Open_P/L_Per_Lot", { formula: `B5-(B6+B7)`, result: latestComplete - (firstComplete + latestCash - initialCash) }, "Current complete value less starting capital and net continuity capital added."],
        ["Leg_Level_SI_P/L_Per_Lot", { formula: `SUM(${supportRef}!$I$${legFirstRow}:$I$${legLastRow})`, result: current.legs.reduce((sum, leg) => sum + rands(leg.current_or_exit_value_cents) - Number(leg.units ?? 0) * rands(leg.entry_price_cents), 0) }, "Independent leg-level since-inception P/L cross-check."],
      ];
      metricRows.forEach(([label, value, why], index) => {
        const row = index + 4;
        view.getCell(row, 1).value = label;
        view.getCell(row, 2).value = value as CellValue;
        view.getCell(row, 3).value = why;
        view.getCell(row, 2).numFmt = row === 4 ? "dd-mmm-yyyy" : moneyFormat;
      });

      view.getCell("A13").value = "Public strategy returns";
      view.getCell("A13").fill = { type: "pattern", pattern: "solid", fgColor: { argb: purple } };
      view.getCell("A13").font = { bold: true, color: { argb: "FFFFFFFF" } };
      view.getCell("A14").fill = { type: "pattern", pattern: "solid", fgColor: { argb: purple } };
      view.getRow(15).values = ["Period", "Benchmark_Value", "Numerator_Value", "P/L", "Return"];
      ["1W", "WTD", "1M", "3M", "YTD", "SI"].forEach((period, index) => {
        const row = 16 + index;
        const sourceRow = metricHeaderRow + 1 + index;
        const metric = current.periods[period] ?? {};
        const benchmark = rands(metric.denominator_cents);
        const pnl = rands(metric.pnl_cents ?? metric.numerator_cents);
        const numerator = rands(metric.numerator_value_cents) || benchmark + pnl;
        view.getCell(row, 1).value = period;
        view.getCell(row, 2).value = { formula: `${supportRef}!B${sourceRow}`, result: benchmark };
        view.getCell(row, 3).value = { formula: `${supportRef}!C${sourceRow}`, result: numerator };
        view.getCell(row, 4).value = { formula: `${supportRef}!D${sourceRow}`, result: pnl };
        view.getCell(row, 5).value = { formula: `IFERROR(D${row}/B${row},"")`, result: metric.return_pct == null ? "" : Number(metric.return_pct) / 100 };
        [2, 3, 4].forEach((column) => { view.getCell(row, column).numFmt = moneyFormat; });
        view.getCell(row, 5).numFmt = percentFormat;
      });

      view.getCell("A25").value = "Open strategy value by date per lot";
      view.getCell("A25").fill = { type: "pattern", pattern: "solid", fgColor: { argb: purple } };
      view.getCell("A25").font = { bold: true, color: { argb: "FFFFFFFF" } };
      const valueColumn = tickers.length + 2;
      const pnlColumn = valueColumn + 1;
      const changeColumn = valueColumn + 2;
      view.getRow(27).values = ["Date", ...tickers.map((ticker) => `${ticker}_Units_Per_Lot`), "Open_Strategy_Value_Per_Lot", "Open_P/L_Per_Lot", "What changed"];
      strategyHistory.forEach((ledgerRow, index) => {
        const targetRow = 28 + index;
        const sourceRow = index + 2;
        view.getCell(targetRow, 1).value = { formula: `${supportRef}!A${sourceRow}`, result: dateValue(ledgerRow.asOf) ?? ledgerRow.asOf };
        view.getCell(targetRow, 1).numFmt = "dd-mmm-yyyy";
        tickers.forEach((_, tickerIndex) => {
          view.getCell(targetRow, tickerIndex + 2).value = { formula: `${supportRef}!${col(tickerIndex + 2)}${sourceRow}`, result: Number(support.getCell(sourceRow, tickerIndex + 2).value ?? 0) };
          view.getCell(targetRow, tickerIndex + 2).numFmt = unitsFormat;
        });
        view.getCell(targetRow, valueColumn).value = { formula: `${supportRef}!${col(completeColumn)}${sourceRow}`, result: ledgerRow.completeValueCents / 100 };
        view.getCell(targetRow, pnlColumn).value = { formula: `${supportRef}!${col(siPnlColumn)}${sourceRow}`, result: rands(ledgerRow.periods.SI?.pnl_cents ?? ledgerRow.periods.SI?.numerator_cents) };
        view.getCell(targetRow, changeColumn).value = { formula: `${supportRef}!${col(siPnlColumn + 1)}${sourceRow}`, result: String(support.getCell(sourceRow, siPnlColumn + 1).value ?? "") };
        view.getCell(targetRow, valueColumn).numFmt = moneyFormat;
        view.getCell(targetRow, pnlColumn).numFmt = moneyFormat;
      });

      [3, 15, 27].forEach((rowNumber) => {
        view.getRow(rowNumber).eachCell({ includeEmpty: true }, (cell) => {
          cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: grey } };
          cell.font = { bold: true };
          cell.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
        });
      });
      view.getCell("A10").fill = { type: "pattern", pattern: "solid", fgColor: { argb: grey } };
      view.getCell("A10").font = { bold: true };
      view.getCell("A10").alignment = { horizontal: "center", vertical: "middle", wrapText: true };
      for (let column = 1; column <= 15; column += 1) {
        const returnCell = view.getCell(16, column);
        returnCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: grey } };
        returnCell.font = { bold: true };
        returnCell.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
        view.getCell(23, column).fill = { type: "pattern", pattern: "solid", fgColor: { argb: grey } };
      }
      for (let row = 4; row <= 11; row += 1) for (let column = 1; column <= 3; column += 1) view.getCell(row, column).alignment = { vertical: "top", wrapText: true };
      view.getColumn(1).width = 40.42578125;
      for (let column = 2; column <= Math.max(8, changeColumn); column += 1) view.getColumn(column).width = column === changeColumn ? 70 : 40.42578125;
      for (let column = 9; column <= 14; column += 1) view.getColumn(column).width = 12;
      view.getColumn(15).width = 70;
      view.views = [{ state: "frozen", ySplit: 3 }];
      view.headerFooter.oddFooter = "MINT public strategy view | &A | Page &P of &N";
    }

    const buffer = await book.xlsx.writeBuffer();
    const blob = new Blob([new Uint8Array(buffer)], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `MINT-07-public-strategy-views-${new Date().toISOString().slice(0, 10)}.xlsx`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const exportCanonicalWorkbook = async () => {
    const XLSX = await import("xlsx");
    const book = XLSX.utils.book_new();
    const usedNames = new Set<string>();
    const sheetName = (name: string) => {
      const base = name.replace(/[\\/?*:[\]]/g, " ").trim().slice(0, 31) || "Strategy";
      let candidate = base;
      let suffix = 2;
      while (usedNames.has(candidate)) {
        const tail = ` ${suffix++}`;
        candidate = `${base.slice(0, 31 - tail.length)}${tail}`;
      }
      usedNames.add(candidate);
      return candidate;
    };
    const strategyGroups = [...new Map(rows.map((row) => [row.strategyId, row.strategy])).entries()]
      .sort((a, b) => a[1].localeCompare(b[1]));
    for (const [strategyId, strategyName] of strategyGroups) {
      const strategyRows = rows
        .filter((row) => row.strategyId === strategyId)
        .sort((a, b) => a.asOf.localeCompare(b.asOf));
      const headings = ["As_Of_Date", "Securities_ZAR", "Continuity_CA_ZAR", "Complete_Value_ZAR", "Status"];
      for (const period of periods) headings.push(`${period}_Date`, `${period}_Opening_ZAR`, `${period}_P&L_ZAR`, `${period}_Return`);
      const grid: unknown[][] = [
        [`MINT canonical strategy ledger — ${strategyName}`],
        ["Database-backed Excel-leg methodology. Purple cells are calculated formulas; DRAFT rows are not client-facing."],
        headings,
      ];
      for (const row of strategyRows) {
        const values: unknown[] = [
          row.asOf,
          row.securitiesCents / 100,
          row.continuityCashCents / 100,
          row.completeValueCents / 100,
          row.certificationStatus,
        ];
        for (const period of periods) {
          const metric = row.periods[period] ?? {};
          values.push(
            metric.reference_date ?? "",
            Number(metric.denominator_cents ?? 0) / 100,
            Number(metric.numerator_cents ?? 0) / 100,
            metric.return_pct == null ? null : Number(metric.return_pct) / 100,
          );
        }
        grid.push(values);
      }
      const sheet = XLSX.utils.aoa_to_sheet(grid);
      sheet["!merges"] = [XLSX.utils.decode_range(`A1:${XLSX.utils.encode_col(headings.length - 1)}1`), XLSX.utils.decode_range(`A2:${XLSX.utils.encode_col(headings.length - 1)}2`)];
      sheet["!cols"] = headings.map((heading, index) => ({ wch: index === 0 ? 13 : heading.endsWith("_Date") ? 13 : heading === "Status" ? 12 : 18 }));
      sheet["!autofilter"] = { ref: `A3:${XLSX.utils.encode_col(headings.length - 1)}${strategyRows.length + 3}` };
      sheet["!freeze"] = { xSplit: 1, ySplit: 3, topLeftCell: "B4", activePane: "bottomRight", state: "frozen" };
      for (let offset = 0; offset < strategyRows.length; offset += 1) {
        const excelRow = offset + 4;
        const completeCell = sheet[`D${excelRow}`];
        if (completeCell) Object.assign(completeCell, { f: `B${excelRow}+C${excelRow}`, z: 'R #,##0.00;[Red]-R #,##0.00' });
        for (let periodIndex = 0; periodIndex < periods.length; periodIndex += 1) {
          const openingColumn = 6 + periodIndex * 4;
          const pnlColumn = openingColumn + 1;
          const returnColumn = openingColumn + 2;
          const openingRef = `${XLSX.utils.encode_col(openingColumn)}${excelRow}`;
          const pnlRef = `${XLSX.utils.encode_col(pnlColumn)}${excelRow}`;
          const pnlCell = sheet[pnlRef];
          const returnRef = `${XLSX.utils.encode_col(returnColumn)}${excelRow}`;
          const returnCell = sheet[returnRef];
          if (pnlCell) pnlCell.z = 'R #,##0.00;[Red]-R #,##0.00';
          if (returnCell) Object.assign(returnCell, { f: `IFERROR(${pnlRef}/${openingRef},0)`, z: '0.0000%;[Red]-0.0000%' });
        }
        for (const column of ["B", "C", "D"]) if (sheet[`${column}${excelRow}`]) sheet[`${column}${excelRow}`].z = 'R #,##0.00;[Red]-R #,##0.00';
      }
      XLSX.utils.book_append_sheet(book, sheet, sheetName(strategyName));
    }
    (book as unknown as { CalcPr: { calcMode: string } }).CalcPr = { calcMode: "auto" };
    XLSX.writeFile(book, `MINT-canonical-strategy-ledgers-${new Date().toISOString().slice(0, 10)}.xlsx`, { compression: true });
  };

  const compareProviderFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    setProofBusy(true);
    setProof(null);
    setProofError("");
    try {
      const providerRows: Array<{ ticker: string; date: string; closeCents: number; sourceFile: string }> = [];
      for (const file of Array.from(files)) {
        const lines = (await file.text()).replace(/^\uFEFF/, "").split(/\r?\n/).filter(Boolean);
        if (lines.length < 2) throw new Error(`${file.name} has no price rows`);
        const headerLine = lines[0] ?? "";
        const delimiter = (headerLine.match(/;/g)?.length ?? 0) > (headerLine.match(/,/g)?.length ?? 0) ? ";" : ",";
        const headers = headerLine.split(delimiter).map((value) => value.trim().toLowerCase().replaceAll("_", " "));
        const dateIndex = headers.findIndex((value) => value === "date" || value === "as of date");
        const tickerIndex = headers.findIndex((value) => value === "ticker" || value === "symbol");
        const centsIndex = headers.findIndex((value) => value === "close cents" || value === "price cents");
        const closeIndex = centsIndex >= 0 ? centsIndex : headers.findIndex((value) => value === "close" || value === "adj close");
        if (dateIndex < 0 || closeIndex < 0) throw new Error(`${file.name} needs Date and Close columns`);
        const inferredTicker = file.name.replace(/\.csv$/i, "").split(/[_ -]/)[0]?.toUpperCase() ?? "";
        for (const line of lines.slice(1)) {
          const cells = line.split(delimiter).map((value) => value.trim().replace(/^"|"$/g, ""));
          const close = Number(cells[closeIndex]);
          if (!cells[dateIndex] || !(close > 0)) continue;
          const ticker = String(tickerIndex >= 0 ? cells[tickerIndex] : inferredTicker).trim();
          const yahooJseCents = /\.(JO|JSE)$/i.test(ticker);
          if (centsIndex < 0 && !yahooJseCents) {
            throw new Error(`${file.name} has an ambiguous Close unit; use a .JO ticker or a Close_Cents column`);
          }
          providerRows.push({
            ticker,
            date: String(cells[dateIndex]).slice(0, 10),
            closeCents: close,
            sourceFile: file.name,
          });
        }
      }
      const response = await fetch("/api/admin/source-of-truth/price-proof", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rows: providerRows }),
      });
      const body = await response.json();
      if (!response.ok || !body.ok) throw new Error(body.error || "Price comparison failed");
      setProof(body);
    } catch (reason) {
      setProofError(reason instanceof Error ? reason.message : "Price comparison failed");
    } finally {
      setProofBusy(false);
    }
  };

  if (loading) return <div className="rounded-2xl border border-white/10 bg-card/70 p-10 text-center text-sm text-muted-foreground">Loading canonical ledger…</div>;
  if (!selected) return <div className="rounded-2xl border border-amber-400/20 bg-amber-400/[0.05] p-8 text-sm text-amber-200">No canonical ledger rows have been staged yet.</div>;

  return (
    <section className="overflow-hidden rounded-2xl border border-violet-400/25 bg-card/80 shadow-[0_24px_80px_-45px_rgba(139,92,246,.9)]">
      <div className="border-b border-white/10 bg-gradient-to-r from-violet-500/15 via-fuchsia-500/5 to-transparent p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.18em] text-violet-300"><FileSpreadsheet className="h-4 w-4" /> Canonical strategy ledger</div>
            <h2 className="mt-2 text-xl font-semibold">Excel-style audit workbook</h2>
            <p className="mt-1 max-w-3xl text-sm text-muted-foreground">Database-backed model legs and all return ranges. This surface displays the stored canonical record; it never recalculates a return in the browser.</p>
          </div>
          <div className="flex items-center gap-2">
            <Button type="button" size="sm" variant="outline" onClick={() => void exportExactReturnEngineWorkbook()}>
              <Download className="mr-1.5 h-3.5 w-3.5" /> Export exact Excel
            </Button>
            {history.length > 1 && (
              <select
                value={selected.asOf}
                onChange={(event) => setSelectedAsOf(event.target.value)}
                className="rounded-lg border border-white/10 bg-black/20 px-3 py-1.5 text-xs text-foreground outline-none focus:border-violet-300/50"
                aria-label="Ledger close date"
              >
                {history.map((row) => <option key={row.asOf} value={row.asOf}>{row.asOf} · {row.certificationStatus}</option>)}
              </select>
            )}
            <StatusLight severity={status} />
          </div>
        </div>
        <div className="mt-5 flex gap-2 overflow-x-auto pb-1">
          {latest.map((row) => (
            <button key={row.strategyId} type="button" onClick={() => { setSelectedId(row.strategyId); setSelectedAsOf(null); }} className={`shrink-0 rounded-lg border px-3 py-2 text-sm transition ${selected.strategyId === row.strategyId ? "border-violet-300/60 bg-violet-500/20 text-violet-100" : "border-white/10 bg-black/10 text-muted-foreground hover:border-violet-300/30 hover:text-foreground"}`}>
              {row.strategy}
            </button>
          ))}
        </div>
      </div>

      <div className="grid gap-3 border-b border-white/10 p-4 sm:grid-cols-2 xl:grid-cols-4">
        <LedgerStat label="As of close" value={when(selected.asOf)} />
        <LedgerStat label="Securities" value={money(selected.securitiesCents)} />
        <LedgerStat label="Continuity cash" value={money(selected.continuityCashCents)} className="text-emerald-300" />
        <LedgerStat label="Complete value" value={money(selected.completeValueCents)} />
      </div>

      <div className="border-b border-white/10 p-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div>
            <div className="text-sm font-semibold">Daily complete-value ledger</div>
            <div className="mt-1 text-xs text-muted-foreground">Stored database rows only · no browser-side return reconstruction</div>
          </div>
          <span className="rounded-full border border-white/10 bg-black/10 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{history.length} closes</span>
        </div>
        {chartRows.length > 1 ? (
          <div className="h-52 rounded-xl border border-white/10 bg-black/10 p-2">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={chartRows} margin={{ top: 10, right: 12, left: 4, bottom: 0 }}>
                <defs>
                  <linearGradient id="canonicalLedgerValue" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#8b5cf6" stopOpacity={0.42} />
                    <stop offset="100%" stopColor="#8b5cf6" stopOpacity={0.02} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,.06)" vertical={false} />
                <XAxis dataKey="date" tick={{ fill: "#9ca3af", fontSize: 10 }} axisLine={false} tickLine={false} minTickGap={24} />
                <YAxis tick={{ fill: "#9ca3af", fontSize: 10 }} axisLine={false} tickLine={false} width={56} tickFormatter={(value) => `R${Number(value).toLocaleString("en-ZA", { maximumFractionDigits: 0 })}`} />
                <Tooltip formatter={(value) => [`R${Number(value).toLocaleString("en-ZA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`, "Complete value"]} labelFormatter={(label) => `Close ${label}`} />
                <Area type="monotone" dataKey="complete" stroke="#a78bfa" strokeWidth={2} fill="url(#canonicalLedgerValue)" dot={{ r: 2, fill: "#c4b5fd" }} activeDot={{ r: 4 }} />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        ) : (
          <div className="rounded-xl border border-dashed border-white/10 bg-black/10 p-6 text-center text-xs text-muted-foreground">The chart will form as additional certified or draft closes are stored.</div>
        )}
      </div>

      <div className="grid gap-5 p-4 xl:grid-cols-[minmax(0,1.2fr)_minmax(330px,.8fr)]">
        <div className="overflow-hidden rounded-xl border border-white/10">
          <div className="border-b border-white/10 bg-white/[0.025] px-4 py-3 text-sm font-semibold">Return range ledger</div>
          <div className="overflow-x-auto"><table className="w-full min-w-[620px] text-left text-xs"><thead className="border-b border-white/10 text-[10px] uppercase tracking-wider text-muted-foreground"><tr><th className="p-3">Range</th><th className="p-3">Reference date</th><th className="p-3">P/L</th><th className="p-3">Opening value</th><th className="p-3">Return</th></tr></thead><tbody>{periods.map((range) => { const metric = selected.periods[range] ?? {}; return <tr key={range} className="border-b border-white/5 last:border-0 hover:bg-violet-500/[0.035]"><td className="p-3 font-semibold text-violet-200">{range}</td><td className="p-3">{when(metric.reference_date)}</td><td className={`p-3 tabular-nums ${Number(metric.numerator_cents) >= 0 ? "text-emerald-300" : "text-rose-300"}`}>{money(metric.numerator_cents)}</td><td className="p-3 tabular-nums">{money(metric.denominator_cents)}</td><td className={`p-3 font-semibold tabular-nums ${Number(metric.return_pct) >= 0 ? "text-emerald-300" : "text-rose-300"}`}>{pct(metric.return_pct)}</td></tr>; })}</tbody></table></div>
        </div>
        <div className="space-y-3">
          <div className="rounded-xl border border-white/10 bg-black/10 p-4 text-xs"><div className="font-semibold">Value identity</div><div className="mt-3 flex items-center justify-between text-muted-foreground"><span>Securities + continuity cash</span><span className="tabular-nums text-foreground">{money(selected.securitiesCents)} + {money(selected.continuityCashCents)}</span></div><div className="mt-2 flex items-center justify-between border-t border-white/10 pt-2 font-semibold"><span>Complete value</span><span className="tabular-nums">{money(selected.completeValueCents)}</span></div></div>
          <div className="rounded-xl border border-amber-400/20 bg-amber-400/[0.05] p-4 text-xs"><div className="font-semibold text-amber-200">Evidence status</div><div className="mt-2 text-muted-foreground">{selected.certificationStatus === "CERTIFIED" ? "Certified values may be read by app surfaces." : "Draft only. This row cannot replace public app/OEM returns."}</div>{unresolved.length > 0 && <ul className="mt-3 space-y-1 text-amber-200">{unresolved.map((item) => <li key={item}>• {item.replaceAll("_", " ")}</li>)}</ul>}</div>
        </div>
      </div>
      <PriceProofPanel proof={proof} busy={proofBusy} error={proofError} onFiles={compareProviderFiles} />
      <div className="border-t border-white/10 p-4"><div className="mb-3 flex items-center justify-between"><div className="text-sm font-semibold">Model-leg evidence</div><span className="text-xs text-muted-foreground">{selected.legs.length} legs</span></div><div className="overflow-x-auto"><table className="w-full min-w-[760px] text-left text-xs"><thead className="border-b border-white/10 text-[10px] uppercase tracking-wider text-muted-foreground"><tr><th className="p-3">Ticker</th><th className="p-3">Entry</th><th className="p-3">Exit</th><th className="p-3">Units</th><th className="p-3">Entry price</th><th className="p-3">Evidence</th></tr></thead><tbody>{selected.legs.map((leg, index) => { const evidence = String(leg.source ?? leg.source_ref ?? "UNKNOWN"); return <tr key={`${String(leg.leg_id)}-${index}`} className="border-b border-white/5 last:border-0"><td className="p-3 font-semibold">{String(leg.ticker ?? "—")}</td><td className="p-3">{when(String(leg.entry_date ?? ""))}</td><td className="p-3">{when(String(leg.exit_date ?? ""))}</td><td className="p-3 tabular-nums">{String(leg.units ?? "—")}</td><td className="p-3 tabular-nums">{money(Number(leg.entry_price_cents ?? 0))}</td><td className="p-3"><span className={`rounded-full px-2 py-1 text-[10px] ${evidence.includes("MODELED") || evidence.includes("proxy") ? "bg-amber-400/15 text-amber-200" : "bg-emerald-400/10 text-emerald-300"}`}>{evidence}</span></td></tr>; })}</tbody></table></div></div>
    </section>
  );
}

function PriceProofPanel({ proof, busy, error, onFiles }: { proof: PriceProofResult | null; busy: boolean; error: string; onFiles: (files: FileList | null) => Promise<void> }) {
  return (
    <div className="border-t border-white/10 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="text-sm font-semibold">Independent closing-price proof</div>
          <p className="mt-1 max-w-3xl text-xs text-muted-foreground">Upload Yahoo-style CSV exports. Yahoo JSE `.JO` closes are ZAc and remain in cents; otherwise provide an explicit Close_Cents column. A multi-ticker export may include Ticker or Symbol. The comparison is read-only and never edits prices or certifies a ledger automatically.</p>
        </div>
        <label className="inline-flex cursor-pointer items-center rounded-lg border border-violet-300/30 bg-violet-500/10 px-3 py-2 text-xs font-semibold text-violet-100 transition hover:bg-violet-500/20">
          <Upload className="mr-2 h-4 w-4" />{busy ? "Comparing…" : "Compare provider CSV"}
          <input type="file" accept=".csv,text/csv" multiple disabled={busy} className="hidden" onChange={(event) => void onFiles(event.target.files)} />
        </label>
      </div>
      {error && <div className="mt-3 rounded-lg border border-rose-400/25 bg-rose-400/[0.06] p-3 text-xs text-rose-200">{error}</div>}
      {proof && (
        <div className={`mt-3 rounded-xl border p-4 ${proof.summary.pass ? "border-emerald-400/25 bg-emerald-400/[0.05]" : "border-amber-400/25 bg-amber-400/[0.05]"}`}>
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
            <span className={`font-semibold ${proof.summary.pass ? "text-emerald-300" : "text-amber-200"}`}>{proof.summary.pass ? "Provider export matches stored closes" : "Provider differences require review"}</span>
            <span className="text-muted-foreground">{proof.summary.matched}/{proof.summary.total} matched · {proof.summary.mismatched} mismatched · {proof.summary.missing} missing</span>
          </div>
          <div className="mt-2 break-all font-mono text-[10px] text-muted-foreground">SHA-256 {proof.evidenceSha256}</div>
          {!proof.summary.pass && <div className="mt-3 overflow-x-auto"><table className="w-full min-w-[620px] text-left text-xs"><thead className="text-[10px] uppercase text-muted-foreground"><tr><th className="p-2">Date</th><th className="p-2">Ticker</th><th className="p-2">Provider</th><th className="p-2">Stored</th><th className="p-2">Difference</th></tr></thead><tbody>{proof.comparisons.filter((row) => row.status !== "MATCH").slice(0, 20).map((row) => <tr key={`${row.sourceFile}:${row.date}:${row.ticker}`} className="border-t border-white/5"><td className="p-2">{row.date}</td><td className="p-2 font-semibold">{row.ticker}</td><td className="p-2 tabular-nums">{money(row.closeCents)}</td><td className="p-2 tabular-nums">{row.storedCloseCents == null ? "Missing" : money(row.storedCloseCents)}</td><td className="p-2 tabular-nums text-amber-200">{row.differenceCents == null ? "—" : money(row.differenceCents)}</td></tr>)}</tbody></table></div>}
        </div>
      )}
    </div>
  );
}

function LedgerStat({ label, value, className }: { label: string; value: string; className?: string }) {
  return <div className="rounded-xl border border-white/10 bg-black/10 p-3"><div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">{label}</div><div className={cn("mt-1 text-lg font-semibold tabular-nums", className)}>{value}</div></div>;
}

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

function PerformanceReconciliation({ position }: { position: TruthPosition }) {
  const p = position.performance;
  const rebalanceProtected = position.rebalanceDiagnostics.every((row) => row.protected);
  const overall =
    p.ytdStatus === "urgent" || p.iressStatus === "urgent" || !rebalanceProtected
      ? "urgent"
      : p.ytdStatus === "warning" || p.iressStatus === "warning"
        ? "warning"
        : "ok";
  return (
    <div className="rounded-xl border border-cyan-400/20 bg-cyan-400/[0.035] p-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 text-sm font-semibold">
            Canonical return-chain integrity proof
            <InfoHint label="Canonical return-chain integrity proof">
              Checks the internal arithmetic and completeness of the approved anchor and every later daily return,
              checks rebalance boundaries, calculates today from quantity × price movement, and compares each
              Yahoo price with a fresh IRESS quote. This is distinct from an independent broker-position proof.
            </InfoHint>
          </div>
          <div className="mt-1 text-xs text-muted-foreground">{p.definition}</div>
        </div>
        <StatusLight severity={overall} />
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2 lg:grid-cols-7">
        <Stat label="Official YTD" value={pct(p.storedYtdPct)} />
        <Stat label="Rebuilt YTD" value={pct(p.independentYtdPct)} />
        <Stat
          label="Chain difference"
          value={p.ytdDifferencePp == null ? "—" : `${p.ytdDifferencePp.toFixed(6)} pp`}
          className={p.ytdStatus === "ok" ? "text-emerald-300" : "text-red-300"}
        />
        <Stat label="Performance P&L" value={money(p.performancePnlCents)} />
        <Stat
          label="Today's strategy P&L"
          value={`${money(p.todayStrategyPnlCents ?? 0)} · ${pct(p.todayStrategyPct)}`}
        />
        <Stat
          label="IRESS coverage"
          value={`${p.iressCovered}/${p.iressRequested} · ${p.iressMode}`}
          className={p.iressStatus === "ok" ? "text-emerald-300" : "text-amber-300"}
        />
        <Stat
          label="Chain completeness"
          value={`${p.returnChainAudit.observedRows} rows · ${p.returnChainAudit.complete ? "Complete" : "Blocked"}`}
          className={p.returnChainAudit.complete ? "text-emerald-300" : "text-amber-300"}
        />
      </div>
      <div className="mt-3 grid gap-3 lg:grid-cols-2">
        <div className="rounded-lg border border-white/10 bg-black/10 p-3 text-xs leading-5">
          <div className="font-semibold">What this proves</div>
          <ul className="mt-2 list-disc space-y-1 pl-4 text-muted-foreground">
            <li>
              YTD arithmetic is re-chained from the approved opening anchor; it is not inferred from raw
              basket-value changes, and no result is emitted when a daily link is missing or duplicated.
            </li>
            <li>{p.feeTreatment}.</li>
            <li>
              CA and execution reserve remain part of account value, but contribute zero market movement until
              deployed.
            </li>
            <li>
              Today&apos;s figure uses only the selected client&apos;s quantities and the current price minus previous
              close.
            </li>
          </ul>
          {!p.returnChainAudit.complete ? (
            <div className="mt-2 rounded-md border border-amber-400/20 bg-amber-400/10 p-2 text-amber-200">
              Missing daily values: {p.returnChainAudit.missingDailyDates.join(", ") || "none"} · missing published dates:{" "}
              {p.returnChainAudit.missingExpectedDates.join(", ") || "none"} · duplicate dates:{" "}
              {p.returnChainAudit.duplicateDates.join(", ") || "none"} · largest calendar gap:{" "}
              {p.returnChainAudit.largestCalendarGapDays}d
            </div>
          ) : null}
        </div>
        <div className="overflow-hidden rounded-lg border border-white/10 bg-black/10">
          <div className="border-b border-white/10 p-3 text-xs font-semibold">
            Rebalance neutralisation proof · {position.rebalanceDiagnostics.length} event(s)
          </div>
          {position.rebalanceDiagnostics.length ? (
            <div className="max-h-44 overflow-auto">
              <table className="w-full text-xs">
                <thead className="text-left text-[10px] uppercase text-muted-foreground">
                  <tr>
                    <th className="p-2">Date</th>
                    <th className="p-2 text-right">Raw NAV</th>
                    <th className="p-2 text-right">Performance</th>
                    <th className="p-2">Verdict</th>
                  </tr>
                </thead>
                <tbody>
                  {position.rebalanceDiagnostics.map((row) => (
                    <tr key={row.id} className="border-t border-white/5">
                      <td className="p-2">{row.date}</td>
                      <td className="p-2 text-right tabular-nums">{pct(row.rawNavChangePct)}</td>
                      <td className="p-2 text-right tabular-nums">{pct(row.canonicalDailyPct)}</td>
                      <td className="p-2">
                        <span className={row.protected ? "text-emerald-300" : "text-red-300"}>
                          {row.protected ? "Neutralised" : "Unproven"}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="p-3 text-xs text-muted-foreground">No rebalance boundary exists for this position.</div>
          )}
        </div>
      </div>
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
    reconstructedCents?: number | null;
  }>;
}) {
  const [view, setView] = useState<"canonical" | "actual">("canonical");
  const chartData = data.map((row) => ({
    ...row,
    displayedCents:
      view === "actual"
        ? Number(
            row.reconstructedCents ?? row.securitiesCents + Number(row.residualCents ?? row.caCents ?? 0),
          )
        : Number(row.valueCents),
  }));
  return (
    <div className="h-72 rounded-xl border border-white/10 bg-black/10 p-3">
      <div className="mb-2 flex items-center justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 text-xs font-semibold">
            {view === "canonical" ? "Canonical basket history" : "Actual basket value chart"}
            <InfoHint label="Basket history chart">
              Canonical shows the published trusted history. Actual recalculates each date from the financial
              components that were recorded for that date. A gap means the historical components were not
              sufficient to prove that point.
            </InfoHint>
          </div>
          <div className="text-[10px] text-muted-foreground">
            {view === "canonical"
              ? "Published effective complete value"
              : "Recalculated per date: securities + CA/residual + reserve − liabilities"}
          </div>
        </div>
        <div className="flex rounded-md border border-white/10 bg-black/20 p-0.5">
          <button
            type="button"
            onClick={() => setView("canonical")}
            className={`rounded px-2 py-1 text-[10px] ${view === "canonical" ? "bg-violet-500 text-white" : "text-muted-foreground"}`}
          >
            Canonical
          </button>
          <button
            type="button"
            onClick={() => setView("actual")}
            className={`rounded px-2 py-1 text-[10px] ${view === "actual" ? "bg-cyan-500 text-white" : "text-muted-foreground"}`}
          >
            Actual basket value
          </button>
        </div>
      </div>
      <ResponsiveContainer width="100%" height="82%">
        <AreaChart data={chartData}>
          <CartesianGrid strokeDasharray="3 3" stroke="#ffffff12" />
          <XAxis dataKey="date" tick={{ fontSize: 9 }} minTickGap={28} />
          <YAxis tick={{ fontSize: 9 }} tickFormatter={(value) => `R${Math.round(value / 100)}`} />
          <Tooltip formatter={(value) => money(Number(value))} />
          <Legend />
          <Area
            type="monotone"
            dataKey="displayedCents"
            name={view === "canonical" ? "Canonical total" : "Recalculated actual"}
            stroke={view === "canonical" ? "#8b5cf6" : "#22d3ee"}
            fill={view === "canonical" ? "#8b5cf633" : "#22d3ee22"}
          />
          <Line type="monotone" dataKey="securitiesCents" name="Securities" stroke="#38bdf8" dot={false} />
          <Line type="monotone" dataKey="residualCents" name="CA" stroke="#22c55e" dot={false} />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

function ClientStrategyComparison({
  position,
  modelHistory,
}: {
  position: TruthPosition;
  modelHistory: ClientTruth["strategyModelHistory"][string];
}) {
  const comparison = useMemo(() => {
    const clientRows = [...position.history]
      .filter((row) => row.date && Number.isFinite(Number(row.allTimePct)))
      .sort((a, b) => a.date.localeCompare(b.date));
    const strategyRows = [...(modelHistory ?? [])]
      .filter((row) => row.date && Number.isFinite(Number(row.allTimePct)))
      .sort((a, b) => a.date.localeCompare(b.date));
    if (!clientRows.length || !strategyRows.length) return [];

    let strategyIndex = -1;
    const aligned = clientRows.flatMap((client) => {
      while (true) {
        const nextStrategy = strategyRows[strategyIndex + 1];
        if (!nextStrategy || nextStrategy.date > client.date) break;
        strategyIndex += 1;
      }
      const strategy = strategyRows[strategyIndex];
      return strategy ? [{ client, strategy }] : [];
    });
    const firstAligned = aligned[0];
    if (!firstAligned) return [];

    const clientStartGrowth = 1 + Number(firstAligned.client.allTimePct) / 100;
    const strategyStartGrowth = 1 + Number(firstAligned.strategy.allTimePct) / 100;
    if (clientStartGrowth <= 0 || strategyStartGrowth <= 0) return [];

    return aligned.map(({ client, strategy }) => {
      const clientPct = ((1 + Number(client.allTimePct) / 100) / clientStartGrowth - 1) * 100;
      const strategyPct = ((1 + Number(strategy.allTimePct) / 100) / strategyStartGrowth - 1) * 100;
      return {
        date: client.date,
        clientPct: Number(clientPct.toFixed(4)),
        strategyPct: Number(strategyPct.toFixed(4)),
        differencePp: Number((clientPct - strategyPct).toFixed(4)),
      };
    });
  }, [modelHistory, position.history]);

  const latest = comparison.at(-1);
  let largest = comparison[0];
  for (const row of comparison) {
    if (!largest || Math.abs(row.differencePp) > Math.abs(largest.differencePp)) largest = row;
  }
  const cashWeightPct = position.canonicalValueCents
    ? ((position.residualCents + position.reserveCents) / position.canonicalValueCents) * 100
    : 0;
  const severity = !latest
    ? "warning"
    : Math.abs(latest.differencePp) >= 1
      ? "urgent"
      : Math.abs(latest.differencePp) >= 0.25
        ? "warning"
        : "ok";

  return (
    <details open className={`rounded-xl border p-3 ${severityStyle[severity]}`}>
      <summary className="cursor-pointer list-none">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="flex items-center gap-2 text-sm font-semibold">
              Client vs actual strategy performance
              <InfoHint label="Client versus strategy performance">
                Both canonical return chains are rebased to zero on the client&apos;s first comparable date. The
                purple line is what this client experienced; the cyan line is the strategy model over those same
                dates; amber is the exact percentage-point gap.
              </InfoHint>
            </div>
            <div className="text-[10px] text-muted-foreground">
              Like-for-like fee-free return comparison · click to collapse
            </div>
          </div>
          <div className="flex items-center gap-3 text-right text-xs tabular-nums">
            <StatusLight severity={severity} />
            <span>Latest gap {pct(latest?.differencePp)}</span>
            <span>Largest gap {pct(largest?.differencePp)}</span>
          </div>
        </div>
      </summary>
      {comparison.length > 1 ? (
        <div className="mt-3 grid gap-3 lg:grid-cols-[minmax(0,2fr)_minmax(240px,1fr)]">
          <div className="h-80 rounded-lg border border-white/10 bg-black/10 p-2">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={comparison}>
                <CartesianGrid strokeDasharray="3 3" stroke="#ffffff12" />
                <XAxis dataKey="date" tick={{ fontSize: 9 }} minTickGap={28} />
                <YAxis tick={{ fontSize: 9 }} tickFormatter={(value) => `${Number(value).toFixed(1)}%`} />
                <Tooltip
                  formatter={(value, name) => [
                    `${Number(value).toFixed(4)} ${name === "Difference" ? "pp" : "%"}`,
                    name,
                  ]}
                />
                <Legend />
                <ReferenceLine y={0} stroke="#ffffff55" />
                {position.rebalanceDiagnostics.map((row) => (
                  <ReferenceLine
                    key={row.id}
                    x={row.date}
                    stroke="#f59e0b66"
                    strokeDasharray="3 3"
                    label={{ value: "R", fill: "#fbbf24", fontSize: 9 }}
                  />
                ))}
                <Line type="monotone" dataKey="clientPct" name="Client" stroke="#a78bfa" strokeWidth={2.5} dot={false} />
                <Line type="monotone" dataKey="strategyPct" name="Actual strategy" stroke="#22d3ee" strokeWidth={2.5} dot={false} />
                <Line
                  type="monotone"
                  dataKey="differencePp"
                  name="Difference"
                  stroke="#f59e0b"
                  strokeWidth={1.5}
                  dot={{ r: 2, fill: "#f59e0b" }}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
          <div className="space-y-2 rounded-lg border border-white/10 bg-black/10 p-3 text-xs">
            <div className="font-semibold">Why can the lines differ?</div>
            <p className="leading-5 text-muted-foreground">
              The client starts on their own entry date and owns real filled quantities. Their strategy-specific CA
              and reserve are included in value but remain flat while securities move. The model represents the
              strategy itself, so entry timing, cash weight, fills, quantity drift, missing valuation dates, or an
              unneutralised rebalance can create a gap.
            </p>
            <div className="grid grid-cols-2 gap-2">
              <Stat label="Client CA + reserve" value={money(position.residualCents + position.reserveCents)} />
              <Stat label="Cash weight" value={pct(cashWeightPct)} />
              <Stat label="Compared dates" value={String(comparison.length)} />
              <Stat label="Rebalances marked" value={String(position.rebalanceDiagnostics.length)} />
            </div>
            <div className="rounded-md bg-white/5 p-2 text-[10px] leading-4 text-muted-foreground">
              Thresholds: under 0.25 pp healthy, 0.25–0.99 pp warning, 1.00 pp or more urgent. An “R” marker is a
              rebalance boundary; it should not cause a discontinuity in either canonical line.
            </div>
          </div>
        </div>
      ) : (
        <div className="mt-3 rounded-lg border border-amber-400/20 bg-amber-400/5 p-3 text-xs text-amber-200">
          At least two overlapping client and strategy valuation dates are required for this comparison.
        </div>
      )}
    </details>
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
      <summary className="flex cursor-pointer list-none items-center gap-2 font-mono text-xs text-cyan-300">
        Developer evidence log
        <InfoHint label="Developer evidence log">
          Technical source names, timestamps, formulas, and variances used to diagnose a failed calculation.
          This section is mainly for developers and auditors.
        </InfoHint>
      </summary>
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
          <div className="flex items-center gap-2 text-sm font-semibold">
            Live surface accuracy matrix
            <InfoHint label="Live surface accuracy matrix">
              Compares what each connected OEM, factsheet, investor, IRESS, or Mint app surface currently
              returns with the value that surface is contractually expected to show. It also reports latency.
            </InfoHint>
          </div>
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
  const [openingPreview, setOpeningPreview] = useState<"dev" | "live" | null>(null);
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

  const openVisualPreview = async (target: "dev" | "live") => {
    const preview = window.open("/admin/studio/preview?loading=1", "_blank");
    if (preview) {
      preview.document.title = "Preparing client card preview";
      preview.document.body.innerHTML =
        '<div style="font-family:system-ui;padding:32px;color:#8b5cf6">Preparing secure Mint client view...</div>';
    }
    setOpeningPreview(target);
    try {
      const [portfolio, session] = await Promise.all([
        fetch(`/api/admin/studio?action=portfolio&user_id=${encodeURIComponent(truth.profile.id)}`)
          .then((response) => response.json()),
        fetch("/api/admin/studio?action=impersonate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ user_id: truth.profile.id, target }),
        }).then((response) => response.json()),
      ]);
      if (!session.ok || !session.actionLink) {
        throw new Error(session.error || "Could not open the Mint client view");
      }
      const client = {
        id: truth.profile.id,
        name:
          `${truth.profile.first_name || ""} ${truth.profile.last_name || ""}`.trim() ||
          truth.profile.email ||
          "Client",
        email: truth.profile.email || null,
      };
      const payload = {
        actionLink: session.actionLink,
        environment: target,
        client,
        portfolio: portfolio.ok ? portfolio : null,
      };
      const encoded = btoa(unescape(encodeURIComponent(JSON.stringify(payload))));
      const previewUrl = `/admin/studio/preview#payload=${encodeURIComponent(encoded)}`;
      if (preview) preview.location.href = previewUrl;
      else window.open(previewUrl, "_blank", "noopener,noreferrer");
    } catch (error) {
      preview?.close();
      window.alert(error instanceof Error ? error.message : "Could not open the Mint client view");
    } finally {
      setOpeningPreview(null);
    }
  };

  if (!checks.length) return null;
  return (
    <details className="group rounded-xl border border-cyan-400/20 bg-cyan-400/[0.035]">
      <summary className="flex cursor-pointer list-none items-center justify-between p-4">
        <div>
          <div className="flex items-center gap-2 font-semibold">
            Client App Card Accuracy
            <InfoHint label="Client App Card Accuracy">
              Authenticates against the actual Mint DEV and LIVE deployments, finds this client&apos;s selected
              strategy card, and compares its value and personal return with canonical client truth.
            </InfoHint>
            <span className="rounded-full bg-cyan-400/10 px-2 py-0.5 text-[10px] uppercase text-cyan-300">
              Dev + Live
            </span>
          </div>
          <div className="mt-1 text-xs text-muted-foreground">
            Mint home-dashboard strategy cards versus this client&apos;s canonical position, including
            CA. Open this panel only when you need the deployment-by-deployment evidence.
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
              <div className="mt-2 rounded-lg border border-white/10 bg-black/10 p-2 text-[10px]">
                <div className="font-semibold uppercase tracking-wide opacity-60">Source page</div>
                <div className="mt-1">Mint {check.surface.includes("DEV") ? "DEV" : "LIVE"} home dashboard · strategy carousel</div>
                {check.sourcePage && (
                  <div className="mt-1 truncate font-mono text-cyan-200/80">{check.sourcePage}</div>
                )}
                {check.sourceEndpoint && (
                  <div className="mt-1 truncate font-mono opacity-60">
                    Data contract: {check.sourceEndpoint}
                  </div>
                )}
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
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="mt-3 h-8 text-xs"
                disabled={openingPreview !== null}
                onClick={() => openVisualPreview(check.surface.includes("DEV") ? "dev" : "live")}
              >
                <ExternalLink className="mr-1.5 h-3.5 w-3.5" />
                {openingPreview === (check.surface.includes("DEV") ? "dev" : "live")
                  ? "Opening visual view..."
                  : "Open visual client card"}
              </Button>
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

function ForensicHistoryLab({ truth }: { truth: ClientTruth | StrategyTruth }) {
  const canShowClient = truth.kind === "client";
  const [scope, setScope] = useState<"basket" | "client">(canShowClient ? "client" : "basket");
  const [method, setMethod] = useState<"raw" | "canonical" | "reconstructed">("canonical");
  const position = truth.kind === "client" ? truth.positions[0] : null;
  const strategyId = truth.kind === "client" ? (position?.strategyId ?? "") : "";
  const raw =
    truth.kind === "strategy"
      ? truth.rawHistory
      : scope === "client"
        ? (position?.rawHistory ?? [])
        : (truth.rawStrategyHistory[strategyId] ?? []);
  const canonical =
    truth.kind === "strategy"
      ? truth.history
      : scope === "client"
        ? (position?.history ?? [])
        : (truth.strategyModelHistory[strategyId] ?? []);
  const currentCents =
    truth.kind === "strategy"
      ? truth.live.modelCapitalCents
      : scope === "client"
        ? position?.liveValueCents
        : Number(truth.strategyBenchmarks[strategyId]?.completeValueCents ?? 0);
  const reconstructed = [
    ...canonical
      .filter((row) => row.reconstructionProvable !== false && row.reconstructedCents != null)
      .map((row) => ({
        date: row.date,
        valueCents: Number(row.reconstructedCents),
      })),
    ...(currentCents
      ? [{ date: truth.generatedAt.slice(0, 10), valueCents: Number(currentCents), current: true }]
      : []),
  ];
  const selected =
    method === "raw"
      ? raw.map((row) => ({ date: row.date, valueCents: Number(row.valueCents) }))
      : method === "canonical"
        ? canonical.map((row) => ({ date: row.date, valueCents: Number(row.valueCents) }))
        : reconstructed;
  const rebalances = truth.rebalances.filter((row) => !strategyId || String(row.strategyId) === strategyId);
  const colour = method === "raw" ? "#ef4444" : method === "canonical" ? "#22c55e" : "#94a3b8";
  const latest = selected.at(-1);
  const unprovableDates = canonical.filter(
    (row) => row.reconstructionProvable === false || row.reconstructedCents == null,
  ).length;
  const purchaseLog =
    truth.kind === "client"
      ? [
          ...truth.activity.map((event) => ({
            date: event.date,
            type: event.direction || "TRANSACTION",
            description: event.name || event.description || "Client transaction",
            value: event.amountCents,
            status: event.reversed ? "REVERSED" : event.status,
          })),
          ...rebalances.flatMap((rebalance) =>
            (rebalance.events ?? []).map((event) => ({
              date: event.date || rebalance.date,
              type: `REBALANCE ${event.side}`,
              description: `${event.quantity} units · security ${event.securityId}`,
              value: Number(event.quantity) * Number(event.priceCents),
              status: rebalance.settlementState || rebalance.status,
            })),
          ),
        ].sort((a, b) => String(b.date).localeCompare(String(a.date)))
      : [];

  const download = async () => {
    const XLSX = await import("xlsx");
    const book = XLSX.utils.book_new();
    const exportSeries = (rows: Array<{ date: string; valueCents: number }>, exportMethod: string) =>
      rows.map((row) => ({
        Date: row.date,
        ValueCents: row.valueCents,
        ValueRands: row.valueCents / 100,
        Method: exportMethod,
        Scope: scope,
      }));
    XLSX.utils.book_append_sheet(
      book,
      XLSX.utils.json_to_sheet([
        {
          Scope: scope,
          GeneratedAt: truth.generatedAt,
          TrustedMethod: "Canonical chain-preserved effective history",
          ReconstructionFormula: "Securities + strategy CA or client residual + unused reserve - liabilities",
          RawWarning: "Raw unchained values are diagnostic only and are not valid performance.",
          Rebalances: rebalances.length,
        },
      ]),
      "Read me",
    );
    XLSX.utils.book_append_sheet(
      book,
      XLSX.utils.json_to_sheet(
        exportSeries(
          canonical.map((row) => ({ date: row.date, valueCents: Number(row.valueCents) })),
          "CANONICAL_TRUSTED",
        ),
      ),
      "Canonical correct",
    );
    XLSX.utils.book_append_sheet(
      book,
      XLSX.utils.json_to_sheet(exportSeries(reconstructed, "RECONSTRUCTED_ACCOUNTING")),
      "Reconstructed",
    );
    XLSX.utils.book_append_sheet(
      book,
      XLSX.utils.json_to_sheet(
        exportSeries(
          raw.map((row) => ({ date: row.date, valueCents: Number(row.valueCents) })),
          "RAW_DIAGNOSTIC_NOT_PERFORMANCE",
        ),
      ),
      "Raw diagnostic",
    );
    XLSX.utils.book_append_sheet(
      book,
      XLSX.utils.json_to_sheet(
        rebalances.flatMap((rebalance) =>
          rebalance.events?.length
            ? rebalance.events.map((event) => ({
                Batch: rebalance.id,
                BatchDate: rebalance.date,
                Settlement: rebalance.settlementState,
                Side: event.side,
                EventDate: event.date,
                SecurityId: event.securityId,
                Quantity: event.quantity,
                PriceCents: event.priceCents,
              }))
            : [
                {
                  Batch: rebalance.id,
                  BatchDate: rebalance.date,
                  Settlement: rebalance.settlementState,
                },
              ],
        ),
      ),
      "Rebalances",
    );
    if (truth.kind === "client") {
      XLSX.utils.book_append_sheet(book, XLSX.utils.json_to_sheet(truth.activity), "Client activity");
    }
    XLSX.writeFile(book, `forensic-${scope}-complete-${truth.generatedAt.slice(0, 10)}.xlsx`);
  };

  return (
    <details open className="group rounded-xl border border-white/10 bg-black/10">
      <summary className="flex cursor-pointer list-none items-center justify-between p-4">
        <div>
          <div className="flex items-center gap-2 font-semibold">
            Forensic history laboratory
            <InfoHint label="Forensic history laboratory">
              Switch between the unsafe raw value path, the trusted chain-preserved performance path, and an
              accounting reconstruction. Rebalance markers explain where basket composition changed.
            </InfoHint>
          </div>
          <div className="text-xs text-muted-foreground">
            Raw legacy, canonical chain-preserved and independently reconstructed paths
          </div>
        </div>
        <ChevronDown className="h-4 w-4 transition-transform group-open:rotate-180" />
      </summary>
      <div className="space-y-4 border-t border-white/10 p-4">
        <div className="flex flex-col justify-between gap-3 lg:flex-row lg:items-center">
          <div className="flex flex-wrap gap-2">
            <div className="flex rounded-lg border border-white/10 p-1">
              <button
                type="button"
                onClick={() => setScope("basket")}
                className={`rounded px-3 py-1.5 text-xs ${scope === "basket" ? "bg-violet-500 text-white" : "text-muted-foreground"}`}
              >
                Basket
              </button>
              <button
                type="button"
                disabled={!canShowClient}
                onClick={() => setScope("client")}
                className={`rounded px-3 py-1.5 text-xs disabled:opacity-30 ${scope === "client" ? "bg-violet-500 text-white" : "text-muted-foreground"}`}
              >
                Individual client
              </button>
            </div>
            <div className="flex rounded-lg border border-white/10 p-1">
              {(["raw", "canonical", "reconstructed"] as const).map((item) => (
                <button
                  key={item}
                  type="button"
                  onClick={() => setMethod(item)}
                  className={`rounded px-3 py-1.5 text-xs capitalize ${
                    method === item
                      ? item === "raw"
                        ? "bg-red-500 text-white"
                        : item === "canonical"
                          ? "bg-emerald-500 text-white"
                          : "bg-slate-500 text-white"
                      : "text-muted-foreground"
                  }`}
                >
                  {item === "raw" ? "Raw / unchained" : item}
                </button>
              ))}
            </div>
          </div>
          <Button size="sm" variant="outline" onClick={() => void download()}>
            <Download className="mr-2 h-4 w-4" />
            Download correct report
          </Button>
        </div>
        <div
          className={`rounded-lg border p-3 text-xs ${
            method === "raw"
              ? "border-red-400/25 bg-red-500/10 text-red-200"
              : method === "canonical"
                ? "border-emerald-400/25 bg-emerald-500/10 text-emerald-200"
                : "border-slate-400/25 bg-slate-500/10 text-slate-200"
          }`}
        >
          {method === "raw"
            ? "Diagnostic only: raw basket values do not preserve the return chain across cash flows and rebalances, so this red line must not be used as performance."
            : method === "canonical"
              ? "Approved chain-preserved effective history. This green line is the trusted performance and reporting path."
              : "Grey reconstruction recalculates each dated accounting equation from securities and cash components, then appends the fresh current truth point. Missing historical components remain unprovable."}
        </div>
        <div className="h-80 rounded-xl border border-white/10 p-3">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={selected}>
              <CartesianGrid strokeDasharray="3 3" stroke="#ffffff12" />
              <XAxis dataKey="date" tick={{ fontSize: 9 }} minTickGap={25} />
              <YAxis tick={{ fontSize: 9 }} tickFormatter={(value) => `R${Math.round(value / 100)}`} />
              <Tooltip formatter={(value) => money(Number(value))} />
              {rebalances.map((rebalance) => (
                <ReferenceLine
                  key={rebalance.id}
                  x={String(rebalance.date).slice(0, 10)}
                  stroke="#f59e0b"
                  strokeDasharray="3 3"
                  label={{ value: "R", fill: "#f59e0b", fontSize: 9 }}
                />
              ))}
              <Area
                type="monotone"
                dataKey="valueCents"
                name={`${scope} ${method}`}
                stroke={colour}
                fill={`${colour}22`}
                strokeWidth={2}
                animationDuration={900}
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
        <div className="grid gap-2 sm:grid-cols-4">
          <Stat
            label={method === "reconstructed" ? "Points proved" : "History points"}
            value={String(selected.length)}
          />
          <Stat label="Latest value" value={money(latest?.valueCents)} />
          <Stat label="Rebalances marked" value={String(rebalances.length)} />
          <Stat
            label="Method status"
            value={
              method === "raw"
                ? "Wrong for returns"
                : method === "canonical"
                  ? "Trusted"
                  : unprovableDates
                    ? `${unprovableDates} gaps`
                    : "Reconciled"
            }
            className={
              method === "raw"
                ? "text-red-400"
                : method === "canonical"
                  ? "text-emerald-400"
                  : "text-slate-300"
            }
          />
        </div>
        {truth.kind === "client" && (
          <details open className="group rounded-xl border border-white/10">
            <summary className="flex cursor-pointer list-none items-center justify-between p-3">
              <div>
                <div className="flex items-center gap-2 text-xs font-semibold">
                  Complete purchase and rebalance log
                  <InfoHint label="Purchase and rebalance log">
                    A dated ledger of client funding, purchases, sales, and rebalance events used to explain
                    how quantities, cash, and the investment trail changed over time.
                  </InfoHint>
                </div>
                <div className="text-[10px] text-muted-foreground">
                  Transactions and lot-changing rebalance events in one dated ledger
                </div>
              </div>
              <ChevronDown className="h-4 w-4 transition-transform group-open:rotate-180" />
            </summary>
            <div className="max-h-80 overflow-auto border-t border-white/10">
              <table className="w-full min-w-[700px] text-xs">
                <thead className="sticky top-0 bg-card text-left text-[10px] uppercase text-muted-foreground">
                  <tr>
                    <th className="p-2">Date</th>
                    <th className="p-2">Activity</th>
                    <th className="p-2">Description</th>
                    <th className="p-2 text-right">Value</th>
                    <th className="p-2">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {purchaseLog.map((event, index) => (
                    <tr key={`${event.date}-${event.type}-${index}`} className="border-t border-white/5">
                      <td className="p-2">{when(event.date)}</td>
                      <td className="p-2 font-medium">{event.type}</td>
                      <td className="p-2 text-muted-foreground">{event.description}</td>
                      <td className="p-2 text-right tabular-nums">{money(event.value)}</td>
                      <td className="p-2">{event.status || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        )}
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
        <TimeAlignmentRibbon snapshot={truth.pricingSnapshot} />
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
                  {finding.kind} · observed value drift {money(finding.differenceCents)}
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
        <TimeAlignmentRibbon
          snapshot={truth.pricingSnapshot}
          canonicalDates={[String(canonical?.as_of_date || "")]}
          comparison={truth.valuationComparison}
        />
        <ReturnStrip returns={truth.returns} />
        <div className={`rounded-xl border p-3 ${severityStyle[truth.ytdStatus]}`}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-xs font-semibold">
              Strategy return-chain integrity
              <InfoHint label="Strategy return-chain integrity">
                Rebuilds YTD from the canonical opening anchor and every published daily return. Missing or
                duplicate links block the rebuilt figure instead of being treated as zero.
              </InfoHint>
            </div>
            <StatusLight severity={truth.ytdStatus} />
          </div>
          <div className="mt-3 grid grid-cols-2 gap-2 md:grid-cols-4">
            <Stat label="Official YTD" value={pct(truth.storedYtdPct)} />
            <Stat label="Rebuilt YTD" value={pct(truth.rebuiltYtdPct)} />
            <Stat
              label="Difference"
              value={truth.ytdDifferencePp == null ? "—" : `${truth.ytdDifferencePp.toFixed(6)} pp`}
            />
            <Stat
              label="Completeness"
              value={`${truth.returnChainAudit.observedRows} rows · ${truth.returnChainAudit.complete ? "Complete" : "Blocked"}`}
            />
          </div>
          {!truth.returnChainAudit.complete ? (
            <div className="mt-2 text-xs text-amber-200">
              Missing daily values: {truth.returnChainAudit.missingDailyDates.join(", ") || "none"} · duplicate
              dates: {truth.returnChainAudit.duplicateDates.join(", ") || "none"}. No rebuilt YTD is trusted until
              the chain is complete.
            </div>
          ) : null}
        </div>
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
            <div className="flex items-center gap-2 text-xs font-semibold">
              What makes up the strategy
              <InfoHint label="Strategy composition">
                The independently priced securities plus this strategy model&apos;s own CA. It is one model
                basket—not the sum of cash belonging to every investor.
              </InfoHint>
            </div>
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
        <ForensicHistoryLab truth={truth} />
        <div className={`rounded-xl border p-3 ${severityStyle[truth.severity]}`}>
          <div className="flex items-center gap-2 font-semibold">
            Possible reasons for the difference
            <InfoHint label="Possible variance reasons">
              Evidence-based explanations to investigate, such as different valuation times, missing quotes,
              rebalance settlement, or cash changes. These are diagnostic possibilities, not automatic proof.
            </InfoHint>
          </div>
          <ul className="mt-2 list-disc space-y-1 pl-4 text-xs">
            {truth.reasons.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
        </div>
        <div className="rounded-xl border border-white/10 p-3 text-xs">
          <div className="flex items-center gap-2 font-semibold">
            Formula
            <InfoHint label="Strategy truth formula">
              The accounting equation used for this result. CA belongs to the selected strategy model and is
              kept separate from client execution reserve.
            </InfoHint>
          </div>
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
      <TimeAlignmentRibbon
        snapshot={truth.pricingSnapshot}
        canonicalDates={truth.positions.map((position) => position.asOf)}
        comparison={truth.positions.length === 1 ? truth.positions[0]?.valuationComparison : undefined}
      />
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
        <div className="flex items-center gap-2 text-xs font-semibold">
          Every cent of live value
          <InfoHint label="Every cent of live value">
            A complete client-value split: priced securities plus residual CA plus unused reserve, less open
            liabilities. These pieces should reconcile to the live total.
          </InfoHint>
        </div>
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
            <PerformanceReconciliation position={position} />
          </div>
          <div className="mt-3">
            <HistoryChart data={position.history} />
          </div>
          <div className="mt-3">
            <ClientStrategyComparison
              position={position}
              modelHistory={truth.strategyModelHistory[position.strategyId] ?? []}
            />
          </div>
          <div className="mt-3 grid grid-cols-2 gap-2">
            <Stat label="Independent live value" value={money(position.liveValueCents)} />
            <Stat label="Client performance P&L" value={money(position.canonicalPnlCents)} />
            <Stat label="Residual" value={money(position.residualCents)} className="text-emerald-400" />
            <Stat label="Reserve" value={money(position.reserveCents)} />
            <Stat label="Liability" value={money(position.liabilityCents)} />
            <Stat label="Securities" value={money(position.securitiesCents)} />
          </div>
          <div className="my-3 rounded-lg bg-white/[0.035] p-2 text-xs text-muted-foreground">
            {position.formula}. This proves current account value separately; performance P&amp;L and YTD come
            from the fee-free, rebalance-neutral canonical return chain.
          </div>
          <div className="mb-3 grid gap-3 md:grid-cols-2">
            <div className="rounded-xl border border-white/10 bg-black/10 p-3 text-xs">
              <div className="flex items-center gap-2 font-semibold">
                Plain-English calculation
                <InfoHint label="Plain-English calculation">
                  A non-technical explanation of how fresh prices, quantities, cash, reserve, and liabilities
                  produce the client value and the reported difference.
                </InfoHint>
              </div>
              <p className="mt-2 leading-5 text-muted-foreground">
                Every active quantity is multiplied by its fresh Yahoo price. We add this strategy&apos;s own
                CA/residual and unused execution reserve, subtract open fee liabilities, then compare the
                result with the canonical value currently supplied to the app. Fees are shown only in that
                withdrawable-value reconciliation and are excluded from the performance return.
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
      <ForensicHistoryLab truth={truth} />
      <div className="rounded-xl border border-white/10 p-3">
        <div className="flex items-center gap-2 text-xs font-semibold">
          Client activity timeline
          <InfoHint label="Client activity timeline">
            The dated cash and investment events associated with this client. Use it to connect value changes
            to purchases, reversals, deposits, or other recorded activity.
          </InfoHint>
        </div>
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
