"use client";

import { useMemo, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Search } from "lucide-react";
import Link from "next/link";

import { GlassSection, GlassKpi, GlassBadge } from "@/components/oems/primitives/glass";
import { NumberCell } from "@/components/oems/primitives/number-cell";
import { Input } from "@/components/ui/input";
import { Pill } from "@/components/oems/primitives/pill";
import { EmptyDataState } from "@/components/oems/primitives/empty-data-state";
import { PanelSkeleton, KpiTileSkeleton } from "@/components/oems/primitives/panel-skeleton";
import { Button } from "@/components/ui/button";
import { useIress } from "@/lib/iress/provider";
import { canRebalance } from "@/lib/iress/strategy";
import { seedLastFor } from "@/lib/iress/seed";
import { isRealDataOnlyClient } from "@/lib/data-policy";
import { mapSource } from "@/lib/data-source";
import { formatPct, formatZAR, formatNumber } from "@/lib/format";
import { useLiveQuotes } from "@/lib/hooks/use-live-quotes";
import { useTick } from "@/lib/store/tick-stream-provider";
import { usePortfolio } from "@/lib/hooks/use-portfolio";
import { cn } from "@/lib/cn";
import { queryOpts } from "@/lib/store/query-provider";
import { JSE_TRACKED_UNIVERSE } from "@/lib/iress/universe";
import type { BffUnavailableReason } from "@/lib/bff-reasons";

// --- Real-data JSE universe (GET /api/equities → retail securities_c) ---------

interface UniverseSecurity {
  symbol: string;
  name: string | null;
  sector: string | null;
  industry: string | null;
  /** INTEGER CENTS — divide by 100 for Rands. */
  last_price: number | null;
  change_price: number | null;
  change_percent: number | null;
  pe: number | null;
  eps: number | null;
  dividend_yield: number | null;
  beta: number | null;
  market_cap: number | null;
  isin: string | null;
  ytd_performance: number | null;
  /** Trailing returns — populated when the worker writes period returns. */
  return_1m?: number | null;
  return_6m?: number | null;
  is_active: boolean | null;
  /** "iress" when last+change were overlaid from live IRESS, else "yahoo". */
  price_source?: "iress" | "yahoo";
}

interface EquitiesUniverseResponse {
  source: "hybrid" | "yahoo" | "unavailable";
  count: number;
  /** How many board rows had price/change overlaid from live IRESS. */
  iressOverlay?: number;
  securities: UniverseSecurity[];
  sectors: { sector: string; count: number; avgChangePct: number; totalMarketCap: number }[];
  reason?: BffUnavailableReason;
  migration?: string;
  error?: string;
}

/** Strip the `.JO` exchange suffix for display (e.g. "NPN.JO" → "NPN"). */
function bareSymbol(symbol: string): string {
  return symbol.replace(/\.JO$/i, "");
}

async function fetchEquitiesUniverse(): Promise<EquitiesUniverseResponse> {
  const res = await fetch("/api/equities");
  const data = (await res.json()) as EquitiesUniverseResponse;
  // The BFF returns 200 even when unavailable (so the UI can render an honest
  // empty state with the reason); only throw on an unexpected transport error.
  if (!res.ok && data.source == null) throw new Error(data.error ?? `equities ${res.status}`);
  return data;
}

export default function EquitiesPage() {
  const { data } = useIress();
  const realDataOnly = isRealDataOnlyClient();
  const [q, setQ] = useState("");
  const strategiesQ = useQuery({
    queryKey: ["strategies"],
    queryFn: () => data.strategies(),
    enabled: !realDataOnly,
    ...queryOpts("live"),
  });
  const equitiesQ = useQuery({ queryKey: ["equities"], queryFn: () => data.jseEquities(), ...queryOpts("reference") });
  // Real-data mode — the full retail-backed JSE universe (246 names) via the
  // `/api/equities` BFF (reads `securities_c`). Static reference data with its
  // own last_price (INTEGER CENTS) + change_percent; not the live tick stream.
  // Mock mode never fetches this (gated by `enabled`).
  const equitiesUniverseQ = useQuery<EquitiesUniverseResponse>({
    queryKey: ["equities-universe"],
    queryFn: fetchEquitiesUniverse,
    enabled: realDataOnly,
    ...queryOpts("reference"),
  });
  // Sorted by bare symbol for a stable A→Z table (BFF already orders by the
  // `.JO`-suffixed symbol; sort defensively on the stripped display symbol).
  const universeRows = useMemo(() => {
    const rows = equitiesUniverseQ.data?.securities ?? [];
    return [...rows].sort((a, b) => bareSymbol(a.symbol).localeCompare(bareSymbol(b.symbol)));
  }, [equitiesUniverseQ.data]);
  const equitiesAvailable = !!equitiesUniverseQ.data && equitiesUniverseQ.data.source !== "unavailable";
  const topMovers = useMemo(() => {
    if (!realDataOnly || !equitiesAvailable) return [];
    const withChange = (equitiesUniverseQ.data?.securities ?? []).filter((s) =>
      Number.isFinite(s.change_percent),
    );
    const gainers = [...withChange]
      .sort((a, b) => (b.change_percent ?? 0) - (a.change_percent ?? 0))
      .slice(0, 4);
    const losers = [...withChange]
      .sort((a, b) => (a.change_percent ?? 0) - (b.change_percent ?? 0))
      .slice(0, 4)
      .reverse();
    const seen = new Set<string>();
    return [...gainers, ...losers].filter((s) => {
      if (seen.has(s.symbol)) return false;
      seen.add(s.symbol);
      return true;
    });
  }, [realDataOnly, equitiesAvailable, equitiesUniverseQ.data]);
  const strategies = (strategiesQ.data ?? []).filter((s) => s.kind === "equity");
  // Audit #9 — limit the equities list to the shared JSE universe
  // (10 names) so the worker / UI agree on coverage. The IRESS
  // provider returns a Top-40 list in mock mode; we slice to the
  // first 10 to keep the table aligned with the worker's default
  // watchlist.
  const equities = useMemo(() => {
    const all = equitiesQ.data ?? [];
    if (!realDataOnly) return all.slice(0, 10);
    // In real-data mode the JSE_TRACKED_UNIVERSE ordering is the
    // contract — match the worker coverage exactly.
    const orderByUniverse = JSE_TRACKED_UNIVERSE.map((e) => e.symbol);
    return all
      .filter((e) => orderByUniverse.includes(e.symbol))
      .sort((a, b) => orderByUniverse.indexOf(a.symbol) - orderByUniverse.indexOf(b.symbol));
  }, [equitiesQ.data, realDataOnly]);
  const symbols = useMemo(() => equities.map((e) => e.symbol), [equities]);
  const liveQuotes = useLiveQuotes(symbols, symbols.length > 0);
  // Audit #34 — read equity KPIs from the same /api/portfolio BFF the
  // Cockpit uses. NOTE (v1): /api/portfolio does NOT filter by asset
  // class — `oems_position_c` has no asset_class column — so these KPIs
  // are portfolio-wide, not equity-only. Treat "Equity AUM/P&L" as the
  // whole book until per-asset-class classification (security_code →
  // securities_c.asset_type) is wired. The BFF still surfaces the
  // cause-based reason when the portfolio migration hasn't been applied.
  const portfolioQ = usePortfolio(realDataOnly);

  const totalAum = strategies.reduce((s, x) => s + x.aum, 0);
  const totalPnl = strategies.reduce((s, x) => s + x.dayPnl, 0);
  const investors = strategies.reduce((s, x) => s + x.investorCount, 0);
  // Real-data aggregation: sum the equity leg of /api/portfolio. The
  // BFF returns positions/accounts; in v1 we sum the open_pl + market_value
  // across all positions and count distinct accounts.
  const realEquityAum = useMemo(() => {
    if (portfolioQ.data?.source !== "supabase") return 0;
    return (portfolioQ.data.positions ?? []).reduce((acc, p) => acc + (Number(p.market_value) || 0), 0);
  }, [portfolioQ.data]);
  // Open P&L is null when positions aren't marked (CT test data — /api/portfolio
  // suppresses open_pl). Sum only the marked legs; if none are marked the P&L is
  // unknown (null → "—"), never a fabricated R0.00.
  const realEquityPnl = useMemo<{ value: number | null; marked: number }>(() => {
    if (portfolioQ.data?.source !== "supabase") return { value: null, marked: 0 };
    const marked = (portfolioQ.data.positions ?? []).filter((p) => p.open_pl != null);
    if (marked.length === 0) return { value: null, marked: 0 };
    return { value: marked.reduce((acc, p) => acc + Number(p.open_pl), 0), marked: marked.length };
  }, [portfolioQ.data]);
  // Developer hint: when the BFF returns Supabase positions but none carry a mark yet,
  // the recent IRESS session didn't include a price for the open legs. Log once so the
  // operator can see why the "Open P&L" tile is showing "—" before they blame the page.
  if (typeof window !== "undefined" && portfolioQ.data?.source === "supabase" && realEquityPnl.value == null && realEquityPnl.marked === 0) {
    console.warn("[equities] no marks yet — recent IRESS session did not include a price for any open position.");
  }
  const realInvestors = (portfolioQ.data?.accounts ?? []).length;

  // Securities-universe search (Lonwabo: "all the securities here… you can just
  // search a particular security"). Filters the universe table by symbol / name / sector.
  const ql = q.trim().toLowerCase();
  const filteredUniverse = useMemo(
    () => (ql ? universeRows.filter((r) => `${bareSymbol(r.symbol)} ${r.name ?? ""} ${r.sector ?? ""}`.toLowerCase().includes(ql)) : universeRows),
    [universeRows, ql],
  );
  const filteredEquities = useMemo(
    () => (ql ? equities.filter((e) => `${e.symbol} ${e.name} ${e.sector}`.toLowerCase().includes(ql)) : equities),
    [equities, ql],
  );

  return (
    <div className="space-y-4 pb-6">
      <header className="glass-panel relative overflow-hidden p-5 md:p-6">
        <h1 className="text-display text-2xl md:text-3xl">Equities</h1>
        <p className="text-caption mt-1.5">JSE mandates · L1 quotes · pre-trade compliance via IRESS</p>
      </header>

      {realDataOnly ? (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {portfolioQ.isLoading ? (
            [0, 1, 2, 3].map((n) => <KpiTileSkeleton key={`equity-kpi-${n}`} />)
          ) : portfolioQ.data?.source === "supabase" ? (
            <>
              <GlassKpi
                label="Equity AUM"
                dataSource="hybrid"
                db="institutional"
                value={formatZAR(realEquityAum)}
                sub={`${(portfolioQ.data.positions ?? []).length} positions`}
              />
              <GlassKpi
                label="Open P&L"
                dataSource="hybrid"
                db="institutional"
                value={realEquityPnl.value != null ? formatZAR(realEquityPnl.value) : "—"}
                sub={
                  realEquityPnl.value != null
                    ? `MTM on ${realEquityPnl.marked} positions`
                    : "Marks unavailable — recent IRESS session did not include a price."
                }
                accent={realEquityPnl.value == null ? "default" : realEquityPnl.value >= 0 ? "positive" : "negative"}
              />
              <GlassKpi
                label="Investors"
                dataSource="supabase"
                db="institutional"
                value={realInvestors.toString()}
                sub={`${(portfolioQ.data.accounts ?? []).length} accounts`}
              />
              <GlassKpi label="Pre-trade checks" value="On submit" sub="IRESS halt / borrow / non-tradeable at order time" accent="primary" />
            </>
          ) : (
            <GlassSection title="Equity KPIs" endpoint="GET /api/portfolio" db="institutional" dataSource="supabase" className="col-span-2 lg:col-span-4">
              <EmptyDataState
                reason={portfolioQ.data?.reason ?? "supabase_query_failed"}
                migration={portfolioQ.data?.migration}
                errorDetail={portfolioQ.data?.error}
                title="Equity AUM unavailable"
                message="Run the Supabase migration listed below in the MyMint SQL editor to enable real-data equity KPIs."
              />
            </GlassSection>
          )}
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {strategiesQ.isLoading ? (
            [0, 1, 2, 3].map((n) => <KpiTileSkeleton key={`equity-kpi-${n}`} />)
          ) : (
            <>
              <GlassKpi label="Equity AUM" value={formatZAR(totalAum)} sub={`${strategies.length} mandates`} />
              <GlassKpi
                label="Day P&L"
                value={formatZAR(totalPnl)}
                sub={formatPct((totalPnl / (totalAum || 1)) * 100, 3)}
                accent={totalPnl >= 0 ? "positive" : "negative"}
              />
              <GlassKpi label="Investors" value={investors.toString()} sub="across all equity mandates" />
              <GlassKpi label="Pre-trade checks" value="LIVE" sub="IRESS halt / borrow / non-tradeable" accent="primary" />
            </>
          )}
        </div>
      )}

      {!realDataOnly && (
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
          {strategiesQ.isLoading ? (
            [0, 1, 2].map((n) => (
              <PanelSkeleton key={`equity-card-${n}`} rows={6} className="glass-panel" />
            ))
          ) : (
            strategies.map((s) => {
              const rebal = canRebalance(s);
              return (
                <GlassSection
                  key={s.id}
                  title={s.name}
                  endpoint="GET /v1/positions?strategy={id}"
                  db="retail"
                  dataSource="mock"
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
                  <div className="mt-3 flex items-center justify-between border-t border-[hsl(var(--glass-border))] pt-2.5 text-[10.5px]">
                    <span className="font-mono text-muted-foreground">bench {s.benchmark}</span>
                    <Button size="sm" variant={rebal ? "default" : "outline"} disabled={!rebal} className="h-6 px-2 text-[10px]">
                      {rebal ? "Rebalance" : "Locked"}
                    </Button>
                  </div>
                </GlassSection>
              );
            })
          )}
        </div>
      )}

      {/* Top Movers — the Sector Heatmap that used to sit beside this was a
          duplicate of the Cockpit's (now a treemap there); removed per Lonwabo. */}
      {realDataOnly ? (
        equitiesUniverseQ.isLoading ? (
          <PanelSkeleton rows={6} height="h-[260px]" className="glass-panel" />
        ) : equitiesAvailable && topMovers.length > 0 ? (
          <GlassSection title="Top Movers · JSE" endpoint="GET /api/equities" db="retail" dataSource={mapSource(equitiesUniverseQ.data?.source, "hybrid")} className="flex h-[260px] flex-col" noPadding>
            <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-5 scrollbar-thin">
              <RealMoversList movers={topMovers} />
            </div>
          </GlassSection>
        ) : (
          <GlassSection title="Top Movers · JSE" endpoint="GET /api/equities" db="retail" dataSource="supabase" className="h-[260px]">
            <EmptyDataState message="Equities board unavailable — retail securities feed returned no rows." />
          </GlassSection>
        )
      ) : equitiesQ.isLoading ? (
        <PanelSkeleton rows={6} height="h-[260px]" className="glass-panel" />
      ) : (
        <GlassSection title="Top Movers · JSE" endpoint="GET /v1/securities/quotes?exchange=JSE" db="retail" dataSource="mock" className="flex h-[260px] flex-col" noPadding>
          <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-5 scrollbar-thin">
            <MockMoversList equities={equities} />
          </div>
        </GlassSection>
      )}

      <GlassSection
        title={realDataOnly ? `Securities universe · ${filteredUniverse.length} names` : "Securities universe · JSE"}
        endpoint={realDataOnly ? "GET /api/equities" : "GET /v1/securities/quotes?exchange=JSE"}
        db="retail"
        dataSource={realDataOnly ? mapSource(equitiesUniverseQ.data?.source, "hybrid") : "mock"}
        right={
          <div className="flex items-center gap-2">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground" />
              <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search security…" className="h-7 w-44 pl-7 text-xs" />
            </div>
            <GlassBadge tone={realDataOnly ? "primary" : "success"}>
              {realDataOnly ? "SUPABASE · L1" : "LIVE · L1"}
            </GlassBadge>
          </div>
        }
        noPadding
      >
        <div className="space-y-3 px-5 pb-5">
          {realDataOnly ? (
            <p className="pt-5 text-[10.5px] text-muted-foreground">
              JSE securities data. Last-trade and day change shown.
              Bid, ask, vwap, and volume require a streaming market data feed.
            </p>
          ) : null}
          {realDataOnly ? (
            <RealEquitiesTable rows={filteredUniverse} isLoading={equitiesUniverseQ.isLoading} response={equitiesUniverseQ.data} />
          ) : equitiesQ.isLoading || (realDataOnly && liveQuotes.isLoading) ? (
            <TableSkeleton realDataOnly={realDataOnly} />
          ) : (
            <GlassInsetTable>
              <table className="w-full font-mono text-xs">
                <thead>
                  <tr className={GLASS_TABLE_HEAD}>
                    <th className="px-3 py-2.5 text-left text-caption font-medium">Sym</th>
                    <th className="px-3 py-2.5 text-left text-caption font-medium">Name</th>
                    <th className="px-3 py-2.5 text-left text-caption font-medium">Sector</th>
                    <th className="px-3 py-2.5 text-right text-caption font-medium">Last</th>
                    <th className="px-3 py-2.5 text-right text-caption font-medium">Bid / Ask</th>
                    <th className="px-3 py-2.5 text-right text-caption font-medium">VWAP</th>
                    <th className="px-3 py-2.5 text-right text-caption font-medium">Volume</th>
                    <th className="px-3 py-2.5 text-right text-caption font-medium">Chg</th>
                    <th className="px-3 py-2.5 text-right text-caption font-medium">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredEquities.map((e) => (
                    <EquityRow key={e.symbol} symbol={e.symbol} name={e.name} sector={e.sector} realDataOnly={realDataOnly} />
                  ))}
                </tbody>
              </table>
            </GlassInsetTable>
          )}
        </div>
      </GlassSection>
    </div>
  );
}

const GLASS_TABLE_HEAD = "border-b border-[hsl(var(--glass-border))] bg-[hsl(var(--foreground)/0.02)]";
const GLASS_TABLE_ROW = "border-b border-[hsl(var(--glass-border))]/60 transition-colors hover:bg-[hsl(var(--primary)/0.04)]";

function GlassInsetTable({ children }: { children: ReactNode }) {
  return <div className="glass-inset overflow-x-auto scrollbar-thin">{children}</div>;
}

function TableSkeleton({ realDataOnly }: { realDataOnly: boolean }) {
  return (
    <div className="glass-inset space-y-1.5 p-3" aria-busy="true" aria-live="polite">
      {[0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => (
        <div key={`equity-row-${n}`} className="flex items-center gap-3 px-2.5 py-1.5">
          <span className="shimmer h-2.5 w-12 rounded" />
          <span className="shimmer h-2.5 w-28 rounded" />
          <span className="shimmer h-2.5 w-20 rounded" />
          <span className="ml-auto shimmer h-2.5 w-16 rounded" />
          {!realDataOnly ? (
            <>
              <span className="shimmer h-2.5 w-16 rounded" />
              <span className="shimmer h-2.5 w-20 rounded" />
              <span className="shimmer h-2.5 w-20 rounded" />
            </>
          ) : null}
          <span className="shimmer h-2.5 w-14 rounded" />
        </div>
      ))}
    </div>
  );
}

function RealMoversList({ movers }: { movers: UniverseSecurity[] }) {
  return (
    <ul className="glass-inset divide-y divide-[hsl(var(--glass-border))]/60 overflow-hidden">
      {movers.map((m) => {
        const chg = m.change_percent ?? 0;
        const up = chg > 0;
        const down = chg < 0;
        const price = m.last_price != null ? m.last_price / 100 : null;
        return (
          <li
            key={m.symbol}
            className="flex items-center gap-2 px-3 py-2 transition-colors hover:bg-[hsl(var(--primary)/0.04)]"
          >
            <div className="min-w-0 flex-1">
              <p className="truncate font-mono text-xs font-semibold">{bareSymbol(m.symbol)}</p>
              <p className="truncate text-[9.5px] text-muted-foreground">{m.name ?? bareSymbol(m.symbol)}</p>
            </div>
            <span className="shrink-0 font-mono text-[11px] tabular-nums text-foreground">
              {price != null ? formatZAR(price) : "—"}
            </span>
            <span
              className={cn(
                "ml-1 shrink-0 font-mono text-[11px] tabular-nums",
                up ? "text-up" : down ? "text-down" : "text-muted-foreground",
              )}
            >
              {formatPct(chg)}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function MockMoversList({ equities }: { equities: { symbol: string; name: string }[] }) {
  return (
    <ul className="glass-inset divide-y divide-[hsl(var(--glass-border))]/60 overflow-hidden">
      {equities.slice(0, 7).map((m) => (
        <li
          key={m.symbol}
          className="flex items-center gap-2 px-3 py-2 transition-colors hover:bg-[hsl(var(--primary)/0.04)]"
        >
          <div className="min-w-0 flex-1">
            <p className="truncate font-mono text-xs font-semibold">{m.symbol}</p>
            <p className="truncate text-[9.5px] text-muted-foreground">{m.name}</p>
          </div>
          <NumberCell sym={m.symbol} fallback={0} decimals={2} size="xs" />
          <NumberCell sym={m.symbol} fallback={0} decimals={2} size="xs" showChange className="ml-1" />
        </li>
      ))}
    </ul>
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
  // Yellow #33 — render a small "no tick" pill in the Symbol column
  // when in real-data mode and the worker hasn't tick'd this symbol
  // yet. Visually distinct from a plain "—" so the operator can
  // see that the worker hasn't polled this name (BHG pattern, or
  // a hollow-row skip).
  const showNoTick = realDataOnly && tick.ts === 0;

  return (
    <tr className={GLASS_TABLE_ROW}>
      <td className="px-3 py-2 font-semibold">
        <span className="inline-flex items-center gap-1.5">
          {symbol}
          {showNoTick ? <Pill tone="neutral" size="xs">no tick</Pill> : null}
        </span>
      </td>
      <td className="px-3 py-2 text-muted-foreground">{name}</td>
      <td className="px-3 py-2 text-muted-foreground">{sector}</td>
      <td className="px-3 py-2 text-right tabular-nums">
        <NumberCell sym={symbol} fallback={ref} decimals={2} />
      </td>
      {realDataOnly ? null : (
        <>
          <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
            <>
              <span className="text-up">{(ref * 0.9997).toFixed(2)}</span> / <span className="text-down">{(ref * 1.0003).toFixed(2)}</span>
            </>
          </td>
          <td className="px-3 py-2 text-right tabular-nums">{formatNumber(vwap)}</td>
          <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
            {volume != null && volume > 0 ? formatNumber(volume) : "—"}
          </td>
        </>
      )}
      <td className="px-3 py-2 text-right">
        <NumberCell sym={symbol} fallback={ref} decimals={2} showChange size="xs" />
      </td>
      <td className="px-3 py-2 text-right">
        <Link
          href={`/oems/analysis/${symbol}` as never}
          className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground transition-colors hover:bg-[hsl(var(--primary)/0.08)] hover:text-primary"
          title="Open in Analysis"
        >
          ↗
        </Link>
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

/** A trailing-period return cell — green/red, or "—" until the worker writes it. */
function PeriodReturn({ v }: { v: number | null | undefined }) {
  if (v == null || !Number.isFinite(v)) return <span className="text-muted-foreground">—</span>;
  return <span className={cn("font-mono text-xs", v > 0 ? "text-up" : v < 0 ? "text-down" : "text-muted-foreground")}>{formatPct(v)}</span>;
}

/**
 * Real-data JSE table — renders the full retail `securities_c` universe from
 * the `/api/equities` BFF. Static reference data (last_price in INTEGER CENTS,
 * day change %), not the live tick stream. Handles loading + empty states.
 */
function RealEquitiesTable({
  rows,
  isLoading,
  response,
}: {
  rows: UniverseSecurity[];
  isLoading: boolean;
  response: EquitiesUniverseResponse | undefined;
}) {
  if (isLoading) {
    return <TableSkeleton realDataOnly={true} />;
  }

  if (rows.length === 0) {
    return (
      <EmptyDataState
        reason={response?.reason ?? "supabase_query_failed"}
        migration={response?.migration}
        errorDetail={response?.error}
        title="JSE universe unavailable"
        message="No JSE securities returned from the retail securities_c board. Check the Supabase migration / env listed below, then refresh."
      />
    );
  }

  const iressCount = response?.iressOverlay ?? rows.filter((r) => r.price_source === "iress").length;
  return (
    <>
      <p className="mb-2 text-[10.5px] text-muted-foreground">
        <span className="font-mono font-semibold text-up">{iressCount}</span> of{" "}
        <span className="font-mono">{rows.length}</span> priced live from IRESS (last + day change);
        the rest show the latest stored price. Fundamentals / market cap / sector come from the stored reference data.
      </p>
      <GlassInsetTable>
        <table className="w-full font-mono text-xs">
          <thead>
            <tr className={GLASS_TABLE_HEAD}>
              <th className="px-3 py-2.5 text-left text-caption font-medium">Sym</th>
              <th className="px-3 py-2.5 text-left text-caption font-medium">Name</th>
              <th className="px-3 py-2.5 text-left text-caption font-medium">Sector</th>
              <th className="px-3 py-2.5 text-right text-caption font-medium">Last</th>
              <th className="px-3 py-2.5 text-right text-caption font-medium">1D</th>
              <th className="px-3 py-2.5 text-right text-caption font-medium">1M</th>
              <th className="px-3 py-2.5 text-right text-caption font-medium">6M</th>
            <th className="px-3 py-2.5 text-center text-caption font-medium">Src</th>
            <th className="px-3 py-2.5 text-right text-caption font-medium">Action</th>
          </tr>
        </thead>
          <tbody>
            {rows.map((e) => {
              const sym = bareSymbol(e.symbol);
              const lastRands = e.last_price != null ? e.last_price / 100 : null;
              const chg = Number(e.change_percent);
              const hasChg = Number.isFinite(chg);
              const onIress = e.price_source === "iress";
              return (
                <tr key={e.symbol} className={GLASS_TABLE_ROW}>
                  <td className="px-3 py-2 font-semibold">{sym}</td>
                  <td className="px-3 py-2 text-muted-foreground">{e.name ?? "—"}</td>
                  <td className="px-3 py-2 text-muted-foreground">{e.sector ?? "—"}</td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {lastRands != null ? formatZAR(lastRands) : <span className="text-muted-foreground">—</span>}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {hasChg ? (
                      <span className={cn("font-mono text-xs", chg > 0 ? "text-up" : chg < 0 ? "text-down" : "text-muted-foreground")}>
                        {formatPct(chg)}
                      </span>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums"><PeriodReturn v={e.return_1m} /></td>
                  <td className="px-3 py-2 text-right tabular-nums"><PeriodReturn v={e.return_6m} /></td>
                  <td className="px-3 py-2 text-center">
                    <Pill tone={onIress ? "success" : "neutral"} size="xs" title={onIress ? "Live IRESS last + change" : "Latest stored price (no live IRESS snapshot for this name yet)"}>
                      {onIress ? "IRESS" : "Stored"}
                    </Pill>
                  </td>
                  <td className="px-3 py-2 text-right">
                    <Link
                      href={`/oems/analysis/${sym}` as never}
                      className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground transition-colors hover:bg-[hsl(var(--primary)/0.08)] hover:text-primary"
                      title="Open in Analysis"
                    >
                      ↗
                    </Link>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </GlassInsetTable>
    </>
  );
}
