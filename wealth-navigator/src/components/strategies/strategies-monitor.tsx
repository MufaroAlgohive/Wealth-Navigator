"use client";

import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useSearchParams } from "next/navigation";
import { ArrowDownRight, ArrowUpRight, Lock, Minus, ShieldCheck } from "lucide-react";

import { Pill } from "@/components/oems/primitives/pill";
import { PanelSkeleton } from "@/components/oems/primitives/panel-skeleton";
import { EmptyDataState } from "@/components/oems/primitives/empty-data-state";
import { GlassSection } from "@/components/oems/primitives/glass";
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
  holdingsPreview: Array<{ symbol: string; logoUrl: string | null }>;
  lastRebalanced: string; // "YYYY-MM-DD" or "—" (already formatted by the BFF)
  deployedAt: string | null;
}

interface StrategiesResponse {
  strategies: StrategyRow[];
  market?: Array<{ symbol: string; price: number | null; changePct: number | null }>;
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

function StrategiesHero({ strategies }: { strategies: StrategyRow[] }) {
  const stats = useMemo(() => {
    const live = strategies.filter((s) => s.status === "live").length;
    const totalAum = strategies.reduce((sum, s) => sum + s.aum, 0);
    const totalInvestors = strategies.reduce((sum, s) => sum + s.investorCount, 0);
    const dayPnl = strategies.reduce((sum, s) => sum + s.dayPnl, 0);
    return { live, totalAum, totalInvestors, dayPnl };
  }, [strategies]);

  return (
    <header className="glass-panel relative overflow-hidden px-3 py-3 sm:px-4">
      {strategies.length > 0 && (
        <div className="grid grid-cols-5 divide-x divide-border/60 rounded-xl border border-border/70 bg-background/35">
          <SlimStat label="Mandates" value={String(strategies.length)} tone="primary" />
          <SlimStat label="Live" value={String(stats.live)} tone={stats.live > 0 ? "positive" : "default"} />
          <SlimStat label="Total AUM" value={stats.totalAum > 0 ? formatZAR(stats.totalAum) : "—"} />
          <SlimStat label="Investors" value={String(stats.totalInvestors)} />
          <SlimStat label="Day P&L" value={stats.dayPnl !== 0 ? formatZAR(stats.dayPnl) : "—"} tone={stats.dayPnl > 0 ? "positive" : stats.dayPnl < 0 ? "negative" : "default"} />
        </div>
      )}
    </header>
  );
}

function SlimStat({ label, value, tone = "default" }: { label: string; value: string; tone?: "default" | "primary" | "positive" | "negative" }) {
  return <div className="flex min-w-0 flex-col items-center justify-center px-1 py-2 text-center sm:px-3"><span className="text-[8px] font-bold uppercase tracking-[.12em] text-muted-foreground sm:text-[9px]">{label}</span><span className={cn("mt-0.5 truncate font-mono text-xs font-bold sm:text-sm", tone === "positive" ? "text-success" : tone === "negative" ? "text-destructive" : tone === "primary" ? "text-primary" : "text-foreground")}>{value}</span></div>;
}

function MarketTicker({ items }: { items: Array<{ symbol: string; price: number | null; changePct: number | null }> }) {
  if (!items.length) return <div className="flex h-10 items-center justify-center border-y border-border/60 bg-background/35 text-[10px] text-muted-foreground">Live market prices unavailable</div>;
  const display = [...items, ...items];
  return <div className="overflow-hidden border-y border-border/60 bg-background/35"><div className="strategy-market-ticker flex w-max items-center whitespace-nowrap" style={{ animationDuration: `${Math.max(24, items.length * 3)}s` }}>{display.map((item, index) => { const up=(item.changePct??0)>0, down=(item.changePct??0)<0; const Icon=up?ArrowUpRight:down?ArrowDownRight:Minus; return <div key={`${item.symbol}-${index}`} className="flex h-10 items-center gap-2 border-r border-border/60 px-5"><span className="font-mono text-[10px] font-bold tracking-wide text-foreground">{item.symbol}</span><span className="font-mono text-[10px] text-muted-foreground">{item.price == null ? "—" : formatZAR(item.price)}</span><span className={cn("inline-flex items-center gap-0.5 font-mono text-[10px] font-semibold",up?"text-success":down?"text-destructive":"text-muted-foreground")}><Icon className="h-3 w-3"/>{item.changePct == null ? "—" : `${item.changePct >= 0 ? "+" : ""}${item.changePct.toFixed(2)}%`}</span></div>})}</div></div>;
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
  useEffect(() => {
    if (focusId && strategies.some((strategy) => strategy.id === focusId)) setSelected(focusId);
  }, [focusId, strategies]);
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
      <div className="-mx-4 -mt-4 sm:-mx-6 sm:-mt-6"><MarketTicker items={strategiesQ.data?.market ?? []} /></div>
      <StrategiesHero strategies={strategies} />

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
        <HoldingLogoStack holdings={s.holdingsPreview ?? []} />
      </div>
    </button>
  );
}

function HoldingLogoStack({ holdings }: { holdings: Array<{ symbol: string; logoUrl: string | null }> }) {
  const visible = holdings.slice(0, 3);
  const remainder = Math.max(0, holdings.length - visible.length);
  return <div className="flex items-center -space-x-1.5" aria-label={`${holdings.length} strategy holdings`}>{visible.map((holding) => <div key={holding.symbol} title={holding.symbol} className="flex h-6 w-6 items-center justify-center overflow-hidden rounded-full border-2 border-card bg-primary/10 text-[7px] font-bold text-primary">{holding.logoUrl ? <img src={holding.logoUrl} alt={holding.symbol} className="h-full w-full object-cover" /> : holding.symbol.slice(0, 2)}</div>)}{remainder > 0 && <div className="flex h-6 min-w-6 items-center justify-center rounded-full border-2 border-card bg-muted px-1 text-[8px] font-bold text-muted-foreground">+{remainder}</div>}</div>;
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
      <section className="glass-panel p-3">
        <div className="mb-2.5 flex items-center gap-2">
          <h2 className="min-w-0 flex-1 truncate text-sm font-semibold text-foreground">{strategy.name} · detail</h2>
          <TooltipProvider delayDuration={120}><Tooltip><TooltipTrigger asChild><span className={cn("inline-flex cursor-help items-center gap-1 rounded-full px-2 py-1 text-[9px] font-bold uppercase tracking-wide", rebal ? "bg-success/15 text-success" : "bg-warning/15 text-warning")}>{rebal ? <ShieldCheck className="h-3 w-3"/> : <Lock className="h-3 w-3"/>}{rebal ? "Eligible" : "Locked"}</span></TooltipTrigger><TooltipContent className="max-w-64 text-xs">{rebal ? `Eligible for rebalance: ${strategy.investorCount} investors and ${strategy.holdingsCount} holdings. Mandate and market-status checks run at execution.` : strategy.status === "halted" ? "Rebalance locked because Risk halted this strategy." : strategy.investorCount === 0 ? "Rebalance locked because no investors are linked." : "Rebalance locked until the strategy is live."}</TooltipContent></Tooltip></TooltipProvider>
          <Pill tone={kindTone(strategy.kind)} size="xs">{kindLabel(strategy.kind)}</Pill>
        </div>
        <div className="grid grid-cols-4 divide-x divide-y divide-border/50 overflow-hidden rounded-lg border border-border/60 bg-background/25 xl:grid-cols-8 xl:divide-y-0">
          <DetailStat label="AUM" value={strategy.aum > 0 ? formatZAR(strategy.aum) : "—"} tone="primary" />
          <DetailStat label="YTD" value={strategy.ytd != null ? formatPct(strategy.ytd) : "—"} tone={strategy.ytd == null ? "default" : strategy.ytd >= 0 ? "positive" : "negative"} />
          <DetailStat label="MTD P&L" value={strategy.pnlMtd != null ? formatZAR(strategy.pnlMtd) : "—"} tone={strategy.pnlMtd == null ? "default" : strategy.pnlMtd >= 0 ? "positive" : "negative"} />
          <DetailStat label="NAV" value={strategy.nav > 0 ? formatZAR(strategy.nav) : "—"} />
          <DetailStat label="Cash" value={strategy.cashWeight != null ? `${strategy.cashWeight.toFixed(1)}%` : "—"} />
          <DetailStat label="Holdings" value={strategy.holdingsCount.toString()} />
          <DetailStat label="Investors" value={strategy.investorCount.toString()} />
          <DetailStat label="Last rebal" value={strategy.lastRebalanced || "—"} />
        </div>
      </section>

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

function DetailStat({ label, value, tone = "default" }: { label: string; value: string; tone?: "default" | "primary" | "positive" | "negative" }) {
  return <div className="flex min-w-0 flex-col items-center justify-center px-1.5 py-2 text-center"><span className="text-[8px] font-bold uppercase tracking-wider text-muted-foreground">{label}</span><span className={cn("mt-0.5 max-w-full truncate font-mono text-[11px] font-bold", tone === "primary" ? "text-primary" : tone === "positive" ? "text-success" : tone === "negative" ? "text-destructive" : "text-foreground")}>{value}</span></div>;
}
