"use client";

import { useQuery } from "@tanstack/react-query";
import { Banknote, TrendingUp, ShieldCheck, AlertCircle } from "lucide-react";

import { Panel } from "@/components/oems/primitives/panel";
import { KpiTile } from "@/components/oems/primitives/kpi-tile";
import { Pill } from "@/components/oems/primitives/pill";
import { PanelSkeleton, KpiTileSkeleton } from "@/components/oems/primitives/panel-skeleton";
import { EmptyDataState } from "@/components/oems/primitives/empty-data-state";
import { isRealDataOnlyClient } from "@/lib/data-policy";
import { formatZAR } from "@/lib/format";
import { cn } from "@/lib/cn";
import { queryOpts } from "@/lib/store/query-provider";

interface InstrumentRow {
  ticker: string;
  name: string;
  type: string;
  issuer: string;
  tenor: string;
  rating: string;
  yield: number;
  duration: number;
  notional: number;
  maturity: string;
}

interface JibarRow {
  tenor: string;
  rate: number;
  change: number;
  rateDate: string;
}

interface MoneyMarketResponse {
  instruments: InstrumentRow[];
  jibar: JibarRow[];
  source: string;
  message?: string;
}

export default function MoneyMarketPage() {
  const realDataOnly = isRealDataOnlyClient();
  const mmQ = useQuery<MoneyMarketResponse>({
    queryKey: ["bff-money-market"],
    queryFn: async () => {
      const r = await fetch("/api/money-market", { cache: "no-store" });
      if (!r.ok) throw new Error(`MM BFF ${r.status}`);
      return r.json();
    },
    enabled: realDataOnly,
    refetchInterval: 60_000,
    ...queryOpts("reference"),
  });
  // SARB benchmarks (repo / prime / ZARONIA / Sabor) — real money-market rates.
  // IRESS has no rates feed; JIBAR term fixings + the NCD/T-Bill instrument
  // universe still need a vendor, so those tables stay honest empty states.
  type SaRate = { label: string; value: number | null; asOf: string | null } | null;
  const saRatesQ = useQuery<{ source: string; sourceLabel?: string; rates: Record<string, SaRate> }>({
    queryKey: ["bff-sa-rates"],
    queryFn: async () => {
      const r = await fetch("/api/sa-rates", { cache: "no-store" });
      if (!r.ok) throw new Error(`sa-rates ${r.status}`);
      return r.json();
    },
    enabled: realDataOnly,
    refetchInterval: 3_600_000,
    ...queryOpts("reference"),
  });
  const sa = saRatesQ.data?.rates;
  const fmtRate = (r: SaRate | undefined) => (r && r.value != null ? `${r.value.toFixed(2)}%` : "—");

  const instruments = mmQ.data?.instruments ?? [];
  const jibar = mmQ.data?.jibar ?? [];
  const hasData = instruments.length > 0 || jibar.length > 0;

  if (!realDataOnly) {
    return (
      <div className="space-y-3">
        <header>
          <h1 className="text-lg font-semibold tracking-tight">Money Market</h1>
          <p className="text-xs text-muted-foreground">JIBAR · ZARONIA · NCD · T-Bill · FRN universe · weighted yield & duration</p>
        </header>
        <Panel title="Money market universe" endpoint="oems_strategy_c (kind=money_market) + money_market_instrument_c + jibar_fixing_c">
          <EmptyDataState
            message="Mock mode disables the money-market module."
            hint="Switch to real-data mode and ensure the worker has written money_market_instrument_c + jibar_fixing_c rows."
            badgeLabel="mock"
          />
        </Panel>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <header>
        <h1 className="text-lg font-semibold tracking-tight">Money Market</h1>
        <p className="text-xs text-muted-foreground">JIBAR · ZARONIA · NCD · T-Bill · FRN universe · weighted yield & duration</p>
      </header>

      <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-5">
        {mmQ.isLoading || saRatesQ.isLoading ? (
          [0, 1, 2, 3, 4].map((n) => <KpiTileSkeleton key={`mm-kpi-${n}`} />)
        ) : (
          <>
            <KpiTile icon={<Banknote className="h-3.5 w-3.5" />} label="SARB Repo" value={fmtRate(sa?.repo)} sub={sa?.repo?.asOf ? sa.repo.asOf.slice(0, 10) : "SARB"} />
            <KpiTile icon={<TrendingUp className="h-3.5 w-3.5" />} label="Prime" value={fmtRate(sa?.prime)} sub="SARB" />
            <KpiTile icon={<TrendingUp className="h-3.5 w-3.5" />} label="ZARONIA" value={fmtRate(sa?.zaronia)} sub={sa?.zaronia?.asOf ? sa.zaronia.asOf.slice(0, 10) : "overnight · SARB"} />
            <KpiTile icon={<TrendingUp className="h-3.5 w-3.5" />} label="Sabor" value={fmtRate(sa?.sabor)} sub="overnight · SARB" />
            <KpiTile icon={<ShieldCheck className="h-3.5 w-3.5" />} label="MM instruments" value={instruments.length.toString()} sub="eligible NCD/TB/FRN" />
          </>
        )}
      </div>

      {!hasData && !mmQ.isLoading && (
        <Panel
          title="Money market universe"
          endpoint="GET /api/money-market"
          dataSource="unconfigured"
        >
          <EmptyDataState
            message="Benchmark rates are live from SARB (above)."
            hint="The JIBAR term-fixing curve (3M/6M/12M) and the NCD / T-Bill / FRN instrument universe still need a JSE or money-market vendor feed — SARB publishes the overnight benchmarks (repo, prime, ZARONIA, Sabor) but not the term fixings or instrument list."
          />
        </Panel>
      )}

      {hasData && (
        <div className="grid grid-cols-12 gap-2.5">
          <Panel
            title="JIBAR fixings"
            endpoint="jibar_fixing_c"
            dataSource="supabase"
            className="col-span-12 lg:col-span-4"
          >
            {jibar.length === 0 ? (
              <EmptyDataState message="No JIBAR fixings ingested." />
            ) : (
              <table className="w-full font-mono text-xs">
                <tbody className="divide-y divide-border/60">
                  {jibar.map((f) => (
                    <tr key={`${f.tenor}-${f.rateDate}`}>
                      <td className="px-3 py-2 font-semibold">{f.tenor}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{f.rate.toFixed(2)}%</td>
                      <td
                        className={cn(
                          "px-3 py-2 text-right font-mono text-[10px]",
                          f.change > 0 ? "text-success" : f.change < 0 ? "text-destructive" : "text-muted-foreground",
                        )}
                      >
                        {f.change > 0 ? "+" : ""}
                        {(f.change * 100).toFixed(0)}bp
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Panel>

          <Panel
            title="Eligible money-market instruments"
            endpoint="money_market_instrument_c"
            dataSource="supabase"
            className="col-span-12 lg:col-span-8"
            right={
              <Pill tone="primary" size="xs">
                {instruments.length} ELIGIBLE
              </Pill>
            }
          >
            {instruments.length === 0 ? (
              <EmptyDataState message="No MM instruments ingested." hint="The worker writes rows to money_market_instrument_c — wire the IRESS rate entitlement or a vendor feed to populate." />
            ) : (
              <table className="w-full font-mono text-xs">
                <thead>
                  <tr className="text-[9.5px] uppercase tracking-wider text-muted-foreground">
                    <th className="px-3 py-2 text-left">Ticker</th>
                    <th className="px-3 py-2 text-left">Type</th>
                    <th className="px-3 py-2 text-left">Issuer</th>
                    <th className="px-3 py-2 text-left">Tenor</th>
                    <th className="px-3 py-2 text-left">Rating</th>
                    <th className="px-3 py-2 text-right">Yield</th>
                    <th className="px-3 py-2 text-right">Duration</th>
                    <th className="px-3 py-2 text-right">Notional</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/60">
                  {instruments.map((i) => (
                    <tr key={i.ticker} className="hover:bg-muted/30">
                      <td className="px-3 py-1.5 font-semibold">{i.ticker}</td>
                      <td className="px-3 py-1.5">
                        <Pill tone="neutral" size="xs">
                          {i.type}
                        </Pill>
                      </td>
                      <td className="px-3 py-1.5 text-muted-foreground">{i.issuer}</td>
                      <td className="px-3 py-1.5">{i.tenor}</td>
                      <td className="px-3 py-1.5">
                        <Pill tone={i.rating.startsWith("AA") ? "success" : "warning"} size="xs">
                          {i.rating}
                        </Pill>
                      </td>
                      <td className="px-3 py-1.5 text-right font-semibold tabular-nums">{i.yield.toFixed(2)}%</td>
                      <td className="px-3 py-1.5 text-right text-muted-foreground tabular-nums">{i.duration.toFixed(2)}y</td>
                      <td className="px-3 py-1.5 text-right tabular-nums">{formatZAR(i.notional)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Panel>
        </div>
      )}

      {/* Yellow #13 — per-mandate aggregates panel was deleted. The
          "MM is a thin view" info box below already explains the
          relationship to the Strategies page; the panel was a
          code-gap note for an unimplemented surface. Replaced with
          a single sub-link that points the operator to the
          Strategies page for MM mandates. */}
      <div className="rounded-md border border-info/30 bg-info/5 p-3 text-[11.5px] text-info">
        <p className="flex items-center gap-2 font-semibold">
          <AlertCircle className="h-3.5 w-3.5" />
          Money market is a separate OEMS surface
        </p>
        <p className="mt-1 text-muted-foreground">
          The Money Market module is a thin view over the same IPS portfolio. MM-only mandates live in <span className="font-mono">oems_strategy_c</span> with <span className="font-mono">asset_class = "money_market"</span>; the audit-grade rebalance state is the same as the equity strategies view.
        </p>
        <p className="mt-2 text-muted-foreground">
          → <a href="/oems/strategies" className="text-primary hover:underline">See Strategies page</a> for MM mandates.
        </p>
      </div>
    </div>
  );
}
