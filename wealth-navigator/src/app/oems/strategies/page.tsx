"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useSearchParams } from "next/navigation";
import { Lock, RefreshCw, Users, Target, Activity, ShieldCheck, ChevronRight } from "lucide-react";

import { Panel } from "@/components/oems/primitives/panel";
import { Pill } from "@/components/oems/primitives/pill";
import { Sparkline } from "@/components/oems/primitives/sparkline";
import { PanelSkeleton } from "@/components/oems/primitives/panel-skeleton";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { useIress } from "@/lib/iress/provider";
import { canRebalance, rebalanceBlockReason, rebalanceBlockTooltip } from "@/lib/iress/strategy";
import { formatPct, formatZAR } from "@/lib/format";
import { cn } from "@/lib/cn";
import type { Strategy } from "@/types/iress";
import { queryOpts } from "@/lib/store/query-provider";

export default function StrategiesPage() {
  const { data } = useIress();
  const strategiesQ = useQuery({ queryKey: ["strategies"], queryFn: () => data.strategies(), ...queryOpts("live") });
  const strategies = strategiesQ.data ?? [];
  // The command palette (⌘K) deep-links here with `?focus=<strategyId>`.
  const focusId = useSearchParams().get("focus");
  const [selected, setSelected] = useState<string>(
    (focusId && strategies.find((s) => s.id === focusId)?.id) || strategies[0]?.id || "",
  );
  const active = strategies.find((s) => s.id === selected) ?? strategies[0];

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
      ) : (
        <div className="grid grid-cols-12 gap-3">
          <div className="col-span-12 lg:col-span-5 space-y-2">
            {strategies.map((s) => (
              <StrategyCard
                key={s.id}
                s={s}
                active={selected === s.id}
                onSelect={() => setSelected(s.id)}
              />
            ))}
          </div>

          {active && <StrategyDetail strategy={active} />}
        </div>
      )}
    </div>
  );
}

function StrategyCard({ s, active, onSelect }: { s: Strategy; active: boolean; onSelect: () => void }) {
  const rebal = canRebalance(s);
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
          <p className="text-[10.5px] text-muted-foreground">{s.manager} · bench {s.benchmark}</p>
        </div>
        <Pill tone={s.kind === "equity" ? "primary" : "warning"} size="xs">
          {s.kind === "equity" ? "EQUITY" : "MONEY MKT"}
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
                <button type="button" aria-label={rebalanceBlockTooltip(s)} className="cursor-help">
                  <Pill tone="destructive" size="xs" dot>
                    REBALANCE LOCKED — {rebalanceBlockReason(s) === "halted" ? "halted" : "no investors"}
                  </Pill>
                </button>
              </TooltipTrigger>
              <TooltipContent className="max-w-[260px]">{rebalanceBlockTooltip(s)}</TooltipContent>
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

function StrategyDetail({ strategy }: { strategy: Strategy }) {
  const { data } = useIress();
  const holdingsQ = useQuery({
    queryKey: ["strategies", strategy.id, "holdings"],
    queryFn: () => data.strategyHoldings(strategy.id),
    ...queryOpts("reference"),
  });
  const holdings = holdingsQ.data ?? [];
  const rebal = canRebalance(strategy);

  return (
    <div className="col-span-12 lg:col-span-7 space-y-3">
      <Panel
        title={`${strategy.name} · detail`}
        endpoint="GET /v1/positions?strategy={id}"
        right={<Pill tone={strategy.kind === "equity" ? "primary" : "warning"} size="xs">{strategy.kind.toUpperCase()}</Pill>}
      >
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <KpiSmall label="Sharpe" value={strategy.sharpe.toFixed(2)} />
          <KpiSmall label="Max DD" value={formatPct(strategy.maxDD)} negative />
          <KpiSmall label="Cash" value={`${strategy.cashWeight.toFixed(1)}%`} />
          <KpiSmall label="Last rebal" value={strategy.lastRebalanced} />
          {strategy.kind === "money_market" && (
            <>
              <KpiSmall label="WAY" value={`${strategy.weightedAvgYield?.toFixed(2)}%`} />
              <KpiSmall label="WAM" value={`${strategy.weightedAvgDuration?.toFixed(2)}y`} />
            </>
          )}
          {strategy.trackingError !== undefined && (
            <KpiSmall label="Tracking error" value={`${strategy.trackingError.toFixed(1)}%`} />
          )}
          <KpiSmall label="Holdings" value={strategy.holdingsCount.toString()} />
        </div>
        {!rebal && (
          <div className="mt-3 flex items-center gap-2 rounded-md border border-warning/40 bg-warning/5 p-2.5 text-[11.5px] text-warning">
            <Lock className="h-3.5 w-3.5" />
            <span>Rebalance disabled — {strategy.investorCount === 0 ? "no underlying investors linked" : "strategy halted by Risk"}.</span>
          </div>
        )}
        {rebal && (
          <div className="mt-3 flex items-center gap-2 rounded-md border border-success/30 bg-success/5 p-2.5 text-[11.5px] text-success">
            <ShieldCheck className="h-3.5 w-3.5" />
            <span>All pre-trade checks passed · {strategy.investorCount} investors · {strategy.holdingsCount} holdings · {strategy.kind === "money_market" ? "issuer concentration OK" : "HALTED/SUSPENDED/NON-TRADEABLE check OK"}.</span>
          </div>
        )}
      </Panel>

      <Panel
        title={`Holdings · Target vs Actual`}
        endpoint="GET /v1/positions?strategy={id}"
        density="scroll"
        className="h-[420px]"
        right={<span className="font-mono text-[10px]">{holdings.length} positions</span>}
      >
        {holdings.length === 0 ? (
          <p className="p-4 text-xs text-muted-foreground">No holdings published for this strategy yet.</p>
        ) : (
          <table className="w-full font-mono text-[11px]">
            <thead className="sticky top-0 z-10 bg-card/95 backdrop-blur">
              <tr className="text-[9.5px] uppercase tracking-wider text-muted-foreground">
                <th className="px-2.5 py-1.5 text-left">Symbol</th>
                <th className="px-2.5 py-1.5 text-left">Name</th>
                <th className="px-2.5 py-1.5 text-right">Qty</th>
                <th className="px-2.5 py-1.5 text-right">MV</th>
                <th className="px-2.5 py-1.5 text-right">Target</th>
                <th className="px-2.5 py-1.5 text-right">Actual</th>
                <th className="px-2.5 py-1.5 text-left">Drift</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/60">
              {holdings.map((h) => {
                const drift = h.actual - h.target;
                return (
                  <tr key={h.symbol}>
                    <td className="px-2.5 py-1.5 font-semibold">{h.symbol}</td>
                    <td className="px-2.5 py-1.5 text-muted-foreground">{h.name}</td>
                    <td className="px-2.5 py-1.5 text-right tabular-nums">{h.qty.toLocaleString()}</td>
                    <td className="px-2.5 py-1.5 text-right tabular-nums">{formatZAR(h.mv)}</td>
                    <td className="px-2.5 py-1.5 text-right tabular-nums text-muted-foreground">{h.target.toFixed(1)}%</td>
                    <td className="px-2.5 py-1.5 text-right tabular-nums">{h.actual.toFixed(1)}%</td>
                    <td className="px-2.5 py-1.5">
                      <DriftBar drift={drift} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
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

function DriftBar({ drift }: { drift: number }) {
  const widthPct = Math.min(Math.abs(drift) * 8, 48);
  const isOver = drift >= 0;
  const isMaterial = Math.abs(drift) > 0.5;
  return (
    <div className="flex items-center gap-1.5">
      <div className="relative h-1.5 flex-1 rounded bg-muted">
        <div className="absolute left-1/2 top-0 h-full w-px bg-muted-foreground/50" />
        <div
          className={cn("absolute top-0 h-full rounded", isOver ? "left-1/2 bg-success" : "right-1/2 bg-destructive")}
          style={{ width: `${widthPct}%` }}
        />
      </div>
      <span
        className={cn(
          "w-12 text-right font-mono text-[10px] tabular-nums",
          isMaterial ? (isOver ? "text-success" : "text-destructive") : "text-muted-foreground",
        )}
      >
        {drift >= 0 ? "+" : ""}{drift.toFixed(2)}
      </span>
    </div>
  );
}
