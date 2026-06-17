"use client";

import { useCallback, useMemo, useState } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import {
  ChevronDown,
  ClipboardCheck,
  ExternalLink,
  FlaskConical,
  History,
  RefreshCw,
  Scale,
  Search,
  UserCircle2,
} from "lucide-react";

import { Panel } from "@/components/oems/primitives/panel";
import { EmptyDataState } from "@/components/oems/primitives/empty-data-state";
import { PanelSkeleton } from "@/components/oems/primitives/panel-skeleton";
import {
  GlassBadge,
  GlassKpi,
  GlassSection,
  GlassSegment,
  ResearchLabCanvas,
} from "@/components/oems/primitives/glass";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { HoldingsTable } from "@/components/research-lab/holdings-table";
import { FundamentalsMatrix } from "@/components/research-lab/fundamentals-matrix";
import { SectorExposureChart, SectorCompareCharts } from "@/components/research-lab/sector-exposure-chart";
import { AllocationDonut } from "@/components/research-lab/allocation-donut";
import { HoldingsWeightChart } from "@/components/research-lab/holdings-weight-chart";
import { CashInvestedBar } from "@/components/research-lab/cash-invested-bar";
import { FundamentalsChart, VerdictStrip } from "@/components/research-lab/fundamentals-chart";
import { DeltaComparisonChart } from "@/components/research-lab/delta-comparison-chart";
import {
  ProposalWorkflowDialog,
  type ProposalWorkflowOpen,
} from "@/components/research-lab/proposal-workflow-dialog";
import {
  ProposalActionBar,
  SessionProposalsList,
} from "@/components/research-lab/session-proposals-list";
import type { DataSourceKind } from "@/components/oems/primitives/data-source-badge";
import { cn } from "@/lib/cn";
import { formatZARExact } from "@/lib/format";
import { queryOpts } from "@/lib/store/query-provider";
import { projectHoldingsFromProposals, securitiesMapFromEquities } from "@/lib/research-lab/proposals";
import type {
  ResearchLabListItem,
  ResearchLabPayload,
  ResearchRole,
  SessionProposal,
} from "@/lib/research-lab/types";

const YIELD_BASKET_FALLBACK_ID = "640dcffb-dc23-4099-9772-0f72ed9688de";

function resolvePanelSource(payload: ResearchLabPayload | undefined): DataSourceKind {
  if (!payload || payload.source !== "retail-supabase") return "unavailable";
  if ((payload.iressOverlay ?? 0) > 0) return "hybrid";
  return "supabase";
}

export function ResearchLabPage() {
  const [role, setRole] = useState<ResearchRole>("strategist");
  const [strategyId, setStrategyId] = useState<string>(YIELD_BASKET_FALLBACK_ID);
  const [compareQ, setCompareQ] = useState("");
  const [extraTickers, setExtraTickers] = useState<string[]>([]);
  const [sessionProposals, setSessionProposals] = useState<Record<string, SessionProposal[]>>({});
  const [workflowOpen, setWorkflowOpen] = useState(false);
  const [workflowInitial, setWorkflowInitial] = useState<ProposalWorkflowOpen | null>(null);
  const [activeTab, setActiveTab] = useState<"before" | "proposed">("before");

  const listQ = useQuery<{ strategies: ResearchLabListItem[]; source: string }>({
    queryKey: ["bff-research-lab-list"],
    queryFn: async () => {
      const r = await fetch("/api/research-lab", { cache: "no-store" });
      if (!r.ok) throw new Error(`research-lab list ${r.status}`);
      return r.json();
    },
    ...queryOpts("reference"),
  });

  const labQ = useQuery<ResearchLabPayload>({
    queryKey: ["bff-research-lab", strategyId, extraTickers.join(",")],
    queryFn: async () => {
      const compare = extraTickers.length ? `?compare=${extraTickers.join(",")}` : "";
      const r = await fetch(`/api/research-lab/${encodeURIComponent(strategyId)}${compare}`, {
        cache: "no-store",
      });
      if (!r.ok) throw new Error(`research-lab ${r.status}`);
      return r.json();
    },
    enabled: Boolean(strategyId),
    refetchInterval: 60_000,
    ...queryOpts("reference"),
  });

  const equitiesQ = useQuery<{
    securities: Array<{
      symbol: string;
      name: string | null;
      sector: string | null;
      industry?: string | null;
      last_price: number | null;
      pe?: number | null;
      eps?: number | null;
      dividend_yield?: number | null;
      beta?: number | null;
      market_cap?: number | null;
      ytd_performance?: number | null;
      price_source?: "iress" | "yahoo";
    }>;
  }>({
    queryKey: ["equities-universe"],
    queryFn: async () => {
      const r = await fetch("/api/equities", { cache: "no-store" });
      if (!r.ok) throw new Error(`equities ${r.status}`);
      return r.json();
    },
    ...queryOpts("reference"),
  });

  const proposalsForStrategy = sessionProposals[strategyId] ?? [];
  const submittedProposals = proposalsForStrategy.filter((p) => p.status === "submitted");

  const openWorkflow = useCallback((initial: ProposalWorkflowOpen) => {
    setWorkflowInitial(initial);
    setWorkflowOpen(true);
  }, []);

  const handleProposalConfirm = useCallback(
    (proposal: SessionProposal) => {
      setSessionProposals((prev) => ({
        ...prev,
        [strategyId]: [...(prev[strategyId] ?? []), proposal],
      }));
      setActiveTab("proposed");
    },
    [strategyId],
  );

  const removeProposal = useCallback(
    (id: string) => {
      setSessionProposals((prev) => ({
        ...prev,
        [strategyId]: (prev[strategyId] ?? []).filter((p) => p.id !== id),
      }));
    },
    [strategyId],
  );

  const strategies = listQ.data?.strategies ?? [];
  const payload = labQ.data;
  const panelSource = resolvePanelSource(payload);

  const selectedName = strategies.find((s) => s.id === strategyId)?.name ?? payload?.strategy.name ?? "—";

  const compareCandidates = useMemo(() => {
    const q = compareQ.trim().toUpperCase();
    if (q.length < 1) return [];
    return (equitiesQ.data?.securities ?? [])
      .map((s) => ({
        ticker: s.symbol.replace(/\.JO$/i, ""),
        name: s.name ?? s.symbol,
      }))
      .filter(
        (s) =>
          s.ticker.includes(q) ||
          s.name.toUpperCase().includes(q),
      )
      .slice(0, 8);
  }, [compareQ, equitiesQ.data?.securities]);

  const matrixTickers = useMemo(() => {
    const base = payload?.tickers ?? [];
    return [...base, ...extraTickers.filter((t) => !base.includes(t))];
  }, [payload?.tickers, extraTickers]);

  const currentHoldings = payload?.current;
  const sessionProjected = useMemo(() => {
    if (!currentHoldings || proposalsForStrategy.length === 0) return null;
    const secMap = securitiesMapFromEquities(equitiesQ.data?.securities ?? []);
    return projectHoldingsFromProposals(
      currentHoldings.holdings,
      proposalsForStrategy,
      currentHoldings.totals.basketMin,
      secMap,
    );
  }, [currentHoldings, proposalsForStrategy, equitiesQ.data?.securities]);

  if (listQ.isLoading) {
    return (
      <div className="space-y-3">
        <PanelSkeleton rows={6} height="h-48" />
        <PanelSkeleton rows={8} />
      </div>
    );
  }

  if (listQ.isError || strategies.length === 0) {
    return (
      <div className="space-y-3">
        <header>
          <h1 className="text-lg font-semibold tracking-tight">Research Lab</h1>
          <p className="text-xs text-muted-foreground">Strategy research · composition · fundamentals</p>
        </header>
        <Panel title="Strategy catalogue" endpoint="strategies_c">
          <EmptyDataState
            message="No model portfolios available."
            hint="Configure RETAIL_SUPABASE_URL and ensure strategies_c is populated."
            badgeLabel="unconfigured"
          />
        </Panel>
      </div>
    );
  }

  const meta = payload?.strategy;
  const current = payload?.current;
  const dbProposed = payload?.proposed;

  const proposed =
    sessionProjected != null
      ? {
          holdings: sessionProjected.holdings,
          totals: sessionProjected.totals,
          sectors: sessionProjected.sectors,
        }
      : dbProposed;

  const hasProposedView = Boolean(proposed);

  return (
    <ResearchLabCanvas>
      {/* Hero */}
      <header className="glass-panel relative overflow-hidden p-6 md:p-8">
        <div className="pointer-events-none absolute -right-20 -top-20 h-56 w-56 rounded-full bg-primary/15 blur-3xl" />
        <div className="relative flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0 flex-1 space-y-4">
            <GlassBadge tone="primary">
              <FlaskConical className="h-3.5 w-3.5" />
              Strategy research hub
            </GlassBadge>
            <div className="flex flex-wrap items-center gap-3">
              <h1 className="text-display">{selectedName}</h1>
              <Select value={strategyId} onValueChange={setStrategyId}>
                <SelectTrigger className="glass-inset h-10 w-auto min-w-[200px] border-0 font-medium shadow-none">
                  <SelectValue placeholder="Switch strategy" />
                </SelectTrigger>
                <SelectContent className="glass-panel border-[hsl(var(--glass-border))] backdrop-blur-xl">
                  {strategies.map((s) => (
                    <SelectItem key={s.id} value={s.id} className="text-sm">
                      <span className="font-medium">{s.name}</span>
                      <span className="ml-2 font-mono text-xs text-muted-foreground">
                        {s.holdingsCount} · {formatZARExact(s.minInvestment)}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                variant="ghost"
                size="icon"
                className="glass-inset h-10 w-10 rounded-xl border-0"
                onClick={() => labQ.refetch()}
                aria-label="Refresh"
              >
                <RefreshCw className={cn("h-4 w-4", labQ.isFetching && "animate-spin")} />
              </Button>
            </div>
            <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">
              {meta?.description ??
                "Model portfolio research — composition, sector exposure, and fundamentals in one workspace."}
            </p>
          </div>
          <GlassBadge tone={panelSource === "unavailable" ? "neutral" : "success"}>
            <span className="h-1.5 w-1.5 rounded-full bg-current opacity-80" />
            {panelSource === "hybrid" ? "Live · Supabase + IRESS" : panelSource}
          </GlassBadge>
        </div>

        <div className="relative mt-6 flex flex-wrap items-center gap-3 border-t border-[hsl(var(--glass-border))] pt-5">
          <span className="glass-inset inline-flex items-center gap-2 px-3 py-2 text-sm">
            <UserCircle2 className="h-4 w-4 text-primary" />
            <span className="text-muted-foreground">Acting as</span>
            <span className="font-medium">{meta?.manager ?? "—"}</span>
          </span>
          <div className="ml-auto">
            <GlassSegment
              value={role}
              options={[
                { id: "strategist", label: "Strategist" },
                { id: "head", label: "Head of Investments" },
              ]}
              onChange={(id) => setRole(id as ResearchRole)}
            />
          </div>
        </div>

        {labQ.isLoading ? (
          <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-4">
            {Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className="h-20 animate-pulse rounded-2xl bg-[hsl(var(--foreground)/0.05)]" />
            ))}
          </div>
        ) : (
          <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <GlassKpi label="Benchmark" value={meta?.benchmark ?? "—"} />
            <GlassKpi label="Inception" value={meta?.inception ?? "—"} />
            <GlassKpi
              label="State"
              value={meta?.status ?? "—"}
              accent={meta?.investorCount ? "positive" : "default"}
            />
            <GlassKpi
              label="Basket minimum"
              value={current ? formatZARExact(current.totals.basketMin) : "—"}
              accent="primary"
            />
            <GlassKpi label="Constituents" value={String(current?.holdings.length ?? 0)} />
            <GlassKpi
              label="Constituent value"
              value={current ? formatZARExact(current.totals.constituent) : "—"}
            />
            <GlassKpi
              label="Cash reserve"
              value={current ? formatZARExact(current.totals.cash) : "—"}
              sub={current ? `${current.totals.cashPct.toFixed(1)}% of basket` : undefined}
            />
            <GlassKpi label="As of" value={meta?.asOf ?? "—"} />
          </div>
        )}
      </header>

      {labQ.isError && (
        <GlassSection title="Research data" dataSource="unavailable">
          <EmptyDataState
            message="Failed to load strategy research payload."
            hint={labQ.error instanceof Error ? labQ.error.message : "Retry refresh."}
            badgeLabel="unavailable"
          />
        </GlassSection>
      )}

      {!labQ.isLoading && payload?.source === "unavailable" && (
        <GlassSection title="Research data" dataSource="unavailable">
          <EmptyDataState
            message="Strategy research unavailable."
            hint={payload.reason ?? "Check retail Supabase configuration."}
            badgeLabel="unconfigured"
          />
        </GlassSection>
      )}

      {current && (
        <>
          <CashInvestedBar totals={current.totals} />

          <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as "before" | "proposed")} className="space-y-4">
            <TabsList className="glass-inset h-auto gap-1 p-1">
              <TabsTrigger
                value="before"
                className="rounded-lg px-4 py-2 text-sm font-medium data-[state=active]:bg-primary data-[state=active]:text-primary-foreground data-[state=active]:shadow-[0_2px_12px_hsl(var(--primary)/0.35)]"
              >
                Current composition
              </TabsTrigger>
              <TabsTrigger
                value="proposed"
                className="rounded-lg px-4 py-2 text-sm font-medium data-[state=active]:bg-primary data-[state=active]:text-primary-foreground disabled:opacity-40"
                disabled={!hasProposedView}
              >
                Proposed
                {hasProposedView && (
                  <span className="ml-2 rounded-full bg-warning/20 px-2 py-0.5 text-xs text-warning">
                    {proposalsForStrategy.length > 0
                      ? proposalsForStrategy.length
                      : proposed?.holdings.filter((h) => h.pending).length}
                  </span>
                )}
              </TabsTrigger>
            </TabsList>

            <TabsContent value="before" className="mt-0 space-y-4">
              <GlassSection
                title="Holdings"
                subtitle={`${meta?.asOf ?? "—"} · live marks`}
                endpoint="strategies_c + securities_c"
                dataSource={panelSource}
                noPadding
                right={
                  <div className="flex flex-wrap items-center gap-2">
                    <ProposalActionBar
                      onAdd={() => openWorkflow({ action: "add" })}
                      onRemove={() => openWorkflow({ action: "remove" })}
                      proposalCount={proposalsForStrategy.length}
                    />
                    <GlassBadge>{meta?.benchmark}</GlassBadge>
                    {payload?.iressOverlay ? (
                      <GlassBadge tone="success">{payload.iressOverlay} IRESS</GlassBadge>
                    ) : null}
                  </div>
                }
              >
                {current.holdings.length === 0 ? (
                  <EmptyDataState
                    message="No published holdings for this strategy."
                    hint="holdings JSON on strategies_c is empty."
                    badgeLabel="unconfigured"
                  />
                ) : (
                  <div className="grid grid-cols-1 gap-6 p-5 xl:grid-cols-12">
                    <div className="xl:col-span-7">
                      <HoldingsTable
                        rows={current.holdings}
                        constituentTotal={current.totals.constituent}
                        cash={current.totals.cash}
                        cashPct={current.totals.cashPct}
                        basketMin={current.totals.basketMin}
                      />
                    </div>
                    <div className="space-y-5 xl:col-span-5">
                      <div className="glass-inset p-4">
                        <AllocationDonut holdings={current.holdings} totals={current.totals} />
                      </div>
                      <div className="glass-inset p-4">
                        <HoldingsWeightChart holdings={current.holdings} />
                      </div>
                    </div>
                  </div>
                )}
              </GlassSection>

              <GlassSection title="Sector exposure" dataSource={panelSource}>
                {current.sectors.length > 0 ? (
                  <SectorExposureChart title="Current allocation" data={current.sectors} variant="both" />
                ) : (
                  <EmptyDataState message="No sector weights to display." badgeLabel="unconfigured" />
                )}
              </GlassSection>
            </TabsContent>

            <TabsContent value="proposed" className="mt-0 space-y-4">
              {proposed ? (
                <>
                  {proposalsForStrategy.length > 0 && (
                    <GlassSection
                      title="Session proposals"
                      subtitle="Strategist workflow · not yet persisted"
                      endpoint="research_workflow"
                      dataSource="code-gap"
                    >
                      <SessionProposalsList proposals={proposalsForStrategy} onRemove={removeProposal} />
                    </GlassSection>
                  )}
                  <GlassSection
                    title="Proposed holdings"
                    subtitle={
                      proposalsForStrategy.length > 0
                        ? "Projected from session proposals + live marks"
                        : "Pending flags from strategies_c"
                    }
                    endpoint={proposalsForStrategy.length > 0 ? "session" : "strategies_c"}
                    dataSource={proposalsForStrategy.length > 0 ? "code-gap" : panelSource}
                    noPadding
                  >
                    <div className="grid grid-cols-1 gap-6 p-5 xl:grid-cols-12">
                      <div className="xl:col-span-7">
                        <HoldingsTable
                          rows={proposed.holdings}
                          constituentTotal={proposed.totals.constituent}
                          cash={proposed.totals.cash}
                          cashPct={proposed.totals.cashPct}
                          basketMin={proposed.totals.basketMin}
                          showRating
                          cashLabel={`Cash reserve (${proposed.totals.cashPct.toFixed(1)}%)`}
                        />
                      </div>
                      <div className="space-y-5 xl:col-span-5">
                        <div className="glass-inset p-4">
                          <AllocationDonut
                            holdings={proposed.holdings}
                            totals={proposed.totals}
                            title="Proposed allocation"
                          />
                        </div>
                        <div className="glass-inset p-4">
                          <HoldingsWeightChart holdings={proposed.holdings} title="Proposed weights" />
                        </div>
                      </div>
                    </div>
                  </GlassSection>

                  <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                    <DeltaComparisonChart
                      label="Constituent value"
                      current={current.totals.constituent}
                      proposed={proposed.totals.constituent}
                    />
                    <DeltaComparisonChart
                      label="Basket minimum price"
                      current={current.totals.basketMin}
                      proposed={proposed.totals.basketMin}
                    />
                  </div>

                  <GlassSection title="Sector shift" dataSource={panelSource}>
                    <SectorCompareCharts before={current.sectors} after={proposed.sectors} />
                  </GlassSection>
                </>
              ) : (
                <GlassSection title="Proposed changes" dataSource="code-gap">
                  <div className="space-y-4">
                    <ProposalActionBar
                      onAdd={() => openWorkflow({ action: "add" })}
                      onRemove={() => openWorkflow({ action: "remove" })}
                      proposalCount={0}
                    />
                    <EmptyDataState
                      message="No pending changes on this strategy."
                      hint="Use Add stock or Remove stock to propose a change with investment thesis and impact preview."
                      badgeLabel="unconfigured"
                    />
                  </div>
                </GlassSection>
              )}
            </TabsContent>
          </Tabs>

          <GlassSection
            title="Compare candidates"
            subtitle="Search the JSE universe"
            endpoint="securities_c"
            dataSource="supabase"
          >
            <div className="space-y-4">
              <div className="relative max-w-lg">
                <Search className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
                <Input
                  placeholder="Ticker or company name…"
                  value={compareQ}
                  onChange={(e) => setCompareQ(e.target.value)}
                  className="glass-inset h-11 border-0 pl-10 text-sm shadow-none"
                />
              </div>
              {compareCandidates.length > 0 && (
                <ul className="glass-inset max-w-lg divide-y divide-[hsl(var(--glass-border))] overflow-hidden">
                  {compareCandidates.map((c) => (
                    <li key={c.ticker}>
                      <button
                        type="button"
                        className="flex w-full items-center justify-between px-4 py-3 text-left text-sm transition-colors hover:bg-[hsl(var(--primary)/0.06)]"
                        onClick={() => {
                          if (!extraTickers.includes(c.ticker) && !matrixTickers.includes(c.ticker)) {
                            setExtraTickers((prev) => [...prev, c.ticker]);
                          }
                          setCompareQ("");
                        }}
                      >
                        <span>
                          <span className="font-semibold text-primary">{c.ticker}</span>
                          <span className="ml-2 text-muted-foreground">{c.name}</span>
                        </span>
                        <ChevronDown className="h-3 w-3 rotate-[-90deg] text-muted-foreground" />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {extraTickers.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {extraTickers.map((t) => (
                    <GlassBadge key={t}>
                      <button
                        type="button"
                        className="flex items-center gap-1"
                        onClick={() => setExtraTickers((p) => p.filter((x) => x !== t))}
                      >
                        {t} ×
                      </button>
                    </GlassBadge>
                  ))}
                </div>
              )}
              <p className="text-caption">
                Comparison columns are session-only. Open any name in Security for full L1 + fundamentals.
              </p>
            </div>
          </GlassSection>

          <GlassSection
            title="Fundamentals"
            subtitle="Yahoo securities_c + model heuristics"
            endpoint="securities_c"
            dataSource={panelSource}
          >
            <div className="space-y-4">
              <VerdictStrip tickers={matrixTickers} metrics={payload?.fundamentals ?? []} />
              <FundamentalsChart tickers={matrixTickers} metrics={payload?.fundamentals ?? []} />
              <FundamentalsMatrix metrics={payload?.fundamentals ?? []} tickers={matrixTickers} />
            </div>
            {payload?.gaps.map((g) => (
              <p key={g} className="mt-4 text-caption leading-relaxed">
                {g}
              </p>
            ))}
            <div className="mt-4 flex flex-wrap gap-2">
              {matrixTickers.map((t) => (
                <Link
                  key={t}
                  href={`/oems/security?sym=${t}`}
                  className="glass-inset inline-flex items-center gap-1.5 px-3 py-1.5 font-mono text-xs text-primary transition-colors hover:border-[hsl(var(--glass-border-strong))]"
                >
                  {t} <ExternalLink className="h-3 w-3" />
                </Link>
              ))}
            </div>
          </GlassSection>

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <GlassSection
              title="Committee approvals"
              subtitle="Pending change requests"
              endpoint="research_workflow"
              dataSource="code-gap"
              right={
                <GlassBadge>
                  <Scale className="h-3 w-3" />
                  {submittedProposals.length} pending
                </GlassBadge>
              }
            >
              {submittedProposals.length > 0 ? (
                <div className="space-y-3">
                  {role === "head" ? (
                    <p className="text-xs text-muted-foreground">
                      Approve or decline once research_workflow BFF is connected. Session proposals shown
                      below.
                    </p>
                  ) : (
                    <p className="flex items-center gap-2 text-xs text-muted-foreground">
                      <ClipboardCheck className="h-4 w-4 text-primary" />
                      Submitted — awaiting Head of Investments review.
                    </p>
                  )}
                  <SessionProposalsList proposals={submittedProposals} onRemove={removeProposal} compact />
                </div>
              ) : role === "head" ? (
                <EmptyDataState
                  message="No pending requests."
                  hint="Committee workflow tables not yet connected — strategist proposals will route here."
                  badgeLabel="code-gap"
                />
              ) : (
                <div className="space-y-2">
                  <p className="flex items-center gap-2 text-xs text-muted-foreground">
                    <ClipboardCheck className="h-4 w-4 text-primary" />
                    Propose changes above; they appear here after submission.
                  </p>
                  <EmptyDataState
                    message="No pending requests."
                    hint="Submit an add/remove proposal to queue committee review."
                    badgeLabel="code-gap"
                  />
                </div>
              )}
            </GlassSection>

            <GlassSection
              title="Audit log"
              subtitle="Strategy activity"
              endpoint="research_audit"
              dataSource="code-gap"
              right={<History className="h-4 w-4 text-muted-foreground" />}
            >
              {submittedProposals.length > 0 ? (
                <ul className="space-y-2 text-sm">
                  {submittedProposals.map((p) => (
                    <li key={p.id} className="glass-inset flex flex-wrap gap-2 px-3 py-2">
                      <span className="font-mono text-xs text-muted-foreground">
                        {new Date(p.createdAt).toLocaleString("en-ZA", {
                          day: "2-digit",
                          month: "short",
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </span>
                      <span className="font-medium">
                        {p.action === "add" ? "Proposed add" : "Proposed remove"} {p.ticker}
                      </span>
                      <span className="text-caption">({p.shares} shares)</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <EmptyDataState
                  message="No activity yet."
                  hint="Submitted requests, approvals and declines will appear when the workflow BFF is live."
                  badgeLabel="code-gap"
                />
              )}
            </GlassSection>
          </div>
        </>
      )}

      {current && (
        <ProposalWorkflowDialog
          open={workflowOpen}
          onOpenChange={setWorkflowOpen}
          initial={workflowInitial}
          currentHoldings={current.holdings}
          basketMin={current.totals.basketMin}
          equities={equitiesQ.data?.securities ?? []}
          existingProposals={proposalsForStrategy}
          onConfirm={handleProposalConfirm}
        />
      )}

      <footer className="text-center text-caption">
        Live marks via IRESS where entitled · fundamentals from Yahoo securities_c · quantities from
        strategies_c
      </footer>
    </ResearchLabCanvas>
  );
}
