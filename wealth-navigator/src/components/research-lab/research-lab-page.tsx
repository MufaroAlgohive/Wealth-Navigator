"use client";

import { useState } from "react";
import {
  ArrowDownRight,
  Plus,
  UserCircle2,
  Scale,
  ClipboardCheck,
  History,
} from "lucide-react";

import { Panel } from "@/components/oems/primitives/panel";
import { Pill } from "@/components/oems/primitives/pill";
import { KpiTile } from "@/components/oems/primitives/kpi-tile";
import { EmptyDataState } from "@/components/oems/primitives/empty-data-state";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { HoldingsTable } from "@/components/research-lab/holdings-table";
import { FundamentalsMatrix } from "@/components/research-lab/fundamentals-matrix";
import { SectorExposureChart } from "@/components/research-lab/sector-exposure-chart";
import { cn } from "@/lib/cn";
import { formatZARExact, formatPctAbs } from "@/lib/format";
import {
  YIELD_BASKET_META,
  CURRENT_HOLDINGS,
  PROPOSED_HOLDINGS,
  FUNDAMENTAL_METRICS,
  SECTOR_BEFORE,
  SECTOR_AFTER,
  CURRENT_TOTALS,
  PROPOSED_TOTALS,
  RESEARCH_TICKERS,
  type ResearchRole,
} from "@/lib/research-lab/yield-basket";

function DeltaKpi({
  label,
  current,
  proposed,
}: {
  label: string;
  current: number;
  proposed: number;
}) {
  const delta = proposed - current;
  const pct = current !== 0 ? (delta / current) * 100 : 0;
  const negative = delta < 0;

  return (
    <div className="rounded-md border border-border bg-card p-3">
      <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{label}</p>
      <p className="mt-1 font-mono text-base font-semibold tabular-nums">{formatZARExact(proposed)}</p>
      <p className="mt-1 font-mono text-[10px] text-muted-foreground">from {formatZARExact(current)}</p>
      <p className={cn("mt-0.5 flex items-center gap-1 font-mono text-[10px]", negative ? "text-down" : "text-up")}>
        <ArrowDownRight className={cn("h-3 w-3", !negative && "rotate-180")} />
        {formatZARExact(Math.abs(delta))} ({negative ? "−" : "+"}
        {formatPctAbs(pct)})
      </p>
    </div>
  );
}

export function ResearchLabPage() {
  const [role, setRole] = useState<ResearchRole>("strategist");
  const meta = YIELD_BASKET_META;
  const cashPct = meta.cashTargetPct;

  return (
    <div className="space-y-3">
      {/* Hero */}
      <header className="space-y-3 rounded-lg border border-border bg-card/40 p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-primary">
              MINT OEMS · Strategy research hub
            </p>
            <h1 className="text-xl font-semibold tracking-tight">{meta.name}</h1>
            <p className="max-w-2xl text-sm text-muted-foreground">{meta.description}</p>
          </div>
          <Pill tone="primary" size="sm" dot>
            SEED · research prototype
          </Pill>
        </div>

        <div className="flex flex-wrap items-center gap-2 border-t border-border/60 pt-3">
          <span className="text-[10px] text-muted-foreground">Acting as</span>
          <span className="inline-flex items-center gap-1.5 rounded-md border border-border bg-muted/30 px-2 py-1 font-sans text-xs">
            <UserCircle2 className="h-3.5 w-3.5 text-primary" />
            {meta.strategist} · {meta.strategistTitle}
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

        <div className="grid grid-cols-2 gap-2 md:grid-cols-4 lg:grid-cols-8">
          <KpiTile label="Benchmark" value={meta.benchmark} />
          <KpiTile label="Inception" value={meta.inception} />
          <KpiTile label="State" value={meta.state} tone="positive" />
          <KpiTile label="Basket min. price" value={formatZARExact(CURRENT_TOTALS.basketMin)} />
          <KpiTile label="Constituents" value={CURRENT_HOLDINGS.length.toString()} />
          <KpiTile label="Constituent value" value={formatZARExact(CURRENT_TOTALS.constituent)} />
          <KpiTile
            label="Cash"
            value={formatZARExact(CURRENT_TOTALS.cash)}
            sub={`${cashPct.toFixed(2)}%`}
          />
          <KpiTile label="As of" value={meta.asOf} />
        </div>
      </header>

      {/* Composition tabs */}
      <Tabs defaultValue="before" className="space-y-3">
        <TabsList className="h-8 bg-muted/40">
          <TabsTrigger value="before" className="font-mono text-[10px] uppercase">
            Composition — Before
          </TabsTrigger>
          <TabsTrigger value="proposed" className="font-mono text-[10px] uppercase">
            Composition — Proposed
          </TabsTrigger>
        </TabsList>

        <TabsContent value="before" className="mt-0 space-y-3">
          <Panel
            title="Current holdings"
            subtitle={`As of ${meta.asOf}`}
            endpoint="research_lab · before"
            dataSource="seed"
            density="dense"
            right={<Pill tone="neutral" size="xs">Benchmark {meta.benchmark}</Pill>}
          >
            <HoldingsTable
              rows={CURRENT_HOLDINGS}
              constituentTotal={CURRENT_TOTALS.constituent}
              cash={CURRENT_TOTALS.cash}
              cashPct={cashPct}
              basketMin={CURRENT_TOTALS.basketMin}
            />
          </Panel>
        </TabsContent>

        <TabsContent value="proposed" className="mt-0 space-y-3">
          <Panel
            title="Rebalance & changes"
            subtitle="Every add, removal or share change opens an investment case"
            endpoint="research_lab · proposed"
            dataSource="seed"
            density="dense"
            right={
              <Button size="sm" variant="outline" className="h-7 gap-1 font-mono text-[10px]">
                <Plus className="h-3 w-3" />
                Propose addition
              </Button>
            }
          >
            <HoldingsTable
              rows={PROPOSED_HOLDINGS}
              constituentTotal={PROPOSED_TOTALS.constituent}
              cash={PROPOSED_TOTALS.cash}
              cashPct={cashPct}
              basketMin={PROPOSED_TOTALS.basketMin}
              showRating
              cashLabel={`Cash reserve (target ${cashPct.toFixed(1)}%)`}
            />
            <p className="border-t border-border/60 px-3.5 py-2 text-[10px] text-muted-foreground">
              Whole-share quantities only. Cash reserve scales to maintain {cashPct.toFixed(1)}% of the basket.
            </p>
          </Panel>

          <div className="grid grid-cols-1 gap-2.5 md:grid-cols-2">
            <DeltaKpi
              label="Constituent value"
              current={CURRENT_TOTALS.constituent}
              proposed={PROPOSED_TOTALS.constituent}
            />
            <DeltaKpi
              label="Basket minimum price"
              current={CURRENT_TOTALS.basketMin}
              proposed={PROPOSED_TOTALS.basketMin}
            />
          </div>

          <div className="grid grid-cols-1 gap-2.5 lg:grid-cols-2">
            <Panel title="Sector exposure — Before" dataSource="seed" density="comfortable">
              <SectorExposureChart title="Before rebalance" data={SECTOR_BEFORE} />
            </Panel>
            <Panel title="Sector exposure — After" dataSource="seed" density="comfortable">
              <SectorExposureChart title="After rebalance" data={SECTOR_AFTER} />
            </Panel>
          </div>
        </TabsContent>
      </Tabs>

      {/* Fundamentals */}
      <Panel
        title="Fundamental metrics & verdict"
        subtitle="Coverage"
        endpoint="research_lab · fundamentals"
        dataSource="seed"
        right={
          <div className="flex gap-1">
            <Pill tone="success" size="xs">Good</Pill>
            <Pill tone="warning" size="xs">Neutral</Pill>
            <Pill tone="destructive" size="xs">Concern</Pill>
          </div>
        }
      >
        <FundamentalsMatrix metrics={FUNDAMENTAL_METRICS} tickers={RESEARCH_TICKERS} />
      </Panel>

      {/* Committee + audit */}
      <div className="grid grid-cols-1 gap-2.5 lg:grid-cols-2">
        <Panel
          title="Investment committee · Approvals"
          subtitle="Pending change requests"
          endpoint="research_lab · approvals"
          dataSource="seed"
          right={
            <Pill tone="neutral" size="xs">
              <Scale className="mr-1 inline h-3 w-3" />0 pending
            </Pill>
          }
        >
          {role === "head" ? (
            <EmptyDataState
              message="No pending requests."
              hint="Strategist actions on the basket will route here for approval."
              badgeLabel="seed"
            />
          ) : (
            <div className="space-y-2">
              <p className="flex items-center gap-2 text-xs text-muted-foreground">
                <ClipboardCheck className="h-4 w-4 text-primary" />
                Switch role to Head of Investments to approve.
              </p>
              <EmptyDataState
                message="No pending requests."
                hint="Strategist actions on the basket will route here for approval."
                badgeLabel="seed"
              />
            </div>
          )}
        </Panel>

        <Panel
          title="Audit log"
          subtitle="Strategy activity"
          endpoint="research_lab · audit"
          dataSource="seed"
          right={<History className="h-3.5 w-3.5 text-muted-foreground" />}
        >
          <EmptyDataState
            message="No activity yet."
            hint="Submitted requests, approvals and declines will appear here."
            badgeLabel="seed"
          />
        </Panel>
      </div>

      <footer className="text-center text-[10px] text-muted-foreground">
        For institutional use only. Whole-share quantities; no fractional ownership. Strategy changes require
        committee approval.
      </footer>
    </div>
  );
}
