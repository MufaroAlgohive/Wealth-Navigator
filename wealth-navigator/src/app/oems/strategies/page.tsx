"use client";

import { Suspense, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useSearchParams } from "next/navigation";
import { Lock, RefreshCw, ShieldCheck } from "lucide-react";

import { Panel } from "@/components/oems/primitives/panel";
import { Pill } from "@/components/oems/primitives/pill";
import { PanelSkeleton } from "@/components/oems/primitives/panel-skeleton";
import { EmptyDataState } from "@/components/oems/primitives/empty-data-state";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { isRealDataOnlyClient } from "@/lib/data-policy";
import { formatPct, formatZAR } from "@/lib/format";
import { cn } from "@/lib/cn";
import { queryOpts } from "@/lib/store/query-provider";

/**
 * Strategy view-model — the shape `/api/strategies` actually returns.
 *
 * NOTE: this is the BFF's normalised view-model (already in Rands / percent,
 * with `id` + `kind`), NOT the raw `oems_strategy_c` column shape. The BFF
 * prefers the populated retail catalogue (`strategies_c` + per-strategy
 * AUM/PnL from `client_strategy_returns_c`) and falls back to the
 * institutional rollup; both are mapped to this single shape. Keep this in
 * sync with `mapRow` / `loadRetailStrategies` in the route.
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
  pnlMtd: number; // Rands
  ytd: number; // percent
  cashWeight: number; // percent
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
  // for the empty/una­vailable case.
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

function StrategiesPageContent() {
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
    // Mock/legacy mode is not the production target; redirect to the
    // new empty state with a clear "MOCK" badge so anyone visiting
    // /oems/strategies in a dev build sees the same honest UI.
    // The `realDataOnly` flag is the only condition that flips
    // between the mock and real-data render paths (audit #23). It is
    // computed once at mount by `isRealDataOnlyClient()` from the
    // NEXT_PUBLIC_USE_SUPABASE_QUOTES / Vercel env; we don't re-read
    // it on each render.
    return (
      <div className="space-y-3">
        <header>
          <h1 className="text-lg font-semibold tracking-tight">Strategies</h1>
          <p className="text-xs text-muted-foreground">
            Rebalance gated on linked investors · pre-trade mandate & halt checks via IRESS
          </p>
        </header>
        <Panel title="Strategy mandates" endpoint="oems_strategy_c">
          <EmptyDataState
            message="Mock mode disables the strategies module."
            hint="Switch to real-data mode and ensure the worker has written oems_strategy_c rows."
            badgeLabel="mock"
          />
        </Panel>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <header>
        <h1 className="text-lg font-semibold tracking-tight">Strategies</h1>
        <p className="text-xs text-muted-foreground">
          Rebalance gated on linked investors · pre-trade mandate & halt checks via IRESS
        </p>
      </header>

      {strategiesQ.isLoading ? (
        <div className="grid grid-cols-12 gap-3">
          <div className="col-span-12 lg:col-span-5 space-y-2">
            {[0, 1, 2, 3, 4, 5].map((n) => (
              <div key={`strategies-row-${n}`} className="rounded-lg border border-border bg-card p-3">
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
        // Audit #12 — render the typed BFF reason through to the
        // EmptyDataState. The BFF returns one of: supabase_not_configured
        // | supabase_query_failed (with a `migration` field) | empty.
        // supabase_query_failed with a missing table maps to the
        // "Run 20260613000002_oems_strategy_c.sql" hint.
        <Panel
          title="Strategy mandates"
          endpoint="GET /api/strategies"
          dataSource={strategiesQ.data?.source === "supabase" ? "supabase" : "unconfigured"}
        >
          <EmptyDataState
            reason={strategiesQ.data?.reason ?? "supabase_query_failed"}
            migration={strategiesQ.data?.migration}
            errorDetail={(strategiesQ.data as { error?: string } | undefined)?.error}
            title="No strategies ingested yet"
            message="Strategy mandates require the Supabase portfolio system integration."
            hint={strategiesQ.data?.message}
          />
        </Panel>
      ) : (
        <div className="grid grid-cols-12 gap-3">
          <div className="col-span-12 lg:col-span-5 space-y-2">
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

export default function StrategiesPage() {
  return (
    <Suspense fallback={null}>
      <StrategiesPageContent />
    </Suspense>
  );
}

function StrategyCard({ s, active, onSelect }: { s: StrategyRow; active: boolean; onSelect: () => void }) {
  const rebal = s.status === "live" && s.investorCount > 0;
  return (
    <button
      onClick={onSelect}
      className={cn(
        "w-full rounded-lg border bg-card p-3 text-left transition-all",
        active ? "border-primary/50 shadow-[inset_0_0_0_1px_hsl(var(--primary)/0.4)]" : "border-border hover:border-border-strong",
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold">{s.name}</p>
          <p className="text-[10.5px] text-muted-foreground">
            {s.manager ?? "—"} {s.benchmark ? `· bench ${s.benchmark}` : ""}
          </p>
        </div>
        <Pill tone={kindTone(s.kind)} size="xs">
          {kindLabel(s.kind)}
        </Pill>
      </div>
      <div className="mt-2.5 grid grid-cols-4 gap-2 text-[10.5px]">
        <Stat label="AUM" value={s.aum > 0 ? formatZAR(s.aum) : "—"} />
        <Stat label="YTD" value={formatPct(s.ytd)} positive={s.ytd >= 0} />
        <Stat label="Day P&L" value={s.dayPnl !== 0 ? formatZAR(s.dayPnl) : "—"} positive={s.dayPnl >= 0} />
        <Stat label="Investors" value={s.investorCount.toString()} />
      </div>
      <div className="mt-2.5 flex items-center justify-between border-t border-border/60 pt-2">
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
            className="h-6 text-[10px] gap-1 px-2"
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
    <div className="col-span-12 lg:col-span-7 space-y-3">
      <Panel
        title={`${strategy.name} · detail`}
        endpoint={`oems_strategy_c[${strategy.id}]`}
        dataSource="supabase"
        right={
          <Pill tone={kindTone(strategy.kind)} size="xs">
            {kindLabel(strategy.kind)}
          </Pill>
        }
      >
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <KpiSmall label="AUM" value={formatZAR(strategy.aum)} />
          <KpiSmall label="YTD" value={formatPct(strategy.ytd)} negative={strategy.ytd < 0} />
          <KpiSmall label="MTD P&L" value={formatZAR(strategy.pnlMtd)} negative={strategy.pnlMtd < 0} />
          <KpiSmall label="NAV" value={formatZAR(strategy.nav)} />
          <KpiSmall label="Cash" value={`${strategy.cashWeight.toFixed(1)}%`} />
          <KpiSmall label="Holdings" value={strategy.holdingsCount.toString()} />
          <KpiSmall label="Investors" value={strategy.investorCount.toString()} />
          <KpiSmall label="Last rebal" value={strategy.lastRebalanced || "—"} />
        </div>
        {!rebal && (
          <div className="mt-3 flex items-center gap-2 rounded-md border border-warning/40 bg-warning/5 p-2.5 text-[11.5px] text-warning">
            <Lock className="h-3.5 w-3.5" />
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
          <div className="mt-3 flex items-center gap-2 rounded-md border border-success/30 bg-success/5 p-2.5 text-[11.5px] text-success">
            <ShieldCheck className="h-3.5 w-3.5" />
            <span>
              All pre-trade checks passed · {strategy.investorCount} investors · {strategy.holdingsCount} holdings
              {strategy.kind === "money_market" ? " · issuer concentration OK" : " · HALTED/SUSPENDED check OK"}.
            </span>
          </div>
        )}
      </Panel>

      <Panel
        title="Holdings · target vs actual"
        endpoint="oems_position_c ?strategy_id = {id}"
        dataSource="unconfigured"
        density="scroll"
        className="h-[420px]"
        right={<span className="font-mono text-[10px]">{strategy.holdingsCount} positions (from oems_position_c)</span>}
      >
        <EmptyDataState
          message="Per-investor holdings not yet published for this strategy."
          hint="The worker computes target vs actual from oems_position_c and oems_transaction_c per investor — wire the per-strategy rollup in the worker to populate this panel."
        />
      </Panel>
    </div>
  );
}

function KpiSmall({ label, value, negative }: { label: string; value: string; negative?: boolean }) {
  return (
    <div className="rounded-md border border-border/60 bg-surface-2/40 p-2">
      <p className="text-[9.5px] uppercase tracking-wider text-muted-foreground">{label}</p>
      <p className={cn("mt-0.5 font-mono text-sm font-semibold", negative && "text-down")}>{value}</p>
    </div>
  );
}
