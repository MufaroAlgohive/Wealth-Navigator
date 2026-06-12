"use client";

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { TrendingUp, ShieldCheck } from "lucide-react";

import { Panel } from "@/components/oems/primitives/panel";
import { KpiTile } from "@/components/oems/primitives/kpi-tile";
import { NumberCell } from "@/components/oems/primitives/number-cell";
import { Pill } from "@/components/oems/primitives/pill";
import { EmptyDataState } from "@/components/oems/primitives/empty-data-state";
import { PanelSkeleton, KpiTileSkeleton } from "@/components/oems/primitives/panel-skeleton";
import { Button } from "@/components/ui/button";
import { useIress } from "@/lib/iress/provider";
import { canRebalance } from "@/lib/iress/strategy";
import { seedLastFor } from "@/lib/iress/seed";
import { isRealDataOnlyClient } from "@/lib/data-policy";
import { formatPct, formatZAR, formatNumber } from "@/lib/format";
import { useLiveQuotes } from "@/lib/hooks/use-live-quotes";
import { useTick } from "@/lib/store/tick-stream-provider";
import { cn } from "@/lib/cn";
import { queryOpts } from "@/lib/store/query-provider";

export default function EquitiesPage() {
  const { data } = useIress();
  const realDataOnly = isRealDataOnlyClient();
  const strategiesQ = useQuery({
    queryKey: ["strategies"],
    queryFn: () => data.strategies(),
    enabled: !realDataOnly,
    ...queryOpts("live"),
  });
  const equitiesQ = useQuery({ queryKey: ["equities"], queryFn: () => data.jseEquities(), ...queryOpts("reference") });
  const strategies = (strategiesQ.data ?? []).filter((s) => s.kind === "equity");
  const equities = equitiesQ.data ?? [];
  const symbols = useMemo(() => equities.map((e) => e.symbol), [equities]);
  const liveQuotes = useLiveQuotes(symbols, symbols.length > 0);

  const totalAum = strategies.reduce((s, x) => s + x.aum, 0);
  const totalPnl = strategies.reduce((s, x) => s + x.dayPnl, 0);
  const investors = strategies.reduce((s, x) => s + x.investorCount, 0);

  return (
    <div className="space-y-3">
      <header>
        <h1 className="text-lg font-semibold tracking-tight">Equities</h1>
        <p className="text-xs text-muted-foreground">JSE mandates · L1 quotes · pre-trade compliance via IRESS</p>
      </header>

      {realDataOnly ? (
        <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-4">
          <Panel title="Equity mandates" endpoint="Portfolio system" className="col-span-2 lg:col-span-4">
            <EmptyDataState message="Platform AUM / mandate KPIs require portfolio system integration." />
          </Panel>
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-4">
          {strategiesQ.isLoading ? (
            [0, 1, 2, 3].map((n) => <KpiTileSkeleton key={`equity-kpi-${n}`} />)
          ) : (
            <>
              <KpiTile icon={<TrendingUp className="h-3.5 w-3.5" />} label="Equity AUM" value={formatZAR(totalAum)} sub={`${strategies.length} mandates`} />
              <KpiTile
                icon={<TrendingUp className="h-3.5 w-3.5" />}
                label="Day P&L"
                value={formatZAR(totalPnl)}
                sub={formatPct((totalPnl / (totalAum || 1)) * 100, 3)}
                tone={totalPnl >= 0 ? "positive" : "negative"}
              />
              <KpiTile icon={<ShieldCheck className="h-3.5 w-3.5" />} label="Investors" value={investors.toString()} sub="across all equity mandates" />
              <KpiTile icon={<ShieldCheck className="h-3.5 w-3.5" />} label="Pre-trade checks" value="LIVE" sub="IRESS halt / borrow / non-tradeable" />
            </>
          )}
        </div>
      )}

      {!realDataOnly && (
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
          {strategiesQ.isLoading ? (
            [0, 1, 2].map((n) => (
              <PanelSkeleton key={`equity-card-${n}`} rows={6} />
            ))
          ) : (
            strategies.map((s) => {
              const rebal = canRebalance(s);
              return (
                <Panel
                  key={s.id}
                  title={s.name}
                  endpoint="GET /v1/positions?strategy={id}"
                  right={
                    <Pill tone={s.status === "live" ? "success" : "neutral"} size="xs" dot>
                      {s.status}
                    </Pill>
                  }
                >
                  <div className="grid grid-cols-3 gap-2 text-xs">
                    <Stat label="AUM" value={s.aum > 0 ? formatZAR(s.aum) : "—"} />
                    <Stat label="YTD" value={formatPct(s.ytd)} positive={s.ytd >= 0} />
                    <Stat label="Sharpe" value={s.sharpe.toFixed(2)} />
                    <Stat label="Max DD" value={formatPct(s.maxDD)} negative />
                    <Stat label="TE" value={s.trackingError ? `${s.trackingError.toFixed(1)}%` : "—"} />
                    <Stat label="Investors" value={s.investorCount.toString()} />
                    <Stat label="Cash" value={`${s.cashWeight.toFixed(1)}%`} />
                    <Stat label="Holdings" value={s.holdingsCount.toString()} />
                    <Stat label="Last rebal" value={s.lastRebalanced} />
                  </div>
                  <div className="mt-3 flex items-center justify-between border-t border-border/60 pt-2.5 text-[10.5px]">
                    <span className="font-mono text-muted-foreground">bench {s.benchmark}</span>
                    <Button size="sm" variant={rebal ? "default" : "outline"} disabled={!rebal} className="h-6 px-2 text-[10px]">
                      {rebal ? "Rebalance" : "Locked"}
                    </Button>
                  </div>
                </Panel>
              );
            })
          )}
        </div>
      )}

      <Panel
        title="JSE · Top 10 JSE-listed names"
        endpoint={realDataOnly ? "GET /api/quotes" : "GET /v1/securities/quotes?exchange=JSE"}
        dataSource={realDataOnly ? liveQuotes.dataSource : undefined}
        right={<Pill tone={realDataOnly ? "primary" : "success"} size="xs" dot>{realDataOnly ? "SUPABASE · L1" : "LIVE · L1"}</Pill>}
      >
        {equitiesQ.isLoading || (realDataOnly && liveQuotes.isLoading) ? (
          <div className="space-y-1.5" aria-busy="true" aria-live="polite">
            {[0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => (
              <div key={`equity-row-${n}`} className="flex items-center gap-3 px-2.5 py-1.5">
                <span className="shimmer h-2.5 w-12 rounded" />
                <span className="shimmer h-2.5 w-28 rounded" />
                <span className="shimmer h-2.5 w-20 rounded" />
                <span className="ml-auto shimmer h-2.5 w-16 rounded" />
                <span className="shimmer h-2.5 w-16 rounded" />
                <span className="shimmer h-2.5 w-20 rounded" />
                <span className="shimmer h-2.5 w-20 rounded" />
                <span className="shimmer h-2.5 w-14 rounded" />
              </div>
            ))}
          </div>
        ) : (
          <table className="w-full font-mono text-xs">
            <thead>
              <tr className="text-[9.5px] uppercase tracking-wider text-muted-foreground">
                <th className="px-2.5 py-2 text-left">Sym</th>
                <th className="px-2.5 py-2 text-left">Name</th>
                <th className="px-2.5 py-2 text-left">Sector</th>
                <th className="px-2.5 py-2 text-right">Last</th>
                <th className="px-2.5 py-2 text-right">Bid / Ask</th>
                <th className="px-2.5 py-2 text-right">VWAP</th>
                <th className="px-2.5 py-2 text-right">Volume</th>
                <th className="px-2.5 py-2 text-right">Chg</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/60">
              {equities.map((e) => (
                <EquityRow key={e.symbol} symbol={e.symbol} name={e.name} sector={e.sector} realDataOnly={realDataOnly} />
              ))}
            </tbody>
          </table>
        )}
      </Panel>
    </div>
  );
}

function EquityRow({
  symbol,
  name,
  sector,
  realDataOnly,
}: {
  symbol: string;
  name: string;
  sector: string;
  realDataOnly: boolean;
}) {
  const tick = useTick(symbol);
  const ref = realDataOnly ? 0 : seedLastFor(symbol);
  const vwap = tick.ts > 0 ? tick.vwap : ref;
  const volume = tick.ts > 0 ? tick.volume : null;

  return (
    <tr className="hover:bg-muted/30">
      <td className="px-2.5 py-1.5 font-semibold">{symbol}</td>
      <td className="px-2.5 py-1.5 text-muted-foreground">{name}</td>
      <td className="px-2.5 py-1.5 text-muted-foreground">{sector}</td>
      <td className="px-2.5 py-1.5 text-right tabular-nums">
        <NumberCell sym={symbol} fallback={ref} decimals={2} />
      </td>
      <td className="px-2.5 py-1.5 text-right tabular-nums text-muted-foreground">
        {realDataOnly ? (
          "— / —"
        ) : (
          <>
            <span className="text-up">{(ref * 0.9997).toFixed(2)}</span> / <span className="text-down">{(ref * 1.0003).toFixed(2)}</span>
          </>
        )}
      </td>
      <td className="px-2.5 py-1.5 text-right tabular-nums">
        {realDataOnly && tick.ts === 0 ? "—" : formatNumber(vwap)}
      </td>
      <td className="px-2.5 py-1.5 text-right tabular-nums text-muted-foreground">
        {volume != null && volume > 0 ? formatNumber(volume) : "—"}
      </td>
      <td className="px-2.5 py-1.5 text-right">
        <NumberCell sym={symbol} fallback={ref} decimals={2} showChange size="xs" />
      </td>
    </tr>
  );
}

function Stat({ label, value, positive, negative }: { label: string; value: string; positive?: boolean; negative?: boolean }) {
  return (
    <div>
      <p className="text-[9.5px] uppercase tracking-wider text-muted-foreground">{label}</p>
      <p className={cn("mt-0.5 font-mono text-xs font-semibold", positive && "text-up", negative && "text-down")}>{value}</p>
    </div>
  );
}
