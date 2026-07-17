import { type BffUnavailableReason, isSupabaseSchemaMissing } from "@/lib/bff-reasons";
import { isUseSupabaseQuotesEnabled } from "@/lib/data-policy";
import { iressPriceOverlayEnabled, iressQuoteMaxAgeMs } from "@/lib/iress/overlay-policy";
import { callWorker } from "@/lib/iress/worker-api";
/**
 * GET /api/analysis/[sym]?range=1Y
 *
 * Master payload for the per-symbol OEMS Analysis tab. Composes the existing
 * per-symbol BFFs so the page renders in one round-trip:
 *
 *   - /api/quote-snapshot/[sym]  → institutional quote_snapshot_c (IRESS L1)
 *   - /api/intraday/[sym]        → retail stock_intraday_c (worker ticks)
 *   - /api/history/[sym]?range=  → worker → IRESS TimeSeriesGet2 (daily)
 *   - /api/equities              → retail securities_c (Yahoo fundamentals)
 *   - /api/quote-snapshot/[sym]  → previously also (worker) for 52w + avg vol
 *
 * Each sub-fetch is best-effort + non-fatal: a missing Supabase table, a
 * worker 25008, an entitlement-blocked TimeSeriesGet2 all degrade gracefully
 * to a `null` field + a typed `reason` (matching the BFF `reason` taxonomy
 * in `src/lib/bff-reasons.ts`). The page renders the honest empty state for
 * each missing piece — no fabricated R0.00 / "—" stand-ins.
 *
 * BFF-side composition keeps the page client light (single fetch) and the
 * N+1 calls (5 sub-fetches per page-load) batched server-side.
 */
import {
  createInstitutionalServiceRoleClient,
  createRetailServiceRoleClient,
  isInstitutionalSupabaseConfigured,
  isRetailSupabaseConfigured,
} from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const HISTORY_RANGES = ["1D", "5D", "1M", "3M", "6M", "YTD", "1Y", "3Y", "5Y", "10Y", "MAX"] as const;
type HistoryRange = (typeof HISTORY_RANGES)[number];
const DEFAULT_RANGE: HistoryRange = "1Y";

const RANGE_DAYS: Record<HistoryRange, number> = {
  "1D": 2,
  "5D": 8,
  "1M": 33,
  "3M": 95,
  "6M": 190,
  YTD: 370,
  "1Y": 370,
  "3Y": 1100,
  "5Y": 1830,
  "10Y": 3700,
  MAX: 7300,
};

function normaliseSym(raw: string): string {
  return raw.replace(/\.(JO|JSE)$/i, "").toUpperCase();
}

function asNumber(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function centsToRands(v: unknown): number | null {
  const n = asNumber(v);
  return n == null ? null : n / 100;
}

interface SnapshotRow {
  security_code: string;
  exchange: string | null;
  last: number | string | null;
  open: number | string | null;
  high: number | string | null;
  low: number | string | null;
  bid: number | string | null;
  ask: number | string | null;
  prev_close: number | string | null;
  volume: number | string | null;
  vwap: number | string | null;
  week52_high: number | string | null;
  week52_low: number | string | null;
  avg_volume: number | string | null;
  currency: string | null;
  market_state: string | null;
  as_of: string | null;
  updated_at: string;
}

interface SecurityRow {
  symbol: string;
  name: string | null;
  sector: string | null;
  industry: string | null;
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
}

async function loadInstitutionalSnapshot(sym: string): Promise<{
  snapshot: Record<string, unknown> | null;
  reason?: BffUnavailableReason;
  error?: string;
  message?: string;
  source: string;
}> {
  // UAT (IRESS_PRICE_OVERLAY=0): the IRESS L1 snapshot in quote_snapshot_c is
  // test data. Do not surface it; the Analysis page then falls back to the
  // Yahoo-fed securities_c last_price for the header and shows the honest empty
  // state for the IRESS-only statistics (bid/ask/vwap/52w).
  if (!iressPriceOverlayEnabled()) {
    return { snapshot: null, source: "overlay-disabled" };
  }
  if (!isInstitutionalSupabaseConfigured()) {
    return { snapshot: null, source: "unavailable", reason: "supabase_not_configured" };
  }
  try {
    const sb = createInstitutionalServiceRoleClient();
    const { data, error } = await sb
      .from("quote_snapshot_c")
      .select("*")
      .eq("security_code", sym)
      .order("updated_at", { ascending: false })
      .limit(1);
    if (error) {
      return {
        snapshot: null,
        source: "unavailable",
        reason: isSupabaseSchemaMissing(error) ? "supabase_query_failed" : "supabase_query_failed",
        error: error.message,
        message: isSupabaseSchemaMissing(error)
          ? "Apply the quote_snapshot_c migration; the worker populates it from IRESS PricingQuoteGet each cycle."
          : undefined,
      };
    }
    const row = ((data ?? []) as SnapshotRow[])[0];
    if (!row) {
      return {
        snapshot: null,
        source: "pending-first-write",
        message: `No IRESS L1 snapshot for ${sym} yet — the worker writes it once the symbol is in the quote watchlist and the table is migrated.`,
      };
    }
    // Freshness gate: drop a snapshot older than the shared max-age window so a
    // stale/backfilled row never renders as a live price — the Analysis header
    // then falls back to the Yahoo-fed last_price. Matches /api/equities.
    const asOf = row.as_of ?? row.updated_at;
    const asOfMs = asOf ? new Date(asOf).getTime() : Number.NaN;
    if (!Number.isFinite(asOfMs) || Date.now() - asOfMs > iressQuoteMaxAgeMs()) {
      return {
        snapshot: null,
        source: "stale",
        message: `IRESS L1 snapshot for ${sym} is older than the freshness window — not shown as live; the Yahoo-fed price is used instead.`,
      };
    }
    return {
      snapshot: {
        last: centsToRands(row.last),
        open: centsToRands(row.open),
        high: centsToRands(row.high),
        low: centsToRands(row.low),
        bid: centsToRands(row.bid),
        ask: centsToRands(row.ask),
        prevClose: centsToRands(row.prev_close),
        volume: asNumber(row.volume),
        vwap: centsToRands(row.vwap),
        week52High: centsToRands(row.week52_high),
        week52Low: centsToRands(row.week52_low),
        avgVolume: asNumber(row.avg_volume),
        currency: row.currency,
        marketState: row.market_state,
        asOf: row.as_of ?? row.updated_at,
        exchange: row.exchange,
      },
      source: "supabase",
    };
  } catch (e) {
    return {
      snapshot: null,
      source: "unavailable",
      reason: "supabase_query_failed",
      error: e instanceof Error ? e.message : "unknown",
    };
  }
}

async function loadRetailIntraday(
  sym: string,
  limit = 90,
): Promise<{
  prevClose: number | null;
  points: Array<{ t: number; v: number }>;
  source: string;
  reason?: BffUnavailableReason;
  error?: string;
  message?: string;
}> {
  if (!isUseSupabaseQuotesEnabled()) {
    return { prevClose: null, points: [], source: "unavailable", reason: "supabase_not_configured" };
  }
  if (!isRetailSupabaseConfigured()) {
    return { prevClose: null, points: [], source: "unavailable", reason: "supabase_not_configured" };
  }
  try {
    const sb = createRetailServiceRoleClient();
    const { data: secRows, error: secErr } = await sb
      .from("securities_c")
      .select("id, symbol, last_price, change_percent")
      .in("symbol", [sym, `${sym}.JO`])
      .limit(1);
    if (secErr) {
      return {
        prevClose: null,
        points: [],
        source: "unavailable",
        reason: "supabase_query_failed",
        error: secErr.message,
      };
    }
    const sec = (secRows ?? [])[0] as
      | { id: string; last_price: number | null; change_percent: number | null }
      | undefined;
    if (!sec) {
      return {
        prevClose: null,
        points: [],
        source: "unavailable",
        reason: "empty",
        message: `securities_c has no row for ${sym}`,
      };
    }
    const lastRands = (Number(sec.last_price) || 0) / 100;
    const pct = Number(sec.change_percent) || 0;
    const prevClose =
      lastRands > 0 && pct !== 0 ? lastRands / (1 + pct / 100) : lastRands > 0 ? lastRands : null;
    const { data: tickRows, error: tickErr } = await sb
      .from("stock_intraday_c")
      .select("current_price, timestamp")
      .eq("security_id", sec.id)
      .order("timestamp", { ascending: false })
      .limit(limit);
    if (tickErr) {
      return {
        prevClose,
        points: [],
        source: "unavailable",
        reason: "supabase_query_failed",
        error: tickErr.message,
      };
    }
    const points = ((tickRows ?? []) as Array<{ current_price: number | string; timestamp: string }>)
      .map((r) => ({ t: new Date(r.timestamp).getTime(), v: Number(r.current_price) / 100 }))
      .filter((p) => Number.isFinite(p.t) && Number.isFinite(p.v))
      .sort((a, b) => a.t - b.t);
    return {
      prevClose,
      points,
      source: points.length > 0 ? "supabase" : "unavailable",
      reason: points.length === 0 ? "empty" : undefined,
      message:
        points.length === 0
          ? `No intraday ticks for ${sym} yet — worker hasn't polled this symbol (BHG hollow-row pattern).`
          : undefined,
    };
  } catch (e) {
    return {
      prevClose: null,
      points: [],
      source: "unavailable",
      reason: "supabase_query_failed",
      error: e instanceof Error ? e.message : "unknown",
    };
  }
}

async function loadRetailFundamentals(sym: string): Promise<{
  fundamentals: Record<string, unknown> | null;
  source: string;
  reason?: BffUnavailableReason;
  error?: string;
  message?: string;
}> {
  if (!isRetailSupabaseConfigured()) {
    return { fundamentals: null, source: "unavailable", reason: "supabase_not_configured" };
  }
  try {
    const sb = createRetailServiceRoleClient();
    const { data, error } = await sb
      .from("securities_c")
      .select(
        "symbol,name,sector,industry,pe,eps,dividend_yield,beta,market_cap,isin,ytd_performance,last_price,change_percent,change_price",
      )
      .or(`symbol.eq.${sym},symbol.eq.${sym}.JO`)
      .limit(1);
    if (error) {
      return {
        fundamentals: null,
        source: "unavailable",
        reason: isSupabaseSchemaMissing(error) ? "supabase_query_failed" : "supabase_query_failed",
        error: error.message,
      };
    }
    const row = ((data ?? []) as SecurityRow[])[0];
    if (!row) {
      return { fundamentals: null, source: "unavailable", reason: "empty" };
    }
    return { fundamentals: row as unknown as Record<string, unknown>, source: "supabase" };
  } catch (e) {
    return {
      fundamentals: null,
      source: "unavailable",
      reason: "supabase_query_failed",
      error: e instanceof Error ? e.message : "unknown",
    };
  }
}

async function loadHistory(
  sym: string,
  range: HistoryRange,
): Promise<{
  points: Array<{ t: number; v: number }>;
  source: string;
  reason?: BffUnavailableReason;
  error?: string;
  message?: string;
  entitlementBlocked?: boolean;
}> {
  try {
    const days = RANGE_DAYS[range] ?? RANGE_DAYS[DEFAULT_RANGE];
    const res = await callWorker<{
      ok: boolean;
      sym: string;
      points?: Array<{ t: number; v: number }>;
      error?: string;
    }>({
      path: `/history?sym=${encodeURIComponent(sym)}&days=${days}&exchange=JSE`,
      timeoutMs: 30_000,
    });
    if (!res.ok) {
      const msg = res.error ?? "worker_unreachable";
      // Worker logs 25014 (or 25008) for entitlement-blocked. Map to a typed
      // reason so the page renders the shared EntitlementRequired block.
      const isEntitlement = /25014|entitlement|TimeSeriesGet2/i.test(msg);
      return {
        points: [],
        source: "unavailable",
        reason: isEntitlement ? "entitlement_blocked" : "worker_not_running",
        error: msg,
        entitlementBlocked: isEntitlement,
        message: isEntitlement
          ? "IRESS TimeSeriesGet2 entitlement required on DFM@Mint."
          : "Railway Iress-Worker offline or returned an error.",
      };
    }
    const raw = Array.isArray(res.body?.points) ? res.body?.points : [];
    const points = raw
      .filter((p) => p && Number.isFinite(p.t) && Number.isFinite(p.v) && p.v > 0)
      .sort((a, b) => a.t - b.t);
    if (points.length === 0) {
      return {
        points: [],
        source: "unavailable",
        reason: "entitlement_blocked",
        entitlementBlocked: true,
        message: "Worker returned no points — TimeSeriesGet2 likely entitlement-blocked.",
      };
    }
    return { points, source: "iress" };
  } catch (e) {
    return {
      points: [],
      source: "unavailable",
      reason: "worker_not_running",
      error: e instanceof Error ? e.message : "unknown",
    };
  }
}

export async function GET(req: Request, { params }: { params: Promise<{ sym: string }> }) {
  const { sym: rawSym } = await params;
  const sym = normaliseSym(rawSym);
  if (!sym) return Response.json({ error: "sym path param required" }, { status: 400 });

  const url = new URL(req.url);
  const rangeParam = (url.searchParams.get("range") ?? DEFAULT_RANGE).toUpperCase();
  const range: HistoryRange = (HISTORY_RANGES as readonly string[]).includes(rangeParam)
    ? (rangeParam as HistoryRange)
    : DEFAULT_RANGE;

  // Compose in parallel — each sub-fetch is best-effort and isolated.
  const [snap, intraday, fundamentals, history] = await Promise.all([
    loadInstitutionalSnapshot(sym),
    loadRetailIntraday(sym, 90),
    loadRetailFundamentals(sym),
    loadHistory(sym, range),
  ]);

  // The header (sym / name / exchange / sector / industry / isin / currency)
  // is sourced from retail fundamentals. When that's unavailable we degrade
  // gracefully — the page just shows "—" for the missing fields.
  const f = (fundamentals.fundamentals ?? {}) as Partial<SecurityRow>;
  const s = (snap.snapshot ?? {}) as {
    currency?: string | null;
    marketState?: string | null;
    exchange?: string | null;
  };

  const exchange = s.exchange ?? "JSE";
  const currency = s.currency ?? "ZAR";
  const marketState = s.marketState ?? null;

  // "Highest-priority" reason is surfaced at the top of the payload so the
  // page header pill can show a single honest label. Priority: entitlement
  // > worker > supabase not configured > query failed > empty > none.
  const allReasons: Array<BffUnavailableReason | undefined> = [
    history.entitlementBlocked ? "entitlement_blocked" : history.reason,
    intraday.reason,
    snap.reason,
    fundamentals.reason,
  ];
  const topReason = allReasons.find((r): r is BffUnavailableReason => Boolean(r));

  return Response.json({
    sym,
    name: f.name ?? null,
    exchange,
    sector: f.sector ?? null,
    industry: f.industry ?? null,
    isin: f.isin ?? null,
    currency,
    marketState,
    range,
    source:
      [
        snap.source === "supabase" && "iress",
        intraday.source === "supabase" && "supabase-intraday",
        history.source === "iress" && "iress-history",
        fundamentals.source === "supabase" && "yahoo",
      ]
        .filter(Boolean)
        .join("+") || "unavailable",
    reason: topReason,
    snapshot: snap.snapshot,
    intraday: { prevClose: intraday.prevClose, points: intraday.points, source: intraday.source },
    history: {
      range,
      points: history.points,
      source: history.source,
      entitlementBlocked: history.entitlementBlocked,
    },
    fundamentals: fundamentals.fundamentals,
    sub: {
      snapshot: { reason: snap.reason, message: snap.message, error: snap.error, source: snap.source },
      intraday: {
        reason: intraday.reason,
        message: intraday.message,
        error: intraday.error,
        source: intraday.source,
      },
      history: {
        reason: history.reason,
        message: history.message,
        error: history.error,
        source: history.source,
        entitlementBlocked: history.entitlementBlocked,
      },
      fundamentals: {
        reason: fundamentals.reason,
        message: fundamentals.message,
        error: fundamentals.error,
        source: fundamentals.source,
      },
    },
  });
}
