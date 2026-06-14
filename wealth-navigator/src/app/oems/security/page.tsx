"use client";

import { Suspense, useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useSearchParams } from "next/navigation";
import { Search } from "lucide-react";

import { Panel } from "@/components/oems/primitives/panel";
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
    <div className="space-y-3">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">Security Lookup</h1>
          <p className="text-xs text-muted-foreground">
            {inst?.name} · {inst?.exchange} · {inst?.isin} · {inst?.sector}
          </p>
        </div>
        <div className="relative w-80">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={sym}
            onChange={(e) => setSym(e.target.value.toUpperCase())}
            placeholder="Ticker / ISIN / RIC"
            className="h-8 pl-8 font-mono text-xs"
          />
        </div>
      </header>

      <div className="grid grid-cols-12 gap-2.5">
        {equitiesQ.isLoading ? (
          <PanelSkeleton rows={1} height="h-[400px]" className="col-span-6 lg:col-span-2" />
        ) : (
          <Panel
            title="Watchlist · JSE"
            endpoint={realDataOnly ? "GET /api/quotes" : "GET /v1/quotes/batch"}
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
          <Panel
            title={`${inst?.symbol ?? "—"} · Intraday`}
            endpoint={realDataOnly ? "GET /api/quotes" : "PricingQuoteGet"}
            dataSource={quoteSource}
            className="col-span-12 lg:col-span-6 h-[400px]"
            right={<NumberCell sym={activeSym} fallback={realDataOnly ? 0 : seedLastFor(activeSym)} decimals={2} showChange />}
          >
            {realDataOnly && !hasLiveQuote ? (
              <EmptyDataState message="No intraday series — quote feed has no ticks for this symbol yet." />
            ) : (
              <SecurityChart sym={activeSym} realDataOnly={realDataOnly} />
            )}
          </Panel>
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
              <EmptyDataState message="Depth L2 feed not configured." />
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

      <Panel
        title="Reference · ISIN / RIC / Sector / Fundamentals"
        endpoint={`GET /v1/securities/${inst?.isin ?? ""}`}
        right={<span className="font-mono text-[10px]">{inst?.isin}</span>}
      >
        {equitiesQ.isLoading ? (
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-6" aria-busy="true" aria-live="polite">
            {[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17].map((n) => (
              <div key={`security-row-${n}`} className="rounded-md border border-border/60 bg-surface-2/30 p-2">
                <span className="shimmer block h-2 w-3/4 rounded" />
                <span className="shimmer mt-1.5 block h-3 w-1/2 rounded" />
              </div>
            ))}
          </div>
        ) : realDataOnly ? (
          <RealFundamentalsGrid sym={activeSym} />
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
      </Panel>
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
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-6">
      {fields.map(({ k, v }) => (
        <div key={k} className="rounded-md border border-border/60 bg-surface-2/30 p-2">
          <p className="text-[9.5px] uppercase tracking-wider text-muted-foreground">{k}</p>
          <p className="mt-0.5 font-mono text-xs font-semibold">{v}</p>
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

function RealFundamentalsGrid({ sym }: { sym: string }) {
  const universeQ = useQuery<{ securities: EquityFundamentals[] }>({
    queryKey: ["equities-universe"],
    queryFn: async () => {
      const r = await fetch("/api/equities", { cache: "no-store" });
      if (!r.ok) throw new Error(`equities ${r.status}`);
      return r.json();
    },
    ...queryOpts("reference"),
  });

  if (universeQ.isLoading) {
    return (
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-6" aria-busy="true" aria-live="polite">
        {[0, 1, 2, 3, 4, 5, 6, 7, 8].map((n) => (
          <div key={`real-fund-${n}`} className="rounded-md border border-border/60 bg-surface-2/30 p-2">
            <span className="shimmer block h-2 w-3/4 rounded" />
            <span className="shimmer mt-1.5 block h-3 w-1/2 rounded" />
          </div>
        ))}
      </div>
    );
  }

  const row = (universeQ.data?.securities ?? []).find(
    (s) => s.symbol.replace(/\.JO$/i, "").toUpperCase() === sym.toUpperCase(),
  );

  if (!row) {
    return (
      <EmptyDataState
        title="Security not in universe"
        message={`No reference row for ${sym} in the retail equities universe (securities_c).`}
      />
    );
  }

  const fmt = (v: number | null | undefined, dp = 2) =>
    v == null || !Number.isFinite(v) ? "—" : v.toFixed(dp);
  const pe = row.pe ?? row.pe_ratio;
  const fields: Array<{ k: string; v: string }> = [
    { k: "ISIN", v: row.isin ?? "—" },
    { k: "Sector", v: row.sector ?? "—" },
    { k: "Industry", v: row.industry ?? "—" },
    { k: "P/E", v: fmt(pe) },
    { k: "EPS", v: fmt(row.eps) },
    { k: "Div Yield", v: row.dividend_yield == null ? "—" : formatPct(row.dividend_yield) },
    { k: "Beta", v: fmt(row.beta) },
    { k: "Mkt Cap", v: row.market_cap == null ? "—" : formatZAR(row.market_cap) },
    { k: "YTD", v: row.ytd_performance == null ? "—" : formatPct(row.ytd_performance) },
  ];

  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-6">
      {fields.map(({ k, v }) => (
        <div key={k} className="rounded-md border border-border/60 bg-surface-2/30 p-2">
          <p className="text-[9.5px] uppercase tracking-wider text-muted-foreground">{k}</p>
          <p className="mt-0.5 font-mono text-xs font-semibold">{v}</p>
        </div>
      ))}
    </div>
  );
}

function SecurityChart({ sym, realDataOnly }: { sym: string; realDataOnly: boolean }) {
  // In real-data mode the chart pulls from `/api/intraday/[sym]` (DB-first
  // read of `stock_intraday_c`) so the line series is sourced from the
  // worker's actual upserts, not the noisy live-tick buffer. Audit #10.
  const intradayQ = useQuery<{
    points: Array<{ t: number; v: number }>;
    prevClose: number | null;
    source: string;
  }>({
    queryKey: ["bff-intraday", sym],
    queryFn: async () => {
      const r = await fetch(`/api/intraday/${encodeURIComponent(sym)}`, { cache: "no-store" });
      if (!r.ok) throw new Error(`intraday ${r.status}`);
      return r.json();
    },
    enabled: realDataOnly,
    refetchInterval: 15_000,
    ...queryOpts("live"),
  });
  const fallback = realDataOnly ? 0 : (initialQuotes()[sym]?.last ?? seedLastFor(sym));
  const livePoints = useTickSeries(sym, fallback, 90);
  const points = realDataOnly
    ? (intradayQ.data?.points ?? []).map((p) => p.v)
    : livePoints;
  const prevClose = intradayQ.data?.prevClose ?? null;
  if (points.length < 2 || (realDataOnly && points.every((p) => p === 0))) {
    return realDataOnly ? null : null;
  }

  const w = 800;
  const h = 360;
  const min = Math.min(...points);
  const max = Math.max(...points);
  const range = max - min || 1;
  const dx = w / (points.length - 1);
  const path = points
    .map((v, i) => {
      const x = i * dx;
      const y = h - ((v - min) / range) * (h - 24) - 12;
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
          y1={h - ((prevClose - min) / range) * (h - 24) - 12}
          y2={h - ((prevClose - min) / range) * (h - 24) - 12}
          stroke="hsl(var(--muted-foreground))"
          strokeDasharray="3 3"
        />
      )}
    </svg>
  );
}
