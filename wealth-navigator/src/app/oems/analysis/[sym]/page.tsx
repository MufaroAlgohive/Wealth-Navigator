"use client";

/**
 * /oems/analysis/[sym] — per-symbol Analysis tab.
 *
 * Sub-tabs (Fiscal.ai-style, but tuned to the OEMS data tiering):
 *   Overview · Financials · Estimates · Dividends · Ownership · News
 *   Filings · Research · Modeling
 *
 * Data sources (no fabricated values — every empty field is a typed reason):
 *   - Header last/change/volume: institutional `quote_snapshot_c` (IRESS L1)
 *   - Intraday chart:             retail `stock_intraday_c` (worker ticks)
 *   - Daily history chart:        worker → IRESS TimeSeriesGet2 (entitlement
 *                                 blocked until Charles flips DFM@Mint)
 *   - Fundamentals (Mkt Cap, P/E,
 *     EPS, Beta, Yld, …):         retail `securities_c` (Yahoo)
 *   - Research sub-tab:           retail `strategies_c` filter by ?sym=
 *   - News:                       Moneyweb + BusinessTech RSS
 *   - SENS:                       vendor_not_contracted (JSE SENS Web Feed)
 *   - Estimates / Dividends /
 *     Ownership:                  no consensus vendor (typed reasons)
 *
 * The active sub-tab is a `?tab=` query string, so any sub-tab is a
 * bookmarkable URL and the back/forward buttons restore state.
 */

import { useQuery } from "@tanstack/react-query";
import {
  AlertTriangle,
  Calendar,
  ChevronRight,
  ExternalLink,
  Percent,
  Radio,
  Scale,
  TrendingUp,
} from "lucide-react";
import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { AnalysisChart, type ChartMode, type IndicatorKey } from "@/components/analysis/analysis-chart";
import { DataSourceBadge } from "@/components/oems/primitives/data-source-badge";
import { EmptyDataState } from "@/components/oems/primitives/empty-data-state";
import { EntitlementRequired } from "@/components/oems/primitives/entitlement-required";
import { GlassSection, PageCanvas } from "@/components/oems/primitives/glass";
import { PanelSkeleton } from "@/components/oems/primitives/panel-skeleton";
import { Pill } from "@/components/oems/primitives/pill";
import type { BffUnavailableReason } from "@/lib/bff-reasons";
import { cn } from "@/lib/cn";
import { formatNumber, formatPct, formatZAR } from "@/lib/format";
import { useLiveQuotes } from "@/lib/hooks/use-live-quotes";
import { queryOpts } from "@/lib/store/query-provider";
import { useTick } from "@/lib/store/tick-stream-provider";

/** Tick shape mirror of `useTick`'s return type (kept local — not exported from the tick provider). */
type TickSnapshot = {
  last: number;
  prev: number;
  change: number;
  changePct: number;
  ts: number;
  vwap: number;
  volume: number;
};

const TABS = [
  { id: "overview", label: "Overview" },
  { id: "financials", label: "Financials" },
  { id: "estimates", label: "Estimates" },
  { id: "dividends", label: "Dividends" },
  { id: "ownership", label: "Ownership" },
  { id: "news", label: "News" },
  { id: "filings", label: "Filings" },
  { id: "research", label: "Research" },
  { id: "modeling", label: "Modeling" },
] as const;

type TabId = (typeof TABS)[number]["id"];

const CHART_RANGES = ["1D", "5D", "1M", "3M", "6M", "YTD", "1Y", "3Y", "5Y", "MAX"] as const;
type RangeId = (typeof CHART_RANGES)[number];

const RANGE_TO_BFF: Record<RangeId, string> = {
  "1D": "1D",
  "5D": "5D",
  "1M": "1M",
  "3M": "3M",
  "6M": "6M",
  YTD: "YTD",
  "1Y": "1Y",
  "3Y": "3Y",
  "5Y": "5Y",
  MAX: "MAX",
};

interface AnalysisResponse {
  sym: string;
  name: string | null;
  exchange: string;
  sector: string | null;
  industry: string | null;
  isin: string | null;
  currency: string;
  marketState: string | null;
  range: string;
  source: string;
  reason?: BffUnavailableReason;
  snapshot: Record<string, unknown> | null;
  intraday: { prevClose: number | null; points: Array<{ t: number; v: number }>; source: string };
  history: {
    range: string;
    points: Array<{ t: number; v: number }>;
    source: string;
    entitlementBlocked?: boolean;
  };
  fundamentals: Record<string, unknown> | null;
  sub: {
    snapshot: { reason?: BffUnavailableReason; message?: string; error?: string; source: string };
    intraday: { reason?: BffUnavailableReason; message?: string; error?: string; source: string };
    history: {
      reason?: BffUnavailableReason;
      message?: string;
      error?: string;
      source: string;
      entitlementBlocked?: boolean;
    };
    fundamentals: { reason?: BffUnavailableReason; message?: string; error?: string; source: string };
  };
}

function AnalysisPageContent() {
  const params = useParams<{ sym: string }>();
  const symRaw = String(params?.sym ?? "").toUpperCase();
  const sym = symRaw.replace(/\.(JO|JSE)$/i, "");
  const router = useRouter();
  const searchParams = useSearchParams();

  const [activeTab, setActiveTab] = useState<TabId>(() => {
    const t = searchParams.get("tab");
    return TABS.some((x) => x.id === t) ? (t as TabId) : "overview";
  });
  useEffect(() => {
    const t = searchParams.get("tab");
    if (t && TABS.some((x) => x.id === t)) setActiveTab(t as TabId);
  }, [searchParams]);

  const onTabChange = useCallback(
    (t: TabId) => {
      setActiveTab(t);
      const sp = new URLSearchParams(Array.from(searchParams.entries()));
      sp.set("tab", t);
      router.replace(`/oems/analysis/${sym}?${sp.toString()}` as never);
    },
    [router, searchParams, sym],
  );

  // Arrow-key navigation across the sub-tab strip — a11y expectation from the
  // spec (all sub-tabs must be keyboard-navigable).
  const tablistRef = useRef<HTMLDivElement | null>(null);
  const onTabKey = (e: React.KeyboardEvent) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    e.preventDefault();
    const i = TABS.findIndex((x) => x.id === activeTab);
    const next = e.key === "ArrowRight" ? (i + 1) % TABS.length : (i - 1 + TABS.length) % TABS.length;
    onTabChange(TABS[next]?.id as TabId);
  };

  const [range, setRange] = useState<RangeId>("1Y");
  const [mode, setMode] = useState<ChartMode>("line");
  const [activeIndicators, setActiveIndicators] = useState<Set<IndicatorKey>>(new Set(["sma20"]));

  const toggleIndicator = (k: IndicatorKey) => {
    setActiveIndicators((prev) => {
      const n = new Set(prev);
      if (n.has(k)) n.delete(k);
      else n.add(k);
      return n;
    });
  };

  const analysisQ = useQuery<AnalysisResponse>({
    queryKey: ["bff-analysis", sym, RANGE_TO_BFF[range]],
    queryFn: async () => {
      const r = await fetch(`/api/analysis/${encodeURIComponent(sym)}?range=${RANGE_TO_BFF[range]}`, {
        cache: "no-store",
      });
      if (!r.ok) throw new Error(`analysis ${r.status}`);
      return r.json();
    },
    enabled: Boolean(sym),
    refetchInterval: 30_000,
    ...queryOpts("reference"),
  });

  // Subscribe to live tick for the header (Live tick overlay — OEMS-only).
  const tick = useTick(sym);
  const hasLiveTick = tick.ts > 0 && tick.last > 0;
  // Also force-load the symbol via the live-quotes BFF so a click from a
  // list (not from Security page) populates the tick stream.
  useLiveQuotes([sym], Boolean(sym));

  if (!sym) {
    return (
      <PageCanvas>
        <header>
          <h1 className="text-display">Analysis</h1>
          <p className="text-caption">No symbol supplied.</p>
        </header>
      </PageCanvas>
    );
  }

  const data = analysisQ.data;
  const snap = (data?.snapshot ?? {}) as {
    last: number | null;
    open: number | null;
    high: number | null;
    low: number | null;
    bid: number | null;
    ask: number | null;
    prevClose: number | null;
    volume: number | null;
    vwap: number | null;
    week52High: number | null;
    week52Low: number | null;
    avgVolume: number | null;
    currency: string | null;
    marketState: string | null;
    asOf: string | null;
  };
  const f = (data?.fundamentals ?? {}) as {
    name: string | null;
    sector: string | null;
    industry: string | null;
    isin: string | null;
    pe: number | null;
    eps: number | null;
    dividend_yield: number | null;
    beta: number | null;
    market_cap: number | null;
    ytd_performance: number | null;
    last_price: number | null;
    change_percent: number | null;
  };

  // Last price: prefer the live tick, else the IRESS L1 snapshot, else the
  // retail Yahoo last (CENTS). Tick stream is the most up-to-date (worker
  // pushes every cycle); the L1 snapshot is the BFF's authoritative source.
  const liveLast = hasLiveTick ? tick.last : null;
  const lastRands = liveLast ?? snap.last ?? (f.last_price != null ? f.last_price / 100 : null);
  const prevCloseRands = snap.prevClose ?? null;
  const chgPct =
    lastRands != null && prevCloseRands != null && prevCloseRands > 0
      ? ((lastRands - prevCloseRands) / prevCloseRands) * 100
      : f.change_percent != null
        ? f.change_percent
        : null;

  const headerSource: "iress" | "supabase" | "stream" | "yahoo" | "unavailable" = hasLiveTick
    ? "stream"
    : data?.sub.snapshot.source === "supabase"
      ? "iress"
      : data?.sub.fundamentals.source === "supabase"
        ? "yahoo"
        : "unavailable";

  return (
    <PageCanvas>
      {/* ── Header strip ──────────────────────────────────────────────── */}
      <header className="glass-panel relative overflow-hidden p-5 md:p-6">
        <div className="pointer-events-none absolute -right-20 -top-20 h-56 w-56 rounded-full bg-primary/15 blur-3xl" />
        <div className="relative flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0 flex-1 space-y-1.5">
            <div className="flex flex-wrap items-center gap-2">
              <Link
                href={`/oems/security?sym=${sym}`}
                className="text-caption inline-flex items-center gap-1 font-mono text-muted-foreground transition-colors hover:text-primary"
                title="Open in Security"
              >
                {sym}
                <ChevronRight className="h-3 w-3" />
              </Link>
              <h1 className="text-display text-2xl">{f.name ?? data?.name ?? sym}</h1>
              {snap.marketState ? (
                <Pill
                  tone={
                    snap.marketState === "OPEN"
                      ? "success"
                      : snap.marketState === "PRE" || snap.marketState === "POST"
                        ? "warning"
                        : "neutral"
                  }
                  dot
                  size="xs"
                >
                  {snap.marketState}
                </Pill>
              ) : (
                <Pill tone="neutral" size="xs">
                  —
                </Pill>
              )}
              {data?.exchange ? (
                <Pill tone="info" size="xs">
                  {data.exchange}
                </Pill>
              ) : null}
              {f.sector ? (
                <Pill tone="neutral" size="xs">
                  {f.sector}
                </Pill>
              ) : null}
              {hasLiveTick ? (
                <Pill tone="success" size="xs" dot>
                  <Radio className="h-2.5 w-2.5" />
                  LIVE
                </Pill>
              ) : null}
            </div>
            <p className="text-caption font-mono">
              {f.isin ?? "—"} · {data?.currency ?? "ZAR"} · {f.industry ?? "—"}
            </p>
          </div>
          <div className="flex flex-col items-end gap-1.5">
            <div className="flex items-baseline gap-3">
              <span className="font-mono text-3xl font-semibold tabular-nums">
                {lastRands != null ? formatZAR(lastRands) : "—"}
              </span>
              <span
                className={cn(
                  "font-mono text-sm font-semibold tabular-nums",
                  chgPct == null
                    ? "text-muted-foreground"
                    : chgPct > 0
                      ? "text-up"
                      : chgPct < 0
                        ? "text-down"
                        : "text-muted-foreground",
                )}
              >
                {chgPct == null ? "—" : `${chgPct >= 0 ? "+" : ""}${chgPct.toFixed(2)}%`}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <DataSourceBadge
                source={
                  headerSource === "iress"
                    ? "iress"
                    : headerSource === "stream"
                      ? "stream"
                      : headerSource === "yahoo"
                        ? "yahoo"
                        : "unavailable"
                }
              />
              {snap.asOf ? (
                <span className="font-mono text-[10px] text-muted-foreground">
                  as of{" "}
                  {new Date(snap.asOf).toLocaleTimeString("en-ZA", {
                    hour: "2-digit",
                    minute: "2-digit",
                    timeZone: "Africa/Johannesburg",
                  })}{" "}
                  SAST
                </span>
              ) : null}
            </div>
          </div>
        </div>
      </header>

      {/* ── Sub-tab nav ──────────────────────────────────────────────── */}
      <div
        ref={tablistRef}
        role="tablist"
        aria-label="Analysis sub-tabs"
        className="glass-inset flex flex-wrap items-center gap-0.5 p-1"
        onKeyDown={onTabKey}
      >
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={activeTab === t.id}
            tabIndex={activeTab === t.id ? 0 : -1}
            onClick={() => onTabChange(t.id)}
            className={cn(
              "h-8 rounded-lg px-3 text-[12px] font-medium transition-all duration-200",
              activeTab === t.id
                ? "bg-primary text-primary-foreground shadow-[0_2px_12px_hsl(var(--primary)/0.35)]"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* ── Sub-tab body ─────────────────────────────────────────────── */}
      {analysisQ.isLoading ? (
        <PanelSkeleton rows={6} height="h-[420px]" />
      ) : data ? (
        <>
          {activeTab === "overview" && (
            <OverviewTab
              sym={sym}
              data={data}
              liveLast={liveLast}
              tick={tick}
              range={range}
              setRange={setRange}
              mode={mode}
              setMode={setMode}
              activeIndicators={activeIndicators}
              toggleIndicator={toggleIndicator}
              hasLiveTick={hasLiveTick}
            />
          )}
          {activeTab === "financials" && <FinancialsTab sym={sym} data={data} />}
          {activeTab === "estimates" && <EstimatesTab sym={sym} data={data} />}
          {activeTab === "dividends" && <DividendsTab sym={sym} data={data} />}
          {activeTab === "ownership" && <OwnershipTab sym={sym} data={data} />}
          {activeTab === "news" && <NewsTab sym={sym} />}
          {activeTab === "filings" && <FilingsTab sym={sym} />}
          {activeTab === "research" && <ResearchTab sym={sym} />}
          {activeTab === "modeling" && <ModelingTab sym={sym} lastRands={lastRands} />}
        </>
      ) : (
        <EmptyDataState
          reason="empty"
          message="No analysis payload returned."
          hint={analysisQ.error instanceof Error ? analysisQ.error.message : "Try a different symbol."}
        />
      )}
    </PageCanvas>
  );
}

export default function AnalysisPage() {
  return (
    <Suspense fallback={<PanelSkeleton rows={6} height="h-[420px]" />}>
      <AnalysisPageContent />
    </Suspense>
  );
}

// ─── Shared sub-components ─────────────────────────────────────────────

function FieldRow({ k, v, reason }: { k: string; v: string; reason?: string }) {
  return (
    <div className="flex items-center justify-between gap-3 px-4 py-2.5">
      <span className="text-caption">{k}</span>
      <div className="flex flex-col items-end">
        <span className="font-mono text-xs font-semibold tabular-nums">{v}</span>
        {reason ? <span className="font-mono text-[9.5px] text-muted-foreground/70">{reason}</span> : null}
      </div>
    </div>
  );
}

function EmptyReasonNote({ reason, message }: { reason?: BffUnavailableReason; message?: string }) {
  if (!reason && !message) return null;
  return (
    <p className="mt-2 font-mono text-[10.5px] text-muted-foreground">
      {reason ? `reason: ${reason}` : null}
      {reason && message ? " · " : null}
      {message}
    </p>
  );
}

function BlockedNote({ children }: { children: React.ReactNode }) {
  return (
    <p className="mt-2 inline-flex items-center gap-1.5 rounded-md border border-warning/30 bg-warning/5 px-2 py-1 font-mono text-[10px] text-warning">
      <AlertTriangle className="h-3 w-3" />
      {children}
    </p>
  );
}

// ─── Overview tab ─────────────────────────────────────────────────────

function OverviewTab({
  sym,
  data,
  liveLast: _liveLast,
  tick,
  range,
  setRange,
  mode,
  setMode,
  activeIndicators,
  toggleIndicator,
  hasLiveTick: _hasLiveTick,
}: {
  sym: string;
  data: AnalysisResponse;
  liveLast: number | null;
  tick: TickSnapshot;
  range: RangeId;
  setRange: (r: RangeId) => void;
  mode: ChartMode;
  setMode: (m: ChartMode) => void;
  activeIndicators: Set<IndicatorKey>;
  toggleIndicator: (k: IndicatorKey) => void;
  hasLiveTick: boolean;
}) {
  const snap = (data.snapshot ?? {}) as {
    last: number | null;
    open: number | null;
    high: number | null;
    low: number | null;
    bid: number | null;
    ask: number | null;
    prevClose: number | null;
    volume: number | null;
    vwap: number | null;
    week52High: number | null;
    week52Low: number | null;
    avgVolume: number | null;
    marketState: string | null;
    asOf: string | null;
  };
  const f = (data.fundamentals ?? {}) as {
    pe: number | null;
    eps: number | null;
    dividend_yield: number | null;
    beta: number | null;
    market_cap: number | null;
    ytd_performance: number | null;
    last_price: number | null;
  };

  // Resolve chart points: 1D = intraday ticks; longer ranges = daily history.
  // We unify on { t, v } because lightweight-charts' line mode only needs a
  // value; candle mode synthesises OHLC from the close.
  const usingHistory = range !== "1D";
  const rawPoints = usingHistory ? data.history.points : data.intraday.points;
  const points = useMemo(
    () =>
      (rawPoints ?? []).filter(
        (p): p is { t: number; v: number } => Number.isFinite(p.t) && Number.isFinite(p.v) && p.v > 0,
      ),
    [rawPoints],
  );
  const prevClose = usingHistory ? null : data.intraday.prevClose;

  // Client-side analytics (OEMS-only): rolling vol, 52w percentile, distance
  // from 50/200 DMA. Honest fallback to "—" when not enough history.
  const analytics = useMemo(() => computeAnalytics(points), [points]);

  const chartEndpoint = usingHistory ? "GET /api/history" : "GET /api/intraday";
  const chartSource: "iress" | "supabase" | "blocked-external" | "unavailable" = usingHistory
    ? data.sub.history.entitlementBlocked
      ? "blocked-external"
      : data.sub.history.source === "iress"
        ? "iress"
        : "unavailable"
    : data.sub.intraday.source === "supabase"
      ? "supabase"
      : "unavailable";

  return (
    <div className="space-y-4">
      {/* Chart panel */}
      <GlassSection
        title={`${sym} · ${range}`}
        subtitle={usingHistory ? "IRESS TimeSeriesGet2 daily" : "Worker-ingested ticks (stock_intraday_c)"}
        endpoint={chartEndpoint}
        dataSource={chartSource}
        noPadding
        right={
          <div className="flex flex-wrap items-center gap-2">
            <div className="glass-inset inline-flex gap-0.5 p-1">
              {CHART_RANGES.map((r) => (
                <button
                  key={r}
                  type="button"
                  onClick={() => setRange(r)}
                  className={cn(
                    "h-6 rounded-md px-1.5 font-mono text-[10px] font-medium transition-all duration-200",
                    range === r
                      ? "bg-primary text-primary-foreground shadow-[0_2px_12px_hsl(var(--primary)/0.35)]"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {r}
                </button>
              ))}
            </div>
            <div className="glass-inset inline-flex gap-0.5 p-1">
              {(["line", "candle"] as ChartMode[]).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setMode(m)}
                  className={cn(
                    "h-6 rounded-md px-1.5 font-mono text-[10px] font-medium transition-all duration-200",
                    mode === m
                      ? "bg-primary text-primary-foreground shadow-[0_2px_12px_hsl(var(--primary)/0.35)]"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {m === "line" ? "Line" : "Candle"}
                </button>
              ))}
            </div>
          </div>
        }
      >
        <div className="flex min-h-0 flex-1 flex-col gap-3 p-4">
          {/* Indicator toggles */}
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-caption font-mono text-muted-foreground">Indicators:</span>
            {(
              [
                ["sma20", "SMA 20"],
                ["sma50", "SMA 50"],
                ["sma200", "SMA 200"],
                ["ema20", "EMA 20"],
                ["rsi", "RSI 14"],
                ["macd", "MACD 12·26·9"],
              ] as Array<[IndicatorKey, string]>
            ).map(([k, label]) => {
              const on = activeIndicators.has(k);
              return (
                <button
                  key={k}
                  type="button"
                  onClick={() => toggleIndicator(k)}
                  className={cn(
                    "rounded-md border px-1.5 py-0.5 font-mono text-[10px] transition-colors",
                    on
                      ? "border-primary/40 bg-primary/10 text-primary"
                      : "border-[hsl(var(--glass-border))] text-muted-foreground hover:border-[hsl(var(--glass-border-strong))] hover:text-foreground",
                  )}
                  aria-pressed={on}
                >
                  {label}
                </button>
              );
            })}
          </div>
          <div className="glass-inset min-h-[420px] flex-1 p-2">
            {data.sub.history.entitlementBlocked ? (
              <EntitlementRequired
                method="TimeSeriesGet2"
                codes={["J200", "J203", "R2030", "R2035", "R2040"]}
                note="Ask Charles to enable TimeSeriesGet2 on the production IRESS V4 profile. Until flipped, the 5D…MAX history chart stays empty."
              />
            ) : points.length < 2 ? (
              <EmptyDataState
                reason={data.sub.history.reason ?? data.sub.intraday.reason}
                message="No price points for this range."
                hint={
                  usingHistory
                    ? (data.sub.history.message ??
                      "Worker hasn't ingested daily history yet (or TimeSeriesGet2 is entitlement-blocked).")
                    : (data.sub.intraday.message ??
                      "No intraday ticks — worker has not polled this symbol yet.")
                }
                badgeLabel={usingHistory ? "blocked-external" : "unconfigured"}
              />
            ) : (
              <AnalysisChart
                sym={sym}
                points={points}
                prevClose={prevClose}
                mode={mode}
                indicators={activeIndicators}
                height={usingHistory ? 360 : 320}
              />
            )}
          </div>
        </div>
      </GlassSection>

      {/* Price & volume analytics + key statistics grid */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <GlassSection
          title="Price & volume analytics"
          subtitle="OEMS-only — computed from the loaded history"
          endpoint="client-compute"
          dataSource={data.sub.history.source === "iress" ? "iress" : "supabase"}
        >
          <div className="grid grid-cols-2 gap-px overflow-hidden sm:grid-cols-3">
            <FieldRow
              k="20D vol (ann.)"
              v={analytics.vol20 != null ? `${(analytics.vol20 * 100).toFixed(1)}%` : "—"}
              reason={analytics.vol20 == null ? "history < 20 pts" : undefined}
            />
            <FieldRow
              k="60D vol (ann.)"
              v={analytics.vol60 != null ? `${(analytics.vol60 * 100).toFixed(1)}%` : "—"}
              reason={analytics.vol60 == null ? "history < 60 pts" : undefined}
            />
            <FieldRow
              k="52W percentile"
              v={analytics.percentile52w != null ? `${analytics.percentile52w.toFixed(0)}th` : "—"}
              reason={analytics.percentile52w == null ? "history < 1Y" : undefined}
            />
            <FieldRow
              k="Distance vs 50 DMA"
              v={analytics.dist50 != null ? formatPct(analytics.dist50) : "—"}
              reason={analytics.dist50 == null ? "history < 50 pts" : undefined}
            />
            <FieldRow
              k="Distance vs 200 DMA"
              v={analytics.dist200 != null ? formatPct(analytics.dist200) : "—"}
              reason={analytics.dist200 == null ? "history < 200 pts" : undefined}
            />
            <FieldRow
              k="Beta-adj return"
              v={analytics.betaAdjReturn != null ? formatPct(analytics.betaAdjReturn) : "—"}
              reason="beta × period return; ALSI proxy unavailable"
            />
          </div>
        </GlassSection>

        <GlassSection
          title="Company statistics"
          subtitle="Yahoo (securities_c) + IRESS L1 (quote_snapshot_c)"
          endpoint="GET /api/equities + /api/quote-snapshot"
          dataSource={
            data.sub.fundamentals.source === "supabase" && data.sub.snapshot.source === "supabase"
              ? "hybrid"
              : data.sub.fundamentals.source === "supabase"
                ? "yahoo"
                : "unavailable"
          }
        >
          <div className="grid grid-cols-1 gap-px overflow-hidden sm:grid-cols-2">
            <FieldRow k="Previous Close" v={snap.prevClose != null ? formatZAR(snap.prevClose) : "—"} />
            <FieldRow k="Open" v={snap.open != null ? formatZAR(snap.open) : "—"} />
            <FieldRow
              k="Bid"
              v={snap.bid != null ? formatZAR(snap.bid) : "—"}
              reason={snap.bid == null ? "IRESS L2 not entitled" : undefined}
            />
            <FieldRow
              k="Ask"
              v={snap.ask != null ? formatZAR(snap.ask) : "—"}
              reason={snap.ask == null ? "IRESS L2 not entitled" : undefined}
            />
            <FieldRow
              k="Day's Range"
              v={
                snap.low != null && snap.high != null
                  ? `${formatZAR(snap.low)} – ${formatZAR(snap.high)}`
                  : "—"
              }
            />
            <FieldRow
              k="52W Range"
              v={
                snap.week52Low != null && snap.week52High != null
                  ? `${formatZAR(snap.week52Low)} – ${formatZAR(snap.week52High)}`
                  : "—"
              }
              reason={snap.week52Low == null ? "no 52w history" : undefined}
            />
            <FieldRow k="Volume" v={snap.volume != null ? formatNumber(snap.volume) : "—"} />
            <FieldRow
              k="Avg. Volume"
              v={snap.avgVolume != null ? formatNumber(snap.avgVolume) : "—"}
              reason={snap.avgVolume == null ? "no daily avg" : undefined}
            />
            <FieldRow k="VWAP" v={snap.vwap != null ? formatZAR(snap.vwap) : "—"} />
            <FieldRow k="Market Cap" v={f.market_cap != null ? formatZAR(f.market_cap) : "—"} />
            <FieldRow k="Beta (5Y)" v={f.beta != null ? f.beta.toFixed(2) : "—"} />
            <FieldRow k="P/E (TTM)" v={f.pe != null ? f.pe.toFixed(2) : "—"} />
            <FieldRow k="EPS (TTM)" v={f.eps != null ? f.eps.toFixed(2) : "—"} />
            <FieldRow k="Div Yield" v={f.dividend_yield != null ? `${f.dividend_yield.toFixed(2)}%` : "—"} />
            <FieldRow k="YTD" v={f.ytd_performance != null ? formatPct(f.ytd_performance) : "—"} />
            <FieldRow k="EV / EBITDA" v="—" reason="no vendor" />
            <FieldRow k="P/B" v="—" reason="no vendor" />
            <FieldRow k="P/FCF" v="—" reason="no vendor" />
            <FieldRow k="ROE" v="—" reason="no vendor" />
            <FieldRow k="ROIC" v="—" reason="no vendor" />
            <FieldRow k="Net Debt" v="—" reason="no vendor" />
            <FieldRow k="D/E" v="—" reason="no vendor" />
            <FieldRow k="1Y Target Est" v="—" reason="no consensus vendor" />
          </div>
        </GlassSection>
      </div>

      {/* Profile + Live tick note */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <GlassSection
          title="Profile"
          subtitle="securities_c + public filings"
          endpoint="GET /api/equities"
          dataSource="yahoo"
        >
          <div className="grid grid-cols-1 gap-px overflow-hidden sm:grid-cols-2">
            <FieldRow k="Description" v="—" reason="securities_c.description not yet populated" />
            <FieldRow k="CEO" v="—" reason="no officer feed" />
            <FieldRow k="Sector" v={data.sector ?? "—"} />
            <FieldRow k="Industry" v={data.industry ?? "—"} />
            <FieldRow k="Year founded" v="—" reason="no IPO vintage field" />
            <FieldRow k="Headquarters" v="—" reason="no address field" />
            <FieldRow k="Website" v="—" reason="no website field" />
            <FieldRow k="Employees" v="—" reason="no headcount vendor" />
          </div>
        </GlassSection>

        <GlassSection
          title="Live tick overlay"
          subtitle="Worker stream (stock_intraday_c → SSE)"
          endpoint="WS /api/ticks"
          dataSource={_hasLiveTick ? "stream" : "unavailable"}
        >
          <div className="space-y-3">
            <p className="text-caption">
              When a new tick lands the header last-price flashes. The current tick snapshot is below.
            </p>
            <div className="grid grid-cols-2 gap-px overflow-hidden sm:grid-cols-3">
              <FieldRow k="Last (tick)" v={_liveLast != null ? formatZAR(_liveLast) : "—"} />
              <FieldRow k="VWAP (tick)" v={_liveLast != null ? formatZAR(tick.vwap) : "—"} />
              <FieldRow k="Volume" v={_hasLiveTick ? formatNumber(tick.volume) : "—"} />
              <FieldRow k="Δ vs prev" v={_hasLiveTick ? formatPct(tick.changePct) : "—"} />
              <FieldRow k="Source" v={_hasLiveTick ? "STREAM" : "—"} />
              <FieldRow
                k="Last tick"
                v={
                  _hasLiveTick
                    ? `${new Date(tick.ts).toLocaleTimeString("en-ZA", { hour: "2-digit", minute: "2-digit", second: "2-digit", timeZone: "Africa/Johannesburg" })} SAST`
                    : "—"
                }
              />
            </div>
            {!_hasLiveTick ? (
              <EmptyDataState
                reason="empty"
                message="No live ticks for this symbol yet."
                hint="The worker has not polled this name (or the SSE stream is disconnected). The header uses the IRESS L1 snapshot as a fallback."
                badgeLabel="unconfigured"
              />
            ) : null}
          </div>
        </GlassSection>
      </div>
    </div>
  );
}

// ─── Tab implementations (Financials, Estimates, Dividends, Ownership) ──

function FinancialsTab({ sym: _sym, data }: { sym: string; data: AnalysisResponse }) {
  const f = (data.fundamentals ?? {}) as { eps: number | null; pe: number | null; market_cap: number | null };
  const [view, setView] = useState<"income" | "balance" | "cashflow">("income");
  const [period, setPeriod] = useState<"annual" | "quarter">("annual");
  void f;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="glass-inset inline-flex p-1">
          {(
            [
              ["income", "Income"],
              ["balance", "Balance"],
              ["cashflow", "Cash Flow"],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              onClick={() => setView(id)}
              className={cn(
                "h-7 rounded-lg px-3 text-xs font-medium transition-all duration-200",
                view === id
                  ? "bg-primary text-primary-foreground shadow-[0_2px_12px_hsl(var(--primary)/0.35)]"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="glass-inset inline-flex p-1">
          {(["annual", "quarter"] as const).map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => setPeriod(p)}
              className={cn(
                "h-7 rounded-lg px-3 text-xs font-medium transition-all duration-200",
                period === p
                  ? "bg-primary text-primary-foreground shadow-[0_2px_12px_hsl(var(--primary)/0.35)]"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {p === "annual" ? "Annual" : "Quarterly"}
            </button>
          ))}
        </div>
      </div>

      <GlassSection
        title={`${view === "income" ? "Income statement" : view === "balance" ? "Balance sheet" : "Cash flow"} · ${period === "annual" ? "FY" : "FQ"}`}
        subtitle="securities_c has only the current-period snapshot; full statements require a fundamentals vendor"
        endpoint="GET /api/equities"
        dataSource="yahoo"
      >
        <div className="glass-inset overflow-hidden">
          <div className="overflow-x-auto scrollbar-thin">
            <table className="w-full font-mono text-xs">
              <thead>
                <tr className="border-b border-[hsl(var(--glass-border))] bg-[hsl(var(--foreground)/0.02)]">
                  <th className="px-3 py-2.5 text-left text-caption font-medium">Line item</th>
                  {period === "annual"
                    ? ["FY+4", "FY+3", "FY+2", "FY+1", "FY"].map((h) => (
                        <th key={h} className="px-3 py-2.5 text-right text-caption font-medium">
                          {h}
                        </th>
                      ))
                    : ["Q+3", "Q+2", "Q+1", "Q0"].map((h) => (
                        <th key={h} className="px-3 py-2.5 text-right text-caption font-medium">
                          {h}
                        </th>
                      ))}
                </tr>
              </thead>
              <tbody>
                {[
                  "Revenue",
                  "Gross profit",
                  "Operating income",
                  "EBITDA",
                  "Pre-tax income",
                  "Net income",
                  "EPS (diluted)",
                ].map((row) => (
                  <tr key={row} className="border-b border-[hsl(var(--glass-border))]/60">
                    <td className="px-3 py-2 font-semibold">{row}</td>
                    {(period === "annual" ? [0, 1, 2, 3, 4] : [0, 1, 2, 3]).map((c) => (
                      <td key={c} className="px-3 py-2 text-right text-muted-foreground tabular-nums">
                        —
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
        <p className="mt-2 text-caption">
          Full per-period statements require a fundamentals vendor (Refinitiv / FactSet). Only the
          current-period snapshot (EPS, P/E, market cap) is sourced from securities_c. The time-series panels
          elsewhere in the desk remain entitlement-blocked until TimeSeriesGet2 is enabled.
        </p>
        {data.sub.history.entitlementBlocked ? (
          <div className="mt-2">
            <BlockedNote>
              TimeSeriesGet2 entitlement required for any multi-period statement to populate.
            </BlockedNote>
          </div>
        ) : null}
      </GlassSection>
    </div>
  );
}

function EstimatesTab({ sym: _sym, data }: { sym: string; data: AnalysisResponse }) {
  const f = (data.fundamentals ?? {}) as { eps: number | null; pe: number | null };
  return (
    <GlassSection
      title="Analyst estimates"
      subtitle="No consensus vendor wired"
      endpoint="vendor_required"
      dataSource="blocked-vendor"
    >
      <div className="grid grid-cols-1 gap-px overflow-hidden sm:grid-cols-2">
        <FieldRow k="P/E (NTM)" v="—" reason="no consensus vendor" />
        <FieldRow k="EV/EBITDA (NTM)" v="—" reason="no consensus vendor" />
        <FieldRow k="EPS growth (NTM)" v="—" reason="no consensus vendor" />
        <FieldRow k="Price target (consensus)" v="—" reason="no consensus vendor" />
        <FieldRow k="EPS LT growth est." v="—" reason="no consensus vendor" />
        <FieldRow k="P/E (TTM)" v={f.pe != null ? f.pe.toFixed(2) : "—"} reason="securities_c snapshot" />
        <FieldRow k="EPS (TTM)" v={f.eps != null ? f.eps.toFixed(2) : "—"} reason="securities_c snapshot" />
        <FieldRow k="Recommendation distribution" v="—" reason="no consensus vendor" />
      </div>
      <p className="mt-3 text-caption">
        Sell-side estimates require a vendor (Refinitiv I/B/E/S, FactSet, S&P Capital IQ). The OEMS stack does
        not subscribe to a consensus feed today; only the Yahoo-fed securities_c snapshot is available.
      </p>
    </GlassSection>
  );
}

function DividendsTab({ sym: _sym, data }: { sym: string; data: AnalysisResponse }) {
  const f = (data.fundamentals ?? {}) as { dividend_yield: number | null };
  return (
    <GlassSection
      title="Dividends"
      subtitle="Yahoo snapshot only; no vendor for DPS history"
      endpoint="GET /api/equities"
      dataSource="yahoo"
    >
      <div className="grid grid-cols-1 gap-px overflow-hidden sm:grid-cols-2">
        <FieldRow k="DPS (10Y history)" v="—" reason="no vendor" />
        <FieldRow k="Yield (TTM)" v={f.dividend_yield != null ? `${f.dividend_yield.toFixed(2)}%` : "—"} />
        <FieldRow k="Payout ratio" v="—" reason="no vendor" />
        <FieldRow k="Ex-div date" v="—" reason="no vendor" />
        <FieldRow k="Payment date" v="—" reason="no vendor" />
        <FieldRow k="DPS growth (3Y)" v="—" reason="no vendor" />
        <FieldRow k="DPS growth (5Y)" v="—" reason="no vendor" />
        <FieldRow k="DPS growth (10Y)" v="—" reason="no vendor" />
        <FieldRow k="DPS growth (Fwd 2Y)" v="—" reason="no vendor" />
      </div>
    </GlassSection>
  );
}

function OwnershipTab({ sym: _sym, data: _data }: { sym: string; data: AnalysisResponse }) {
  return (
    <GlassSection
      title="Ownership"
      subtitle="No institutional / insider feed wired"
      endpoint="vendor_required"
      dataSource="blocked-vendor"
    >
      <div className="grid grid-cols-1 gap-px overflow-hidden sm:grid-cols-2">
        <FieldRow k="Top institutional #1" v="—" reason="no vendor" />
        <FieldRow k="Top institutional #2" v="—" reason="no vendor" />
        <FieldRow k="Top institutional #3" v="—" reason="no vendor" />
        <FieldRow k="Top institutional #4" v="—" reason="no vendor" />
        <FieldRow k="Top institutional #5" v="—" reason="no vendor" />
        <FieldRow k="Top insider #1" v="—" reason="no vendor" />
        <FieldRow k="Top insider #2" v="—" reason="no vendor" />
        <FieldRow k="Top insider #3" v="—" reason="no vendor" />
        <FieldRow k="Top insider #4" v="—" reason="no vendor" />
        <FieldRow k="Top insider #5" v="—" reason="no vendor" />
        <FieldRow k="% institutional" v="—" reason="no vendor" />
        <FieldRow k="% insider" v="—" reason="no vendor" />
      </div>
      <p className="mt-3 text-caption">
        Institutional and insider holdings require a vendor (Refinitiv ownership, Bloomberg HOLD) — not on the
        OEMS stack today.
      </p>
    </GlassSection>
  );
}

// ─── News / Filings / Research / Modeling tabs ────────────────────────

interface NewsItem {
  id: string;
  source: string;
  category: string;
  severity: string;
  ticker: string | null;
  issuer: string | null;
  headline: string;
  body: string | null;
  url: string | null;
  publishedAt: string;
  ts: number;
  priority: string;
  tickers: string[];
}

interface NewsResponse {
  items: NewsItem[];
  count: number;
  source: string;
  reason?: string;
  message?: string;
}

function NewsTab({ sym }: { sym: string }) {
  const newsQ = useQuery<NewsResponse>({
    queryKey: ["bff-analysis-news", sym],
    queryFn: async () => {
      const r = await fetch("/api/news?limit=50", { cache: "no-store" });
      if (!r.ok) throw new Error(`news ${r.status}`);
      return r.json();
    },
    refetchInterval: 60_000,
    ...queryOpts("reference"),
  });
  const sensQ = useQuery<{
    items: Array<{ id: string; headline: string; ts: number; source: string }>;
    count: number;
    reason?: string;
    message?: string;
  }>({
    queryKey: ["bff-analysis-sens", sym],
    queryFn: async () => {
      const r = await fetch(`/api/sens?sym=${encodeURIComponent(sym)}`, { cache: "no-store" });
      if (!r.ok) throw new Error(`sens ${r.status}`);
      return r.json();
    },
    refetchInterval: 60_000,
    ...queryOpts("reference"),
  });

  const items = (newsQ.data?.items ?? []).filter((n) => {
    const t = n.tickers.map((x) => x.toUpperCase());
    return n.ticker?.toUpperCase() === sym || t.includes(sym) || t.length === 0;
  });
  const sens = sensQ.data?.items ?? [];

  return (
    <div className="space-y-4">
      <GlassSection
        title="News · symbol-tagged"
        subtitle="Moneyweb + BusinessTech RSS · Alliance wire (when wired)"
        endpoint="GET /api/news"
        dataSource={newsQ.data?.source === "unavailable" ? "unavailable" : "external"}
      >
        {newsQ.isLoading ? (
          <PanelSkeleton rows={4} />
        ) : items.length === 0 ? (
          <EmptyDataState
            reason="empty"
            message={`No recent news items tagged ${sym}.`}
            hint={
              newsQ.data?.message ??
              "The wire source is live; tagged matches will appear when issuers publish headlines referencing the ticker."
            }
            badgeLabel="unconfigured"
          />
        ) : (
          <ul className="glass-inset divide-y divide-[hsl(var(--glass-border))]/60 overflow-hidden">
            {items.slice(0, 12).map((n) => (
              <li
                key={n.id}
                className="px-4 py-3 text-sm transition-colors hover:bg-[hsl(var(--primary)/0.04)]"
              >
                <div className="flex flex-wrap items-center gap-1.5">
                  <Pill tone={n.category.toUpperCase() === "SENS" ? "primary" : "info"} size="xs">
                    {n.category}
                  </Pill>
                  <Pill tone="neutral" size="xs">
                    {n.source}
                  </Pill>
                  {n.tickers.slice(0, 3).map((t) => (
                    <span
                      key={t}
                      className="rounded bg-muted/60 px-1.5 py-0.5 font-mono text-[9.5px] text-muted-foreground"
                    >
                      {t}
                    </span>
                  ))}
                  <span className="ml-auto font-mono text-[10px] text-muted-foreground">
                    {new Date(n.ts).toLocaleString("en-ZA", {
                      day: "2-digit",
                      month: "short",
                      hour: "2-digit",
                      minute: "2-digit",
                      timeZone: "Africa/Johannesburg",
                    })}{" "}
                    SAST
                  </span>
                </div>
                {n.url ? (
                  <a
                    href={n.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="mt-1 block font-medium hover:text-primary hover:underline"
                  >
                    {n.headline} <span className="text-[10px] text-muted-foreground">↗</span>
                  </a>
                ) : (
                  <p className="mt-1 font-medium">{n.headline}</p>
                )}
                {n.body ? (
                  <p className="mt-1 text-[11px] text-muted-foreground line-clamp-2">{n.body}</p>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </GlassSection>

      <GlassSection
        title="JSE SENS announcements"
        subtitle="Official regulatory tape"
        endpoint="GET /api/sens"
        dataSource={sensQ.data?.reason === "vendor_not_contracted" ? "blocked-vendor" : "unavailable"}
      >
        {sensQ.isLoading ? (
          <PanelSkeleton rows={3} />
        ) : sens.length === 0 ? (
          <EmptyDataState
            reason="empty"
            message={`No SENS announcements for ${sym}.`}
            hint={sensQ.data?.message ?? "JSE SENS Web Feed subscription required."}
            badgeLabel="blocked-vendor"
          />
        ) : (
          <ul className="space-y-2">
            {sens.map((s) => (
              <li key={s.id} className="glass-inset flex items-center justify-between px-3 py-2 text-sm">
                <span className="font-medium">{s.headline}</span>
                <span className="font-mono text-[10px] text-muted-foreground">{s.source}</span>
              </li>
            ))}
          </ul>
        )}
      </GlassSection>
    </div>
  );
}

function FilingsTab({ sym }: { sym: string }) {
  return (
    <div className="space-y-4">
      <GlassSection
        title="Upcoming IR calendar"
        subtitle="Earnings, AGMs, roadshows"
        endpoint="vendor_required"
        dataSource="blocked-vendor"
      >
        <EmptyDataState
          reason="empty"
          message={`No upcoming IR calendar events for ${sym}.`}
          hint="Wire an IR calendar vendor (IRfirm, Q4 Desktop) into oems_calendar_c."
          badgeLabel="blocked-vendor"
        />
      </GlassSection>
      <GlassSection
        title="JSE SENS feed"
        subtitle="Regulatory announcements"
        endpoint="GET /api/sens"
        dataSource="blocked-vendor"
      >
        <EmptyDataState
          reason="empty"
          message={`No SENS items for ${sym}.`}
          hint="SENS requires the JSE SENS Web Feed subscription."
          badgeLabel="blocked-vendor"
        />
      </GlassSection>
    </div>
  );
}

interface StrategyListItem {
  id: string;
  name: string;
  benchmark: string;
  holdingsCount: number;
  minInvestment: number;
  status: string;
}

function ResearchTab({ sym }: { sym: string }) {
  const listQ = useQuery<{ strategies: StrategyListItem[]; source: string; reason?: string }>({
    queryKey: ["bff-research-lab-sym", sym],
    queryFn: async () => {
      const r = await fetch(`/api/research-lab?sym=${encodeURIComponent(sym)}`, { cache: "no-store" });
      if (!r.ok) throw new Error(`research-lab ${r.status}`);
      return r.json();
    },
    refetchInterval: 60_000,
    ...queryOpts("reference"),
  });
  const strategies = listQ.data?.strategies ?? [];

  return (
    <div className="space-y-4">
      <GlassSection
        title="Research Lab · baskets holding this symbol"
        subtitle="strategies_c filter by ?sym="
        endpoint="GET /api/research-lab?sym=…"
        db="retail"
        dataSource={listQ.data?.source === "unavailable" ? "unavailable" : "supabase"}
      >
        {listQ.isLoading ? (
          <PanelSkeleton rows={3} />
        ) : strategies.length === 0 ? (
          <EmptyDataState
            reason="empty"
            message={`No published basket holds ${sym}.`}
            hint={
              listQ.data?.reason === "supabase_not_configured"
                ? "Set RETAIL_SUPABASE_URL and RETAIL_SUPABASE_SERVICE_ROLE_KEY."
                : listQ.data?.reason === "no_match"
                  ? "Add this symbol to a strategies_c row's holdings JSON, or open it via the Security page to define one."
                  : "No strategies reference this ticker today."
            }
            badgeLabel="unconfigured"
          />
        ) : (
          <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {strategies.map((s) => (
              <li key={s.id} className="glass-inset flex items-center justify-between gap-3 p-3">
                <div className="min-w-0 flex-1 space-y-1">
                  <p className="truncate font-semibold">{s.name}</p>
                  <p className="text-caption font-mono text-muted-foreground">
                    {s.benchmark} · {s.holdingsCount} holdings
                  </p>
                </div>
                <div className="flex flex-col items-end gap-1">
                  <Pill tone="primary" size="xs">
                    {s.status}
                  </Pill>
                  <Link
                    href={`/oems/research-lab?strategy=${s.id}`}
                    className="inline-flex items-center gap-1 font-mono text-[10.5px] text-primary hover:underline"
                  >
                    Open <ExternalLink className="h-3 w-3" />
                  </Link>
                </div>
              </li>
            ))}
          </ul>
        )}
      </GlassSection>

      <GlassSection
        title="Analyst price target & recommendation"
        subtitle="No consensus vendor wired"
        endpoint="vendor_required"
        dataSource="blocked-vendor"
      >
        <div className="grid grid-cols-1 gap-px overflow-hidden sm:grid-cols-2">
          <FieldRow k="Price target (consensus)" v="—" reason="no consensus vendor" />
          <FieldRow k="Price target (high)" v="—" reason="no consensus vendor" />
          <FieldRow k="Price target (low)" v="—" reason="no consensus vendor" />
          <FieldRow k="Recommendation" v="—" reason="no consensus vendor" />
        </div>
      </GlassSection>
    </div>
  );
}

function ModelingTab({ sym, lastRands }: { sym: string; lastRands: number | null }) {
  const [growth, setGrowth] = useState(8);
  const [discount, setDiscount] = useState(12);
  const [terminalMultiple, setTerminalMultiple] = useState(15);
  const [horizon, setHorizon] = useState(5);

  // A textbook Gordon + exit-multiple blend. Indicative only — not a
  // recommendation. Computed client-side, deterministic.
  const valuation = useMemo<{
    fairValue: number | null;
    gordon: number;
    exit: number;
    reason?: string;
  } | null>(() => {
    if (lastRands == null) return null;
    const g = growth / 100;
    const r = discount / 100;
    if (r <= g) return { fairValue: null, gordon: 0, exit: 0, reason: "discount ≤ growth" };
    const startCf = 1; // normalised free cash flow unit
    const pvGordon: number = Array.from({ length: horizon }).reduce<number>((acc, _y, i) => {
      const cf = startCf * (1 + g) ** (i + 1);
      return acc + cf / (1 + r) ** (i + 1);
    }, 0);
    const terminalCf = startCf * (1 + g) ** (horizon + 1);
    const terminalVal = terminalMultiple * terminalCf;
    const pvTerminal = terminalVal / (1 + r) ** horizon;
    const fairValue = (pvGordon + pvTerminal) * lastRands;
    return { fairValue, gordon: pvGordon, exit: pvTerminal / (1 + r) ** horizon };
  }, [lastRands, growth, discount, terminalMultiple, horizon]);

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <GlassSection
        title="DCF / DDM sandbox"
        subtitle="Indicative only — not a recommendation"
        endpoint="client-compute"
        dataSource="code-gap"
      >
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <ModelField
              label="Growth rate (%)"
              value={growth}
              step={0.5}
              onChange={setGrowth}
              icon={<TrendingUp className="h-3.5 w-3.5" />}
            />
            <ModelField
              label="Discount rate (%)"
              value={discount}
              step={0.5}
              onChange={setDiscount}
              icon={<Percent className="h-3.5 w-3.5" />}
            />
            <ModelField
              label="Exit multiple (x)"
              value={terminalMultiple}
              step={0.5}
              onChange={setTerminalMultiple}
              icon={<Scale className="h-3.5 w-3.5" />}
            />
            <ModelField
              label="Horizon (years)"
              value={horizon}
              step={1}
              min={1}
              max={15}
              onChange={(n) => setHorizon(Math.max(1, Math.min(15, n)))}
              icon={<Calendar className="h-3.5 w-3.5" />}
            />
          </div>
          <div className="glass-inset flex flex-col gap-1 px-4 py-3 text-sm">
            <span className="text-caption uppercase tracking-wider">Indicative fair value</span>
            <span className="font-mono text-2xl font-semibold tabular-nums">
              {valuation?.fairValue != null ? formatZAR(valuation.fairValue) : "—"}
            </span>
            {valuation?.reason ? (
              <span className="font-mono text-[10.5px] text-warning">{valuation.reason}</span>
            ) : null}
          </div>
          <p className="text-caption">
            Method: 2-stage Gordon (PV of dividends) + exit multiple on the terminal-year cash flow, blended.
            Inputs are desk-side assumptions. This is a quick directional sandbox — not a financial
            recommendation and not wired to a model library.
          </p>
        </div>
      </GlassSection>

      <GlassSection
        title="Context"
        subtitle="Inputs vs current last"
        endpoint="client-compute"
        dataSource="unconfigured"
      >
        <div className="grid grid-cols-1 gap-px overflow-hidden sm:grid-cols-2">
          <FieldRow k="Symbol" v={sym} />
          <FieldRow k="Last (Rands)" v={lastRands != null ? formatZAR(lastRands) : "—"} />
          <FieldRow
            k="Implied upside"
            v={
              valuation?.fairValue != null && lastRands != null
                ? formatPct(((valuation.fairValue - lastRands) / lastRands) * 100)
                : "—"
            }
          />
          <FieldRow k="PV (Gordon leg)" v={valuation?.gordon != null ? valuation.gordon.toFixed(3) : "—"} />
          <FieldRow k="PV (exit multiple)" v={valuation?.exit != null ? valuation.exit.toFixed(3) : "—"} />
          <FieldRow k="WACC proxy" v={`${discount.toFixed(2)}%`} />
        </div>
        <p className="mt-3 inline-flex items-center gap-1.5 text-caption text-warning">
          <AlertTriangle className="h-3 w-3" />
          Indicative only. Not wired to a fundamentals vendor. WACC is the discount input — not a risk-free +
          ERP decomposition.
        </p>
      </GlassSection>
    </div>
  );
}

function ModelField({
  label,
  value,
  step,
  min,
  max,
  onChange,
  icon,
}: {
  label: string;
  value: number;
  step: number;
  min?: number;
  max?: number;
  onChange: (n: number) => void;
  icon: React.ReactNode;
}) {
  return (
    <label className="glass-inset flex items-center gap-2 px-3 py-2">
      <span className="text-muted-foreground">{icon}</span>
      <span className="text-caption flex-1">{label}</span>
      <input
        type="number"
        value={value}
        step={step}
        {...(min !== undefined ? { min } : {})}
        {...(max !== undefined ? { max } : {})}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-20 bg-transparent text-right font-mono text-xs font-semibold tabular-nums outline-none"
      />
    </label>
  );
}

// ─── Client-side analytics helpers ────────────────────────────────────

function stdev(arr: number[]): number {
  if (arr.length < 2) return 0;
  const m = arr.reduce((a, b) => a + b, 0) / arr.length;
  const v = arr.reduce((a, b) => a + (b - m) * (b - m), 0) / (arr.length - 1);
  return Math.sqrt(v);
}

function computeAnalytics(points: Array<{ t: number; v: number }>): {
  vol20: number | null;
  vol60: number | null;
  percentile52w: number | null;
  dist50: number | null;
  dist200: number | null;
  betaAdjReturn: number | null;
} {
  if (points.length < 5) {
    return {
      vol20: null,
      vol60: null,
      percentile52w: null,
      dist50: null,
      dist200: null,
      betaAdjReturn: null,
    };
  }
  const logRets: number[] = [];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]?.v ?? 0;
    const b = points[i]?.v ?? 0;
    if (a > 0 && b > 0) logRets.push(Math.log(b / a));
  }
  const tail = (n: number) => logRets.slice(-n);
  const vol = (n: number): number | null => {
    const r = tail(n);
    if (r.length < 5) return null;
    // Annualised daily vol: 252 trading days; for intraday, the caller passes
    // a 1D series and the metric is more of a tick-vol proxy.
    const daysPerYear = points.length > 100 ? 252 : 252;
    return stdev(r) * Math.sqrt(daysPerYear) || null;
  };
  const sma = (n: number): number | null => {
    if (points.length < n) return null;
    let s = 0;
    for (let i = points.length - n; i < points.length; i++) s += points[i]?.v ?? 0;
    return s / n;
  };
  const last = points[points.length - 1]?.v ?? 0;
  const dist = (n: number) => {
    const m = sma(n);
    if (m == null || m === 0) return null;
    return ((last - m) / m) * 100;
  };
  // 52W percentile: rank of `last` vs the full series values.
  const values = points.map((p) => p.v);
  const below = values.filter((v) => v <= last).length;
  const pct = values.length > 0 ? (below / values.length) * 100 : null;
  // Beta-adjusted return: total return over the series, scaled by a typical
  // 0.85–1.15 equity beta. Without an ALSI proxy we report the raw return
  // divided by 1.0 (assume β=1) and footnote the limitation.
  const first = points[0]?.v ?? 0;
  const totalRet = first > 0 ? ((last - first) / first) * 100 : null;
  return {
    vol20: vol(20),
    vol60: vol(60),
    percentile52w: pct,
    dist50: dist(50),
    dist200: dist(200),
    betaAdjReturn: totalRet,
  };
}
