"use client";

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { TrendingUp, ShieldCheck, Layers, Activity } from "lucide-react";

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
  is_active: boolean | null;
}

interface EquitiesUniverseResponse {
  source: "retail-supabase" | "unavailable";
  count: number;
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
  const realInvestors = (portfolioQ.data?.accounts ?? []).length;

  return (
    <div className="space-y-3">
      <header>
        <h1 className="text-lg font-semibold tracking-tight">Equities</h1>
        <p className="text-xs text-muted-foreground">JSE mandates · L1 quotes · pre-trade compliance via IRESS</p>
      </header>

      {realDataOnly ? (
        // Audit #34 — header KPIs from /api/portfolio in real-data mode.
        <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-4">
          {portfolioQ.isLoading ? (
            [0, 1, 2, 3].map((n) => <KpiTileSkeleton key={`equity-kpi-${n}`} />)
          ) : portfolioQ.data?.source === "supabase" ? (
            <>
              <KpiTile icon={<Layers className="h-3.5 w-3.5" />} label="Equity AUM" value={formatZAR(realEquityAum)} sub={`${(portfolioQ.data.positions ?? []).length} positions`} />
              <KpiTile
                icon={<Activity className="h-3.5 w-3.5" />}
                label="Open P&L"
                value={realEquityPnl.value != null ? formatZAR(realEquityPnl.value) : "—"}
                sub={
                  realEquityPnl.value != null
                    ? `MTM on ${realEquityPnl.marked} positions`
                    : "Marks unavailable (CT test data)"
                }
                tone={realEquityPnl.value == null ? "default" : realEquityPnl.value >= 0 ? "positive" : "negative"}
              />
              <KpiTile icon={<ShieldCheck className="h-3.5 w-3.5" />} label="Investors" value={realInvestors.toString()} sub={`${(portfolioQ.data.accounts ?? []).length} accounts`} />
              <KpiTile icon={<ShieldCheck className="h-3.5 w-3.5" />} label="Pre-trade checks" value="On submit" sub="IRESS halt / borrow / non-tradeable at order time" />
            </>
          ) : (
            <Panel title="Equity KPIs" endpoint="GET /api/portfolio" className="col-span-2 lg:col-span-4">
              <EmptyDataState
                reason={portfolioQ.data?.reason ?? "supabase_query_failed"}
                migration={portfolioQ.data?.migration}
                errorDetail={portfolioQ.data?.error}
                title="Equity AUM unavailable"
                message="Run the Supabase migration listed below in the MyMint SQL editor to enable real-data equity KPIs."
              />
            </Panel>
          )}
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
        title={realDataOnly ? `JSE · ${universeRows.length} names` : "JSE · Top 10 JSE-listed names"}
        endpoint={realDataOnly ? "GET /api/equities" : "GET /v1/securities/quotes?exchange=JSE"}
        dataSource={realDataOnly ? "supabase" : undefined}
        right={<Pill tone={realDataOnly ? "primary" : "success"} size="xs" dot>{realDataOnly ? "SUPABASE · L1" : "LIVE · L1"}</Pill>}
      >
        {realDataOnly ? (
          // Real-data table is the retail `securities_c` board (last_price +
          // day change). L1 reference only — bid/ask/vwap/volume require IPS
          // L2 or a streaming feed we don't have on the production profile,
          // so the table shows 5 columns (Symbol, Name, Sector, Last, Chg).
          <p className="mb-2 text-[10.5px] text-muted-foreground">
            Retail <span className="font-mono">securities_c</span> board — L1 last-trade +
            day change. Bid/ask/vwap/volume require IPS L2 or a streaming feed.
          </p>
        ) : null}
        {realDataOnly ? (
          <RealEquitiesTable rows={universeRows} isLoading={equitiesUniverseQ.isLoading} response={equitiesUniverseQ.data} />
        ) : equitiesQ.isLoading || (realDataOnly && liveQuotes.isLoading) ? (
          <div className="space-y-1.5" aria-busy="true" aria-live="polite">
            {[0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => (
              <div key={`equity-row-${n}`} className={`flex items-center gap-3 px-2.5 py-1.5 ${realDataOnly ? "grid-cols-5" : ""}`}>
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
        ) : (
          <table className="w-full font-mono text-xs">
            <thead>
              <tr className="text-[9.5px] uppercase tracking-wider text-muted-foreground">
                <th className="px-2.5 py-2 text-left">Sym</th>
                <th className="px-2.5 py-2 text-left">Name</th>
                <th className="px-2.5 py-2 text-left">Sector</th>
                <th className="px-2.5 py-2 text-right">Last</th>
                {realDataOnly ? null : (
                  <>
                    <th className="px-2.5 py-2 text-right">Bid / Ask</th>
                    <th className="px-2.5 py-2 text-right">VWAP</th>
                    <th className="px-2.5 py-2 text-right">Volume</th>
                  </>
                )}
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
  // Yellow #33 — render a small "no tick" pill in the Symbol column
  // when in real-data mode and the worker hasn't tick'd this symbol
  // yet. Visually distinct from a plain "—" so the operator can
  // see that the worker hasn't polled this name (BHG pattern, or
  // a hollow-row skip).
  const showNoTick = realDataOnly && tick.ts === 0;

  return (
    <tr className="hover:bg-muted/30">
      <td className="px-2.5 py-1.5 font-semibold">
        <span className="inline-flex items-center gap-1.5">
          {symbol}
          {showNoTick ? <Pill tone="neutral" size="xs">no tick</Pill> : null}
        </span>
      </td>
      <td className="px-2.5 py-1.5 text-muted-foreground">{name}</td>
      <td className="px-2.5 py-1.5 text-muted-foreground">{sector}</td>
      <td className="px-2.5 py-1.5 text-right tabular-nums">
        <NumberCell sym={symbol} fallback={ref} decimals={2} />
      </td>
      {realDataOnly ? null : (
        <>
          <td className="px-2.5 py-1.5 text-right tabular-nums text-muted-foreground">
            <>
              <span className="text-up">{(ref * 0.9997).toFixed(2)}</span> / <span className="text-down">{(ref * 1.0003).toFixed(2)}</span>
            </>
          </td>
          <td className="px-2.5 py-1.5 text-right tabular-nums">{formatNumber(vwap)}</td>
          <td className="px-2.5 py-1.5 text-right tabular-nums text-muted-foreground">
            {volume != null && volume > 0 ? formatNumber(volume) : "—"}
          </td>
        </>
      )}
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
    return (
      <div className="space-y-1.5" aria-busy="true" aria-live="polite">
        {[0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => (
          <div key={`equity-row-${n}`} className="flex items-center gap-3 px-2.5 py-1.5">
            <span className="shimmer h-2.5 w-12 rounded" />
            <span className="shimmer h-2.5 w-28 rounded" />
            <span className="shimmer h-2.5 w-20 rounded" />
            <span className="ml-auto shimmer h-2.5 w-16 rounded" />
            <span className="shimmer h-2.5 w-14 rounded" />
          </div>
        ))}
      </div>
    );
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

  return (
    <table className="w-full font-mono text-xs">
      <thead>
        <tr className="text-[9.5px] uppercase tracking-wider text-muted-foreground">
          <th className="px-2.5 py-2 text-left">Sym</th>
          <th className="px-2.5 py-2 text-left">Name</th>
          <th className="px-2.5 py-2 text-left">Sector</th>
          <th className="px-2.5 py-2 text-right">Last</th>
          <th className="px-2.5 py-2 text-right">Chg %</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-border/60">
        {rows.map((e) => {
          const sym = bareSymbol(e.symbol);
          // last_price is INTEGER CENTS → Rands.
          const lastRands = e.last_price != null ? e.last_price / 100 : null;
          const chg = Number(e.change_percent);
          const hasChg = Number.isFinite(chg);
          return (
            <tr key={e.symbol} className="hover:bg-muted/30">
              <td className="px-2.5 py-1.5 font-semibold">{sym}</td>
              <td className="px-2.5 py-1.5 text-muted-foreground">{e.name ?? "—"}</td>
              <td className="px-2.5 py-1.5 text-muted-foreground">{e.sector ?? "—"}</td>
              <td className="px-2.5 py-1.5 text-right tabular-nums">
                {lastRands != null ? formatZAR(lastRands) : <span className="text-muted-foreground">—</span>}
              </td>
              <td className="px-2.5 py-1.5 text-right tabular-nums">
                {hasChg ? (
                  <span className={cn("font-mono text-xs", chg > 0 ? "text-up" : chg < 0 ? "text-down" : "text-muted-foreground")}>
                    {formatPct(chg)}
                  </span>
                ) : (
                  <span className="text-muted-foreground">—</span>
                )}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
