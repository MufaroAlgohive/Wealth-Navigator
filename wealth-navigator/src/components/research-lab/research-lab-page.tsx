"use client";

import { useMemo, useState } from "react";
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
import { Pill } from "@/components/oems/primitives/pill";
import { KpiTile } from "@/components/oems/primitives/kpi-tile";
import { EmptyDataState } from "@/components/oems/primitives/empty-data-state";
import { PanelSkeleton } from "@/components/oems/primitives/panel-skeleton";
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
import type { DataSourceKind } from "@/components/oems/primitives/data-source-badge";
import { cn } from "@/lib/cn";
import { formatZARExact } from "@/lib/format";
import { queryOpts } from "@/lib/store/query-provider";
import type {
  ResearchLabListItem,
  ResearchLabPayload,
  ResearchRole,
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

  const equitiesQ = useQuery<{ securities: Array<{ symbol: string; name: string | null }> }>({
    queryKey: ["equities-universe"],
    queryFn: async () => {
      const r = await fetch("/api/equities", { cache: "no-store" });
      if (!r.ok) throw new Error(`equities ${r.status}`);
      return r.json();
    },
    ...queryOpts("reference"),
  });

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
  const proposed = payload?.proposed;

  return (
    <div className="space-y-3">
      {/* Hero */}
      <header className="space-y-3 rounded-lg border border-border bg-card/40 p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex-1 space-y-2">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-primary">
              MINT OEMS · Strategy research hub
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <FlaskConical className="h-5 w-5 text-primary" />
              <Select value={strategyId} onValueChange={setStrategyId}>
                <SelectTrigger className="h-9 w-[min(100%,280px)] border-border bg-background font-semibold">
                  <SelectValue placeholder="Select strategy">{selectedName}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {strategies.map((s) => (
                    <SelectItem key={s.id} value={s.id} className="font-sans text-sm">
                      <span className="font-medium">{s.name}</span>
                      <span className="ml-2 font-mono text-[10px] text-muted-foreground">
                        {s.holdingsCount} names · {formatZARExact(s.minInvestment)} min
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8"
                onClick={() => labQ.refetch()}
                aria-label="Refresh"
              >
                <RefreshCw className={cn("h-3.5 w-3.5", labQ.isFetching && "animate-spin")} />
              </Button>
            </div>
            {meta?.description && (
              <p className="max-w-2xl text-sm text-muted-foreground">{meta.description}</p>
            )}
          </div>
          <Pill tone={panelSource === "unavailable" ? "warning" : "primary"} size="sm" dot>
            {panelSource === "hybrid" ? "SUPABASE + IRESS" : panelSource.toUpperCase()}
          </Pill>
        </div>

        <div className="flex flex-wrap items-center gap-2 border-t border-border/60 pt-3">
          <span className="text-[10px] text-muted-foreground">Acting as</span>
          <span className="inline-flex items-center gap-1.5 rounded-md border border-border bg-muted/30 px-2 py-1 font-sans text-xs">
            <UserCircle2 className="h-3.5 w-3.5 text-primary" />
            {meta?.manager ?? "—"} · Portfolio Strategist
          </span>
          <div className="ml-auto flex rounded-md border border-border p-0.5">
            {(
              [
                { id: "strategist" as const, label: "Strategist" },
                { id: "head" as const, label: "Head of Investments" },
              ] as const
            ).map((r) => (
              <button
                key={r.id}
                type="button"
                onClick={() => setRole(r.id)}
                className={cn(
                  "rounded px-2.5 py-1 font-mono text-[10px] uppercase tracking-wider transition-colors",
                  role === r.id
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {r.label}
              </button>
            ))}
          </div>
        </div>

        {labQ.isLoading ? (
          <div className="grid grid-cols-2 gap-2 md:grid-cols-4 lg:grid-cols-8">
            {Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className="h-16 animate-pulse rounded-md bg-muted/40" />
            ))}
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-2 md:grid-cols-4 lg:grid-cols-8">
            <KpiTile label="Benchmark" value={meta?.benchmark ?? "—"} />
            <KpiTile label="Inception" value={meta?.inception ?? "—"} />
            <KpiTile
              label="State"
              value={meta?.status ?? "—"}
              tone={meta?.investorCount ? "positive" : "default"}
            />
            <KpiTile
              label="Basket min. price"
              value={current ? formatZARExact(current.totals.basketMin) : "—"}
            />
            <KpiTile label="Constituents" value={String(current?.holdings.length ?? 0)} />
            <KpiTile
              label="Constituent value"
              value={current ? formatZARExact(current.totals.constituent) : "—"}
            />
            <KpiTile
              label="Cash"
              value={current ? formatZARExact(current.totals.cash) : "—"}
              sub={current ? `${current.totals.cashPct.toFixed(2)}%` : undefined}
            />
            <KpiTile label="As of" value={meta?.asOf ?? "—"} />
          </div>
        )}
      </header>

      {labQ.isError && (
        <Panel title="Research data" dataSource="unavailable">
          <EmptyDataState
            message="Failed to load strategy research payload."
            hint={labQ.error instanceof Error ? labQ.error.message : "Retry refresh."}
            badgeLabel="unavailable"
          />
        </Panel>
      )}

      {!labQ.isLoading && payload?.source === "unavailable" && (
        <Panel title="Research data" dataSource="unavailable">
          <EmptyDataState
            message="Strategy research unavailable."
            hint={payload.reason ?? "Check retail Supabase configuration."}
            badgeLabel="unconfigured"
          />
        </Panel>
      )}

      {current && (
        <>
          <CashInvestedBar totals={current.totals} />

          <Tabs defaultValue="before" className="space-y-3">
            <TabsList className="h-8 bg-muted/40">
              <TabsTrigger value="before" className="font-mono text-[10px] uppercase">
                Composition — Current
              </TabsTrigger>
              <TabsTrigger
                value="proposed"
                className="font-mono text-[10px] uppercase"
                disabled={!proposed}
              >
                Composition — Proposed
                {proposed && (
                  <span className="ml-1.5 rounded bg-primary/20 px-1 font-mono text-[9px] text-primary">
                    {proposed.holdings.filter((h) => h.pending).length} pending
                  </span>
                )}
              </TabsTrigger>
            </TabsList>

            <TabsContent value="before" className="mt-0 space-y-3">
              <Panel
                title="Current holdings"
                subtitle={`As of ${meta?.asOf ?? "—"} · live marks`}
                endpoint="strategies_c + securities_c"
                dataSource={panelSource}
                density="dense"
                right={
                  <div className="flex items-center gap-2">
                    <Pill tone="neutral" size="xs">Benchmark {meta?.benchmark}</Pill>
                    {payload?.iressOverlay ? (
                      <Pill tone="success" size="xs">{payload.iressOverlay} IRESS marks</Pill>
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
                  <div className="grid grid-cols-1 gap-4 xl:grid-cols-12">
                    <div className="xl:col-span-7">
                      <HoldingsTable
                        rows={current.holdings}
                        constituentTotal={current.totals.constituent}
                        cash={current.totals.cash}
                        cashPct={current.totals.cashPct}
                        basketMin={current.totals.basketMin}
                      />
                    </div>
                    <div className="space-y-4 border-t border-border/60 pt-4 xl:col-span-5 xl:border-l xl:border-t-0 xl:pl-4 xl:pt-0">
                      <AllocationDonut holdings={current.holdings} totals={current.totals} />
                      <HoldingsWeightChart holdings={current.holdings} />
                    </div>
                  </div>
                )}
              </Panel>

              <Panel title="Sector exposure" dataSource={panelSource} density="comfortable">
                {current.sectors.length > 0 ? (
                  <SectorExposureChart title="Current allocation" data={current.sectors} variant="both" />
                ) : (
                  <EmptyDataState message="No sector weights to display." badgeLabel="unconfigured" />
                )}
              </Panel>
            </TabsContent>

            <TabsContent value="proposed" className="mt-0 space-y-3">
              {proposed ? (
                <>
                  <Panel
                    title="Proposed composition"
                    subtitle="Includes pending catalogue flags from strategies_c"
                    endpoint="strategies_c · pending"
                    dataSource={panelSource}
                    density="dense"
                  >
                    <div className="grid grid-cols-1 gap-4 xl:grid-cols-12">
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
                      <div className="space-y-4 border-t border-border/60 pt-4 xl:col-span-5 xl:border-l xl:border-t-0 xl:pl-4 xl:pt-0">
                        <AllocationDonut
                          holdings={proposed.holdings}
                          totals={proposed.totals}
                          title="Proposed allocation"
                        />
                        <HoldingsWeightChart holdings={proposed.holdings} title="Proposed weights" />
                      </div>
                    </div>
                  </Panel>

                  <div className="grid grid-cols-1 gap-2.5 md:grid-cols-2">
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

                  <Panel title="Sector shift" dataSource={panelSource} density="comfortable">
                    <SectorCompareCharts before={current.sectors} after={proposed.sectors} />
                  </Panel>
                </>
              ) : (
                <Panel title="Proposed changes" dataSource="code-gap">
                  <EmptyDataState
                    message="No pending changes on this strategy."
                    hint="Mark a holding with pending: true in strategies_c, or use Compare below to research candidates."
                    badgeLabel="unconfigured"
                  />
                </Panel>
              )}
            </TabsContent>
          </Tabs>

          {/* Compare / research */}
          <Panel
            title="Compare candidates"
            subtitle="Add names from the JSE universe"
            endpoint="securities_c"
            dataSource="supabase"
          >
            <div className="space-y-3">
              <div className="relative max-w-md">
                <Search className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
                <Input
                  placeholder="Search ticker or company…"
                  value={compareQ}
                  onChange={(e) => setCompareQ(e.target.value)}
                  className="h-8 pl-8 font-mono text-xs"
                />
              </div>
              {compareCandidates.length > 0 && (
                <ul className="max-w-md divide-y divide-border rounded-md border border-border">
                  {compareCandidates.map((c) => (
                    <li key={c.ticker}>
                      <button
                        type="button"
                        className="flex w-full items-center justify-between px-3 py-2 text-left text-xs hover:bg-muted/40"
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
                    <Pill key={t} tone="info" size="xs" className="cursor-pointer" onClick={() => setExtraTickers((p) => p.filter((x) => x !== t))}>
                      {t} ×
                    </Pill>
                  ))}
                </div>
              )}
              <p className="text-[10px] text-muted-foreground">
                Comparison columns are session-only. Open any constituent in Security for full L1 + Yahoo stats.
              </p>
            </div>
          </Panel>

          {/* Fundamentals */}
          <Panel
            title="Fundamental metrics"
            subtitle="Yahoo (securities_c) + model heuristics"
            endpoint="securities_c"
            dataSource={panelSource}
            right={
              <div className="flex gap-1">
                <Pill tone="success" size="xs">Good</Pill>
                <Pill tone="warning" size="xs">Neutral</Pill>
                <Pill tone="destructive" size="xs">Concern</Pill>
              </div>
            }
          >
            <div className="space-y-4">
              <VerdictStrip tickers={matrixTickers} metrics={payload?.fundamentals ?? []} />
              <FundamentalsChart tickers={matrixTickers} metrics={payload?.fundamentals ?? []} />
              <FundamentalsMatrix metrics={payload?.fundamentals ?? []} tickers={matrixTickers} />
            </div>
            {payload?.gaps.map((g) => (
              <p key={g} className="mt-2 text-[10px] leading-relaxed text-muted-foreground">
                {g}
              </p>
            ))}
            <div className="mt-2 flex flex-wrap gap-2">
              {matrixTickers.map((t) => (
                <Link
                  key={t}
                  href={`/oems/security?sym=${t}`}
                  className="inline-flex items-center gap-1 font-mono text-[10px] text-primary hover:underline"
                >
                  {t} <ExternalLink className="h-3 w-3" />
                </Link>
              ))}
            </div>
          </Panel>

          {/* Committee + audit */}
          <div className="grid grid-cols-1 gap-2.5 lg:grid-cols-2">
            <Panel
              title="Investment committee · Approvals"
              subtitle="Pending change requests"
              endpoint="research_workflow"
              dataSource="code-gap"
              right={
                <Pill tone="neutral" size="xs">
                  <Scale className="mr-1 inline h-3 w-3" />0 pending
                </Pill>
              }
            >
              {role === "head" ? (
                <EmptyDataState
                  message="No pending requests."
                  hint="Committee workflow tables not yet connected — strategist proposals will route here."
                  badgeLabel="code-gap"
                />
              ) : (
                <div className="space-y-2">
                  <p className="flex items-center gap-2 text-xs text-muted-foreground">
                    <ClipboardCheck className="h-4 w-4 text-primary" />
                    Switch role to Head of Investments to approve.
                  </p>
                  <EmptyDataState
                    message="No pending requests."
                    hint="Committee workflow not yet wired to Supabase."
                    badgeLabel="code-gap"
                  />
                </div>
              )}
            </Panel>

            <Panel
              title="Audit log"
              subtitle="Strategy activity"
              endpoint="research_audit"
              dataSource="code-gap"
              right={<History className="h-3.5 w-3.5 text-muted-foreground" />}
            >
              <EmptyDataState
                message="No activity yet."
                hint="Submitted requests, approvals and declines will appear when the workflow BFF is live."
                badgeLabel="code-gap"
              />
            </Panel>
          </div>
        </>
      )}

      <footer className="text-center text-[10px] text-muted-foreground">
        Prices: IRESS overlay where entitled, else Yahoo securities_c. Whole-share quantities from strategies_c.
        Extended fundamentals and committee workflow require vendor / schema work.
      </footer>
    </div>
  );
}
