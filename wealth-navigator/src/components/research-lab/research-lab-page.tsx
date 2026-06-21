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
  NotebookPen,
  RefreshCw,
  Scale,
  Search,
  Send,
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
import { RemovableHoldingsTable } from "@/components/research-lab/removable-holdings-table";
import { FundamentalsMatrix } from "@/components/research-lab/fundamentals-matrix";
import { BasketSummaryBar } from "@/components/research-lab/basket-summary-bar";
import { BasketCompare } from "@/components/research-lab/basket-compare";
import { AiResearch } from "@/components/research-lab/ai-research";
import {
  ResearchWishlist,
  SecurityResearchDialog,
  hasResearch,
  type SecurityResearch,
} from "@/components/research-lab/security-research";
import { FundamentalsChart, VerdictStrip } from "@/components/research-lab/fundamentals-chart";
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
  const [activeTab, setActiveTab] = useState<"composition" | "fundamentals" | "ai">("composition");

  // Item 7 — per-security research, keyed by ticker. Session state only; a
  // desk-wide `security_research` table is the data phase.
  const [securityResearch, setSecurityResearch] = useState<Record<string, SecurityResearch>>({});
  const [researchOpen, setResearchOpen] = useState(false);
  const [researchTarget, setResearchTarget] = useState<{ ticker: string; name: string } | null>(null);

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
  const draftProposals = proposalsForStrategy.filter((p) => p.status === "draft");

  const researchedTickers = useMemo(
    () =>
      new Set(
        Object.values(securityResearch)
          .filter(hasResearch)
          .map((r) => r.ticker),
      ),
    [securityResearch],
  );
  const ratingFor = useCallback(
    (ticker: string) => securityResearch[ticker]?.rating ?? null,
    [securityResearch],
  );
  const researchList = useMemo(() => Object.values(securityResearch), [securityResearch]);

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
      setActiveTab("composition");
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

  // Item 3 — remove a single constituent (one-by-one). Creates a draft remove
  // proposal for the full position; the proposed basket recomputes live. Toggle
  // off if the same removal is already queued.
  const removeOneConstituent = useCallback(
    (row: { ticker: string; name: string; shares: number }) => {
      setSessionProposals((prev) => {
        const list = prev[strategyId] ?? [];
        const existingIdx = list.findIndex(
          (p) => p.action === "remove" && p.ticker === row.ticker,
        );
        if (existingIdx >= 0) {
          return { ...prev, [strategyId]: list.filter((_, i) => i !== existingIdx) };
        }
        const proposal: SessionProposal = {
          id: crypto.randomUUID(),
          action: "remove",
          ticker: row.ticker,
          name: row.name,
          shares: row.shares,
          thesis: "Removed from basket via composition editor.",
          saleTrigger: "Pending committee review.",
          status: "draft",
          createdAt: new Date().toISOString(),
        };
        return { ...prev, [strategyId]: [...list, proposal] };
      });
    },
    [strategyId],
  );

  // Item 3 (extended) — inline-edit the share count of an existing constituent
  // ("move this to 22 shares"). Encodes the new TOTAL as one delta proposal from
  // the published base, replacing any prior add/remove for that ticker so the
  // session list stays one-proposal-per-edit; the proposed basket recomputes live.
  const setConstituentShares = useCallback(
    (row: { ticker: string; name: string }, target: number) => {
      const baseShares = labQ.data?.current?.holdings.find((h) => h.ticker === row.ticker)?.shares ?? 0;
      const t = Math.max(0, Math.round(target));
      setSessionProposals((prev) => {
        const list = (prev[strategyId] ?? []).filter((p) => p.ticker !== row.ticker);
        if (t === baseShares) return { ...prev, [strategyId]: list };
        const delta = t - baseShares;
        const proposal: SessionProposal = {
          id: crypto.randomUUID(),
          action: delta > 0 ? "add" : "remove",
          ticker: row.ticker,
          name: row.name,
          shares: Math.abs(delta),
          thesis: `Adjusted to ${t} shares via composition editor.`,
          saleTrigger: delta < 0 ? "Trim pending committee review." : "Add pending committee review.",
          status: "draft",
          createdAt: new Date().toISOString(),
        };
        return { ...prev, [strategyId]: [...list, proposal] };
      });
    },
    [strategyId, labQ.data],
  );

  // Item 8 — promote every draft proposal to "submitted", routing the proposed
  // basket into the committee approval queue. Persistence ties into the
  // /compliance Approvals queue in the data phase.
  const submitForApproval = useCallback(() => {
    setSessionProposals((prev) => ({
      ...prev,
      [strategyId]: (prev[strategyId] ?? []).map((p) =>
        p.status === "draft" ? { ...p, status: "submitted" as const } : p,
      ),
    }));
  }, [strategyId]);

  // Item 7 — research dialog open / save.
  const openResearch = useCallback((ticker: string, name: string) => {
    setResearchTarget({ ticker, name });
    setResearchOpen(true);
  }, []);

  const saveResearch = useCallback((research: SecurityResearch) => {
    setSecurityResearch((prev) => ({ ...prev, [research.ticker]: research }));
  }, []);

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

  // The proposed side always renders so the side-by-side comparison is present
  // even before any edit — it simply mirrors the current basket until the
  // analyst adds/removes a constituent, at which point it recomputes live.
  const proposedSide = proposed ?? current ?? {
    holdings: [],
    totals: { constituent: 0, cash: 0, cashPct: 0, basketMin: 0 },
    sectors: [],
  };

  return (
    <ResearchLabCanvas>
      {/* Hero */}
      <header className="glass-panel relative overflow-hidden p-6 md:p-8">
        <div className="pointer-events-none absolute -right-20 -top-20 h-56 w-56 rounded-full bg-primary/15 blur-3xl" />
        <div className="relative flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0 flex-1 space-y-4">
            {/* Item 1 — brand label capitalised: "MINT" not "mint". */}
            <GlassBadge tone="primary">
              <FlaskConical className="h-3.5 w-3.5" />
              MINT Research Lab
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
        <GlassSection title="Research data" db="retail" dataSource="unavailable">
          <EmptyDataState
            message="Failed to load strategy research payload."
            hint={labQ.error instanceof Error ? labQ.error.message : "Retry refresh."}
            badgeLabel="unavailable"
          />
        </GlassSection>
      )}

      {!labQ.isLoading && payload?.source === "unavailable" && (
        <GlassSection title="Research data" db="retail" dataSource="unavailable">
          <EmptyDataState
            message="Strategy research unavailable."
            hint={payload.reason ?? "Check retail Supabase configuration."}
            badgeLabel="unconfigured"
          />
        </GlassSection>
      )}

      {current && (
        <>
          {/* Item 2 — sticky resulting-basket-weight summary. Reflects the
              proposed basket (live recompute) so the running totals stay
              visible while the holdings lists scroll. */}
          <BasketSummaryBar
            totals={proposedSide.totals}
            constituentCount={proposedSide.holdings.length}
            pendingCount={proposalsForStrategy.length}
          />

          <Tabs
            value={activeTab}
            onValueChange={(v) => setActiveTab(v as "composition" | "fundamentals" | "ai")}
            className="space-y-4"
          >
            <TabsList className="glass-inset h-auto gap-1 p-1">
              <TabsTrigger
                value="composition"
                className="rounded-lg px-4 py-2 text-sm font-medium data-[state=active]:bg-primary data-[state=active]:text-primary-foreground data-[state=active]:shadow-[0_2px_12px_hsl(var(--primary)/0.35)]"
              >
                Composition
              </TabsTrigger>
              {/* Item 6 — Fundamentals is its own tab so the user doesn't scroll
                  through everything; research candidates are divided from the
                  basket constituents by a line inside it. */}
              <TabsTrigger
                value="fundamentals"
                className="rounded-lg px-4 py-2 text-sm font-medium data-[state=active]:bg-primary data-[state=active]:text-primary-foreground"
              >
                Fundamentals
              </TabsTrigger>
              {/* AI Research — LLM-assisted outlook per security (GET /api/research-ai). */}
              <TabsTrigger
                value="ai"
                className="rounded-lg px-4 py-2 text-sm font-medium data-[state=active]:bg-primary data-[state=active]:text-primary-foreground"
              >
                AI Research
              </TabsTrigger>
            </TabsList>

            {/* ── Composition tab ───────────────────────────────────────── */}
            <TabsContent value="composition" className="mt-0 space-y-4">
              {current.holdings.length === 0 ? (
                <GlassSection title="Holdings" db="retail" dataSource={panelSource}>
                  <EmptyDataState
                    message="No published holdings for this strategy."
                    hint="holdings JSON on strategies_c is empty."
                    badgeLabel="unconfigured"
                  />
                </GlassSection>
              ) : (
                <GlassSection
                  title="Basket composition"
                  subtitle={`${meta?.asOf ?? "—"} · live marks · edit the proposed basket, then submit for approval`}
                  endpoint="GET /api/research-lab (strategies_c + securities_c)"
                  db="retail"
                  dataSource={panelSource}
                  right={
                    <div className="flex flex-wrap items-center gap-2">
                      {/* Items 3 + 8 — propose changes (add via wizard, remove
                          one-by-one inline) then route them for sign-off. */}
                      <ProposalActionBar
                        onAdd={() => openWorkflow({ action: "add" })}
                        onRemove={() => openWorkflow({ action: "remove" })}
                        proposalCount={proposalsForStrategy.length}
                      />
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        className="glass-inset gap-1.5 border-0"
                        disabled={draftProposals.length === 0}
                        onClick={submitForApproval}
                      >
                        <Send className="h-4 w-4" />
                        Submit for approval
                      </Button>
                      <GlassBadge>{meta?.benchmark}</GlassBadge>
                      {payload?.iressOverlay ? (
                        <GlassBadge tone="success">{payload.iressOverlay} IRESS</GlassBadge>
                      ) : null}
                    </div>
                  }
                >
                  {/* Item 4 — current vs proposed SIDE-BY-SIDE with live totals
                      and a chart (twin pies, item 5) under each. The proposed
                      table removes constituents one-by-one (item 3) and shows a
                      research tick + clickable thesis per name (item 7). */}
                  <BasketCompare
                    current={current}
                    proposed={proposedSide}
                    currentTable={
                      <HoldingsTable
                        rows={current.holdings}
                        constituentTotal={current.totals.constituent}
                        cash={current.totals.cash}
                        cashPct={current.totals.cashPct}
                        basketMin={current.totals.basketMin}
                      />
                    }
                    proposedTable={
                      <RemovableHoldingsTable
                        rows={proposedSide.holdings}
                        constituentTotal={proposedSide.totals.constituent}
                        cash={proposedSide.totals.cash}
                        cashPct={proposedSide.totals.cashPct}
                        basketMin={proposedSide.totals.basketMin}
                        researchedTickers={researchedTickers}
                        ratingFor={ratingFor}
                        onOpenResearch={openResearch}
                        onRemoveOne={removeOneConstituent}
                        onSetShares={setConstituentShares}
                        cashLabel={`Cash reserve (${proposedSide.totals.cashPct.toFixed(1)}%)`}
                      />
                    }
                  />
                </GlassSection>
              )}

              {/* Session proposals + Submit for approval (items 3, 8) */}
              {proposalsForStrategy.length > 0 && (
                <GlassSection
                  title="Session proposals"
                  subtitle="Strategist workflow · not yet persisted"
                  endpoint="research_workflow"
                  db="retail"
                  dataSource="code-gap"
                  right={
                    <Button
                      type="button"
                      size="sm"
                      className="gap-1.5 bg-primary text-primary-foreground shadow-[0_2px_12px_hsl(var(--primary)/0.35)] hover:bg-primary/90"
                      disabled={draftProposals.length === 0}
                      onClick={submitForApproval}
                    >
                      <Send className="h-4 w-4" />
                      Submit {draftProposals.length > 0 ? `${draftProposals.length} ` : ""}for approval
                    </Button>
                  }
                >
                  <div className="space-y-3">
                    <SessionProposalsList proposals={proposalsForStrategy} onRemove={removeProposal} />
                    <p className="text-caption">
                      Nothing takes effect until the Head of Investments signs off — submitting routes the
                      proposed basket into the committee approval queue below (wires into the /compliance
                      Approvals queue in the data phase).
                    </p>
                  </div>
                </GlassSection>
              )}

              {/* Committee approval workflow (item 8) + audit log */}
              <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <GlassSection
              title="Committee approvals"
              subtitle="Pending change requests"
              endpoint="research_workflow"
              db="retail"
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
              db="retail"
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
            </TabsContent>

            {/* ── Fundamentals tab (item 6) ─────────────────────────────── */}
            <TabsContent value="fundamentals" className="mt-0 space-y-4">
              {/* Per-security research shortlist / "wish list" (item 7) */}
              <GlassSection
                title="Research shortlist"
                subtitle="Notes + buy/sell rating per security — desk-wide wish list"
                endpoint="security_research"
                db="retail"
                dataSource="code-gap"
                right={
                  <GlassBadge>
                    <NotebookPen className="h-3 w-3" />
                    {researchedTickers.size} researched
                  </GlassBadge>
                }
              >
                <ResearchWishlist research={researchList} onOpen={openResearch} />
              </GlassSection>

              <GlassSection
                title="Fundamentals"
                subtitle="Basket constituents, then research candidates below the line"
                endpoint="GET /api/research-lab (securities_c)"
                db="retail"
                dataSource={panelSource}
              >
                <div className="space-y-4">
                  <VerdictStrip tickers={current.holdings.map((h) => h.ticker)} metrics={payload?.fundamentals ?? []} />
                  <FundamentalsChart
                    tickers={current.holdings.map((h) => h.ticker)}
                    metrics={payload?.fundamentals ?? []}
                  />
                  <FundamentalsMatrix
                    metrics={payload?.fundamentals ?? []}
                    tickers={current.holdings.map((h) => h.ticker)}
                  />
                </div>

                {/* Item 6 — divider between current basket constituents (above)
                    and research candidates pulled from the universe (below). */}
                <div className="my-6 flex items-center gap-3">
                  <span className="h-px flex-1 bg-[hsl(var(--glass-border-strong))]" />
                  <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                    Research candidates
                  </span>
                  <span className="h-px flex-1 bg-[hsl(var(--glass-border-strong))]" />
                </div>

                <div className="space-y-4">
                  <div className="relative max-w-lg">
                    <Search className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
                    <Input
                      placeholder="Search JSE universe — ticker or company name…"
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
                  {extraTickers.length > 0 ? (
                    <>
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
                      <VerdictStrip tickers={extraTickers} metrics={payload?.fundamentals ?? []} />
                      <FundamentalsMatrix metrics={payload?.fundamentals ?? []} tickers={extraTickers} />
                    </>
                  ) : (
                    <p className="text-caption">
                      Search a candidate to compare it against the basket — session-only. Each name can carry
                      its own research thesis + buy/sell rating from the shortlist above.
                    </p>
                  )}
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
            </TabsContent>

            {/* ── AI Research tab ───────────────────────────────────────── */}
            <TabsContent value="ai" className="mt-0 space-y-4">
              <AiResearch />
            </TabsContent>
          </Tabs>
        </>
      )}

      {/* Item 7 — per-security research dialog (notes + rating). */}
      <SecurityResearchDialog
        open={researchOpen}
        onOpenChange={setResearchOpen}
        ticker={researchTarget?.ticker ?? null}
        name={researchTarget?.name ?? ""}
        existing={researchTarget ? securityResearch[researchTarget.ticker] : undefined}
        onSave={saveResearch}
      />

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
