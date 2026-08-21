"use client";

import { useQuery } from "@tanstack/react-query";
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  BarChart3,
  ChevronLeft,
  ChevronRight,
  Flame,
  Search,
  TrendingDown,
  TrendingUp,
} from "lucide-react";
import Link from "next/link";
import { type ReactNode, useMemo, useState } from "react";

import { EmptyDataState } from "@/components/oems/primitives/empty-data-state";
import { GlassBadge, GlassKpi, GlassSection } from "@/components/oems/primitives/glass";
import { NumberCell } from "@/components/oems/primitives/number-cell";
import { KpiTileSkeleton, PanelSkeleton } from "@/components/oems/primitives/panel-skeleton";
import { Pill } from "@/components/oems/primitives/pill";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { BffUnavailableReason } from "@/lib/bff-reasons";
import { cn } from "@/lib/cn";
import { isRealDataOnlyClient } from "@/lib/data-policy";
import { mapSource } from "@/lib/data-source";
import { formatNumber, formatPct, formatZAR } from "@/lib/format";
import { useLiveQuotes } from "@/lib/hooks/use-live-quotes";
import { usePortfolio } from "@/lib/hooks/use-portfolio";
import { useIress } from "@/lib/iress/provider";
import { seedLastFor } from "@/lib/iress/seed";
import { canRebalance } from "@/lib/iress/strategy";
import { JSE_TRACKED_UNIVERSE } from "@/lib/iress/universe";
import { queryOpts } from "@/lib/store/query-provider";
import { useTick } from "@/lib/store/tick-stream-provider";

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
  /** Trailing returns — Yahoo daily closes for the top-N by market cap. */
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
  /** How many board rows carry Yahoo-derived 1M/6M returns. */
  returnsCoverage?: number;
  /** Latest daily close used for the period returns. */
  returnsAsOf?: string | null;
  securities: UniverseSecurity[];
  sectors: { sector: string; count: number; avgChangePct: number; totalMarketCap: number }[];
  reason?: BffUnavailableReason;
  migration?: string;
  error?: string;
}
interface ClientBookResponse {
  source: "retail-supabase" | "unavailable";
  aum: number;
  investors: number;
  holdings: number;
  asOf: string | null;
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

const PAGE_SIZES = [10, 25, 50] as const;

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
  const equitiesQ = useQuery({
    queryKey: ["equities"],
    queryFn: () => data.jseEquities(),
    ...queryOpts("reference"),
  });
  // Real-data mode — the full retail-backed JSE universe (246 names) via the
  // `/api/equities` BFF (reads `securities_c`). Static reference data with its
  // own last_price (INTEGER CENTS) + change_percent; not the live tick stream.
  // Mock mode never fetches this (gated by `enabled`).
  const equitiesUniverseQ = useQuery<EquitiesUniverseResponse>({
    queryKey: ["equities-universe"],
    queryFn: fetchEquitiesUniverse,
    enabled: realDataOnly,
    ...queryOpts("reference"),
    // 1M/6M trailing returns are backfilled a bounded batch at a time (see
    // /api/equities' attachPeriodReturns — persisted, rotating cache, PR
    // #159-#161), so a single load rarely has full coverage. Poll every 3s
    // while returnsCoverage is still behind count so the board fills in on
    // its own instead of requiring manual refreshes; stop the moment it
    // catches up (or if the response is unavailable/still loading).
    refetchInterval: (query) => {
      const d = query.state.data;
      if (!d || d.source === "unavailable") return false;
      const coverage = d.returnsCoverage ?? 0;
      return coverage < d.count ? 3_000 : false;
    },
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
  const clientBookQ = useQuery<ClientBookResponse>({
    queryKey: ["bff-client-book"],
    queryFn: async () => {
      const response = await fetch("/api/client-book");
      return (await response.json()) as ClientBookResponse;
    },
    enabled: realDataOnly,
    ...queryOpts("live"),
  });

  const totalAum = strategies.reduce((s, x) => s + x.aum, 0);
  const totalPnl = strategies.reduce((s, x) => s + x.dayPnl, 0);
  const investors = strategies.reduce((s, x) => s + x.investorCount, 0);
  // Real-data aggregation: sum the equity leg of /api/portfolio. The
  // BFF returns positions/accounts; in v1 we sum the open_pl + market_value
  // across all positions and count distinct accounts.
  // Open P&L is null when positions aren't marked (CT test data — /api/portfolio
  // suppresses open_pl). Sum only the marked legs; if none are marked the P&L is
  // unknown (null → "—"), never a fabricated R0.00.
  const realEquityPnl = useMemo<{ value: number | null; marked: number }>(() => {
    if (portfolioQ.data?.source !== "supabase") return { value: null, marked: 0 };
    const marked = (portfolioQ.data.positions ?? []).filter((p) => p.open_pl != null);
    if (marked.length === 0) return { value: null, marked: 0 };
    return { value: marked.reduce((acc, p) => acc + Number(p.open_pl), 0), marked: marked.length };
  }, [portfolioQ.data]);

  // Securities-universe search (Lonwabo: "all the securities here… you can just
  // search a particular security"). Filters the universe table by symbol / name / sector.
  const ql = q.trim().toLowerCase();
  const filteredUniverse = useMemo(
    () =>
      ql
        ? universeRows.filter((r) =>
            `${bareSymbol(r.symbol)} ${r.name ?? ""} ${r.sector ?? ""}`.toLowerCase().includes(ql),
          )
        : universeRows,
    [universeRows, ql],
  );
  const filteredEquities = useMemo(
    () =>
      ql ? equities.filter((e) => `${e.symbol} ${e.name} ${e.sector}`.toLowerCase().includes(ql)) : equities,
    [equities, ql],
  );

  return (
    <div className="space-y-4 pb-6">
      <header className="glass-panel relative overflow-hidden p-5 md:p-6">
        <div className="pointer-events-none absolute -right-16 -top-16 h-48 w-48 rounded-full bg-primary/15 blur-3xl" />
        <div className="relative">
          <h1 className="text-display text-2xl md:text-3xl">Equities</h1>
          <p className="text-caption mt-1.5">JSE mandates · L1 quotes · pre-trade compliance via IRESS</p>
        </div>
      </header>

      {realDataOnly ? (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {portfolioQ.isLoading || clientBookQ.isLoading ? (
            [0, 1, 2, 3].map((n) => <KpiTileSkeleton key={`equity-kpi-${n}`} />)
          ) : portfolioQ.data?.source === "supabase" ? (
            <>
              <GlassKpi
                label="Platform AUM"
                dataSource="supabase"
                db="retail"
                value={clientBookQ.data?.source === "retail-supabase" ? formatZAR(clientBookQ.data.aum) : "—"}
                sub={
                  clientBookQ.data?.source === "retail-supabase"
                    ? `${clientBookQ.data.holdings} LIVE holdings`
                    : "Canonical LIVE AUM unavailable"
                }
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
                accent={
                  realEquityPnl.value == null ? "default" : realEquityPnl.value >= 0 ? "positive" : "negative"
                }
              />
              <GlassKpi
                label="Investors"
                dataSource="supabase"
                db="retail"
                value={
                  clientBookQ.data?.source === "retail-supabase" ? clientBookQ.data.investors.toString() : "—"
                }
                sub="LIVE clients only"
              />
              <GlassKpi
                label="Pre-trade checks"
                value="On submit"
                sub="IRESS halt / borrow / non-tradeable at order time"
                accent="primary"
              />
            </>
          ) : (
            <GlassSection
              title="Equity KPIs"
              endpoint="GET /api/portfolio"
              db="institutional"
              dataSource="supabase"
              className="col-span-2 lg:col-span-4"
            >
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
              <GlassKpi
                label="Equity AUM"
                value={formatZAR(totalAum)}
                sub={`${strategies.length} mandates`}
              />
              <GlassKpi
                label="Day P&L"
                value={formatZAR(totalPnl)}
                sub={formatPct((totalPnl / (totalAum || 1)) * 100, 3)}
                accent={totalPnl >= 0 ? "positive" : "negative"}
              />
              <GlassKpi label="Investors" value={investors.toString()} sub="across all equity mandates" />
              <GlassKpi
                label="Pre-trade checks"
                value="LIVE"
                sub="IRESS halt / borrow / non-tradeable"
                accent="primary"
              />
            </>
          )}
        </div>
      )}

      {!realDataOnly && (
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
          {strategiesQ.isLoading
            ? [0, 1, 2].map((n) => (
                <PanelSkeleton key={`equity-card-${n}`} rows={6} className="glass-panel" />
              ))
            : strategies.map((s) => {
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
                      <Button
                        size="sm"
                        variant={rebal ? "default" : "outline"}
                        disabled={!rebal}
                        className="h-6 px-2 text-[10px]"
                      >
                        {rebal ? "Rebalance" : "Locked"}
                      </Button>
                    </div>
                  </GlassSection>
                );
              })}
        </div>
      )}

      {/* ── Top Movers · JSE ─────────────────────────────────────────────── */}
      {realDataOnly ? (
        equitiesUniverseQ.isLoading ? (
          <PanelSkeleton rows={6} height="h-[280px]" className="glass-panel" />
        ) : equitiesAvailable && topMovers.length > 0 ? (
          <MoversBoard
            movers={topMovers}
            source={mapSource(equitiesUniverseQ.data?.source, "hybrid")}
            endpoint="GET /api/equities"
          />
        ) : (
          <GlassSection
            title="Top Movers · JSE"
            endpoint="GET /api/equities"
            db="retail"
            dataSource="supabase"
          >
            <EmptyDataState message="Equities board unavailable — retail securities feed returned no rows." />
          </GlassSection>
        )
      ) : equitiesQ.isLoading ? (
        <PanelSkeleton rows={6} height="h-[280px]" className="glass-panel" />
      ) : (
        <MoversBoardMock equities={equities} />
      )}

      {/* ── Securities Universe · JSE ───────────────────────────────────── */}
      <GlassSection
        title={
          realDataOnly
            ? `Securities universe · ${filteredUniverse.length} names`
            : "Securities universe · JSE"
        }
        endpoint={realDataOnly ? "GET /api/equities" : "GET /v1/securities/quotes?exchange=JSE"}
        db="retail"
        dataSource={realDataOnly ? mapSource(equitiesUniverseQ.data?.source, "hybrid") : "mock"}
        right={
          <div className="flex items-center gap-2">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search security…"
                className="h-7 w-44 pl-7 text-xs"
              />
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
              JSE securities data. Last-trade and day change shown. Bid, ask, vwap, and volume require a
              streaming market data feed.
            </p>
          ) : null}
          {realDataOnly ? (
            <RealUniverseTable
              rows={filteredUniverse}
              isLoading={equitiesUniverseQ.isLoading}
              response={equitiesUniverseQ.data}
            />
          ) : equitiesQ.isLoading || (realDataOnly && liveQuotes.isLoading) ? (
            <TableSkeleton realDataOnly={realDataOnly} />
          ) : (
            <MockUniverseTable rows={filteredEquities} />
          )}
        </div>
      </GlassSection>
    </div>
  );
}

// ─── Top Movers · real-data board ───────────────────────────────────────

function MoversBoard({
  movers,
  source,
  endpoint,
}: {
  movers: UniverseSecurity[];
  source: Parameters<typeof GlassSection>[0]["dataSource"];
  endpoint: string;
}) {
  const gainers = movers.filter((m) => (m.change_percent ?? 0) > 0).slice(0, 4);
  const losers = movers.filter((m) => (m.change_percent ?? 0) < 0).slice(0, 4);
  const maxAbs = Math.max(1, ...[...gainers, ...losers].map((m) => Math.abs(m.change_percent ?? 0)));

  const Card = ({
    m,
    rank,
    direction,
  }: { m: UniverseSecurity; rank: number; direction: "gain" | "loss" }) => {
    const chg = m.change_percent ?? 0;
    const up = direction === "gain";
    const price = m.last_price != null ? m.last_price / 100 : null;
    const magnitude = Math.min(100, (Math.abs(chg) / maxAbs) * 100);
    return (
      <Link
        href={`/oems/analysis/${bareSymbol(m.symbol)}` as never}
        className="group glass-inset relative flex flex-col gap-2.5 overflow-hidden p-3 transition-all duration-300 hover:-translate-y-0.5 hover:shadow-lg hover:shadow-black/20"
        title={`Open ${bareSymbol(m.symbol)} in Analysis`}
      >
        <div className="flex items-center justify-between">
          <span
            className={cn(
              "flex h-5 min-w-5 items-center justify-center rounded-md px-1 font-mono text-[10px] font-bold",
              up ? "bg-success/15 text-success" : "bg-destructive/15 text-destructive",
            )}
          >
            {rank}
          </span>
          <span
            className={cn(
              "flex items-center gap-1 font-mono text-[10px] font-bold",
              up ? "text-success" : "text-destructive",
            )}
          >
            {up ? <TrendingUp className="h-3 w-3" /> : <TrendingDown className="h-3 w-3" />}
            {formatPct(chg)}
          </span>
        </div>
        <div className="min-w-0">
          <p className="truncate font-mono text-sm font-bold">{bareSymbol(m.symbol)}</p>
          <p className="truncate text-[10px] text-muted-foreground">{m.name ?? bareSymbol(m.symbol)}</p>
        </div>
        <div className="mt-auto flex items-end justify-between gap-2">
          <span className="font-mono text-xs tabular-nums">{price != null ? formatZAR(price) : "—"}</span>
          <span className="h-1 w-16 overflow-hidden rounded-full bg-muted/40">
            <span
              className={cn(
                "block h-full rounded-full transition-all duration-500",
                up ? "bg-success" : "bg-destructive",
              )}
              style={{ width: `${magnitude}%` }}
            />
          </span>
        </div>
      </Link>
    );
  };

  return (
    <GlassSection
      title="Top Movers · JSE"
      subtitle="Gainers and losers on the retail securities board"
      endpoint={endpoint}
      db="retail"
      dataSource={source}
      right={
        <div className="flex items-center gap-3">
          <span className="hidden items-center gap-1.5 font-mono text-[10px] text-success sm:inline-flex">
            <Flame className="h-3 w-3" /> {gainers.length} up
          </span>
          <span className="hidden items-center gap-1.5 font-mono text-[10px] text-destructive sm:inline-flex">
            <BarChart3 className="h-3 w-3" /> {losers.length} down
          </span>
        </div>
      }
    >
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {gainers.map((m, i) => (
          <div
            key={m.symbol}
            className="animate-in fade-in slide-in-from-bottom-2"
            style={{ animationDelay: `${i * 60}ms` }}
          >
            <Card m={m} rank={i + 1} direction="gain" />
          </div>
        ))}
        {losers.map((m, i) => (
          <div
            key={m.symbol}
            className="animate-in fade-in slide-in-from-bottom-2"
            style={{ animationDelay: `${(i + 4) * 60}ms` }}
          >
            <Card m={m} rank={i + 5} direction="loss" />
          </div>
        ))}
      </div>
    </GlassSection>
  );
}

function MoversBoardMock({ equities }: { equities: { symbol: string; name: string }[] }) {
  return (
    <GlassSection
      title="Top Movers · JSE"
      endpoint="GET /v1/securities/quotes?exchange=JSE"
      db="retail"
      dataSource="mock"
    >
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {equities.slice(0, 8).map((m, i) => (
          <div
            key={m.symbol}
            className="animate-in fade-in slide-in-from-bottom-2"
            style={{ animationDelay: `${i * 60}ms` }}
          >
            <Link
              href={`/oems/analysis/${bareSymbol(m.symbol)}` as never}
              className="group glass-inset relative flex flex-col gap-2.5 p-3 transition-all duration-300 hover:-translate-y-0.5 hover:shadow-lg hover:shadow-black/20"
            >
              <div className="flex items-center justify-between">
                <span className="flex h-5 min-w-5 items-center justify-center rounded-md bg-muted/60 px-1 font-mono text-[10px] font-bold text-muted-foreground">
                  {i + 1}
                </span>
              </div>
              <div className="min-w-0">
                <p className="truncate font-mono text-sm font-bold">{m.symbol}</p>
                <p className="truncate text-[10px] text-muted-foreground">{m.name}</p>
              </div>
              <div className="flex items-end justify-between gap-2">
                <NumberCell sym={m.symbol} fallback={0} decimals={2} size="xs" />
                <NumberCell sym={m.symbol} fallback={0} decimals={2} size="xs" showChange />
              </div>
            </Link>
          </div>
        ))}
      </div>
    </GlassSection>
  );
}

// ─── Securities Universe · table shell ──────────────────────────────────

/** Column sort state shared by the real/mock universe tables. */
type SortKey =
  | "symbol"
  | "name"
  | "sector"
  | "last_price"
  | "change_percent"
  | "return_1m"
  | "return_6m"
  | "market_cap";

interface SortState {
  key: SortKey;
  dir: 1 | -1;
}

function SortHeader({
  label,
  sortKey,
  sort,
  onSort,
  className,
}: {
  label: string;
  sortKey: SortKey;
  sort: SortState;
  onSort: (key: SortKey) => void;
  className?: string;
}) {
  const active = sort.key === sortKey;
  return (
    <TableHead className={cn("cursor-pointer select-none", className)} onClick={() => onSort(sortKey)}>
      <span className="inline-flex items-center gap-1">
        {label}
        {active ? (
          sort.dir === 1 ? (
            <ArrowUp className="h-2.5 w-2.5 text-primary" />
          ) : (
            <ArrowDown className="h-2.5 w-2.5 text-primary" />
          )
        ) : (
          <ArrowUpDown className="h-2.5 w-2.5 opacity-40" />
        )}
      </span>
    </TableHead>
  );
}

function UniversePagination({
  page,
  pageSize,
  total,
  onPage,
  onPageSize,
}: {
  page: number;
  pageSize: number;
  total: number;
  onPage: (p: number) => void;
  onPageSize: (n: number) => void;
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(total, page * pageSize);
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[hsl(var(--glass-border))] px-1 pt-3">
      <div className="flex items-center gap-2">
        <span className="font-mono text-[10px] text-muted-foreground">
          {from}–{to} of {total}
        </span>
        <div className="flex items-center gap-1">
          {PAGE_SIZES.map((n) => (
            <button
              key={n}
              type="button"
              onClick={() => onPageSize(n)}
              className={cn(
                "rounded px-1.5 py-0.5 font-mono text-[10px] transition-colors",
                pageSize === n ? "bg-primary/15 text-primary" : "text-muted-foreground hover:text-foreground",
              )}
              title={`${n} rows per page`}
            >
              {n}
            </button>
          ))}
        </div>
      </div>
      <div className="flex items-center gap-1">
        <button
          type="button"
          disabled={page <= 1}
          onClick={() => onPage(page - 1)}
          className="flex h-6 w-6 items-center justify-center rounded border border-[hsl(var(--glass-border))] text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
          aria-label="Previous page"
        >
          <ChevronLeft className="h-3 w-3" />
        </button>
        <span className="px-1 font-mono text-[10px] text-muted-foreground">
          {page} / {pages}
        </span>
        <button
          type="button"
          disabled={page >= pages}
          onClick={() => onPage(page + 1)}
          className="flex h-6 w-6 items-center justify-center rounded border border-[hsl(var(--glass-border))] text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
          aria-label="Next page"
        >
          <ChevronRight className="h-3 w-3" />
        </button>
      </div>
    </div>
  );
}

/**
 * Small live progress readout for the 1M/6M returns backfill. The board
 * polls `/api/equities` every 3s (see `equitiesUniverseQ.refetchInterval`
 * above) while coverage is incomplete — this just renders where that
 * polling currently stands, so the user isn't left guessing whether
 * reloading the page is doing anything.
 */
function ReturnsCoverageBadge({ response }: { response: EquitiesUniverseResponse | undefined }) {
  if (!response || response.source === "unavailable") return null;
  const coverage = response.returnsCoverage ?? 0;
  const total = response.count;
  if (total <= 0) return null;
  const remaining = Math.max(total - coverage, 0);
  const done = remaining === 0;
  return (
    <div className="mb-2 flex items-center gap-1.5 text-[10.5px] text-muted-foreground">
      <span
        className={cn(
          "h-1.5 w-1.5 rounded-full",
          done ? "bg-up" : "animate-pulse bg-amber-400",
        )}
        aria-hidden
      />
      {done ? (
        <span>
          1M/6M returns fully loaded — <span className="font-mono">{total}</span>/
          <span className="font-mono">{total}</span>
        </span>
      ) : (
        <span>
          Loading 1M/6M returns… <span className="font-mono font-semibold">{coverage}</span>/
          <span className="font-mono">{total}</span> loaded,{" "}
          <span className="font-mono">{remaining}</span> still loading
        </span>
      )}
    </div>
  );
}

// ─── Securities Universe · real-data table ──────────────────────────────

function RealUniverseTable({
  rows,
  isLoading,
  response,
}: {
  rows: UniverseSecurity[];
  isLoading: boolean;
  response: EquitiesUniverseResponse | undefined;
}) {
  const [sort, setSort] = useState<SortState>({ key: "symbol", dir: 1 });
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<number>(25);

  // Reset to page 1 when the search/filter changes the row set.
  const lastRowKey = rows.map((r) => r.symbol).join("|");
  const [prevKey, setPrevKey] = useState(lastRowKey);
  if (prevKey !== lastRowKey) {
    setPrevKey(lastRowKey);
    setPage(1);
  }

  const sorted = useMemo(() => {
    const dir = sort.dir;
    return [...rows].sort((a, b) => {
      const va = a[sort.key];
      const vb = b[sort.key];
      const result =
        sort.key === "symbol" || sort.key === "name" || sort.key === "sector"
          ? String(va ?? "").localeCompare(String(vb ?? ""))
          : Number(va ?? Number.NEGATIVE_INFINITY) - Number(vb ?? Number.NEGATIVE_INFINITY);
      return result * dir;
    });
  }, [rows, sort]);

  const paged = sorted.slice((page - 1) * pageSize, page * pageSize);

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
  const onSort = (key: SortKey) =>
    setSort((s) => (s.key === key ? { key, dir: s.dir === 1 ? -1 : 1 } : { key, dir: 1 }));

  return (
    <>
      <p className="mb-2 text-[10.5px] text-muted-foreground">
        <span className="font-mono font-semibold text-up">{iressCount}</span> of{" "}
        <span className="font-mono">{rows.length}</span> priced live from IRESS (last + day change); the rest
        show the latest stored price. Fundamentals / market cap / sector come from the stored reference data.
        {response?.returnsCoverage ? (
          <>
            {" "}
            <span className="font-mono font-semibold">{response.returnsCoverage}</span> names carry 1M/6M
            trailing returns from Yahoo daily closes
            {response.returnsAsOf ? (
              <>
                {" "}
                (as of{" "}
                <span className="font-mono">
                  {new Date(response.returnsAsOf).toLocaleDateString("en-ZA", {
                    day: "2-digit",
                    month: "short",
                    year: "numeric",
                  })}
                </span>
                )
              </>
            ) : null}
            ; the rest render "—" until covered.
          </>
        ) : null}
      </p>
      <ReturnsCoverageBadge response={response} />
      <div className="glass-inset overflow-x-auto scrollbar-thin">
        <Table>
          <TableHeader>
            <TableRow>
              <SortHeader label="Sym" sortKey="symbol" sort={sort} onSort={onSort} />
              <SortHeader label="Name" sortKey="name" sort={sort} onSort={onSort} />
              <SortHeader label="Sector" sortKey="sector" sort={sort} onSort={onSort} />
              <SortHeader
                label="Last"
                sortKey="last_price"
                sort={sort}
                onSort={onSort}
                className="text-right"
              />
              <SortHeader
                label="1D"
                sortKey="change_percent"
                sort={sort}
                onSort={onSort}
                className="text-right"
              />
              <SortHeader label="1M" sortKey="return_1m" sort={sort} onSort={onSort} className="text-right" />
              <SortHeader label="6M" sortKey="return_6m" sort={sort} onSort={onSort} className="text-right" />
              <SortHeader
                label="Mkt Cap"
                sortKey="market_cap"
                sort={sort}
                onSort={onSort}
                className="text-right"
              />
              <TableHead className="text-center">Src</TableHead>
              <TableHead className="text-right">Action</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {paged.map((e) => {
              const sym = bareSymbol(e.symbol);
              const lastRands = e.last_price != null ? e.last_price / 100 : null;
              const chg = Number(e.change_percent);
              const hasChg = Number.isFinite(chg);
              const onIress = e.price_source === "iress";
              return (
                <TableRow key={e.symbol} className="group/row">
                  <TableCell className="font-mono text-xs font-bold">
                    <Link
                      href={`/oems/analysis/${sym}` as never}
                      className="transition-colors hover:text-primary"
                      title={`Open ${sym} in Analysis`}
                    >
                      {sym}
                    </Link>
                  </TableCell>
                  <TableCell className="max-w-[180px] truncate text-muted-foreground">
                    {e.name ?? "—"}
                  </TableCell>
                  <TableCell className="max-w-[140px] truncate text-muted-foreground">
                    {e.sector ?? "—"}
                  </TableCell>
                  <TableCell className="text-right font-mono text-xs tabular-nums">
                    {lastRands != null ? (
                      formatZAR(lastRands)
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    {hasChg ? (
                      <span
                        className={cn(
                          "inline-flex min-w-[52px] items-center justify-end gap-0.5 rounded-md px-1.5 py-0.5 font-mono text-[11px] font-semibold tabular-nums",
                          chg > 0
                            ? "bg-success/10 text-success"
                            : chg < 0
                              ? "bg-destructive/10 text-destructive"
                              : "bg-muted/40 text-muted-foreground",
                        )}
                      >
                        {chg > 0 ? (
                          <ArrowUp className="h-2.5 w-2.5" />
                        ) : chg < 0 ? (
                          <ArrowDown className="h-2.5 w-2.5" />
                        ) : null}
                        {formatPct(chg)}
                      </span>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    <PeriodReturn v={e.return_1m} />
                  </TableCell>
                  <TableCell className="text-right">
                    <PeriodReturn v={e.return_6m} />
                  </TableCell>
                  <TableCell className="text-right font-mono text-xs tabular-nums text-muted-foreground">
                    {e.market_cap != null ? formatZAR(e.market_cap) : "—"}
                  </TableCell>
                  <TableCell className="text-center">
                    <Pill
                      tone={onIress ? "success" : "neutral"}
                      size="xs"
                      title={
                        onIress
                          ? "Live IRESS last + change"
                          : "Latest stored price (no live IRESS snapshot for this name yet)"
                      }
                    >
                      {onIress ? "IRESS" : "Stored"}
                    </Pill>
                  </TableCell>
                  <TableCell className="text-right">
                    <Link
                      href={`/oems/analysis/${sym}` as never}
                      className="inline-flex items-center gap-1 rounded-md border border-transparent px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground transition-colors hover:border-primary/30 hover:bg-primary/10 hover:text-primary"
                      title="Open in Analysis"
                    >
                      Analyze
                    </Link>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
      <UniversePagination
        page={page}
        pageSize={pageSize}
        total={sorted.length}
        onPage={setPage}
        onPageSize={(n) => {
          setPageSize(n);
          setPage(1);
        }}
      />
    </>
  );
}

// ─── Securities Universe · mock/tick table ──────────────────────────────

function MockUniverseTable({ rows }: { rows: Array<{ symbol: string; name: string; sector: string }> }) {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<number>(10);

  const paged = rows.slice((page - 1) * pageSize, page * pageSize);

  return (
    <>
      <div className="glass-inset overflow-x-auto scrollbar-thin">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Sym</TableHead>
              <TableHead>Name</TableHead>
              <TableHead>Sector</TableHead>
              <TableHead className="text-right">Last</TableHead>
              <TableHead className="text-right">Bid / Ask</TableHead>
              <TableHead className="text-right">VWAP</TableHead>
              <TableHead className="text-right">Volume</TableHead>
              <TableHead className="text-right">Chg</TableHead>
              <TableHead className="text-right">Action</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {paged.map((e) => (
              <MockEquityRow key={e.symbol} symbol={e.symbol} name={e.name} sector={e.sector} />
            ))}
          </TableBody>
        </Table>
      </div>
      <UniversePagination
        page={page}
        pageSize={pageSize}
        total={rows.length}
        onPage={setPage}
        onPageSize={(n) => {
          setPageSize(n);
          setPage(1);
        }}
      />
    </>
  );
}

function MockEquityRow({ symbol, name, sector }: { symbol: string; name: string; sector: string }) {
  const tick = useTick(symbol);
  const ref = seedLastFor(symbol);
  const vwap = tick.ts > 0 ? tick.vwap : ref;
  const volume = tick.ts > 0 ? tick.volume : null;
  // Yellow #33 — render a small "no tick" pill in the Symbol column
  // when in real-data mode and the worker hasn't tick'd this symbol
  // yet. Visually distinct from a plain "—" so the operator can
  // see that the worker hasn't polled this name (BHG pattern, or
  // a hollow-row skip).
  const showNoTick = tick.ts === 0;

  return (
    <TableRow className="group/row">
      <TableCell className="font-mono text-xs font-bold">
        <span className="inline-flex items-center gap-1.5">
          {symbol}
          {showNoTick ? (
            <Pill tone="neutral" size="xs">
              no tick
            </Pill>
          ) : null}
        </span>
      </TableCell>
      <TableCell className="max-w-[180px] truncate text-muted-foreground">{name}</TableCell>
      <TableCell className="max-w-[140px] truncate text-muted-foreground">{sector}</TableCell>
      <TableCell className="text-right tabular-nums">
        <NumberCell sym={symbol} fallback={ref} decimals={2} />
      </TableCell>
      <TableCell className="text-right tabular-nums text-muted-foreground">
        <>
          <span className="text-up">{(ref * 0.9997).toFixed(2)}</span> /{" "}
          <span className="text-down">{(ref * 1.0003).toFixed(2)}</span>
        </>
      </TableCell>
      <TableCell className="text-right tabular-nums">{formatNumber(vwap)}</TableCell>
      <TableCell className="text-right tabular-nums text-muted-foreground">
        {volume != null && volume > 0 ? formatNumber(volume) : "—"}
      </TableCell>
      <TableCell className="text-right">
        <NumberCell sym={symbol} fallback={ref} decimals={2} showChange size="xs" />
      </TableCell>
      <TableCell className="text-right">
        <Link
          href={`/oems/analysis/${symbol}` as never}
          className="inline-flex items-center gap-1 rounded-md border border-transparent px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground transition-colors hover:border-primary/30 hover:bg-primary/10 hover:text-primary"
          title="Open in Analysis"
        >
          Analyze
        </Link>
      </TableCell>
    </TableRow>
  );
}

// ─── Shared bits ────────────────────────────────────────────────────────

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

function Stat({
  label,
  value,
  positive,
  negative,
}: { label: string; value: string; positive?: boolean; negative?: boolean }) {
  return (
    <div>
      <p className="text-[9.5px] uppercase tracking-wider text-muted-foreground">{label}</p>
      <p
        className={cn(
          "mt-0.5 font-mono text-xs font-semibold",
          positive && "text-up",
          negative && "text-down",
        )}
      >
        {value}
      </p>
    </div>
  );
}

/** A trailing-period return cell — green/red, or "—" until the worker writes it. */
function PeriodReturn({ v }: { v: number | null | undefined }) {
  if (v == null || !Number.isFinite(v)) return <span className="text-muted-foreground">—</span>;
  return (
    <span
      className={cn("font-mono text-xs", v > 0 ? "text-up" : v < 0 ? "text-down" : "text-muted-foreground")}
    >
      {formatPct(v)}
    </span>
  );
}

export type { UniverseSecurity };
