"use client";

import { useQuery } from "@tanstack/react-query";
import { AlertCircle } from "lucide-react";

import { GlassKpi, GlassSection, PageCanvas } from "@/components/oems/primitives/glass";
import { Pill } from "@/components/oems/primitives/pill";
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

function GlassKpiSkeleton() {
  return <div className="glass-kpi h-[88px] animate-pulse bg-[hsl(var(--foreground)/0.04)]" />;
}

function GlassTableShell({ children }: { children: React.ReactNode }) {
  return <div className="glass-inset overflow-hidden">{children}</div>;
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
      <PageCanvas>
        <header className="glass-panel p-5 md:p-6">
          <h1 className="text-display text-2xl">Money Market</h1>
          <p className="mt-1 text-caption">
            JIBAR · ZARONIA · NCD · T-Bill · FRN universe · weighted yield & duration
          </p>
        </header>
        <GlassSection
          title="Money market universe"
          endpoint="oems_strategy_c (kind=money_market) + money_market_instrument_c + jibar_fixing_c"
        >
          <EmptyDataState
            message="Mock mode disables the money-market module."
            hint="Switch to real-data mode and ensure the worker has written money_market_instrument_c + jibar_fixing_c rows."
            badgeLabel="mock"
          />
        </GlassSection>
      </PageCanvas>
    );
  }

  return (
    <PageCanvas>
      <header className="glass-panel relative overflow-hidden p-5 md:p-6">
        <div className="pointer-events-none absolute -right-16 -top-16 h-40 w-40 rounded-full bg-primary/10 blur-3xl" />
        <div className="relative">
          <h1 className="text-display text-2xl">Money Market</h1>
          <p className="mt-1 text-caption">
            JIBAR · ZARONIA · NCD · T-Bill · FRN universe · weighted yield & duration
          </p>
        </div>
      </header>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        {mmQ.isLoading || saRatesQ.isLoading ? (
          [0, 1, 2, 3, 4].map((n) => <GlassKpiSkeleton key={`mm-kpi-${n}`} />)
        ) : (
          <>
            <GlassKpi
              label="SARB Repo"
              value={fmtRate(sa?.repo)}
              sub={sa?.repo?.asOf ? sa.repo.asOf.slice(0, 10) : "SARB"}
              accent="primary"
            />
            <GlassKpi label="Prime" value={fmtRate(sa?.prime)} sub="SARB" />
            <GlassKpi
              label="ZARONIA"
              value={fmtRate(sa?.zaronia)}
              sub={sa?.zaronia?.asOf ? sa.zaronia.asOf.slice(0, 10) : "overnight · SARB"}
            />
            <GlassKpi label="Sabor" value={fmtRate(sa?.sabor)} sub="overnight · SARB" />
            <GlassKpi
              label="MM instruments"
              value={instruments.length.toString()}
              sub="eligible NCD/TB/FRN"
            />
          </>
        )}
      </div>

      {!hasData && !mmQ.isLoading && (
        <GlassSection title="Money market universe" endpoint="GET /api/money-market" dataSource="unconfigured">
          <EmptyDataState
            message="Benchmark rates are live from SARB (above)."
            hint="The JIBAR term-fixing curve (3M/6M/12M) and the NCD / T-Bill / FRN instrument universe still need a JSE or money-market vendor feed — SARB publishes the overnight benchmarks (repo, prime, ZARONIA, Sabor) but not the term fixings or instrument list."
          />
        </GlassSection>
      )}

      {hasData && (
        <div className="grid grid-cols-12 gap-3">
          <GlassSection
            title="JIBAR fixings"
            endpoint="jibar_fixing_c"
            dataSource="supabase"
            className="col-span-12 lg:col-span-4"
            noPadding
          >
            {jibar.length === 0 ? (
              <div className="p-5">
                <EmptyDataState message="No JIBAR fixings ingested." />
              </div>
            ) : (
              <GlassTableShell>
                <table className="w-full font-mono text-xs">
                  <tbody>
                    {jibar.map((f) => (
                      <tr
                        key={`${f.tenor}-${f.rateDate}`}
                        className="border-b border-[hsl(var(--glass-border))]/60 transition-colors last:border-0 hover:bg-[hsl(var(--primary)/0.04)]"
                      >
                        <td className="px-4 py-2.5 font-semibold">{f.tenor}</td>
                        <td className="px-4 py-2.5 text-right tabular-nums">{f.rate.toFixed(2)}%</td>
                        <td
                          className={cn(
                            "px-4 py-2.5 text-right font-mono text-[10px]",
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
              </GlassTableShell>
            )}
          </GlassSection>

          <GlassSection
            title="Eligible money-market instruments"
            endpoint="money_market_instrument_c"
            dataSource="supabase"
            className="col-span-12 lg:col-span-8"
            noPadding
            right={
              <Pill tone="primary" size="xs">
                {instruments.length} ELIGIBLE
              </Pill>
            }
          >
            {instruments.length === 0 ? (
              <div className="p-5">
                <EmptyDataState
                  message="No MM instruments ingested."
                  hint="The worker writes rows to money_market_instrument_c — wire the IRESS rate entitlement or a vendor feed to populate."
                />
              </div>
            ) : (
              <GlassTableShell>
                <div className="overflow-x-auto scrollbar-thin">
                  <table className="w-full min-w-[640px] font-mono text-xs">
                    <thead>
                      <tr className="border-b border-[hsl(var(--glass-border))] bg-[hsl(var(--foreground)/0.02)] text-[9.5px] uppercase tracking-wider text-muted-foreground">
                        <th className="px-4 py-2.5 text-left font-medium">Ticker</th>
                        <th className="px-4 py-2.5 text-left font-medium">Type</th>
                        <th className="px-4 py-2.5 text-left font-medium">Issuer</th>
                        <th className="px-4 py-2.5 text-left font-medium">Tenor</th>
                        <th className="px-4 py-2.5 text-left font-medium">Rating</th>
                        <th className="px-4 py-2.5 text-right font-medium">Yield</th>
                        <th className="px-4 py-2.5 text-right font-medium">Duration</th>
                        <th className="px-4 py-2.5 text-right font-medium">Notional</th>
                      </tr>
                    </thead>
                    <tbody>
                      {instruments.map((i) => (
                        <tr
                          key={i.ticker}
                          className="border-b border-[hsl(var(--glass-border))]/60 transition-colors last:border-0 hover:bg-[hsl(var(--primary)/0.04)]"
                        >
                          <td className="px-4 py-2 font-semibold">{i.ticker}</td>
                          <td className="px-4 py-2">
                            <Pill tone="neutral" size="xs">
                              {i.type}
                            </Pill>
                          </td>
                          <td className="px-4 py-2 text-muted-foreground">{i.issuer}</td>
                          <td className="px-4 py-2">{i.tenor}</td>
                          <td className="px-4 py-2">
                            <Pill tone={i.rating.startsWith("AA") ? "success" : "warning"} size="xs">
                              {i.rating}
                            </Pill>
                          </td>
                          <td className="px-4 py-2 text-right font-semibold tabular-nums">{i.yield.toFixed(2)}%</td>
                          <td className="px-4 py-2 text-right text-muted-foreground tabular-nums">
                            {i.duration.toFixed(2)}y
                          </td>
                          <td className="px-4 py-2 text-right tabular-nums">{formatZAR(i.notional)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </GlassTableShell>
            )}
          </GlassSection>
        </div>
      )}

      <div className="glass-panel border-info/30 p-4 text-[11.5px]">
        <p className="flex items-center gap-2 font-semibold text-info">
          <AlertCircle className="h-3.5 w-3.5" />
          Money market is a separate OEMS surface
        </p>
        <p className="mt-1 text-muted-foreground">
          The Money Market module is a thin view over the same IPS portfolio. MM-only mandates live in{" "}
          <span className="font-mono">oems_strategy_c</span> with{" "}
          <span className="font-mono">asset_class = &quot;money_market&quot;</span>; the audit-grade rebalance state is
          the same as the equity strategies view.
        </p>
        <p className="mt-2 text-muted-foreground">
          →{" "}
          <a href="/strategies" className="text-primary hover:underline">
            See Strategies page
          </a>{" "}
          for MM mandates.
        </p>
      </div>
    </PageCanvas>
  );
}
