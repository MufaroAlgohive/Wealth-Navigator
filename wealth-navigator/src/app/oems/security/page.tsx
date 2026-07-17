"use client";

import { Suspense, useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useSearchParams } from "next/navigation";
import { Search, ChevronRight } from "lucide-react";
import Link from "next/link";

import { Panel } from "@/components/oems/primitives/panel";
import { GlassSection } from "@/components/oems/primitives/glass";
import { NumberCell } from "@/components/oems/primitives/number-cell";
import { DepthLadder } from "@/components/oems/primitives/depth-ladder";
import { TimeAndSales } from "@/components/oems/primitives/time-and-sales";
import { PanelSkeleton } from "@/components/oems/primitives/panel-skeleton";
import { EmptyDataState } from "@/components/oems/primitives/empty-data-state";
import { Input } from "@/components/ui/input";
import { useIress } from "@/lib/iress/provider";
import { initialQuotes, seedLastFor } from "@/lib/iress/seed";
import { isRealDataOnlyClient } from "@/lib/data-policy";
import { useTick, useTickSeries } from "@/lib/store/tick-stream-provider";
import { cn } from "@/lib/cn";
import { formatPct, formatZAR } from "@/lib/format";
import { queryOpts } from "@/lib/store/query-provider";
import { useLiveQuotes } from "@/lib/hooks/use-live-quotes";
import { JSE_TRACKED_UNIVERSE } from "@/lib/iress/universe";

function SecurityPageContent() {
  const { data } = useIress();
  const realDataOnly = isRealDataOnlyClient();
  const equitiesQ = useQuery({ queryKey: ["equities"], queryFn: () => data.jseEquities(), ...queryOpts("reference") });
  const equities = equitiesQ.data ?? [];
  const searchParams = useSearchParams();
  const [sym, setSym] = useState("NPN");
  const [chartRange, setChartRange] = useState("1D");

  // Subscribe to the entire JSE universe on mount so a click on any
  // watchlist row in the panel is instant — no per-symbol BFF round-trip
  // for the first click. `useLiveQuotes` is a no-op when
  // `realDataOnly=false`, so the dev path stays cheap. Audit #22.
  useLiveQuotes(JSE_TRACKED_UNIVERSE.map((e) => e.symbol));

  useEffect(() => {
    const fromUrl = searchParams.get("sym");
    if (fromUrl) setSym(fromUrl.toUpperCase());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const inst = equities.find((i) => i.symbol === sym) ?? equities[0];
  const activeSym = inst?.symbol ?? sym;
  const liveQuotes = useLiveQuotes([activeSym]);
  const quoteSource = liveQuotes.dataSource;
  const tick = useTick(activeSym);
  const hasLiveQuote = tick.ts > 0;

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0 space-y-1">
          <h1 className="text-display text-2xl">Security Lookup</h1>
          <p className="text-caption">
            {inst?.name} · {inst?.exchange} · {inst?.isin} · {inst?.sector}
          </p>
        </div>
        <div className="relative w-80">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={sym}
            onChange={(e) => setSym(e.target.value.toUpperCase())}
            placeholder="Ticker / ISIN / RIC"
            className="glass-inset h-10 border-0 pl-10 font-mono text-sm shadow-none"
          />
        </div>
        <div className="flex items-center gap-2">
          <Link
            href={`/oems/analysis/${activeSym}` as never}
            className="glass-inset inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 font-mono text-[11px] font-medium text-primary transition-colors hover:border-[hsl(var(--glass-border-strong))]"
          >
            Open in Analysis
            <ChevronRight className="h-3 w-3" />
          </Link>
        </div>
      </header>

      <div className="grid grid-cols-12 gap-2.5">
        {equitiesQ.isLoading ? (
          <PanelSkeleton rows={1} height="h-[400px]" className="col-span-6 lg:col-span-2" />
        ) : (
          <Panel
            title="Watchlist · JSE"
            endpoint={realDataOnly ? "GET /api/quotes" : "Live Quotes"}
            dataSource={realDataOnly ? quoteSource : undefined}
            className="col-span-6 lg:col-span-2 h-[400px]"
            density="scroll"
          >
            <ul className="divide-y divide-border/60">
              {equities.slice(0, JSE_TRACKED_UNIVERSE.length).map((m) => (
                <li key={m.symbol}>
                  <button
                    onClick={() => setSym(m.symbol)}
                    className={cn(
                      "w-full px-2.5 py-1.5 text-left transition-colors hover:bg-muted/30",
                      sym === m.symbol && "bg-primary/10",
                    )}
                  >
                    <div className="flex items-center justify-between font-mono text-[11px]">
                      <span className="font-semibold">{m.symbol}</span>
                      <NumberCell sym={m.symbol} fallback={realDataOnly ? 0 : 0} decimals={2} />
                    </div>
                    <div className="mt-0.5 flex items-center justify-between text-[9.5px] text-muted-foreground">
                      <span className="truncate">{m.name}</span>
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          </Panel>
        )}

        {equitiesQ.isLoading ? (
          <PanelSkeleton rows={4} height="h-[400px]" className="col-span-12 lg:col-span-6" />
        ) : (
          <GlassSection
            title={`${inst?.symbol ?? "—"} · ${chartRange}`}
            endpoint={realDataOnly ? (chartRange === "1D" ? "GET /api/intraday" : "GET /api/history") : "PricingQuoteGet"}
            db={realDataOnly && chartRange === "1D" ? "retail" : undefined}
            dataSource={realDataOnly ? "iress" : undefined}
            className="col-span-12 flex h-[400px] min-h-0 flex-col lg:col-span-6"
            noPadding
            right={
              <div className="flex items-center gap-2">
                <div className="glass-inset inline-flex gap-0.5 p-1">
                  {(["1D", "5D", "1M", "6M", "YTD", "1Y", "5Y", "All"] as const).map((r) => (
                    <button
                      key={r}
                      onClick={() => setChartRange(r)}
                      className={cn(
                        "rounded-lg px-2 py-1 font-mono text-[10px] font-medium transition-all duration-200",
                        chartRange === r
                          ? "bg-primary text-primary-foreground shadow-[0_2px_12px_hsl(var(--primary)/0.35)]"
                          : "text-muted-foreground hover:text-foreground",
                      )}
                    >
                      {r}
                    </button>
                  ))}
                </div>
                <NumberCell sym={activeSym} fallback={realDataOnly ? 0 : seedLastFor(activeSym)} decimals={2} showChange />
              </div>
            }
          >
            <div className="flex min-h-0 flex-1 flex-col p-4">
              <div className="glass-inset min-h-0 flex-1 overflow-hidden p-2">
                {realDataOnly && chartRange === "1D" && !hasLiveQuote ? (
                  <EmptyDataState message="No intraday data available yet. Try a longer time range." />
                ) : (
                  <SecurityChart sym={activeSym} realDataOnly={realDataOnly} range={chartRange} />
                )}
              </div>
            </div>
          </GlassSection>
        )}

        {equitiesQ.isLoading ? (
          <PanelSkeleton rows={1} height="h-[400px]" className="col-span-6 lg:col-span-2" />
        ) : (
          <Panel
            title="Depth · L2"
            endpoint={`WS /v1/depth/${inst?.isin ?? ""}/stream`}
            className="col-span-6 lg:col-span-2 h-[400px]"
            density="scroll"
          >
            {realDataOnly ? (
              <EmptyDataState
                title="No L2 order book"
                message="Order book depth is not available for this account. Best bid/ask is shown in Key Statistics below."
              />
            ) : (
              <DepthLadder mid={seedLastFor(activeSym)} tick={seedLastFor(activeSym) > 1000 ? 0.5 : 0.05} levels={8} />
            )}
          </Panel>
        )}

        {equitiesQ.isLoading ? (
          <PanelSkeleton rows={1} height="h-[400px]" className="col-span-6 lg:col-span-2" />
        ) : (
          <Panel
            title="Time & Sales"
            endpoint={`WS /v1/trades/${inst?.isin ?? ""}/stream`}
            className="col-span-6 lg:col-span-2 h-[400px]"
            density="scroll"
          >
            {realDataOnly ? (
              <EmptyDataState message="Time & sales feed not configured." />
            ) : (
              <TimeAndSales mid={seedLastFor(activeSym)} n={28} />
            )}
          </Panel>
        )}
      </div>

      {realDataOnly ? (
        <GlassSection
          title={`Key Statistics · ${inst?.name ?? activeSym}`}
          endpoint="GET /api/quote-snapshot + /api/equities"
          db="institutional"
          dataSource="supabase"
          right={<span className="text-caption font-mono">{inst?.sector ?? inst?.isin ?? ""}</span>}
        >
          <SecurityStatsGrid sym={activeSym} />
        </GlassSection>
      ) : (
        <GlassSection
          title="Reference · ISIN / RIC / Sector / Fundamentals"
          endpoint={`GET /v1/securities/${inst?.isin ?? ""}`}
          db="retail"
          dataSource="mock"
          right={<span className="text-caption font-mono">{inst?.isin}</span>}
        >
          {equitiesQ.isLoading ? (
            <div
              className="glass-inset grid grid-cols-2 gap-px overflow-hidden sm:grid-cols-4 lg:grid-cols-6"
              aria-busy="true"
              aria-live="polite"
            >
              {[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15].map((n) => (
                <div key={`security-row-${n}`} className="px-3 py-2.5">
                  <span className="shimmer block h-2 w-3/4 rounded" />
                  <span className="shimmer mt-1.5 block h-3 w-1/2 rounded" />
                </div>
              ))}
            </div>
          ) : (
            <FundamentalsGrid
              inst={{
                ric: inst?.ric,
                isin: inst?.isin,
                exchange: inst?.exchange,
                sector: inst?.sector,
                currency: inst?.currency,
                assetClass: inst?.assetClass,
              }}
              sym={activeSym}
            />
          )}
        </GlassSection>
      )}
    </div>
  );
}

export default function SecurityPage() {
  return (
    <Suspense fallback={null}>
      <SecurityPageContent />
    </Suspense>
  );
}

function FundamentalsGrid({
  sym,
  inst,
}: {
  sym: string;
  inst: {
    ric?: string;
    isin?: string;
    exchange?: string;
    sector?: string;
    currency?: string;
    assetClass?: string;
  };
}) {
  const seedLast = seedLastFor(sym);
  const fields = [
    { k: "RIC", v: inst.ric ?? "—" },
    { k: "ISIN", v: inst.isin ?? "—" },
    { k: "Exchange", v: inst.exchange ?? "—" },
    { k: "Sector", v: inst.sector ?? "—" },
    { k: "Currency", v: inst.currency ?? "—" },
    { k: "Asset class", v: inst.assetClass ?? "—" },
    { k: "P/E", v: "18.4" },
    { k: "EV/EBITDA", v: "11.2" },
    { k: "Div Yield", v: "2.4%" },
    { k: "Mkt Cap", v: "R1.81tn" },
    { k: "52w Hi", v: (seedLast * 1.18).toFixed(2) },
    { k: "52w Lo", v: (seedLast * 0.78).toFixed(2) },
    { k: "ADV (3m)", v: "1.8m" },
    { k: "Beta", v: "1.12" },
    { k: "Bid", v: (seedLast * 0.9997).toFixed(2) },
    { k: "Ask", v: (seedLast * 1.0003).toFixed(2) },
    { k: "Spread bp", v: (((seedLast * 1.0003) - (seedLast * 0.9997)) / seedLast * 10_000).toFixed(1) },
    { k: "VWAP", v: seedLast.toFixed(2) },
  ];
  return (
    <div className="glass-inset grid grid-cols-2 gap-px overflow-hidden sm:grid-cols-4 lg:grid-cols-6">
      {fields.map(({ k, v }) => (
        <div key={k} className="px-3 py-2.5">
          <p className="text-caption uppercase tracking-wider">{k}</p>
          <p className="mt-1 font-mono text-xs font-semibold tabular-nums">{v}</p>
        </div>
      ))}
    </div>
  );
}

/**
 * Real-data fundamentals — sourced from the retail-backed `/api/equities` BFF
 * (`securities_c`, Yahoo-fed today). This is reference data that does NOT need
 * IRESS or a market-data vendor, so it is wired even on the real-data-only
 * production profile. Depth L2 / Time & Sales stay UNCONFIGURED because those
 * genuinely require an IRESS / streaming feed we don't have.
 *
 * `last_price` is INTEGER CENTS (securities_c convention); we don't render it
 * here (the panel header / NumberCell own the live last) but other fields are
 * plain numbers. `symbol` carries a `.JO` suffix — we strip it to match the
 * page's bare selected symbol (e.g. "NPN").
 */
interface EquityFundamentals {
  symbol: string;
  name: string | null;
  sector: string | null;
  industry: string | null;
  pe: number | null;
  pe_ratio?: number | null;
  eps: number | null;
  dividend_yield: number | null;
  beta: number | null;
  market_cap: number | null;
  isin: string | null;
  ytd_performance: number | null;
}

function SecurityStatsGrid({ sym }: { sym: string }) {
  const snapQ = useQuery<{ symbol: string; snapshot: L1Snapshot | null; source: string; message?: string }>({
    queryKey: ["quote-snapshot", sym],
    queryFn: async () => {
      const r = await fetch(`/api/quote-snapshot/${encodeURIComponent(sym)}`, { cache: "no-store" });
      if (!r.ok) throw new Error(`quote-snapshot ${r.status}`);
      return r.json();
    },
    // queryOpts("live") FIRST so the intended 15s cadence wins (the "live"
    // preset's refetchInterval: 5_000 would otherwise clobber it).
    ...queryOpts("live"),
    refetchInterval: 15_000,
  });
  const eqQ = useQuery<{ securities: EquityFundamentals[] }>({
    queryKey: ["equities-universe"],
    queryFn: async () => {
      const r = await fetch("/api/equities", { cache: "no-store" });
      if (!r.ok) throw new Error(`equities ${r.status}`);
      return r.json();
    },
    ...queryOpts("reference"),
  });

  if (snapQ.isLoading || eqQ.isLoading) {
    return (
      <div
        className="glass-inset grid grid-cols-1 gap-px overflow-hidden sm:grid-cols-2"
        aria-busy="true"
      >
        {Array.from({ length: 16 }).map((_, n) => (
          <div key={`stat-${n}`} className="px-4 py-2.5">
            <span className="shimmer block h-3 w-2/3 rounded" />
          </div>
        ))}
      </div>
    );
  }

  const s = snapQ.data?.snapshot ?? null;
  const eq = (eqQ.data?.securities ?? []).find(
    (x) => x.symbol.replace(/\.JO$/i, "").toUpperCase() === sym.toUpperCase(),
  );

  const z = (v: number | null | undefined) => (v == null || !Number.isFinite(v) ? "—" : formatZAR(v));
  const vol = (v: number | null | undefined) => (v == null || !Number.isFinite(v) ? "—" : Math.round(v).toLocaleString("en-ZA"));
  const n2 = (v: number | null | undefined) => (v == null || !Number.isFinite(v) ? "—" : v.toFixed(2));
  const range = (lo: number | null | undefined, hi: number | null | undefined) =>
    lo == null || hi == null ? "—" : `${formatZAR(lo)} – ${formatZAR(hi)}`;

  // Yahoo-style 16-field layout (Lonwabo's spec). Quote block = IRESS L1;
  // valuation = Yahoo securities_c; the three date/estimate fields have no
  // IRESS or securities_c source yet (shown "—").
  const fields: Array<{ k: string; v: string }> = [
    { k: "Previous Close", v: z(s?.prevClose) },
    { k: "Open", v: z(s?.open) },
    { k: "Bid", v: z(s?.bid) },
    { k: "Ask", v: z(s?.ask) },
    { k: "Day's Range", v: range(s?.low, s?.high) },
    { k: "52 Week Range", v: range(s?.week52Low, s?.week52High) },
    { k: "Volume", v: vol(s?.volume) },
    { k: "Avg. Volume", v: vol(s?.avgVolume) },
    { k: "Market Cap (intraday)", v: eq?.market_cap == null ? "—" : formatZAR(eq.market_cap) },
    { k: "Beta (5Y Monthly)", v: n2(eq?.beta) },
    { k: "PE Ratio (TTM)", v: n2(eq?.pe ?? eq?.pe_ratio) },
    { k: "EPS (TTM)", v: n2(eq?.eps) },
    { k: "Earnings Date (est.)", v: "—" },
    { k: "Forward Dividend & Yield", v: eq?.dividend_yield == null ? "—" : formatPct(eq.dividend_yield) },
    { k: "Ex-Dividend Date", v: "—" },
    { k: "1y Target Est", v: "—" },
  ];

  return (
    <div className="space-y-3">
      <div className="glass-inset grid grid-cols-1 gap-px overflow-hidden sm:grid-cols-2">
        {fields.map(({ k, v }) => (
          <div key={k} className="flex items-center justify-between gap-3 px-4 py-2.5">
            <span className="text-caption">{k}</span>
            <span className="font-mono text-xs font-semibold tabular-nums">{v}</span>
          </div>
        ))}
      </div>
      <p className="text-[10px] leading-relaxed text-muted-foreground/70">
        Prev Close / Open / Bid / Ask / Day&apos;s Range / Volume: <span className="text-muted-foreground">IRESS PricingQuoteGet</span>
        {s == null ? " (data pending)" : ""}. 52-Week Range / Avg. Volume:
        IRESS daily history (worker fill pending). Market Cap / Beta / PE / EPS / Dividend:{" "}
        <span className="text-muted-foreground">Yahoo Finance</span>. Earnings Date / Ex-Dividend / 1y Target
        Est: pending a fundamentals vendor.
      </p>
    </div>
  );
}

/**
 * IRESS L1 quote snapshot shape — Prev Close / Open / Bid / Ask / Day's Range /
 * Volume (+ 52-week range / avg volume) from `/api/quote-snapshot/[sym]`
 * (institutional `quote_snapshot_c`, worker-fed from PricingQuoteGet). Consumed
 * by SecurityStatsGrid (the combined Key-Statistics grid above).
 */
interface L1Snapshot {
  last: number | null; open: number | null; high: number | null; low: number | null;
  bid: number | null; ask: number | null; prevClose: number | null; volume: number | null;
  vwap: number | null; week52High: number | null; week52Low: number | null; avgVolume: number | null;
  currency: string | null; marketState: string | null; asOf: string;
}

function SecurityChart({ sym, realDataOnly, range = "1D" }: { sym: string; realDataOnly: boolean; range?: string }) {
  const isIntraday = range === "1D";
  // 1D = intraday ticks (/api/intraday → stock_intraday_c). 5D…All = daily
  // history (/api/history → worker → IRESS TimeSeriesGet2).
  const intradayQ = useQuery<{ points: Array<{ t: number; v: number }>; prevClose: number | null; source: string }>({
    queryKey: ["bff-intraday", sym],
    queryFn: async () => {
      const r = await fetch(`/api/intraday/${encodeURIComponent(sym)}`, { cache: "no-store" });
      if (!r.ok) throw new Error(`intraday ${r.status}`);
      return r.json();
    },
    enabled: realDataOnly && isIntraday,
    // queryOpts("live") FIRST so the intended 15s cadence wins (the "live"
    // preset's refetchInterval: 5_000 would otherwise clobber it).
    ...queryOpts("live"),
    refetchInterval: 15_000,
  });
  const historyQ = useQuery<{ points: Array<{ t: number; v: number }>; source: string }>({
    queryKey: ["bff-history", sym, range],
    queryFn: async () => {
      const r = await fetch(`/api/history/${encodeURIComponent(sym)}?range=${range}`, { cache: "no-store" });
      if (!r.ok) throw new Error(`history ${r.status}`);
      return r.json();
    },
    enabled: realDataOnly && !isIntraday,
    ...queryOpts("reference"),
  });
  const fallback = realDataOnly ? 0 : (initialQuotes()[sym]?.last ?? seedLastFor(sym));
  const livePoints = useTickSeries(sym, fallback, 90);
  const points = realDataOnly
    ? (isIntraday ? intradayQ.data?.points ?? [] : historyQ.data?.points ?? []).map((p) => p.v)
    : livePoints;
  const prevClose = isIntraday ? intradayQ.data?.prevClose ?? null : null;
  const loading = realDataOnly && (isIntraday ? intradayQ.isLoading : historyQ.isLoading);

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-caption font-mono uppercase tracking-wider">Loading {range}…</p>
      </div>
    );
  }
  if (points.length < 2 || (realDataOnly && points.every((p) => p === 0))) {
    return realDataOnly ? (
      <div className="flex h-full items-center justify-center">
        <p className="text-caption font-mono uppercase tracking-wider">No {range} data for this symbol.</p>
      </div>
    ) : null;
  }

  const w = 800;
  const h = 360;
  const min = Math.min(...points);
  const max = Math.max(...points);
  const span = max - min || 1;
  const dx = w / (points.length - 1);
  const path = points
    .map((v, i) => {
      const x = i * dx;
      const y = h - ((v - min) / span) * (h - 24) - 12;
      return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  const area = `${path} L${w},${h} L0,${h} Z`;
  const up = points[points.length - 1]! >= points[0]!;

  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="h-full w-full" preserveAspectRatio="none">
      <defs>
        <linearGradient id={`sec-${sym}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={up ? "hsl(152 70% 50%)" : "hsl(351 90% 60%)"} stopOpacity={0.35} />
          <stop offset="100%" stopColor={up ? "hsl(152 70% 50%)" : "hsl(351 90% 60%)"} stopOpacity={0} />
        </linearGradient>
      </defs>
      {[0.25, 0.5, 0.75].map((p) => (
        <line key={p} x1={0} x2={w} y1={h * p} y2={h * p} stroke="hsl(var(--border))" strokeDasharray="2 4" />
      ))}
      <path d={area} fill={`url(#sec-${sym})`} />
      <path d={path} fill="none" stroke={up ? "hsl(152 70% 50%)" : "hsl(351 90% 60%)"} strokeWidth={1.6} />
      {realDataOnly && prevClose != null && prevClose >= min && prevClose <= max && (
        <line
          x1={0}
          x2={w}
          y1={h - ((prevClose - min) / span) * (h - 24) - 12}
          y2={h - ((prevClose - min) / span) * (h - 24) - 12}
          stroke="hsl(var(--muted-foreground))"
          strokeDasharray="3 3"
        />
      )}
    </svg>
  );
}
