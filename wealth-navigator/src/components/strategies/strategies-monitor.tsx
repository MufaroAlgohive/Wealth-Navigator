"use client";

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useRouter, useSearchParams } from "next/navigation";
import { Layers, Lock, RefreshCw, ShieldCheck } from "lucide-react";

import { Pill } from "@/components/oems/primitives/pill";
import { PanelSkeleton } from "@/components/oems/primitives/panel-skeleton";
import { EmptyDataState } from "@/components/oems/primitives/empty-data-state";
import { GlassBadge, GlassKpi, GlassSection } from "@/components/oems/primitives/glass";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { isRealDataOnlyClient } from "@/lib/data-policy";
import { formatPct, formatZAR } from "@/lib/format";
import { cn } from "@/lib/cn";
import { queryOpts } from "@/lib/store/query-provider";

/**
 * Mandates monitor — the read-only "live book" view of strategies (AUM / YTD /
 * P&L / rebalance eligibility), backed by the `/api/strategies` BFF. Rendered as
 * the "Mandates" tab of the unified Strategies page. The "Builder" tab
 * (create/edit) lives in `strategy-builder.tsx`.
 *
 * Strategy view-model — the shape `/api/strategies` actually returns. This is
 * the BFF's normalised view-model (already in Rands / percent, with `id` +
 * `kind`), NOT the raw `oems_strategy_c` column shape. Keep in sync with
 * `mapRow` / `loadRetailStrategies` in the route.
 */
interface StrategyRow {
  id: string;
  name: string;
  status: "live" | "paper" | "halted";
  kind: "equity" | "money_market" | "balanced" | "fixed_income";
  manager: string | null;
  benchmark: string | null;
  aum: number; // Rands
  dayPnl: number; // Rands
  pnlMtd: number | null; // Rands — null when not computed (shows "—")
  ytd: number | null; // percent — null when no cost basis (shows "—")
  cashWeight: number | null; // percent — null when not computed (shows "—")
  nav: number; // Rands
  investorCount: number;
  holdingsCount: number;
  lastRebalanced: string; // "YYYY-MM-DD" or "—" (already formatted by the BFF)
  deployedAt: string | null;
}

interface StrategiesResponse {
  strategies: StrategyRow[];
  source: string;
  message?: string;
  // Audit #12 — the BFF returns the typed reason + migration hint
  // for the empty/unavailable case.
  reason?: import("@/lib/bff-reasons").BffUnavailableReason;
  migration?: string;
  error?: string;
}

/** Asset-class label, defensive against a missing/unknown `kind`. */
function kindLabel(kind: string | null | undefined): string {
  return (kind ?? "equity").replace("_", " ").toUpperCase();
}

function kindTone(kind: string | null | undefined): "primary" | "warning" | "neutral" {
  return kind === "equity" ? "primary" : kind === "money_market" ? "warning" : "neutral";
}

function StrategiesHero({
  strategies,
  source,
}: {
  strategies: StrategyRow[];
  source?: string;
}) {
  const stats = useMemo(() => {
    const live = strategies.filter((s) => s.status === "live").length;
    const totalAum = strategies.reduce((sum, s) => sum + s.aum, 0);
    const totalInvestors = strategies.reduce((sum, s) => sum + s.investorCount, 0);
    const dayPnl = strategies.reduce((sum, s) => sum + s.dayPnl, 0);
    return { live, totalAum, totalInvestors, dayPnl };
  }, [strategies]);

  return (
    <header className="glass-panel relative overflow-hidden p-6 md:p-8">
      <div className="pointer-events-none absolute -right-20 -top-20 h-56 w-56 rounded-full bg-primary/15 blur-3xl" />
      <div className="relative flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 flex-1 space-y-4">
          <GlassBadge tone="primary">
            <Layers className="h-3.5 w-3.5" />
            Strategy mandates
          </GlassBadge>
          <div>
            <h1 className="text-display">Mandates</h1>
            <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted-foreground">
              Live book · rebalance gated on linked investors · pre-trade mandate &amp; halt checks via IRESS
            </p>
          </div>
        </div>
        <GlassBadge tone={strategies.length > 0 ? "success" : "neutral"}>
          <span className="h-1.5 w-1.5 rounded-full bg-current opacity-80" />
          {source === "supabase" ? "Supabase" : strategies.length > 0 ? "Loaded" : "Awaiting data"}
        </GlassBadge>
      </div>

      {strategies.length > 0 && (
        <div className="relative mt-6 grid grid-cols-2 gap-3 border-t border-[hsl(var(--glass-border))] pt-5 sm:grid-cols-4">
          <GlassKpi label="Mandates" value={String(strategies.length)} accent="primary" />
          <GlassKpi
            label="Live"
            value={String(stats.live)}
            accent={stats.live > 0 ? "positive" : "default"}
          />
          <GlassKpi
            label="Total AUM"
            value={stats.totalAum > 0 ? formatZAR(stats.totalAum) : "—"}
          />
          <GlassKpi label="Investors" value={String(stats.totalInvestors)} />
          <GlassKpi
            label="Day P&L"
            value={stats.dayPnl !== 0 ? formatZAR(stats.dayPnl) : "—"}
            accent={stats.dayPnl > 0 ? "positive" : stats.dayPnl < 0 ? "negative" : "default"}
          />
        </div>
      )}
    </header>
  );
}

/** The "Mandates" tab body — was `/oems/strategies`. Must render inside a Suspense boundary (uses `useSearchParams`). */
export function StrategiesMonitor() {
  const realDataOnly = isRealDataOnlyClient();
  const strategiesQ = useQuery<StrategiesResponse>({
    queryKey: ["bff-strategies"],
    queryFn: async () => {
      const r = await fetch("/api/strategies", { cache: "no-store" });
      if (!r.ok) throw new Error(`Strategies BFF ${r.status}`);
      return r.json();
    },
    enabled: realDataOnly,
    refetchInterval: 60_000,
    ...queryOpts("reference"),
  });
  const strategies = strategiesQ.data?.strategies ?? [];
  const focusId = useSearchParams().get("focus");
  const [selected, setSelected] = useState<string>(
    (focusId && strategies.find((s) => s.id === focusId)?.id) || strategies[0]?.id || "",
  );
  const active = strategies.find((s) => s.id === selected) ?? strategies[0];

  if (!realDataOnly) {
    return (
      <div className="space-y-5 pb-8">
        <StrategiesHero strategies={[]} />
        <GlassSection title="Strategy mandates" db="retail" dataSource="supabase" endpoint="GET /api/strategies">
          <EmptyDataState
            message="Mock mode disables the strategies module."
            hint="Switch to real-data mode and ensure the data sync service has loaded portfolio data."
            badgeLabel="mock"
          />
        </GlassSection>
      </div>
    );
  }

  return (
    <div className="space-y-5 pb-8">
      <StrategiesHero strategies={strategies} source={strategiesQ.data?.source} />

      {strategiesQ.isLoading ? (
        <div className="grid grid-cols-12 gap-3">
          <div className="col-span-12 space-y-2 lg:col-span-5">
            {[0, 1, 2, 3, 4, 5].map((n) => (
              <div key={`strategies-row-${n}`} className="glass-panel p-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex-1 space-y-1.5">
                    <span className="shimmer block h-3 w-2/3 rounded" />
                    <span className="shimmer block h-2 w-1/2 rounded" />
                  </div>
                  <span className="shimmer h-4 w-16 rounded" />
                </div>
                <div className="mt-3 grid grid-cols-4 gap-2">
                  {[0, 1, 2, 3].map((m) => (
                    <div key={`strategies-cell-${m}`} className="space-y-1">
                      <span className="shimmer block h-2 w-3/4 rounded" />
                      <span className="shimmer block h-3 w-1/2 rounded" />
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
          <PanelSkeleton rows={6} className="col-span-12 lg:col-span-7" />
        </div>
      ) : strategies.length === 0 ? (
        <GlassSection
          title="Strategy mandates"
          db="retail"
          endpoint="GET /api/strategies"
          dataSource="supabase"
        >
          <EmptyDataState
            reason={strategiesQ.data?.reason ?? "supabase_query_failed"}
            migration={strategiesQ.data?.migration}
            errorDetail={(strategiesQ.data as { error?: string } | undefined)?.error}
            title="No strategies ingested yet"
            message="Strategy mandates require the Supabase portfolio system integration."
            hint={strategiesQ.data?.message}
          />
        </GlassSection>
      ) : (
        /* Lonwabo: list column scrolls; detail column is pinned (position:sticky in
           StrategyDetail). `items-start` lets the sticky child stick rather than
           stretch to the row height of the (taller) list column. */
        <div className="grid grid-cols-12 items-start gap-3">
          <div className="col-span-12 space-y-2 lg:col-span-5">
            {strategies.map((s) => (
              <StrategyCard key={s.id} s={s} active={selected === s.id} onSelect={() => setSelected(s.id)} />
            ))}
          </div>

          {active && <StrategyDetail strategy={active} />}
        </div>
      )}
    </div>
  );
}

function StrategyCard({ s, active, onSelect }: { s: StrategyRow; active: boolean; onSelect: () => void }) {
  const router = useRouter();
  const rebal = s.status === "live" && s.investorCount > 0;
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "glass-panel w-full p-3 text-left transition-all duration-300",
        active
          ? "border-primary/50 shadow-[inset_0_0_0_1px_hsl(var(--primary)/0.35)] ring-1 ring-primary/25"
          : "hover:border-[hsl(var(--glass-border-strong))]",
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold">{s.name}</p>
          <p className="text-caption">
            {s.manager ?? "—"} {s.benchmark ? `· bench ${s.benchmark}` : ""}
          </p>
        </div>
        <Pill tone={kindTone(s.kind)} size="xs">
          {kindLabel(s.kind)}
        </Pill>
      </div>
      <div className="mt-2.5 grid grid-cols-4 gap-2 text-[10.5px]">
        <Stat label="AUM" value={s.aum > 0 ? formatZAR(s.aum) : "—"} />
        <Stat label="YTD" value={s.ytd != null ? formatPct(s.ytd) : "—"} positive={s.ytd != null ? s.ytd >= 0 : undefined} />
        <Stat label="Day P&L" value={s.dayPnl !== 0 ? formatZAR(s.dayPnl) : "—"} positive={s.dayPnl >= 0} />
        <Stat label="Investors" value={s.investorCount.toString()} />
      </div>
      <div className="mt-2.5 flex items-center justify-between border-t border-[hsl(var(--glass-border))] pt-2">
        <Pill
          tone={s.status === "live" ? "success" : s.status === "paper" ? "neutral" : "destructive"}
          size="xs"
          dot
        >
          {s.status}
        </Pill>
        {rebal ? (
          <Button
            size="sm"
            variant="default"
            className="h-6 gap-1 px-2 text-[10px]"
            onClick={(e) => {
              e.stopPropagation();
              router.push(
                `/oems/rebalance?strategy=${encodeURIComponent(s.id)}&name=${encodeURIComponent(s.name)}`,
              );
            }}
          >
            <RefreshCw className="h-2.5 w-2.5" /> Rebalance
          </Button>
        ) : (
          <TooltipProvider delayDuration={150}>
            <Tooltip>
              <TooltipTrigger asChild>
                <button type="button" aria-label={`Rebalance locked — ${s.status === "halted" ? "halted" : "no investors"}`} className="cursor-help">
                  <Pill tone="destructive" size="xs" dot>
                    REBALANCE LOCKED — {s.status === "halted" ? "halted" : "no investors"}
                  </Pill>
                </button>
              </TooltipTrigger>
              <TooltipContent className="max-w-[260px]">
                {s.status === "halted"
                  ? "Strategy halted by Risk. Re-deploy after compliance sign-off."
                  : "No underlying investors linked. Rebalance is meaningless without subscribed capital."}
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        )}
      </div>
    </button>
  );
}

function Stat({ label, value, positive }: { label: string; value: string; positive?: boolean }) {
  return (
    <div>
      <p className="text-muted-foreground">{label}</p>
      <p
        className={cn(
          "font-mono font-semibold",
          positive === true && "text-up",
          positive === false && "text-down",
        )}
      >
        {value}
      </p>
    </div>
  );
}

function StrategyDetail({ strategy }: { strategy: StrategyRow }) {
  const rebal = strategy.status === "live" && strategy.investorCount > 0;
  return (
    /* Sticky on lg+ so the detail panel stays in view while the strategy list
       column scrolls (Lonwabo). top-4 clears the page padding; on mobile the
       columns stack so sticky is disabled to avoid an awkward pin. */
    <div className="col-span-12 space-y-3 self-start lg:sticky lg:top-4 lg:col-span-7">
      <GlassSection
        title={`${strategy.name} · detail`}
        db="retail"
        endpoint="GET /api/strategies"
        dataSource="supabase"
        right={
          <Pill tone={kindTone(strategy.kind)} size="xs">
            {kindLabel(strategy.kind)}
          </Pill>
        }
      >
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <GlassKpi label="AUM" value={strategy.aum > 0 ? formatZAR(strategy.aum) : "—"} accent="primary" />
          <GlassKpi
            label="YTD"
            value={strategy.ytd != null ? formatPct(strategy.ytd) : "—"}
            accent={strategy.ytd != null ? (strategy.ytd >= 0 ? "positive" : "negative") : "default"}
          />
          <GlassKpi
            label="MTD P&L"
            value={strategy.pnlMtd != null ? formatZAR(strategy.pnlMtd) : "—"}
            accent={strategy.pnlMtd != null ? (strategy.pnlMtd >= 0 ? "positive" : "negative") : "default"}
          />
          <GlassKpi label="NAV" value={strategy.nav > 0 ? formatZAR(strategy.nav) : "—"} />
          <GlassKpi label="Cash" value={strategy.cashWeight != null ? `${strategy.cashWeight.toFixed(1)}%` : "—"} />
          <GlassKpi label="Holdings" value={strategy.holdingsCount.toString()} />
          <GlassKpi label="Investors" value={strategy.investorCount.toString()} />
          <GlassKpi label="Last rebal" value={strategy.lastRebalanced || "—"} />
        </div>
        {!rebal && (
          <div className="glass-inset mt-4 flex items-center gap-2 p-2.5 text-[11.5px] text-warning">
            <Lock className="h-3.5 w-3.5 shrink-0" />
            <span>
              Rebalance disabled —{" "}
              {strategy.status === "halted"
                ? "strategy halted by Risk"
                : strategy.investorCount === 0
                  ? "no underlying investors linked"
                  : "strategy not yet deployed"}
              .
            </span>
          </div>
        )}
        {rebal && (
          <div className="glass-inset mt-4 flex items-center gap-2 p-2.5 text-[11.5px] text-success">
            <ShieldCheck className="h-3.5 w-3.5 shrink-0" />
            <span>
              Rebalance-eligible — live with {strategy.investorCount} investors · {strategy.holdingsCount} holdings.
              Pre-trade mandate &amp; {strategy.kind === "money_market" ? "issuer-concentration" : "halt/suspension"} checks
              run against IRESS at rebalance time.
            </span>
          </div>
        )}
      </GlassSection>

      <GlassSection
        title="Holdings · target vs actual"
        db="retail"
        endpoint="GET /api/strategies"
        dataSource="supabase"
        className="h-[420px]"
        right={<span className="font-mono text-[10px]">{strategy.holdingsCount} positions</span>}
      >
        <EmptyDataState
          message="Per-investor holdings not yet published for this strategy."
          hint="This data will be available after the data sync service processes position and transaction records."
        />
      </GlassSection>
    </div>
  );
}
