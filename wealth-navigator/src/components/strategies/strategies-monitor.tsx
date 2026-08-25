"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useRouter, useSearchParams } from "next/navigation";
import type { Route } from "next";
import { ArrowDownRight, ArrowUpRight, CalendarDays, ChevronDown, ExternalLink, Eye, Lock, Minus, Newspaper, ShieldCheck, TrendingUp } from "lucide-react";

import { Pill } from "@/components/oems/primitives/pill";
import { PanelSkeleton } from "@/components/oems/primitives/panel-skeleton";
import { EmptyDataState } from "@/components/oems/primitives/empty-data-state";
import { GlassSection } from "@/components/oems/primitives/glass";
import { DataSourceBadge } from "@/components/oems/primitives/data-source-badge";
import { NewsArticleDialog, type NewsArticleDialogItem } from "@/components/oems/primitives/news-article-dialog";
import { CashAssetIcon } from "@/components/strategies/cash-asset-icon";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { isRealDataOnlyClient } from "@/lib/data-policy";
import { formatPct, formatZAR, formatZARExact } from "@/lib/format";
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
  holdingsPreview: Array<{ symbol: string; logoUrl: string | null; isCash?: boolean }>;
  minValue: number;
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

interface DayPnlResponse {
  ok: boolean;
  today: { date: string; pnl: number | null; byStrategy: Record<string, number>; status: "live" | "stale"; source: string; asOf: string | null; coveredHoldings: number; totalHoldings: number; directPositions: number; strategyPositions: number; coveredSecurities: number; totalSecurities: number; missingSymbols: string[]; feesIncluded: boolean };
  history: Array<{ date: string; pnl: number; strategies: number; investors: number }>;
}

/** Asset-class label, defensive against a missing/unknown `kind`. */
function kindLabel(kind: string | null | undefined): string {
  return (kind ?? "equity").replace("_", " ").toUpperCase();
}

function kindTone(kind: string | null | undefined): "primary" | "warning" | "neutral" {
  return kind === "equity" ? "primary" : kind === "money_market" ? "warning" : "neutral";
}

function StrategiesHero({ strategies, dayPnl, onOpenHistory }: { strategies: StrategyRow[]; dayPnl?: DayPnlResponse; onOpenHistory?: () => void }) {
  const stats = useMemo(() => {
    const live = strategies.filter((s) => s.status === "live").length;
    const totalAum = strategies.reduce((sum, s) => sum + s.aum, 0);
    const totalInvestors = strategies.reduce((sum, s) => sum + s.investorCount, 0);
    return { live, totalAum, totalInvestors };
  }, [strategies]);
  const currentPnl = dayPnl?.today.status === "live" ? dayPnl.today.pnl : null;

  return (
    <header className="glass-panel relative overflow-hidden px-3 py-3 sm:px-4">
      {strategies.length > 0 && (
        <>
        <DataSourceBadge source="supabase" db="retail" className="absolute right-2 top-1.5 z-10" />
        <div className="grid grid-cols-5 divide-x divide-border/60 rounded-xl border border-border/70 bg-background/35">
          <SlimStat label="Mandates" value={String(strategies.length)} tone="primary" />
          <SlimStat label="Live" value={String(stats.live)} tone={stats.live > 0 ? "positive" : "default"} />
          <SlimStat label="Total AUM" value={stats.totalAum > 0 ? formatZARExact(stats.totalAum) : "—"} />
          <SlimStat label="Investors" value={String(stats.totalInvestors)} />
          <button type="button" onClick={onOpenHistory} className="transition-colors hover:bg-primary/5" title="Open daily P&L history">
            <SlimStat label={currentPnl == null ? "Day P&L · pending" : "Day P&L · live"} value={currentPnl == null ? "—" : formatZAR(currentPnl)} tone={currentPnl == null ? "default" : currentPnl > 0 ? "positive" : currentPnl < 0 ? "negative" : "default"} />
          </button>
        </div>
        </>
      )}
    </header>
  );
}

function SlimStat({ label, value, tone = "default" }: { label: string; value: string; tone?: "default" | "primary" | "positive" | "negative" }) {
  return <div className="flex min-w-0 flex-col items-center justify-center px-1 py-2 text-center sm:px-3"><span className="text-[8px] font-bold uppercase tracking-[.12em] text-muted-foreground sm:text-[9px]">{label}</span><span className={cn("mt-0.5 truncate font-mono text-xs font-bold sm:text-sm", tone === "positive" ? "text-success" : tone === "negative" ? "text-destructive" : tone === "primary" ? "text-primary" : "text-foreground")}>{value}</span></div>;
}

function DayPnlHistoryDialog({ open, onOpenChange, data }: { open: boolean; onOpenChange: (open: boolean) => void; data?: DayPnlResponse }) {
  const [range, setRange] = useState<"7D" | "1M" | "3M" | "YTD">("1M");
  const days = range === "7D" ? 7 : range === "1M" ? 31 : range === "3M" ? 93 : 370;
  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
  const rows = (data?.history ?? []).filter((row) => row.date >= cutoff);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[82vh] max-w-3xl overflow-hidden">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><CalendarDays className="h-4 w-4 text-primary" />Daily P&amp;L history</DialogTitle>
          <DialogDescription>Gross market P&amp;L across LIVE client assets. Opening units use previous close; intraday trades use actual fills. Earlier dates use stored return snapshots. Fees are currently excluded.</DialogDescription>
        </DialogHeader>
        <div className="flex gap-1">{(["7D", "1M", "3M", "YTD"] as const).map((item) => <button key={item} type="button" onClick={() => setRange(item)} className={cn("rounded-md border px-3 py-1 text-xs", range === item ? "border-primary bg-primary/10 text-primary" : "border-border text-muted-foreground")}>{item}</button>)}</div>
        <div className="rounded-lg border border-border/70 bg-background/35 p-4">
          <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Today · {data?.today.date ?? "—"}</p>
          <p className={cn("mt-1 font-mono text-2xl font-bold", (data?.today.pnl ?? 0) > 0 ? "text-success" : (data?.today.pnl ?? 0) < 0 ? "text-destructive" : "text-foreground")}>{data?.today.pnl == null ? "Pending fresh market evidence" : formatZAR(data.today.pnl)}</p>
          <p className="mt-1 text-[10px] text-muted-foreground">{data?.today.status === "live" ? `All LIVE assets · ${data.today.strategyPositions} strategy + ${data.today.directPositions} direct positions · refreshes every 30 seconds` : data?.today ? `Pricing ${data.today.coveredSecurities}/${data.today.totalSecurities} securities across strategy and direct holdings${data.today.missingSymbols.length ? ` · waiting for ${data.today.missingSymbols.slice(0, 5).join(", ")}${data.today.missingSymbols.length > 5 ? "…" : ""}` : ""}. Coverage warms in bounded batches.` : "A previous-day value is never presented as today."}</p>
        </div>
        <div className="max-h-[45vh] overflow-y-auto rounded-lg border border-border/70">
          <div className="grid grid-cols-[1fr_1fr_80px_80px] border-b border-border/70 px-3 py-2 text-[10px] uppercase text-muted-foreground"><span>Date</span><span className="text-right">P&amp;L</span><span className="text-right">Strategies</span><span className="text-right">Investors</span></div>
          {rows.map((row) => <div key={row.date} className="grid grid-cols-[1fr_1fr_80px_80px] border-b border-border/40 px-3 py-2 text-xs last:border-0"><span>{row.date}</span><span className={cn("text-right font-mono font-semibold", row.pnl > 0 ? "text-success" : row.pnl < 0 ? "text-destructive" : "text-muted-foreground")}>{formatZAR(row.pnl)}</span><span className="text-right text-muted-foreground">{row.strategies}</span><span className="text-right text-muted-foreground">{row.investors}</span></div>)}
          {rows.length === 0 && <p className="p-6 text-center text-xs text-muted-foreground">No stored P&amp;L rows in this range.</p>}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function MarketTicker({ items }: { items: Array<{ symbol: string; price: number | null; changePct: number | null }> }) {
  if (!items.length) return <div className="flex h-10 items-center justify-center border-y border-border/60 bg-background/35 text-[10px] text-muted-foreground">Live market prices unavailable</div>;
  const display = [...items, ...items];
  return <div className="relative overflow-hidden border-y border-border/60 bg-background/35"><div className="absolute right-0 top-0 z-10 flex h-10 items-center gap-1 border-l border-border/60 bg-background/90 pl-3 pr-2 backdrop-blur-sm"><DataSourceBadge source="supabase" db="retail" /></div><div className="strategy-market-ticker flex w-max items-center whitespace-nowrap" style={{ animationDuration: `${Math.max(24, items.length * 3)}s` }}>{display.map((item, index) => { const up=(item.changePct??0)>0, down=(item.changePct??0)<0; const Icon=up?ArrowUpRight:down?ArrowDownRight:Minus; return <div key={`${item.symbol}-${index}`} className="flex h-10 items-center gap-2 border-r border-border/60 px-5"><span className="font-mono text-[10px] font-bold tracking-wide text-foreground">{item.symbol}</span><span className="font-mono text-[10px] text-muted-foreground">{item.price == null ? "—" : formatZAR(item.price)}</span><span className={cn("inline-flex items-center gap-0.5 font-mono text-[10px] font-semibold",up?"text-success":down?"text-destructive":"text-muted-foreground")}><Icon className="h-3 w-3"/>{item.changePct == null ? "—" : `${item.changePct >= 0 ? "+" : ""}${item.changePct.toFixed(2)}%`}</span></div>})}</div></div>;
}

/** The "Mandates" tab body — was `/oems/strategies`. Must render inside a Suspense boundary (uses `useSearchParams`). */
export function StrategiesMonitor() {
  const router = useRouter();
  const realDataOnly = isRealDataOnlyClient();
  // Two independent requests: the panels (strategy list/hero) and the market
  // ticker each render as soon as their own data lands, instead of the whole
  // page blocking on one combined BFF response.
  const strategiesQ = useQuery<StrategiesResponse>({
    queryKey: ["bff-strategies"],
    queryFn: async () => {
      const r = await fetch("/api/strategies?part=core", { cache: "no-store" });
      if (!r.ok) throw new Error(`Strategies BFF ${r.status}`);
      return r.json();
    },
    enabled: realDataOnly,
    refetchInterval: 60_000,
    ...queryOpts("reference"),
  });
  const marketQ = useQuery<StrategiesResponse>({
    queryKey: ["bff-strategies-market"],
    queryFn: async () => {
      const r = await fetch("/api/strategies?part=market", { cache: "no-store" });
      if (!r.ok) throw new Error(`Strategies market BFF ${r.status}`);
      return r.json();
    },
    enabled: realDataOnly,
    refetchInterval: 60_000,
    ...queryOpts("reference"),
  });
  const dayPnlQ = useQuery<DayPnlResponse>({
    queryKey: ["strategy-day-pnl"],
    queryFn: async () => {
      const r = await fetch("/api/strategies/day-pnl", { cache: "no-store" });
      if (!r.ok) throw new Error(`Day P&L ${r.status}`);
      return r.json();
    },
    enabled: realDataOnly,
    refetchInterval: 30_000,
    ...queryOpts("reference"),
  });
  const strategies = useMemo(() => {
    const rows = strategiesQ.data?.strategies ?? [];
    const today = dayPnlQ.data?.today;
    if (today?.status !== "live") return rows.map((row) => ({ ...row, dayPnl: 0 }));
    return rows.map((row) => ({ ...row, dayPnl: today.byStrategy[row.id] ?? 0 }));
  }, [strategiesQ.data?.strategies, dayPnlQ.data]);
  const focusId = useSearchParams().get("focus");
  const [selected, setSelected] = useState("");
  const [pnlHistoryOpen, setPnlHistoryOpen] = useState(false);
  const [firstReveal, setFirstReveal] = useState(false);
  const hasRevealed = useRef(false);
  const reveal = (id: string) => {
    setSelected(id);
    if (!hasRevealed.current) {
      hasRevealed.current = true;
      setFirstReveal(true);
      window.setTimeout(() => setFirstReveal(false), 650);
    }
  };
  useEffect(() => {
    if (focusId && strategies.some((strategy) => strategy.id === focusId)) reveal(focusId);
    // A focus query represents an explicit choice from the global strategy selector.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusId, strategies]);
  const active = strategies.find((s) => s.id === selected) ?? strategies[0];

  if (!realDataOnly) {
    return (
      <div className="space-y-5 pb-8">
        <StrategiesHero strategies={[]} />
        <GlassSection title="Strategy mandates" dataSource="supabase" endpoint="GET /api/strategies">
          <EmptyDataState
            message="Strategies are offline. Try again once the worker is online."
            hint="Switch to live data via the IRESS worker (Railway) once online."
            badgeLabel="unconfigured"
          />
        </GlassSection>
      </div>
    );
  }

  return (
    <div className="space-y-5 pb-8">
      <div className="-mx-4 -mt-4 sm:-mx-6 sm:-mt-6"><MarketTicker items={marketQ.data?.market ?? []} /></div>
      <StrategiesHero strategies={strategies} dayPnl={dayPnlQ.data} onOpenHistory={() => setPnlHistoryOpen(true)} />
      <DayPnlHistoryDialog open={pnlHistoryOpen} onOpenChange={setPnlHistoryOpen} data={dayPnlQ.data} />

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
              <StrategyCard key={s.id} s={s} active={selected === s.id} onSelect={() => reveal(s.id)} />
            ))}
          </div>

          {active && <StrategyDetail strategy={active} showSummary={Boolean(selected)} firstReveal={firstReveal} onView={() => router.push(`/strategies/${active.id}` as Route)} />}
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
        <Stat label="Min value" value={s.minValue > 0 ? formatZAR(s.minValue) : "—"} />
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

function HoldingLogoStack({
  holdings,
}: { holdings: Array<{ symbol: string; logoUrl: string | null; isCash?: boolean }> }) {
  const visible = holdings.slice(0, 3);
  const remainder = Math.max(0, holdings.length - visible.length);
  return <div className="flex items-center -space-x-1.5" aria-label={`${holdings.length} strategy holdings`}>{visible.map((holding) => holding.isCash ? <CashAssetIcon key={holding.symbol} className="h-6 w-6 border-2 border-card" /> : <div key={holding.symbol} title={holding.symbol} className="flex h-6 w-6 items-center justify-center overflow-hidden rounded-full border-2 border-card bg-primary/10 text-[7px] font-bold text-primary">{holding.logoUrl ? <img src={holding.logoUrl} alt={holding.symbol} className="h-full w-full object-cover" /> : holding.symbol.slice(0, 2)}</div>)}{remainder > 0 && <div className="flex h-6 min-w-6 items-center justify-center rounded-full border-2 border-card bg-muted px-1 text-[8px] font-bold text-muted-foreground">+{remainder}</div>}</div>;
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

function StrategyDetail({ strategy, showSummary, firstReveal, onView }: { strategy: StrategyRow; showSummary: boolean; firstReveal: boolean; onView: () => void }) {
  const rebal = strategy.status === "live" && strategy.investorCount > 0;
  return (
    /* Sticky on lg+ so the detail panel stays in view while the strategy list
       column scrolls (Lonwabo). top-4 clears the page padding; on mobile the
       columns stack so sticky is disabled to avoid an awkward pin. */
    <div className="col-span-12 space-y-3 self-start lg:sticky lg:top-4 lg:col-span-7">
      {showSummary && <section className={cn("glass-panel p-3", firstReveal && "strategy-detail-first-reveal")}>
        <div className="mb-2.5 flex items-center gap-2">
          <h2 className="min-w-0 flex-1 truncate text-sm font-semibold text-foreground">{strategy.name} · detail</h2>
          <DataSourceBadge source="supabase" db="retail" />
          <TooltipProvider delayDuration={120}><Tooltip><TooltipTrigger asChild><span className={cn("inline-flex cursor-help items-center gap-1 rounded-full px-2 py-1 text-[9px] font-bold uppercase tracking-wide", rebal ? "bg-success/15 text-success" : "bg-warning/15 text-warning")}>{rebal ? <ShieldCheck className="h-3 w-3"/> : <Lock className="h-3 w-3"/>}{rebal ? "Eligible" : "Locked"}</span></TooltipTrigger><TooltipContent side="bottom" className="max-w-80 rounded-xl p-3 text-xs leading-relaxed shadow-xl">{rebal ? <><p className="font-bold text-success">Strategy is eligible for rebalance</p><p className="mt-1">{strategy.holdingsCount} securities · {strategy.investorCount} linked investors. Investor mandates and live market halt/suspension checks run before execution.</p></> : strategy.status === "halted" ? "Rebalance is locked because Risk halted this strategy." : strategy.investorCount === 0 ? "Rebalance is locked because no investors are linked." : "Rebalance is locked until the strategy is live."}</TooltipContent></Tooltip></TooltipProvider>
          <Pill tone={kindTone(strategy.kind)} size="xs">{kindLabel(strategy.kind)}</Pill>
          <button type="button" onClick={onView} className="inline-flex h-7 items-center gap-1.5 rounded-lg bg-primary px-2.5 text-[9px] font-bold text-primary-foreground shadow-sm shadow-primary/20 transition hover:-translate-y-px hover:bg-primary/90"><Eye className="h-3 w-3"/>View strategy</button>
        </div>
        <div className="grid grid-cols-4 divide-x divide-y divide-border/50 overflow-hidden rounded-lg border border-border/60 bg-background/25 xl:grid-cols-8 xl:divide-y-0">
          <DetailStat label="Min value" value={strategy.minValue > 0 ? formatZAR(strategy.minValue) : "—"} tone="primary" />
          <DetailStat label="YTD" value={strategy.ytd != null ? formatPct(strategy.ytd) : "—"} tone={strategy.ytd == null ? "default" : strategy.ytd >= 0 ? "positive" : "negative"} />
          <DetailStat label="MTD P&L" value={strategy.pnlMtd != null ? formatZAR(strategy.pnlMtd) : "—"} tone={strategy.pnlMtd == null ? "default" : strategy.pnlMtd >= 0 ? "positive" : "negative"} />
          <DetailStat label="NAV" value={strategy.nav > 0 ? formatZAR(strategy.nav) : "—"} />
          <DetailStat label="Cash" value={strategy.cashWeight != null ? `${strategy.cashWeight.toFixed(1)}%` : "—"} />
          <DetailStat label="Holdings" value={strategy.holdingsCount.toString()} />
          <DetailStat label="Investors" value={strategy.investorCount.toString()} />
          <DetailStat label="Last rebal" value={strategy.lastRebalanced || "—"} />
        </div>
      </section>}

      <details className="group glass-panel overflow-hidden">
        <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-3"><span className="text-xs font-bold text-foreground">Holdings · target vs actual</span><span className="ml-auto font-mono text-[10px] text-muted-foreground">{strategy.holdingsCount} positions</span><ChevronDown className="h-3.5 w-3.5 text-muted-foreground transition group-open:rotate-180"/></summary>
        <div className="border-t border-border p-3"><EmptyDataState message="Per-investor holdings not yet published for this strategy." hint="This data will be available after the data sync service processes position and transaction records." /></div>
      </details>
      <ReturnInsightsCard strategy={strategy}/>
      <NewsInsightsCard strategy={strategy}/>
    </div>
  );
}

const RETURN_PERIODS = [["1D", "1d_pct"], ["5D", "5d_pct"], ["MTD", "mtd_pct"], ["6M", "6m_pct"], ["YTD", "ytd_pct"], ["1Y", "1y_pct"]] as const;
type ReturnPeriodKey = (typeof RETURN_PERIODS)[number][1];
type ReturnSet = Partial<Record<ReturnPeriodKey, number | null>>;
interface StrategyReturnInsightsResponse {
  ok: boolean;
  strategy?: { name: string; asOf: string | null; source: string; returns: ReturnSet };
  constituents?: Array<{ symbol: string; name: string | null; asOf: string | null; source: string; error?: string | null; returns: ReturnSet }>;
  cash?: { symbol: string; name: string; source: string; returns: ReturnSet };
  benchmark?: { symbol: string; asOf: string | null; source: string; returns: ReturnSet | null } | null;
}

function returnAlertFloor(period: ReturnPeriodKey): number {
  return period === "1d_pct" ? -4 : period === "5d_pct" ? -7 : period === "mtd_pct" ? -10 : -20;
}

function ReturnInsightsCard({ strategy }: { strategy: StrategyRow }) {
  const [period, setPeriod] = useState<ReturnPeriodKey>("1d_pct");
  const query = useQuery<StrategyReturnInsightsResponse>({
    queryKey: ["strategy-return-insights", strategy.id],
    queryFn: async () => {
      const response = await fetch(`/api/strategies/${encodeURIComponent(strategy.id)}/return-insights`, { cache: "no-store" });
      if (!response.ok) throw new Error(`return insights ${response.status}`);
      return response.json();
    },
    ...queryOpts("live"),
    refetchInterval: 60_000,
  });
  const rows = (query.data?.constituents ?? [])
    .map((row) => ({ ...row, value: row.returns[period] }))
    .sort((a, b) => (b.value ?? Number.NEGATIVE_INFINITY) - (a.value ?? Number.NEGATIVE_INFINITY));
  const alerts = rows.filter((row) => row.value != null && row.value <= returnAlertFloor(period));
  const asOf = rows.map((row) => row.asOf).filter((value): value is string => Boolean(value)).sort().at(-1) ?? null;
  const strategyAsOf = query.data?.strategy?.asOf ?? null;
  const strategyIsAligned = period !== "1d_pct" || !asOf || !strategyAsOf || asOf.slice(0, 10) === strategyAsOf.slice(0, 10);
  const strategyValue = strategyIsAligned ? query.data?.strategy?.returns[period] ?? null : null;
  const benchmarkValue = query.data?.benchmark?.returns?.[period] ?? null;
  const cashValue = query.data?.cash?.returns[period] ?? 0;
  return (
    <section className="glass-panel overflow-hidden">
      <header className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2.5">
        <span className="flex h-6 w-6 items-center justify-center rounded-lg bg-success/10 text-success"><TrendingUp className="h-3.5 w-3.5"/></span>
        <div><h3 className="text-xs font-bold">Return Insights</h3><p className="text-[8px] text-muted-foreground">Certified strategy · Yahoo constituents</p></div>
        {alerts.length > 0 && <span className="rounded-full bg-destructive/15 px-2 py-0.5 text-[9px] font-bold text-destructive">{alerts.length} alerts</span>}
        <DataSourceBadge source="supabase" db="retail" />
        <Pill tone="neutral" size="xs">Yahoo</Pill>
        <div className="ml-auto flex rounded-lg bg-muted/50 p-0.5">{RETURN_PERIODS.map(([label, key]) => <button type="button" key={key} onClick={() => setPeriod(key)} className={cn("rounded-md px-1.5 py-1 text-[8px] font-bold", period === key ? "bg-background text-primary shadow-sm" : "text-muted-foreground")}>{label}</button>)}</div>
      </header>
      <div className="p-3">
        {query.isLoading ? <p className="py-5 text-center text-[10px] text-muted-foreground">Loading focused returns…</p> : rows.length === 0 ? <p className="py-5 text-center text-[10px] text-muted-foreground">No return data for these strategy securities.</p> : <>
          <div className={cn("mb-3 grid gap-2 rounded-lg border border-border/70 bg-background/25 p-2.5", query.data?.benchmark ? "grid-cols-2" : "grid-cols-1")}>
            <div><p className="text-[8px] font-bold uppercase tracking-wider text-muted-foreground">Certified strategy return · as of {strategyAsOf ?? "—"}</p><p className={cn("mt-1 font-mono text-sm font-bold", strategyValue == null ? "text-muted-foreground" : strategyValue >= 0 ? "text-success" : "text-destructive")}>{strategyValue == null ? (strategyIsAligned ? "—" : "Awaiting today's certification") : `${strategyValue >= 0 ? "+" : ""}${strategyValue.toFixed(2)}%`}</p></div>
            {query.data?.benchmark ? <div className="text-right"><p className="text-[8px] font-bold uppercase tracking-wider text-muted-foreground">Benchmark {query.data.benchmark.symbol}</p><p className={cn("mt-1 font-mono text-sm font-bold", benchmarkValue == null ? "text-muted-foreground" : benchmarkValue >= 0 ? "text-success" : "text-destructive")}>{benchmarkValue == null ? "—" : `${benchmarkValue >= 0 ? "+" : ""}${benchmarkValue.toFixed(2)}%`}</p></div> : null}
          </div>
          <p className="mb-1.5 text-[8px] font-bold uppercase tracking-wider text-muted-foreground">Constituent returns</p>
          <div className="grid grid-cols-2 gap-2">{rows.map((row) => <div key={row.symbol} title={row.error ?? `${row.source} as of ${row.asOf ?? "unknown"}`} className="flex min-w-0 items-center rounded-lg border border-border px-2.5 py-2"><div className="min-w-0"><span className="font-mono text-[10px] font-bold">{row.symbol}</span><p className="truncate text-[8px] text-muted-foreground">{row.name ?? (row.source === "supabase-stored-close" ? "Stored-close fallback" : row.source === "unavailable" ? "No market history available" : "Yahoo")}</p></div><span className={cn("ml-auto font-mono text-[10px] font-bold", row.value == null ? "text-muted-foreground" : row.value >= 0 ? "text-success" : "text-destructive")}>{row.value == null ? "—" : `${row.value >= 0 ? "+" : ""}${row.value.toFixed(2)}%`}</span></div>)}</div>
          {strategy.holdingsPreview.some((holding) => holding.isCash) ? <div className="mt-2 flex items-center rounded-lg border border-border px-2.5 py-2"><div><span className="font-mono text-[10px] font-bold">CA</span><p className="text-[8px] text-muted-foreground">Continuity cash · nominal return</p></div><span className="ml-auto font-mono text-[10px] font-bold text-muted-foreground">{`${cashValue >= 0 ? "+" : ""}${cashValue.toFixed(2)}%`}</span></div> : null}
          <p className="mt-2 text-right font-mono text-[8px] text-muted-foreground">Yahoo as of {asOf ? new Date(asOf).toLocaleString("en-ZA") : "—"} · refreshes every 60s</p>
        </>}
      </div>
    </section>
  );
}

interface NewsCardItem { id: string; source: string; headline: string; body: string | null; url: string | null; publishedAt: string; ticker: string | null; tickers: string[]; category?: string | null; }
function NewsInsightsCard({ strategy }: { strategy: StrategyRow }) {
  const query = useQuery<{ items?: NewsCardItem[]; sourceLabel?: string }>({ queryKey: ["strategy-news-insights"], queryFn: () => fetch("/api/news?limit=60", { cache: "no-store" }).then((response) => response.json()), ...queryOpts("reference") });
  const [active, setActive] = useState<NewsArticleDialogItem | null>(null);
  const symbols = new Set(strategy.holdingsPreview.map((holding) => holding.symbol.replace(/\.JO$/i, "").toUpperCase()));
  const relevant = (query.data?.items ?? []).filter((item) => { const tagged = [item.ticker, ...(item.tickers || [])].filter(Boolean).map((value) => String(value).replace(/\.JO$/i, "").toUpperCase()); return tagged.some((symbol) => symbols.has(symbol)) || [...symbols].some((symbol) => item.headline.toUpperCase().includes(symbol)); }).slice(0, 6);
  const items = relevant.length ? relevant : (query.data?.items ?? []).slice(0, 4);
  return <section className="glass-panel overflow-hidden"><header className="flex items-center gap-2 border-b border-border px-3 py-2.5"><span className="flex h-6 w-6 items-center justify-center rounded-lg bg-primary/10 text-primary"><Newspaper className="h-3.5 w-3.5"/></span><div><h3 className="text-xs font-bold">News & Insights</h3><p className="text-[8px] text-muted-foreground">{relevant.length ? `${strategy.name} securities` : query.data?.sourceLabel || "Mint Platform"}</p></div><DataSourceBadge source="external" className="ml-auto" /></header><div className="divide-y divide-border px-3">{query.isLoading ? <p className="py-5 text-center text-[10px] text-muted-foreground">Loading news…</p> : items.length === 0 ? <p className="py-5 text-center text-[10px] text-muted-foreground">No news available.</p> : items.map((item) => <button type="button" key={item.id} onClick={() => setActive({ headline: item.headline, body: item.body, source: item.source, publishedAt: item.publishedAt, url: item.url, category: item.category, tickers: item.tickers })} className="block w-full py-2.5 text-left hover:text-primary"><div className="flex items-center gap-2"><span className="rounded-full bg-primary/10 px-1.5 py-0.5 text-[8px] font-bold uppercase text-primary">{item.source}</span><span className="ml-auto text-[8px] text-muted-foreground">{new Date(item.publishedAt).toLocaleDateString("en-ZA")}</span>{item.url && <ExternalLink className="h-2.5 w-2.5 text-muted-foreground"/>}</div><p className="mt-1 text-[10px] font-semibold leading-snug">{item.headline}</p>{item.body && <p className="mt-0.5 line-clamp-2 text-[9px] leading-relaxed text-muted-foreground">{item.body}</p>}</button>)}</div><NewsArticleDialog item={active} open={active != null} onOpenChange={(open) => !open && setActive(null)} /></section>;
}

function DetailStat({ label, value, tone = "default" }: { label: string; value: string; tone?: "default" | "primary" | "positive" | "negative" }) {
  return <div className="flex min-w-0 flex-col items-center justify-center px-1.5 py-2 text-center"><span className="text-[8px] font-bold uppercase tracking-wider text-muted-foreground">{label}</span><span className={cn("mt-0.5 max-w-full truncate font-mono text-[11px] font-bold", tone === "primary" ? "text-primary" : tone === "positive" ? "text-success" : tone === "negative" ? "text-destructive" : "text-foreground")}>{value}</span></div>;
}
