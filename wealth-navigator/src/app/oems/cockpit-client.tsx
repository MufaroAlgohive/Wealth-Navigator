"use client";

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Area, AreaChart, Bar, BarChart, CartesianGrid, Line, LineChart, ResponsiveContainer,
  Tooltip, XAxis, YAxis, Cell, ReferenceLine,
} from "recharts";
import {
  Layers, Activity, Lock, AlertTriangle, Banknote, TrendingUp, Globe2,
  Newspaper, ArrowUpRight, ArrowDownRight,
} from "lucide-react";

import { Panel } from "@/components/oems/primitives/panel";
import { KpiTile } from "@/components/oems/primitives/kpi-tile";
import { NumberCell } from "@/components/oems/primitives/number-cell";
import { DataSourceBadge } from "@/components/oems/primitives/data-source-badge";
import { Pill } from "@/components/oems/primitives/pill";
import { Sparkline } from "@/components/oems/primitives/sparkline";
import { SectorHeatmap } from "@/components/oems/primitives/sector-heatmap";
import { PanelSkeleton, KpiTileSkeleton, PanelErrorShell } from "@/components/oems/primitives/panel-skeleton";
import { Badge } from "@/components/ui/badge";
// Tabs/TabsList/TabsTrigger were removed with the non-functional range
// tabs (Yellow #27). They will be re-introduced when the BFF honors
// `?range=5D` after the TimeSeriesGet2 entitlement is flipped.
import { useIress } from "@/lib/iress/provider";
import { formatPct, formatTime, formatZAR, formatBps, formatPctAbs } from "@/lib/format";
import { cn } from "@/lib/cn";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { queryOpts } from "@/lib/store/query-provider";
import { useLiveQuotes } from "@/lib/hooks/use-live-quotes";
import { useTick } from "@/lib/store/tick-stream-provider";
import { deriveDataSource } from "@/lib/hooks/quote-routing";
import { EntitlementRequired } from "@/components/oems/primitives/entitlement-required";
import { useAuditOrders } from "@/lib/hooks/use-audit-orders";
import { useWorkerHealth } from "@/lib/hooks/use-worker-health";
import { usePortfolio } from "@/lib/hooks/use-portfolio";
import { isRealDataOnlyClient, FEED_NOT_CONFIGURED } from "@/lib/data-policy";
import { EmptyDataState } from "@/components/oems/primitives/empty-data-state";

/**
 * SSR-safe intraday x-axis labels.
 *
 * `Date.now()` at render time is the classic SSR/CSR hydration landmine: the
 * server renders e.g. "08:42" and the client re-renders "08:45" three seconds
 * later, flashing. Instead, the timestamps are pre-computed once at module
 * scope from a deterministic seed (a synthetic JSE trading day starting at
 * 09:00 SAST on 2026-06-06, one minute apart). Both server and client see the
 * exact same strings — no hydration mismatch, no console warning.
 *
 * Trade-off: the labels don't reflect the actual current time, but for a
 * mock trading desk a synthetic day is even desirable (the demo doesn't
 * decay the chart as the clock moves). When this becomes a real-time feed
 * we'll move the chart into a <ClientOnly> wrapper and use wall-clock time.
 */
const INTRADAY_TS: readonly number[] = (() => {
  // 2026-06-06 was a Saturday in real life, but for a mock we don't care.
  // 09:00 SAST is the JSE cash-equity open.
  const open = new Date(2026, 5, 6, 9, 0, 0).getTime();
  return Array.from({ length: 78 }, (_, i) => open + (i - 77) * 60_000);
})();

const INTRADAY_LABELS: readonly string[] = INTRADAY_TS.map((ts) =>
  new Date(ts).toLocaleTimeString("en-ZA", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "Africa/Johannesburg",
  }),
);

interface CockpitClientProps {
  /** Pre-formatted masthead date string computed on the server. */
  mastheadDate: string;
}

/** A row from `GET /api/equities` `securities[]`. `last_price` is INTEGER CENTS. */
interface EquitiesBffSecurity {
  symbol: string;
  name: string | null;
  sector: string | null;
  last_price: number | null;
  change_percent: number | null;
  market_cap: number | null;
}

/** A sector aggregate from `GET /api/equities` `sectors[]`. */
interface EquitiesBffSector {
  sector: string;
  count: number;
  avgChangePct: number;
  totalMarketCap: number;
}

interface EquitiesBffResponse {
  source: "retail-supabase" | "unavailable";
  count: number;
  securities: EquitiesBffSecurity[];
  sectors: EquitiesBffSector[];
  reason?: string;
  error?: string;
}

/** `GET /api/client-book` — retail book aggregate. All money values are RANDS. */
interface ClientBookBffResponse {
  source: "retail-supabase" | "unavailable";
  aum: number;
  dayPnl: number;
  ytdPnl: number;
  investors: number;
  holdings: number;
  asOf: string | null;
  reason?: string;
  error?: string;
}

/** Strip the JSE `.JO` suffix for display (`NPN.JO` → `NPN`). */
function bareSymbol(symbol: string): string {
  return symbol.replace(/\.JO$/i, "");
}

/**
 * Symbols the Cockpit polls once per quote interval. The mover set sits on
 * the existing JSE Top-40; the FX / money-market entries (USDZAR, JIBAR_3M)
 * ride the same `/api/quotes` call so the KPI tiles update without
 * triggering a second BFF request.
 */
const MOVER_SYMBOLS = ["NPN", "PRX", "FSR", "SBK", "AGL", "MTN", "SOL", "USDZAR", "JIBAR_3M"];

/**
 * Cause-based subtext for the AUM tile (audit #5). Reads the BFF's
 * `reason` + `migration` + `error` fields and returns a JSX
 * snippet the KpiTile can render as a single line. The migration
 * filename is rendered in a monospace pill so the operator can
 * copy-paste it.
 */
function portfolioAumSub(portfolio: { source: string; reason?: string; migration?: string; error?: string; accounts?: unknown[] } | undefined): React.ReactNode {
  if (!portfolio) return "Loading portfolio…";
  if (portfolio.source === "supabase") return `${(portfolio.accounts ?? []).length} accounts`;
  if (portfolio.reason === "supabase_not_configured") return <span>Set <span className="font-mono">SUPABASE_URL</span> + <span className="font-mono">SUPABASE_SERVICE_ROLE_KEY</span> on Vercel</span>;
  if (portfolio.reason === "supabase_query_failed") return (
    <span>Run <span className="font-mono">{portfolio.migration ?? "supabase migration"}</span></span>
  );
  if (portfolio.reason === "empty") return <span>No open positions — derived from IOS+ order fills (book currently flat)</span>;
  if (portfolio.reason === "entitlement_blocked") return <span>Positions are derived from IOS+ fills (we don&apos;t use IPS) for <span className="font-mono">DFM@MINT</span></span>;
  if (portfolio.reason === "worker_not_running") return <span>Railway iress-ingest offline — start the worker</span>;
  return FEED_NOT_CONFIGURED;
}

function portfolioDayPnlSub(portfolio: { source: string; reason?: string; migration?: string; positions?: unknown[] } | undefined): React.ReactNode {
  if (!portfolio) return "Loading…";
  if (portfolio.source === "supabase") {
    const n = (portfolio.positions ?? []).length;
    return n > 0 ? `MTM on ${n} positions` : "MTM via IPS";
  }
  if (portfolio.reason === "supabase_query_failed") return (
    <span>Run <span className="font-mono">{portfolio.migration ?? "migration"}</span> first</span>
  );
  return portfolioAumSub(portfolio);
}

function portfolioRebalanceSub(portfolio: { source: string; reason?: string; migration?: string; rebalanceDrift?: number } | undefined): React.ReactNode {
  if (!portfolio) return "Loading…";
  if (portfolio.source === "supabase") return `max drift ${(portfolio.rebalanceDrift ?? 0).toFixed(2)}%`;
  if (portfolio.reason === "supabase_query_failed") return (
    <span>Run <span className="font-mono">{portfolio.migration ?? "migration"}</span> first</span>
  );
  return portfolioAumSub(portfolio);
}

/**
 * Yellow #6 / #32 — JIBAR 3M + USDZAR subtext. Picks one of:
 *   "Live tick from stock_intraday_c" (when fresh)
 *   "Worker has not polled this symbol" (worker running, no tick)
 *   "Worker not configured" (no heartbeat)
 *   "Migration pending" (intraday table missing)
 *
 * Uses the shared tick stream (audit #1) so we don't add a second
 * subscription. Renders a stable short string under 60 chars so it
 * fits the KpiTile's single-line sub slot.
 */
function JibarOrUsdzarSub({
  sym,
  primaryWorker,
}: {
  sym: string;
  primaryWorker: { last_heartbeat_at: string } | null | undefined;
}): React.ReactNode {
  const tick = useTick(sym);
  const fresh = tick && tick.ts && Date.now() - tick.ts < 60_000;
  if (fresh) {
    return <span>Live tick from <span className="font-mono">stock_intraday_c</span></span>;
  }
  if (!primaryWorker) {
    return <span>Worker not configured — start Railway <span className="font-mono">Iress-Worker</span></span>;
  }
  // JIBAR / USD-ZAR are not in this account's IRESS security master (FX spot +
  // SARB/JIBAR rates aren't provisioned for DFM@MINT — confirmed via
  // SecuritySearchGet). Not a "pending poll"; it needs IRESS to enable the feed.
  return <span><span className="font-mono">{sym}</span> not in this account&apos;s IRESS feed (FX/rates not provisioned)</span>;
}

/**
 * Audit #7 + #31 — open-orders empty state. Distinguishes between:
 *   - worker_not_running        (no heartbeat)
 *   - entitlement_blocked       (worker healthy but IOS+ 500)
 *   - no_iress_account_code     (worker healthy, account missing)
 *   - empty                     (worker healthy, audit table is empty)
 */
function ordersEmptyMessage(
  primaryWorker: { status?: string; account_configured?: boolean; last_heartbeat_at: string; accounts?: string[] } | null,
  reason: string | undefined,
): string {
  if (reason === "supabase_query_failed") return "Run supabase/migrations/20260613000000_oems_order_audit.sql first";
  if (!primaryWorker) return "Worker not heartbeating";
  if (primaryWorker.status === "healthy" && primaryWorker.account_configured === false)
    return "Set IRESS_ACCOUNT_CODE on the Railway worker";
  if (primaryWorker.status === "healthy" && primaryWorker.account_configured === true) {
    // Worker healthy + account set + no WORKING orders. IOS+ is live (orders
    // are read from the pad); the current book is simply filled/cancelled, so
    // there are no open orders to show. The full history is on the Blotter.
    return "No working orders — current book is filled/cancelled (see Blotter)";
  }
  return `Worker ${primaryWorker.status ?? "unknown"} · no open orders for this account`;
}

export function CockpitClient({ mastheadDate }: CockpitClientProps) {
  const { data } = useIress();
  const realDataOnly = isRealDataOnlyClient();
  // Yellow #27 — `range` state was removed when the non-functional
  // 1D/5D/1M/3M tabs were replaced with a static "Range · 1D" label.
  // The re-introduction is gated on the TimeSeriesGet2 entitlement
  // being flipped (audit #27).
  const liveQuotes = useLiveQuotes(MOVER_SYMBOLS);

  // Heatmap exchange switch — JSE (securities_c) | US (Yahoo screener). Other
  // regions need custom Yahoo screeners, so only these two are wired today.
  const [heatmapMarket, setHeatmapMarket] = useState<"JSE" | "US">("JSE");
  const globalMoversQ = useQuery({
    queryKey: ["bff-global-movers", heatmapMarket],
    queryFn: () =>
      fetchJson<{
        market: string;
        source: "yahoo" | "unavailable";
        sourceLabel: string;
        tiles: Array<{ symbol: string; name: string; chg: number; cap: number }>;
        gainers: Array<{ symbol: string; name: string; chg: number; price: number | null }>;
        losers: Array<{ symbol: string; name: string; chg: number; price: number | null }>;
        error?: string;
      }>(`/api/global-movers?market=${heatmapMarket}`),
    enabled: realDataOnly && heatmapMarket !== "JSE",
    refetchInterval: 60_000,
  });

  const strategiesQ = useQuery({ queryKey: ["strategies"], queryFn: () => data.strategies(), enabled: !realDataOnly, ...queryOpts("live") });
  const indicesQ = useQuery({ queryKey: ["indices"], queryFn: () => data.indices(), enabled: !realDataOnly, ...queryOpts("reference") });
  const sectorsQ = useQuery({ queryKey: ["sectors"], queryFn: () => data.sectors(), enabled: !realDataOnly, ...queryOpts("reference") });
  const curveQ = useQuery({ queryKey: ["zar-govi"], queryFn: () => data.zarGoviCurve(), enabled: !realDataOnly, ...queryOpts("reference") });
  const jibarQ = useQuery({ queryKey: ["jibar"], queryFn: () => data.jibarFixings(), enabled: !realDataOnly, ...queryOpts("reference") });
  const macroQ = useQuery({ queryKey: ["macro"], queryFn: () => data.macroIndicators(), enabled: !realDataOnly, ...queryOpts("reference") });
  const seedOrdersQ = useQuery({ queryKey: ["orders"], queryFn: () => data.orders(), enabled: !realDataOnly, ...queryOpts("live") });
  const auditOrdersQ = useAuditOrders("ALL", realDataOnly);
  const workerQ = useWorkerHealth(realDataOnly);
  const portfolioQ = usePortfolio(realDataOnly);
  // Audit #3 — derive the Cockpit top-right data source badge label
  // from the worker's `iress_mode` and the response freshness. The
  // routing layer (`deriveDataSource`) is the single source of truth
  // for badge labels; both the Cockpit and Integration pages feed it
  // the worker mode + tick timestamps.
  const primaryWorker = workerQ.data?.workers?.[0] ?? null;
  const wsDataSource = deriveDataSource(
    ((liveQuotes.data as unknown) as { rows?: Array<{ sym: string; last: number; ts?: number; source: "live" | "supabase" | "mock" | "seed-fallback" | "unavailable" }> })?.rows ?? [],
    {
      liveCount: (liveQuotes.data as { liveCount?: number } | undefined)?.liveCount ?? 0,
      fallbackCount: (liveQuotes.data as { fallbackCount?: number } | undefined)?.fallbackCount ?? 0,
      supabaseCount: (liveQuotes.data as { supabaseCount?: number } | undefined)?.supabaseCount ?? 0,
      mockCount: (liveQuotes.data as { mockCount?: number } | undefined)?.mockCount ?? 0,
      unavailableCount: (liveQuotes.data as { unavailableCount?: number } | undefined)?.unavailableCount ?? 0,
    },
    { workerIrEssMode: primaryWorker?.iress_mode ?? null },
  );
  // Use the new derivation when the worker is live AND we have a
  // BFF response; otherwise fall back to the existing hook output
  // (the seed/mock path). The hook internally calls the legacy
  // `deriveDataSource` which is fine for non-live modes.
  const cockpitDataSource = primaryWorker?.iress_mode === "live" ? wsDataSource : (liveQuotes.dataSource ?? "mock");
  const moversQ = useQuery({ queryKey: ["movers"], queryFn: () => data.jseEquities(), ...queryOpts("reference") });
  const newsQ = useQuery({ queryKey: ["news"], queryFn: () => data.news(), enabled: !realDataOnly, ...queryOpts("reference") });
  const sensQ = useQuery({ queryKey: ["sens"], queryFn: () => data.sens(), enabled: !realDataOnly, ...queryOpts("reference") });
  // Real-data news: live RSS (Moneyweb/BusinessTech) + Alliance wire via the BFF.
  const newsBffQ = useQuery<{
    items: Array<{ id: string; headline: string; ts: number; source: string; category: string; tickers: string[]; url: string | null }>;
    source: string;
    sourceLabel?: string;
  }>({
    queryKey: ["bff-news"],
    queryFn: async () => {
      const r = await fetch("/api/news?limit=12", { cache: "no-store" });
      if (!r.ok) throw new Error(`news ${r.status}`);
      return r.json();
    },
    enabled: realDataOnly,
    refetchInterval: 120_000,
    ...queryOpts("reference"),
  });
  // Real USD/ZAR from the FX BFF (Frankfurter / ECB) — IRESS has no FX feed.
  const fxQ = useQuery<{ pair: string; rate: number | null; change: number | null; changePct: number | null; source: string; sourceLabel?: string }>({
    queryKey: ["bff-fx-usdzar"],
    queryFn: async () => {
      const r = await fetch("/api/fx/USDZAR", { cache: "no-store" });
      if (!r.ok) throw new Error(`fx ${r.status}`);
      return r.json();
    },
    enabled: realDataOnly,
    refetchInterval: 300_000,
    ...queryOpts("reference"),
  });
  // Official SARB rates + macro (repo / prime / ZARONIA / Sabor / CPI / PPI).
  // IRESS V4 on DFM@MINT has no rates or macro feed; SARB's free Web API does.
  type SaRate = { label: string; value: number | null; asOf: string | null } | null;
  const saRatesQ = useQuery<{ source: string; sourceLabel?: string; asOf: string | null; rates: Record<string, SaRate> }>({
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
  const saRates = saRatesQ.data?.rates;

  // Tier 2 BFFs — DB-first when realDataOnly. Falls back to seed in
  // mock/dev (realDataOnly=false). The BFF returns `source` so the panel
  // can show a precise "TimeSeriesGet2 entitlement required" message when
  // the table is empty.
  //
  // NOTE: the Sector Heatmap no longer reads `/api/sectors` (official J2xx
  // index families, gated on TimeSeriesGet2). It is now computed from the
  // retail equities board (`/api/equities` → `equitiesQ`), so the old
  // `sectorsBffQ` poll was removed.
  const curveBffQ = useQuery({
    queryKey: ["bff-curve-zar-nss"],
    queryFn: () => fetchJson<{ code: string; points: Array<{ tenor: string; years: number; yield: number; asOf: string }>; source: string; message?: string }>("/api/curves/ZAR_NSS"),
    enabled: realDataOnly,
    refetchInterval: 60_000,
  });
  const alsiBffQ = useQuery({
    queryKey: ["bff-index-J203"],
    queryFn: () => fetchJson<{ code: string; points: Array<{ t: number; v: number }>; source: string; message?: string }>("/api/indices/J203"),
    enabled: realDataOnly,
    refetchInterval: 30_000,
  });

  // Retail-backed equities universe (Sector Heatmap + Top Movers). `last_price`
  // is INTEGER CENTS (securities_c convention) → /100 for Rands. Symbols carry
  // a `.JO` suffix — stripped for display via `bareSymbol`. Fetched once in
  // real-data mode only (queryOpts("reference"): cached 60s, no polling).
  const equitiesQ = useQuery({
    queryKey: ["bff-equities"],
    queryFn: () => fetchJson<EquitiesBffResponse>("/api/equities"),
    enabled: realDataOnly,
    ...queryOpts("reference"),
  });
  // Retail "client book" aggregate (Platform AUM + Day P&L tiles). All money
  // values are RANDS. Fetched once in real-data mode only.
  const clientBookQ = useQuery({
    queryKey: ["bff-client-book"],
    queryFn: () => fetchJson<ClientBookBffResponse>("/api/client-book"),
    enabled: realDataOnly,
    ...queryOpts("live"),
  });
  const equitiesData = equitiesQ.data;
  const equitiesAvailable = equitiesData?.source === "retail-supabase";
  const clientBook = clientBookQ.data;
  const clientBookAvailable = clientBook?.source === "retail-supabase";
  // Cap-weighted broad-market proxy from the JSE constituent universe (real data
  // already loaded). IRESS has no official J203/ALSI index on this account, so
  // we surface this clearly-labelled proxy rather than an empty index panel.
  const marketProxy = (() => {
    const secs = equitiesData?.securities ?? [];
    const withData = secs.filter((s) => s.change_percent != null && (s.market_cap ?? 0) > 0);
    const totalCap = withData.reduce((a, s) => a + (s.market_cap ?? 0), 0);
    if (totalCap <= 0) return null;
    const capWtd = withData.reduce((a, s) => a + (s.change_percent ?? 0) * (s.market_cap ?? 0), 0) / totalCap;
    // Heatmap tiles: the biggest JSE names by market cap, shaded by day move
    // — a real constituent heatmap (finviz-style) computed from the same
    // securities_c universe, not a synthetic index.
    const tiles = [...withData]
      .sort((a, b) => (b.market_cap ?? 0) - (a.market_cap ?? 0))
      .slice(0, 36)
      .map((s) => ({
        symbol: bareSymbol(s.symbol),
        name: s.name ?? bareSymbol(s.symbol),
        chg: s.change_percent ?? 0,
      }));
    return { changePct: capWtd, count: withData.length, tiles };
  })();

  // Active heatmap, selected by the JSE | US exchange switch. JSE comes from
  // the live securities_c universe; US from the Yahoo screener BFF. Both render
  // through the same tile grid below.
  const heatmap = (() => {
    if (heatmapMarket === "JSE") {
      return {
        market: "JSE" as const,
        tiles: marketProxy?.tiles ?? [],
        status: marketProxy ? ("ok" as const) : ("empty" as const),
        capWtd: marketProxy?.changePct ?? null,
        sourceLabel: "securities_c",
      };
    }
    const d = globalMoversQ.data;
    const ok = d?.source === "yahoo" && (d?.tiles?.length ?? 0) > 0;
    return {
      market: "US" as const,
      tiles: (d?.tiles ?? []).map((t) => ({ symbol: t.symbol, name: t.name, chg: t.chg })),
      status: globalMoversQ.isLoading ? ("loading" as const) : ok ? ("ok" as const) : ("empty" as const),
      capWtd: null,
      sourceLabel: d?.sourceLabel ?? "Yahoo Finance",
    };
  })();

  // Top gainers + losers by change_percent, top ~8 combined (4 up / 4 down).
  // Positive change_percent = up (single sign convention, matches the ticker
  // strip which reads the quote's own signed value directly).
  const topMovers = useMemo<EquitiesBffSecurity[]>(() => {
    if (!equitiesAvailable) return [];
    const withChange = (equitiesData?.securities ?? []).filter(
      (s) => Number.isFinite(s.change_percent),
    );
    const gainers = [...withChange]
      .sort((a, b) => (b.change_percent ?? 0) - (a.change_percent ?? 0))
      .slice(0, 4);
    const losers = [...withChange]
      .sort((a, b) => (a.change_percent ?? 0) - (b.change_percent ?? 0))
      .slice(0, 4)
      .reverse();
    // De-dupe in case the board is tiny (gainers and losers overlap).
    const seen = new Set<string>();
    return [...gainers, ...losers].filter((s) => {
      if (seen.has(s.symbol)) return false;
      seen.add(s.symbol);
      return true;
    });
  }, [equitiesAvailable, equitiesData]);

  const strategies = strategiesQ.data ?? [];
  const indices = indicesQ.data ?? [];
  const sectors = sectorsQ.data ?? [];
  const curve = curveQ.data ?? [];
  const jibar = jibarQ.data ?? [];
  const macro = macroQ.data ?? [];
  const orders = realDataOnly ? (auditOrdersQ.data?.orders ?? []) : (seedOrdersQ.data ?? []);
  const ordersLoading = realDataOnly ? auditOrdersQ.isLoading : seedOrdersQ.isLoading;
  const movers = moversQ.data ?? [];
  const news = newsQ.data ?? [];
  const sens = sensQ.data ?? [];

  const totalAum = strategies.reduce((s, x) => s + x.aum, 0);
  const livePnl = strategies.reduce((s, x) => s + x.dayPnl, 0);
  const liveStrats = strategies.filter((s) => s.status === "live").length;
  const blocked = strategies.filter((s) => s.investorCount === 0 || s.status === "halted").length;
  const openOrders = orders.filter((o) => o.state === "WORKING" || o.state === "PARTIAL");
  const rejected = orders.filter((o) => o.state === "REJECTED").length;

  const intraday = useMemo(() => {
    const base = indices.find((i) => i.code === "J203")?.last ?? 87412;
    return INTRADAY_LABELS.map((label, i) => {
      const drift = (i / 78) * 380;
      const noise = Math.sin(i / 5) * 90 + Math.cos(i / 11) * 60;
      return { t: label, v: +(base + drift + noise).toFixed(2) };
    });
  }, [indices]);

  const alsi = indices.find((i) => i.code === "J203");

  // PCA / curve move is read from the BFF (`/api/curves/ZAR_NSS/metrics`),
  // not synthesised. The panel renders an honest empty state when the
  // fitted-curve feed is unconfigured — see the `EmptyDataState` branch
  // below. The hook stays enabled in real-data mode only so mock
  // / dev never makes a network call to a route that requires
  // `USE_SUPABASE_QUOTES=true`.
  const curveMetricsQ = useQuery({
    queryKey: ["bff-curve-zar-nss-metrics"],
    queryFn: () =>
      fetchJson<{
        code: string;
        metrics: Array<{
          metric: string;
          tenorLabel: string | null;
          value: number;
          unit: "bp" | "%";
          asOf: string;
        }>;
        pca: { level: number | null; slope: number | null; curvature: number | null; residual: number | null } | null;
        source: string;
        message?: string;
      }>("/api/curves/ZAR_NSS/metrics"),
    enabled: realDataOnly,
    refetchInterval: 60_000,
  });
  const pcaRows = useMemo(() => {
    const pca = curveMetricsQ.data?.pca;
    if (!pca) return null;
    return [
      { factor: "Level (parallel)", bp: pca.level ?? 0 },
      { factor: "Slope (2s10s)", bp: pca.slope ?? 0 },
      { factor: "Curvature (butterfly)", bp: pca.curvature ?? 0 },
      { factor: "Residual", bp: pca.residual ?? 0 },
    ];
  }, [curveMetricsQ.data]);
  const curveMetricsSource = curveMetricsQ.data?.source ?? "unavailable";

  return (
    <div className="space-y-3">
      {/* Page header */}
      <header className="flex flex-wrap items-end justify-between gap-3 pb-1">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">Cockpit</h1>
          <p className="text-xs text-muted-foreground">
            Institutional trading desk · JSE + ZAR + SARB · {mastheadDate}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <DataSourceBadge source={cockpitDataSource} />
          {/* Yellow #27 — range tabs were non-functional (charts don't
              read the range). Replaced with a static label
              "Range · 1D" until TimeSeriesGet2 is flipped and the
              BFF can honor `?range=5D`. The `range` state is kept
              for the future re-introduction. */}
          <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">Range · 1D</span>
        </div>
      </header>

      {/* KPI strip */}
      <div className="grid grid-cols-2 gap-2.5 md:grid-cols-3 lg:grid-cols-6">
        {strategiesQ.isLoading || jibarQ.isLoading ? (
          [0, 1, 2, 3, 4, 5].map((n) => <KpiTileSkeleton key={`cockpit-kpi-${n}`} />)
        ) : realDataOnly ? (
          <>
            {/*
              Platform AUM + Day P&L wire to the retail client book
              (`GET /api/client-book`) while the IRESS institutional IPS
              feed is blocked. All money values are RANDS. When the
              client-book source is "unavailable" the tiles render "—"
              with an honest cause-based sub-line.
            */}
            <KpiTile
              icon={<Layers className="h-3.5 w-3.5" />}
              label="Platform AUM"
              value={clientBookAvailable ? formatZAR(clientBook!.aum) : "—"}
              sub={
                clientBookAvailable
                  ? `${clientBook!.investors} investors · ${clientBook!.holdings} holdings`
                  : "Retail client book unavailable"
              }
            />
            <KpiTile
              icon={<Activity className="h-3.5 w-3.5" />}
              label="Day P&L"
              value={clientBookAvailable ? formatZAR(clientBook!.dayPnl) : "—"}
              sub={
                clientBookAvailable
                  ? `as of ${clientBook!.asOf ?? "—"}`
                  : "Retail client book unavailable"
              }
              tone={
                clientBookAvailable
                  ? clientBook!.dayPnl >= 0
                    ? "positive"
                    : "negative"
                  : "default"
              }
            />
            <KpiTile
              icon={<Lock className="h-3.5 w-3.5" />}
              label="Rebalance Locked"
              value={portfolioQ.data?.source === "supabase" ? (portfolioQ.data.rebalanceLocked ? "Yes" : "No") : "—"}
              sub={portfolioRebalanceSub(portfolioQ.data)}
              tone={
                portfolioQ.data?.source === "supabase"
                  ? portfolioQ.data.rebalanceLocked
                    ? "warning"
                    : "positive"
                  : "default"
              }
            />
            <KpiTile
              icon={<AlertTriangle className="h-3.5 w-3.5" />}
              label="Open Orders"
              value={openOrders.length.toString()}
              sub={`${rejected} rejected · audit`}
              tone={openOrders.length > 0 ? "warning" : "default"}
            />
            {/*
              JIBAR 3M + USD/ZAR wire through the worker → stock_intraday_c
              path when the watchlist contains `JIBAR_3M` (exchange MM) and
              `USDZAR` (exchange FX). The BFF serves the most recent intraday
              tick for both. NumberCell renders "—" if no live tick is in
              the stream yet; the sub-line is the honest diagnostic per
              Yellow #6 / #32 — chosen from {live tick / worker not
              polled this symbol / worker not configured / migration
              pending}.
            */}
            <KpiTile
              icon={<Banknote className="h-3.5 w-3.5" />}
              label="ZARONIA"
              value={saRates?.zaronia?.value != null ? `${saRates.zaronia.value.toFixed(3)}%` : "—"}
              sub={
                saRates?.zaronia?.value != null ? (
                  <span>overnight · SARB{saRates.zaronia.asOf ? ` · ${saRates.zaronia.asOf.slice(0, 10)}` : ""}</span>
                ) : saRatesQ.isLoading ? (
                  "Loading SARB…"
                ) : (
                  "SARB feed unavailable"
                )
              }
            />
            <KpiTile
              icon={<TrendingUp className="h-3.5 w-3.5" />}
              label="USD/ZAR"
              value={fxQ.data?.rate != null ? fxQ.data.rate.toFixed(4) : "—"}
              sub={
                fxQ.data?.rate != null ? (
                  <span>
                    {(fxQ.data.changePct ?? 0) >= 0 ? "+" : ""}
                    {(fxQ.data.changePct ?? 0).toFixed(2)}% · {fxQ.data.sourceLabel ?? "ECB"}
                  </span>
                ) : fxQ.isLoading ? (
                  "Loading USD/ZAR…"
                ) : (
                  "FX source unavailable"
                )
              }
            />
          </>
        ) : (
          <>
            <KpiTile
              icon={<Layers className="h-3.5 w-3.5" />}
              label="Platform AUM"
              value={formatZAR(totalAum)}
              sub={`${strategies.length} strategies · ${liveStrats} live`}
            />
            <KpiTile
              icon={<Activity className="h-3.5 w-3.5" />}
              label="Day P&L"
              value={formatZAR(livePnl)}
              sub={formatPct((livePnl / (totalAum || 1)) * 100, 3)}
              tone={livePnl >= 0 ? "positive" : "negative"}
            />
            <KpiTile
              icon={<Lock className="h-3.5 w-3.5" />}
              label="Rebalance Locked"
              value={blocked.toString()}
              sub="no investors / halted"
              tone={blocked > 0 ? "warning" : "default"}
            />
            <KpiTile
              icon={<AlertTriangle className="h-3.5 w-3.5" />}
              label="Open Orders"
              value={openOrders.length.toString()}
              sub={`${rejected} rejected`}
              tone={openOrders.length > 0 ? "warning" : "default"}
            />
            <KpiTile
              icon={<Banknote className="h-3.5 w-3.5" />}
              label="JIBAR 3M"
              live={{ sym: "JIBAR_3M", fallback: 8.11, decimals: 3, suffix: "%" }}
              value={`${jibar[2]?.rate.toFixed(2) ?? "—"}%`}
              sub={
                jibar[2] ? (
                  <span>Δ {jibar[2].change >= 0 ? "+" : ""}{(jibar[2].change * 100).toFixed(0)}bp</span>
                ) : <span>—</span>
              }
            />
            <KpiTile
              icon={<TrendingUp className="h-3.5 w-3.5" />}
              label="USD/ZAR"
              live={{ sym: "USDZAR", fallback: 18.452, decimals: 4, showChange: false }}
              value=""
              sub={<span className="flex items-center gap-1"><NumberCell sym="USDZAR" fallback={18.452} decimals={4} size="xs" showChange /></span>}
            />
          </>
        )}
      </div>

      {/* Row 1: heatmap | govi | movers */}
      <div className="grid grid-cols-12 gap-2.5">
        {realDataOnly ? (
          equitiesQ.isLoading ? (
            <PanelSkeleton rows={6} height="h-[300px]" className="col-span-12 lg:col-span-5" />
          ) : equitiesAvailable && (equitiesData?.sectors.length ?? 0) > 0 ? (
            // Heatmap computed from JSE constituents (securities_c), not the
            // official J2xx index families — these need TimeSeriesGet2.
            <Panel
              title="Sector Heatmap"
              endpoint="GET /api/equities"
              dataSource="supabase"
              className="col-span-12 lg:col-span-5 h-[300px]"
              density="scroll"
              right={
                <span className="font-mono text-[10px]">computed from JSE constituents (not official J2xx indices)</span>
              }
            >
              <ul role="list" className="divide-y divide-border/40">
                {[...(equitiesData?.sectors ?? [])]
                  .sort((a, b) => b.avgChangePct - a.avgChangePct)
                  .map((s) => {
                    const up = s.avgChangePct > 0;
                    const down = s.avgChangePct < 0;
                    const tone = up ? "text-up" : down ? "text-down" : "text-muted-foreground";
                    return (
                      <li
                        key={s.sector}
                        className="group flex items-center gap-3 px-3 py-1.5 transition-colors hover:bg-muted/30"
                        title={`${s.sector} · ${formatPct(s.avgChangePct)} · ${s.count} constituents`}
                      >
                        <span
                          aria-hidden
                          className={cn(
                            "h-1.5 w-1.5 shrink-0 rounded-full",
                            up ? "bg-up" : down ? "bg-down" : "bg-muted-foreground/50",
                          )}
                        />
                        <span className="flex-1 truncate text-sm font-medium text-foreground/90">
                          {s.sector}
                        </span>
                        <span
                          className={cn(
                            "w-16 shrink-0 text-right font-mono text-xs font-semibold tabular-nums",
                            tone,
                          )}
                        >
                          {formatPct(s.avgChangePct)}
                        </span>
                        <span className="w-14 shrink-0 text-right font-mono text-[11px] tabular-nums text-muted-foreground">
                          {s.count}
                          <span className="ml-1 text-muted-foreground/60">cnt</span>
                        </span>
                      </li>
                    );
                  })}
              </ul>
            </Panel>
          ) : (
            // `/api/equities` unavailable — keep the institutional
            // TimeSeriesGet2 entitlement empty state.
            <Panel
              title="Sector Heatmap"
              endpoint="GET /api/equities"
              dataSource="unavailable"
              className="col-span-12 lg:col-span-5 h-[300px]"
            >
              {/* Yellow #16 — same EntitlementRequired primitive the
                  Curves and Fixed Income pages use. */}
              <EntitlementRequired
                method="TimeSeriesGet2"
                codes={["J200", "J203"]}
                note="Official J2xx sector indices have no data on the prod-test (CT) feed (TimeSeriesGet2 works; the index feed isn't on CT for DFM@MINT). The heatmap above is computed live from JSE constituents instead."
              />
            </Panel>
          )
        ) : sectorsQ.isLoading ? (
          <PanelSkeleton rows={6} height="h-[300px]" className="col-span-12 lg:col-span-5" />
        ) : sectorsQ.isError ? (
          <PanelErrorShell title="Sector Heatmap" className="col-span-12 lg:col-span-5 h-[300px]" />
        ) : (
          <SectorHeatmap
            data={sectors}
            dataSource="seed"
            className="col-span-12 lg:col-span-5 h-[300px]"
          />
        )}

        {realDataOnly ? (
          curveBffQ.isLoading ? (
            <PanelSkeleton rows={4} height="h-[300px]" className="col-span-12 lg:col-span-4" />
          ) : curveBffQ.isError || (curveBffQ.data?.source === "entitlement-required") ? (
            <Panel
              title="ZAR Sovereign Curve · NSS"
              endpoint="GET /api/curves/ZAR_NSS"
              dataSource={curveBffQ.data?.source === "entitlement-required" ? "unconfigured" : "unavailable"}
              className="col-span-12 lg:col-span-4 h-[300px]"
            >
              <EmptyDataState
                title={curveBffQ.data?.source === "entitlement-required" ? "ZAR curve feed not on prod-test" : "Curve data unavailable"}
                message={
                  curveBffQ.data?.message ??
                  "TimeSeriesGet2 works; the NSS/GOVI curve has no data on the prod-test (CT) feed. Needs the curve code + DataSource enabled for DFM@MINT, or production."
                }
              />
            </Panel>
          ) : curveBffQ.data && curveBffQ.data.points.length > 0 ? (
            <Panel
              title="ZAR Sovereign Curve · NSS"
              endpoint="GET /api/curves/ZAR_NSS"
              dataSource="supabase"
              className="col-span-12 lg:col-span-4 h-[300px]"
              right={(() => {
                // Show the benchmark nearest 10y. The basket tenors (R2035 ~8.7y,
                // R2037 ~10.6y) rarely round to exactly 10, so pick the closest
                // rather than requiring an exact match (which showed "—").
                const pts = curveBffQ.data.points;
                if (!pts.length) return <span className="font-mono">—</span>;
                const near = pts.reduce((b, p) => (Math.abs(p.years - 10) < Math.abs(b.years - 10) ? p : b));
                return (
                  <span className="font-mono">
                    {near.tenor} · {near.yield.toFixed(2)}%
                  </span>
                );
              })()}
            >
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={curveBffQ.data.points} margin={{ top: 8, right: 12, left: -8, bottom: 0 }}>
                  <defs>
                    <linearGradient id="goviGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="hsl(263 80% 65%)" stopOpacity={0.4} />
                      <stop offset="100%" stopColor="hsl(263 80% 65%)" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid stroke="hsl(var(--border))" strokeDasharray="2 4" vertical={false} />
                  <XAxis dataKey="tenor" tick={{ fontSize: 9, fill: "hsl(var(--muted-foreground))" }} stroke="hsl(var(--border))" />
                  <YAxis tick={{ fontSize: 9, fill: "hsl(var(--muted-foreground))" }} stroke="hsl(var(--border))" domain={["dataMin - 0.3", "dataMax + 0.3"]} tickFormatter={(v) => `${v}%`} />
                  <Tooltip
                    contentStyle={{ fontSize: 11, background: "hsl(var(--popover))", border: "1px solid hsl(var(--border))", borderRadius: 6 }}
                    formatter={(v: number) => [`${v.toFixed(2)}%`, "Yield"]}
                    labelStyle={{ color: "hsl(var(--muted-foreground))" }}
                  />
                  <Line type="monotone" dataKey="yield" stroke="hsl(38 95% 56%)" strokeWidth={2} dot={{ r: 2, fill: "hsl(38 95% 56%)" }} />
                </LineChart>
              </ResponsiveContainer>
            </Panel>
          ) : (
            <Panel
              title="ZAR Sovereign Curve · NSS"
              endpoint="GET /api/curves/ZAR_NSS"
              dataSource="unconfigured"
              className="col-span-12 lg:col-span-4 h-[300px]"
            >
              <EmptyDataState message="Yield curve feed not yet populated — worker has not synced a NSS series." />
            </Panel>
          )
        ) : curveQ.isLoading ? (
          <PanelSkeleton rows={4} height="h-[300px]" className="col-span-12 lg:col-span-4" />
        ) : (
          <Panel
            title="ZAR Sovereign Curve · NSS"
            endpoint="GET /v1/yieldcurve/zar?model=nss"
            className="col-span-12 lg:col-span-4 h-[300px]"
            right={
              <span className="font-mono">
                10Y · <NumberCell sym="R2035" fallback={11.42} decimals={3} />%
              </span>
            }
          >
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={curve} margin={{ top: 8, right: 12, left: -8, bottom: 0 }}>
                <defs>
                  <linearGradient id="goviGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="hsl(263 80% 65%)" stopOpacity={0.4} />
                    <stop offset="100%" stopColor="hsl(263 80% 65%)" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid stroke="hsl(var(--border))" strokeDasharray="2 4" vertical={false} />
                <XAxis dataKey="tenor" tick={{ fontSize: 9, fill: "hsl(var(--muted-foreground))" }} stroke="hsl(var(--border))" />
                <YAxis tick={{ fontSize: 9, fill: "hsl(var(--muted-foreground))" }} stroke="hsl(var(--border))" domain={["dataMin - 0.3", "dataMax + 0.3"]} tickFormatter={(v) => `${v}%`} />
                <Tooltip
                  contentStyle={{ fontSize: 11, background: "hsl(var(--popover))", border: "1px solid hsl(var(--border))", borderRadius: 6 }}
                  formatter={(v: number) => [`${v.toFixed(2)}%`, "Yield"]}
                  labelStyle={{ color: "hsl(var(--muted-foreground))" }}
                />
                <Line type="monotone" dataKey="yield" stroke="hsl(38 95% 56%)" strokeWidth={2} dot={{ r: 2, fill: "hsl(38 95% 56%)" }} />
              </LineChart>
            </ResponsiveContainer>
          </Panel>
        )}

        {realDataOnly ? (
          heatmapMarket === "US" ? (
            // Mirrors the heatmap's JSE|US switch — US gainers + losers from
            // the Yahoo screener (already fetched by globalMoversQ). Prices
            // are USD. Degrades to an honest empty state if Yahoo blocked us.
            <Panel
              title="Top Movers · US"
              endpoint="GET /api/global-movers"
              dataSource={globalMoversQ.data?.source === "yahoo" ? "supabase" : "unconfigured"}
              className="col-span-12 lg:col-span-3 h-[300px]"
              density="scroll"
              right={<span className="font-mono text-[9.5px] text-muted-foreground">Yahoo</span>}
            >
              {globalMoversQ.isLoading ? (
                <PanelSkeleton rows={7} />
              ) : (globalMoversQ.data?.gainers?.length ?? 0) + (globalMoversQ.data?.losers?.length ?? 0) === 0 ? (
                <EmptyDataState message="Yahoo returned no US movers this cycle — it retries automatically." />
              ) : (
                <ul className="divide-y divide-border/70">
                  {[
                    ...(globalMoversQ.data?.gainers ?? []).slice(0, 4),
                    ...(globalMoversQ.data?.losers ?? []).slice(0, 4),
                  ].map((m) => {
                    const up = m.chg > 0;
                    const down = m.chg < 0;
                    return (
                      <li key={m.symbol} className="flex items-center gap-2 px-3 py-1.5 transition-colors hover:bg-muted/30">
                        <div className="min-w-0 flex-1">
                          <p className="truncate font-mono text-xs font-semibold">{m.symbol}</p>
                          <p className="truncate text-[9.5px] text-muted-foreground">{m.name}</p>
                        </div>
                        <span className="shrink-0 font-mono text-[11px] tabular-nums text-foreground">
                          {m.price != null ? `$${m.price.toFixed(2)}` : "—"}
                        </span>
                        <span
                          className={cn(
                            "ml-1 shrink-0 font-mono text-[11px] tabular-nums",
                            up ? "text-up" : down ? "text-down" : "text-muted-foreground",
                          )}
                        >
                          {formatPct(m.chg)}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              )}
            </Panel>
          ) : equitiesQ.isLoading ? (
            <PanelSkeleton rows={7} height="h-[300px]" className="col-span-12 lg:col-span-3" />
          ) : equitiesAvailable && topMovers.length > 0 ? (
            // Top gainers + losers from the retail equities board
            // (`securities_c`). `change_percent` is the symbol's own
            // signed day change (positive = up) — the same convention the
            // ticker strip uses, so the two never disagree on sign.
            // `last_price` is INTEGER CENTS → /100 for Rands.
            <Panel
              title="Top Movers · JSE"
              endpoint="GET /api/equities"
              dataSource="supabase"
              className="col-span-12 lg:col-span-3 h-[300px]"
              density="scroll"
              right={
                <Link href="/oems/equities" className="text-[10px] text-primary hover:underline">
                  All →
                </Link>
              }
            >
              <ul className="divide-y divide-border/70">
                {topMovers.map((m) => {
                  const chg = m.change_percent ?? 0;
                  const up = chg > 0;
                  const down = chg < 0;
                  const price = m.last_price != null ? m.last_price / 100 : null;
                  return (
                    <li key={m.symbol} className="flex items-center gap-2 px-3 py-1.5 transition-colors hover:bg-muted/30">
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
            </Panel>
          ) : (
            <Panel
              title="Top Movers · JSE"
              endpoint="GET /api/equities"
              dataSource="unavailable"
              className="col-span-12 lg:col-span-3 h-[300px]"
            >
              <EmptyDataState message="Equities board unavailable — retail securities feed returned no rows." />
            </Panel>
          )
        ) : moversQ.isLoading ? (
          <PanelSkeleton rows={7} height="h-[300px]" className="col-span-12 lg:col-span-3" />
        ) : (
          <Panel
            title="Top Movers · JSE"
            endpoint="PricingQuoteGet"
            dataSource={liveQuotes.dataSource}
            className="col-span-12 lg:col-span-3 h-[300px]"
            density="scroll"
            right={
              <Link href="/oems/equities" className="text-[10px] text-primary hover:underline">
                All →
              </Link>
            }
          >
            <ul className="divide-y divide-border/70">
              {movers.slice(0, 7).map((m) => (
                <li key={m.symbol} className="flex items-center gap-2 px-3 py-1.5 transition-colors hover:bg-muted/30">
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-mono text-xs font-semibold">{m.symbol}</p>
                    <p className="truncate text-[9.5px] text-muted-foreground">{m.name}</p>
                  </div>
                  <Sparkline sym={m.symbol} fallback={0} width={48} height={20} points={24} />
                  <NumberCell sym={m.symbol} fallback={0} decimals={2} size="xs" />
                  <NumberCell sym={m.symbol} fallback={0} decimals={2} size="xs" showChange className="ml-1" />
                </li>
              ))}
            </ul>
          </Panel>
        )}
      </div>

      {/* Row 2: ALSI intraday | SENS feed */}
      <div className="grid grid-cols-12 gap-2.5">
        {realDataOnly ? (
          alsiBffQ.isLoading ? (
            <PanelSkeleton rows={5} height="h-[320px]" className="col-span-12 lg:col-span-8" />
          ) : alsiBffQ.isError || (alsiBffQ.data?.source === "entitlement-required") ? (
            <Panel
              title={`${heatmap.market} Market · Heatmap`}
              endpoint={heatmap.market === "JSE" ? "GET /api/equities" : "GET /api/global-movers"}
              dataSource={heatmap.status === "empty" ? "unconfigured" : "supabase"}
              className="col-span-12 lg:col-span-8 h-[320px]"
              right={
                <div className="flex items-center gap-2">
                  <div className="flex overflow-hidden rounded border border-border/60">
                    {(["JSE", "US"] as const).map((m) => (
                      <button
                        key={m}
                        type="button"
                        onClick={() => setHeatmapMarket(m)}
                        className={cn(
                          "px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider transition-colors",
                          heatmapMarket === m ? "bg-primary/20 text-primary" : "text-muted-foreground hover:bg-muted/40",
                        )}
                      >
                        {m}
                      </button>
                    ))}
                  </div>
                  {heatmap.market === "JSE" && heatmap.capWtd != null ? (
                    <span className="flex items-center gap-1 font-mono text-[10px] text-muted-foreground">
                      cap-wt
                      <span className={cn("text-sm font-semibold", heatmap.capWtd >= 0 ? "text-up" : "text-down")}>
                        {heatmap.capWtd >= 0 ? "+" : ""}
                        {heatmap.capWtd.toFixed(2)}%
                      </span>
                    </span>
                  ) : (
                    <span className="font-mono text-[10px] text-muted-foreground">most active</span>
                  )}
                </div>
              }
            >
              {heatmap.status === "loading" ? (
                <PanelSkeleton rows={6} />
              ) : heatmap.status === "ok" ? (
                <div className="flex h-full flex-col gap-1.5">
                  <div className="grid flex-1 auto-rows-fr grid-cols-4 gap-1 overflow-hidden sm:grid-cols-6 lg:grid-cols-9">
                    {heatmap.tiles.map((t) => {
                      // Shade red→green by day move; intensity saturates at ±4%.
                      const intensity = Math.min(Math.abs(t.chg) / 4, 1);
                      const alpha = 0.14 + intensity * 0.6;
                      const bg =
                        t.chg > 0
                          ? `rgba(34,197,94,${alpha})`
                          : t.chg < 0
                            ? `rgba(239,68,68,${alpha})`
                            : "rgba(120,120,130,0.18)";
                      return (
                        <div
                          key={t.symbol}
                          className="flex flex-col items-center justify-center rounded-sm px-1 py-1 text-center"
                          style={{ backgroundColor: bg }}
                          title={`${t.name} · ${formatPct(t.chg)}`}
                        >
                          <span className="font-mono text-[10px] font-semibold leading-tight text-foreground">{t.symbol}</span>
                          <span className="font-mono text-[9px] leading-tight text-foreground/80">
                            {t.chg >= 0 ? "+" : ""}
                            {t.chg.toFixed(1)}%
                          </span>
                        </div>
                      );
                    })}
                  </div>
                  <p className="shrink-0 text-[9.5px] leading-relaxed text-muted-foreground/70">
                    {heatmap.market === "JSE" ? (
                      <>
                        Top {heatmap.tiles.length} JSE names by market cap, shaded by day move — a real constituent
                        heatmap from the live universe. The cap-weighted figure is a broad-market proxy, NOT the
                        official J203/ALSI (IRESS has no index feed on this account).
                      </>
                    ) : (
                      <>
                        Top {heatmap.tiles.length} most-active US names by market cap, shaded by day move. Source:{" "}
                        {heatmap.sourceLabel} — unofficial public endpoints, best-effort.
                      </>
                    )}
                  </p>
                </div>
              ) : (
                <EmptyDataState
                  title={heatmap.market === "JSE" ? "Index feed not on prod-test" : "US market data unavailable"}
                  message={
                    heatmap.market === "JSE"
                      ? (alsiBffQ.data?.message ??
                        "TimeSeriesGet2 works; J203 returns no data on the prod-test (CT) feed. Needs the index DataSource enabled for DFM@MINT, or production.")
                      : "Yahoo Finance returned no data this cycle (cookie/crumb or rate limit). It retries automatically — switch back to JSE for the live constituent heatmap."
                  }
                />
              )}
            </Panel>
          ) : alsiBffQ.data && alsiBffQ.data.points.length > 0 ? (
            <Panel
              title="JSE All Share · Intraday"
              endpoint="GET /api/indices/J203"
              dataSource="supabase"
              className="col-span-12 lg:col-span-8 h-[320px]"
              right={(() => {
                const pts = alsiBffQ.data.points;
                if (pts.length === 0) return null;
                const last = pts[pts.length - 1];
                const first = pts[0];
                if (!last || !first) return null;
                const change = last.v - first.v;
                const changePct = first.v > 0 ? (change / first.v) * 100 : 0;
                return (
                  <div className="font-mono text-right">
                    <span className="text-sm font-semibold">
                      {last.v.toLocaleString("en-ZA", { maximumFractionDigits: 0 })}
                    </span>
                    <span className={cn("ml-2 text-xs", changePct >= 0 ? "text-up" : "text-down")}>
                      {changePct >= 0 ? "+" : ""}{change.toFixed(2)} ({formatPct(changePct)})
                    </span>
                  </div>
                );
              })()}
            >
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={alsiBffQ.data.points} margin={{ top: 8, right: 12, left: -8, bottom: 0 }}>
                  <defs>
                    <linearGradient id="alsiGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="hsl(263 80% 65%)" stopOpacity={0.4} />
                      <stop offset="100%" stopColor="hsl(263 80% 65%)" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid stroke="hsl(var(--border))" strokeDasharray="2 4" vertical={false} />
                  <XAxis
                    dataKey="t"
                    tick={{ fontSize: 9, fill: "hsl(var(--muted-foreground))" }}
                    stroke="hsl(var(--border))"
                    interval={Math.max(1, Math.floor(alsiBffQ.data.points.length / 8))}
                    tickFormatter={(v) => new Date(v).toLocaleTimeString("en-ZA", { hour: "2-digit", minute: "2-digit", timeZone: "Africa/Johannesburg" })}
                  />
                  <YAxis tick={{ fontSize: 9, fill: "hsl(var(--muted-foreground))" }} stroke="hsl(var(--border))" domain={["dataMin - 40", "dataMax + 40"]} />
                  <Tooltip
                    contentStyle={{ fontSize: 11, background: "hsl(var(--popover))", border: "1px solid hsl(var(--border))", borderRadius: 6 }}
                    labelStyle={{ color: "hsl(var(--muted-foreground))" }}
                    labelFormatter={(v) => new Date(v as number).toLocaleTimeString("en-ZA", { hour: "2-digit", minute: "2-digit", timeZone: "Africa/Johannesburg" })}
                  />
                  <ReferenceLine y={alsiBffQ.data.points[0]?.v ?? 0} stroke="hsl(var(--muted-foreground))" strokeDasharray="3 3" label={{ value: "Open", fontSize: 9, fill: "hsl(var(--muted-foreground))", position: "insideTopLeft" }} />
                  <Area type="monotone" dataKey="v" stroke="hsl(263 80% 65%)" strokeWidth={1.8} fill="url(#alsiGrad)" />
                </AreaChart>
              </ResponsiveContainer>
            </Panel>
          ) : (
            <Panel
              title="JSE All Share · Intraday"
              endpoint="GET /api/indices/J203"
              dataSource="unconfigured"
              className="col-span-12 lg:col-span-8 h-[320px]"
            >
              <EmptyDataState message="ALSI intraday not yet populated — worker has not synced a J203 series." />
            </Panel>
          )
        ) : indicesQ.isLoading ? (
          <PanelSkeleton rows={5} height="h-[320px]" className="col-span-12 lg:col-span-8" />
        ) : (
          <Panel
            title="JSE All Share · Intraday"
            endpoint="WS /v1/indices/J203/stream"
            className="col-span-12 lg:col-span-8 h-[320px]"
            right={
              alsi ? (
                <div className="font-mono text-right">
                  <span className="text-sm font-semibold">
                    {alsi.last.toLocaleString("en-ZA", { maximumFractionDigits: 0 })}
                  </span>
                  <span className={cn("ml-2 text-xs", alsi.changePct >= 0 ? "text-up" : "text-down")}>
                    {alsi.changePct >= 0 ? "+" : ""}{alsi.change.toFixed(2)} ({formatPct(alsi.changePct)})
                  </span>
                </div>
              ) : null
            }
          >
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={intraday} margin={{ top: 8, right: 12, left: -8, bottom: 0 }}>
                <defs>
                  <linearGradient id="alsiGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="hsl(263 80% 65%)" stopOpacity={0.4} />
                    <stop offset="100%" stopColor="hsl(263 80% 65%)" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid stroke="hsl(var(--border))" strokeDasharray="2 4" vertical={false} />
                <XAxis dataKey="t" tick={{ fontSize: 9, fill: "hsl(var(--muted-foreground))" }} stroke="hsl(var(--border))" interval={11} />
                <YAxis tick={{ fontSize: 9, fill: "hsl(var(--muted-foreground))" }} stroke="hsl(var(--border))" domain={["dataMin - 40", "dataMax + 40"]} />
                <Tooltip
                  contentStyle={{ fontSize: 11, background: "hsl(var(--popover))", border: "1px solid hsl(var(--border))", borderRadius: 6 }}
                  labelStyle={{ color: "hsl(var(--muted-foreground))" }}
                />
                <ReferenceLine y={intraday[0]?.v ?? 0} stroke="hsl(var(--muted-foreground))" strokeDasharray="3 3" label={{ value: "Prev close", fontSize: 9, fill: "hsl(var(--muted-foreground))", position: "insideTopLeft" }} />
                <Area type="monotone" dataKey="v" stroke="hsl(263 80% 65%)" strokeWidth={1.8} fill="url(#alsiGrad)" />
              </AreaChart>
            </ResponsiveContainer>
          </Panel>
        )}

        {realDataOnly ? (
          <Panel title="SENS · Live" endpoint="External vendor required" className="col-span-12 lg:col-span-4 h-[320px]">
            <EmptyDataState message="SENS feed not configured." />
          </Panel>
        ) : sensQ.isLoading ? (
          <PanelSkeleton rows={5} height="h-[320px]" className="col-span-12 lg:col-span-4" />
        ) : (
          <Panel
            title="SENS · Live"
            endpoint="WS /v1/news/sens/stream"
            className="col-span-12 lg:col-span-4 h-[320px]"
            density="scroll"
            right={
              <Link href="/oems/news" className="text-[10px] text-primary hover:underline">
                News →
              </Link>
            }
          >
            <SensTape items={sens} limit={5} />
          </Panel>
        )}
      </div>

      {/* Row 3: open orders | macro pulse */}
      <div className="grid grid-cols-12 gap-2.5">
        {ordersLoading ? (
          <PanelSkeleton rows={8} height="h-[340px]" className="col-span-12 lg:col-span-8" />
        ) : (
          <Panel
            title={`Open Orders · ${openOrders.length}`}
            endpoint="Order audit table · oems_order_audit"
            dataSource={realDataOnly ? "supabase" : "seed"}
            className="col-span-12 lg:col-span-8 h-[340px]"
            density="scroll"
            right={
              <Link href="/oems/blotter" className="text-[10px] text-primary hover:underline">
                Blotter →
              </Link>
            }
          >
            {openOrders.length === 0 ? (
              <>
                <EmptyDataState
                  title="No open orders"
                  message={
                    realDataOnly
                      ? primaryWorker
                        ? ordersEmptyMessage(primaryWorker, auditOrdersQ.data?.reason)
                      : "Worker not heartbeating"
                      : FEED_NOT_CONFIGURED
                  }
                  hint={
                    realDataOnly && primaryWorker
                      ? undefined
                      : undefined
                  }
                />
                {/* Yellow #37 — deployment details collapsed by default.
                    The empty-state message above is the visible copy;
                    the deployment specifics live inside `<details>` so
                    a trader/operator doesn't get a deployment-instruction
                    paragraph where they expected a status message. */}
                {realDataOnly && primaryWorker ? (
                  <details className="mt-2 text-[10.5px] text-muted-foreground">
                    <summary className="cursor-pointer select-none text-primary hover:underline">
                      Show deployment details
                    </summary>
                    <div className="mt-1.5 space-y-1 rounded-md border border-border/60 bg-surface-2/40 p-2 font-mono text-[10px]">
                      <p>
                        Set <span className="text-foreground">IRESS_ACCOUNT_CODE</span> on the Railway
                        <span className="text-foreground"> Iress-Worker </span>
                        service to a comma-separated list of account codes (e.g.{" "}
                        <span className="text-foreground">Z12345,Z67890</span>), then restart.
                      </p>
                      <p>
                        Quote ingest keeps running independently of this env.
                        OrderPadGetByAccount → oems_order_audit is the audit
                        table the Cockpit Open Orders panel reads from.
                      </p>
                    </div>
                  </details>
                ) : null}
              </>
            ) : (
            <table className="w-full font-mono text-[11px]">
              <thead className="sticky top-0 z-10 bg-card/95 backdrop-blur">
                <tr className="text-[9.5px] uppercase tracking-wider text-muted-foreground">
                  <th className="px-2.5 py-1.5 text-left">Time</th>
                  <th className="px-2.5 py-1.5 text-left">Strategy</th>
                  <th className="px-2.5 py-1.5 text-left">Side</th>
                  <th className="px-2.5 py-1.5 text-left">Sym</th>
                  <th className="px-2.5 py-1.5 text-right">Qty</th>
                  <th className="px-2.5 py-1.5 text-right">Filled</th>
                  <th className="px-2.5 py-1.5 text-right">Limit</th>
                  <th className="px-2.5 py-1.5 text-right">Last</th>
                  <th className="px-2.5 py-1.5 text-right">VWAP</th>
                  <th className="px-2.5 py-1.5 text-right">Slip</th>
                  <th className="px-2.5 py-1.5 text-left">State</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/60">
                {openOrders.map((o) => (
                  <tr key={o.id} className="hover:bg-muted/30">
                    <td className="px-2.5 py-1.5 text-muted-foreground">{formatTime(o.ts)}</td>
                    <td className="px-2.5 py-1.5">{o.strategy}</td>
                    <td className={cn("px-2.5 py-1.5 font-semibold", o.side === "BUY" ? "text-up" : "text-down")}>{o.side}</td>
                    <td className="px-2.5 py-1.5 font-semibold">{o.symbol}</td>
                    <td className="px-2.5 py-1.5 text-right tabular-nums">{o.qty.toLocaleString()}</td>
                    <td className="px-2.5 py-1.5 text-right tabular-nums">
                      {o.filled.toLocaleString()} <span className="text-muted-foreground/70">({Math.round((o.filled / o.qty) * 100)}%)</span>
                    </td>
                    <td className="px-2.5 py-1.5 text-right tabular-nums">{o.limit?.toFixed(2) ?? "MKT"}</td>
                    <td className="px-2.5 py-1.5 text-right tabular-nums">
                      <NumberCell sym={o.symbol} fallback={o.arrivalMid} decimals={2} />
                    </td>
                    <td className="px-2.5 py-1.5 text-right tabular-nums">{o.vwap != null ? o.vwap.toFixed(2) : "—"}</td>
                    <td
                      className={cn(
                        "px-2.5 py-1.5 text-right tabular-nums",
                        o.slippageBps == null ? "text-muted-foreground" : o.slippageBps >= 0 ? "text-up" : "text-down",
                      )}
                    >
                      {o.slippageBps != null ? `${o.slippageBps.toFixed(1)}bp` : "—"}
                    </td>
                    <td className="px-2.5 py-1.5">
                      <OrderStatePill state={o.state} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            )}
          </Panel>
        )}

        {realDataOnly ? (
          <Panel
            title="Macro Pulse"
            endpoint="GET /api/sa-rates"
            dataSource={saRatesQ.data?.source === "sarb" ? "supabase" : "unconfigured"}
            className="col-span-12 lg:col-span-4 h-[340px]"
            density="scroll"
            right={<span className="font-mono text-[9.5px] text-muted-foreground">{saRatesQ.data?.sourceLabel ?? "SARB"}</span>}
          >
            {saRatesQ.isLoading ? (
              <PanelSkeleton rows={4} />
            ) : saRatesQ.data?.source !== "sarb" || !saRates ? (
              <EmptyDataState message="SARB feed unavailable." hint="Official SA rates/macro come from the SARB public Web API (resbank.co.za)." />
            ) : (
              <div className="grid grid-cols-2 gap-1.5">
                {([
                  ["Repo", saRates.repo],
                  ["Prime", saRates.prime],
                  ["CPI y/y", saRates.cpi],
                  ["PPI y/y", saRates.ppi],
                  ["ZARONIA", saRates.zaronia],
                  ["Sabor", saRates.sabor],
                ] as const).map(([k, r]) => (
                  <div key={k} className="rounded-md border border-border/60 bg-surface-2/30 p-2.5">
                    <p className="text-[9.5px] uppercase tracking-wider text-muted-foreground">{k}</p>
                    <p className="mt-0.5 font-mono text-sm font-semibold">{r?.value != null ? `${r.value.toFixed(2)}%` : "—"}</p>
                    {r?.asOf && <p className="text-[8.5px] text-muted-foreground/70">{r.asOf.slice(0, 10)}</p>}
                  </div>
                ))}
              </div>
            )}
          </Panel>
        ) : macroQ.isLoading ? (
          <PanelSkeleton rows={4} height="h-[340px]" className="col-span-12 lg:col-span-4" />
        ) : (
          <Panel
            title="Macro Pulse"
            endpoint="GET /v1/macro/series"
            className="col-span-12 lg:col-span-4 h-[340px]"
            density="scroll"
            right={
              <Link href="/oems/macro" className="text-[10px] text-primary hover:underline">
                Macro →
              </Link>
            }
          >
            <div className="grid grid-cols-2 gap-1.5">
              {macro.map((m) => (
                <div key={m.name} className="rounded-md border border-border/60 bg-surface-2/30 p-2.5">
                  <div className="flex items-center justify-between">
                    <p className="text-[9.5px] uppercase tracking-wider text-muted-foreground">{m.name}</p>
                    {m.trend === "up" ? <ArrowUpRight className="h-3 w-3 text-up" /> :
                      m.trend === "down" ? <ArrowDownRight className="h-3 w-3 text-down" /> :
                      <span className="text-muted-foreground/50">—</span>}
                  </div>
                  <p className="mt-1 font-mono text-sm font-semibold tabular-nums">
                    {m.value}<span className="ml-1 text-[10px] text-muted-foreground">{m.unit}</span>
                  </p>
                  <p className="font-mono text-[10px] text-muted-foreground">prior {m.prior}</p>
                </div>
              ))}
            </div>
          </Panel>
        )}
      </div>

      {/* Row 4: News flash strip + curve move decomposition */}
      <div className="grid grid-cols-12 gap-2.5">
        {realDataOnly ? (
          <Panel
            title="News Flow · Latest"
            endpoint="GET /api/news"
            dataSource={(newsBffQ.data?.items?.length ?? 0) > 0 ? "supabase" : "unconfigured"}
            className="col-span-12 lg:col-span-8 h-[260px]"
            density="scroll"
            right={<span className="font-mono text-[9.5px] text-muted-foreground">{newsBffQ.data?.sourceLabel ?? "RSS"}</span>}
          >
            {newsBffQ.isLoading ? (
              <PanelSkeleton rows={5} />
            ) : (newsBffQ.data?.items?.length ?? 0) === 0 ? (
              <EmptyDataState
                message="No news items right now."
                hint="Live RSS (Moneyweb / BusinessTech) + Alliance wire. Official JSE SENS regulatory announcements still require the paid web feed."
              />
            ) : (
              <ul className="divide-y divide-border/60">
                {newsBffQ.data!.items.slice(0, 6).map((n) => (
                  <li key={n.id} className="flex items-start gap-3 px-3 py-2.5 hover:bg-muted/30">
                    <div className="flex-1 min-w-0">
                      {n.url ? (
                        <a href={n.url} target="_blank" rel="noopener noreferrer" className="text-xs font-medium leading-snug hover:underline">
                          {n.headline}
                        </a>
                      ) : (
                        <p className="text-xs font-medium leading-snug">{n.headline}</p>
                      )}
                      <div className="mt-1.5 flex flex-wrap items-center gap-1.5 font-mono text-[9.5px] text-muted-foreground">
                        <span>{formatTime(n.ts)}</span>
                        <span className="text-muted-foreground/50">·</span>
                        <Pill tone="neutral" size="xs">{n.source}</Pill>
                        {n.tickers.slice(0, 3).map((t) => (
                          <span key={t} className="rounded bg-primary/10 px-1.5 py-0.5 text-primary">{t}</span>
                        ))}
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        ) : newsQ.isLoading ? (
          <PanelSkeleton rows={5} height="h-[260px]" className="col-span-12 lg:col-span-8" />
        ) : (
          <Panel
            title="News Flow · Last 60 min"
            endpoint="WS /v1/news/stream"
            className="col-span-12 lg:col-span-8 h-[260px]"
            density="scroll"
          >
            <ul className="divide-y divide-border/60">
              {news.slice(0, 5).map((n) => (
                <li key={n.id} className="flex items-start gap-3 px-3 py-2.5 hover:bg-muted/30">
                  {n.priority === "high" && <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-destructive" />}
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-medium leading-snug">{n.headline}</p>
                    <div className="mt-1.5 flex flex-wrap items-center gap-1.5 font-mono text-[9.5px] text-muted-foreground">
                      <span>{formatTime(n.ts)}</span>
                      <span className="text-muted-foreground/50">·</span>
                      <Pill tone="neutral" size="xs">{n.source}</Pill>
                      <Pill tone="neutral" size="xs">{n.category}</Pill>
                      {n.tickers.map((t) => (
                        <span key={t} className="rounded bg-primary/10 px-1.5 py-0.5 text-primary">{t}</span>
                      ))}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          </Panel>
        )}

        <Panel
          title="Curve Move · PCA"
          endpoint="GET /api/curves/ZAR_NSS/metrics"
          dataSource={
            curveMetricsSource === "supabase" || curveMetricsSource === "live"
              ? "supabase"
              : curveMetricsSource === "unconfigured"
                ? "unconfigured"
                : "unconfigured"
          }
          className="col-span-12 lg:col-span-4 h-[260px]"
          right={<span className="font-mono text-[10px]">today vs 1D</span>}
        >
          {realDataOnly ? (
            curveMetricsQ.isLoading ? (
              <div className="flex h-full items-center justify-center">
                <p className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">computing PCA…</p>
              </div>
            ) : pcaRows ? (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={pcaRows} layout="vertical" margin={{ top: 8, right: 8, left: 8, bottom: 0 }}>
                  <CartesianGrid stroke="hsl(var(--border))" strokeDasharray="2 4" horizontal={false} />
                  <XAxis type="number" tick={{ fontSize: 9, fill: "hsl(var(--muted-foreground))" }} stroke="hsl(var(--border))" unit="bp" />
                  <YAxis type="category" dataKey="factor" tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} stroke="hsl(var(--border))" width={130} />
                  <Tooltip contentStyle={{ fontSize: 11, background: "hsl(var(--popover))", border: "1px solid hsl(var(--border))", borderRadius: 6 }} />
                  <Bar dataKey="bp" radius={[0, 2, 2, 0]}>
                    {pcaRows.map((p, i) => (
                      <Cell key={i} fill={p.bp >= 0 ? "hsl(var(--warning))" : "hsl(var(--success))"} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <EmptyDataState
                message="Curve is live — PCA accumulating from daily snapshots."
                hint={curveMetricsQ.data?.message ?? "The ZAR_NSS curve flows from IRESS; PCA needs a few days of yield_curve_history_c snapshots to decompose."}
              />
            )
          ) : (
            // Mock/dev mode — same bar chart as before, but using the
            // explicit "mock" data source label rather than a synthesised
            // production row.
            <div className="flex h-full items-center justify-center">
              <EmptyDataState
                message="Mock mode"
                hint="Enable real data mode to compute PCA from the ZAR fitted curve feed."
                badgeLabel="mock"
              />
            </div>
          )}
        </Panel>
      </div>

      {/* Row 4: Portfolio (IPS) — accounts + positions, only on real-data */}
      {realDataOnly && (
        <div className="grid grid-cols-12 gap-2.5">
          {portfolioQ.isLoading ? (
            <PanelSkeleton rows={5} height="h-[340px]" className="col-span-12 lg:col-span-4" />
          ) : (
            <Panel
              title="Portfolio · Accounts"
              endpoint="GET /api/portfolio"
              dataSource={portfolioQ.data?.source === "supabase" ? "supabase" : "unconfigured"}
              className="col-span-12 lg:col-span-4 h-[340px]"
              right={
                portfolioQ.data?.source === "supabase" ? (
                  <span className="font-mono text-[10px]">{portfolioQ.data.accounts.length} accts</span>
                ) : undefined
              }
            >
              {portfolioQ.data?.source === "supabase" ? (
                <ul className="divide-y divide-border/70">
                  {portfolioQ.data.accounts.map((a) => (
                    <li key={a.account_code} className="px-3.5 py-2.5">
                      <div className="flex items-center justify-between gap-2">
                        <p className="truncate text-xs font-medium">{a.account_name ?? a.account_code}</p>
                        <Pill tone="neutral" size="xs">{a.account_type ?? "—"}</Pill>
                      </div>
                      <div className="mt-1 flex items-center justify-between font-mono text-[10px] text-muted-foreground">
                        <span>{a.account_code}</span>
                        <span>{a.currency ?? "ZAR"}</span>
                      </div>
                      <div className="mt-1.5 flex items-center justify-between">
                        <span className="font-mono text-[11px]">NAV {formatZAR(Number(a.nav_value ?? 0))}</span>
                        <span className="font-mono text-[10px] text-muted-foreground">cash {formatZAR(Number(a.cash_balance ?? 0))}</span>
                      </div>
                    </li>
                  ))}
                </ul>
              ) : (
                <EmptyDataState
                  title="No account master"
                  message="IOS+ is live (orders + positions flow from the order pad for DFM@MINT, account 56378). There's no separate account-master feed wired — we don't use IPS — so this list stays empty until an account directory is sourced."
                />
              )}
            </Panel>
          )}

          {portfolioQ.isLoading ? (
            <PanelSkeleton rows={6} height="h-[340px]" className="col-span-12 lg:col-span-8" />
          ) : (
            <Panel
              title="Portfolio · Positions"
              endpoint="GET /api/portfolio"
              dataSource={portfolioQ.data?.source === "supabase" ? "supabase" : "unconfigured"}
              className="col-span-12 lg:col-span-8 h-[340px]"
              right={
                portfolioQ.data?.source === "supabase" ? (
                  <span className="font-mono text-[10px]">{portfolioQ.data.positions.length} positions · MV {formatZAR(portfolioQ.data.positions.reduce((acc, p) => acc + Number(p.market_value ?? 0), 0))}</span>
                ) : undefined
              }
            >
              {portfolioQ.data?.source === "supabase" && portfolioQ.data.positions.length > 0 ? (
                <div className="h-full overflow-auto">
                  <table className="w-full text-[11px]">
                    <thead className="sticky top-0 bg-card/90 backdrop-blur-sm">
                      <tr className="text-left text-[9.5px] uppercase tracking-wider text-muted-foreground">
                        <th className="px-3.5 py-1.5 font-medium">Symbol</th>
                        <th className="px-3 py-1.5 font-medium">Account</th>
                        <th className="px-3 py-1.5 text-right font-medium">Qty</th>
                        <th className="px-3 py-1.5 text-right font-medium">Avg Cost</th>
                        <th className="px-3 py-1.5 text-right font-medium">MV</th>
                        <th className="px-3 py-1.5 text-right font-medium">P&amp;L</th>
                      </tr>
                    </thead>
                    <tbody className="font-mono">
                      {portfolioQ.data.positions.map((p) => {
                        // P&L is null while marks are CT test data (cost basis
                        // unreliable) — render "—" rather than a misleading R0/gain.
                        const hasPl = p.open_pl != null;
                        const pl = Number(p.open_pl ?? 0);
                        return (
                          <tr key={p.id} className="border-t border-border/60">
                            <td className="px-3.5 py-1.5 font-medium text-foreground">{p.security_code}</td>
                            <td className="px-3 py-1.5 text-muted-foreground">{p.account_code}</td>
                            <td className="px-3 py-1.5 text-right">{p.quantity.toLocaleString("en-ZA")}</td>
                            <td className="px-3 py-1.5 text-right">{p.open_average_price != null ? p.open_average_price.toFixed(2) : "—"}</td>
                            <td className="px-3 py-1.5 text-right">{p.market_value != null ? formatZAR(Number(p.market_value)) : "—"}</td>
                            <td className={cn("px-3 py-1.5 text-right", !hasPl ? "text-muted-foreground" : pl >= 0 ? "text-success" : "text-destructive")}>
                              {!hasPl ? "—" : `${pl >= 0 ? "+" : ""}${formatZAR(pl)}`}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              ) : (
                <EmptyDataState
                  title="No open positions"
                  message={
                    portfolioQ.data?.source === "supabase"
                      ? "0 net positions. IOS+ is live — positions are derived from order fills (net done volume per security); the book is currently flat."
                      : "Positions are derived from IOS+ order fills (we don't use IPS) for DFM@MINT, account 56378."
                  }
                />
              )}
            </Panel>
          )}
        </div>
      )}
    </div>
  );
}

function OrderStatePill({ state }: { state: string }) {
  const tone =
    state === "FILLED"   ? "success" :
    state === "PARTIAL"  ? "warning" :
    state === "WORKING"  ? "primary" :
    state === "REJECTED" ? "destructive" :
                            "neutral";
  return (
    <Badge variant={tone as never} className="text-[9.5px]">
      {state}
    </Badge>
  );
}

/**
 * Tiny JSON fetch helper for BFF endpoints. The standard `fetch` call is
 * enough — we don't need to thread headers, cookies, or retries through
 * React Query for these read-only polls. On non-2xx we throw so the
 * `useQuery` flips to `isError` and the panel renders the error shell.
 */
async function fetchJson<T>(path: string): Promise<T> {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`${path} ${res.status}`);
  return (await res.json()) as T;
}

const SENS_TONE: Record<string, "primary" | "info" | "success" | "neutral" | "warning" | "destructive"> = {
  RESULTS: "primary",
  TRADING: "info",
  DIVIDEND: "success",
  DIRECTORATE: "neutral",
  "RELATED PARTY": "neutral",
  "CORP ACTION": "warning",
  CAUTIONARY: "destructive",
};

function SensTape({ items, limit = 6 }: { items: { id: string; ts: number; ticker: string; issuer: string; category: string; severity: string; headline: string }[]; limit?: number }) {
  return (
    <ul className="divide-y divide-border/60">
      {items.slice(0, limit).map((s) => (
        <li key={s.id} className="px-3 py-2.5 hover:bg-muted/30">
          <div className="flex items-center gap-1.5">
            <Pill tone={SENS_TONE[s.category] ?? "neutral"} size="xs">{s.category}</Pill>
            {s.severity === "regulatory" && <Pill tone="destructive" size="xs">REG</Pill>}
            <span className="ml-auto font-mono text-[9.5px] text-muted-foreground">{formatTime(s.ts)}</span>
          </div>
          <p className="mt-1 text-xs font-medium leading-snug">{s.headline}</p>
          <div className="mt-0.5 flex items-center gap-1.5 font-mono text-[9.5px] text-muted-foreground">
            <span className="text-primary">{s.ticker}</span>
            <span className="text-muted-foreground/50">·</span>
            <span>{s.issuer}</span>
          </div>
        </li>
      ))}
    </ul>
  );
}
