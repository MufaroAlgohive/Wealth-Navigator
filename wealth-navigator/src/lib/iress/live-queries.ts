/**
 * Server-only live query bridge.
 *
 * Mirrors the most-used `iressQueries` helpers but calls the live SOAP
 * client with real session keys. On failure, falls back to seed data with
 * `source: "seed-fallback"` metadata — never crashes the UI.
 *
 * When `USE_SUPABASE_QUOTES=true`, `fetchQuotesSafe` reads the latest
 * `stock_intraday_c` rows directly via the service-role Supabase client
 * and never calls IRESS on the read path. The new `supabase` source lets
 * the UI badge distinguish DB-first reads from live SOAP calls.
 */

import { getIressClient, iressConfig } from "@/lib/iress/index";
import { iressQueries } from "@/lib/iress/mock";
import { IressError } from "@/lib/iress/errors";
import { iressPriceOverlayEnabled, iressQuoteMaxAgeMs, IRESS_DIVERGENCE } from "@/lib/iress/overlay-policy";
import { getMintSession, withMintSession, invalidateMintSession } from "@/lib/iress/session-manager";
import { emptyQuote, isUseSupabaseQuotesEnabled } from "@/lib/data-policy";
import { initialQuotes, zarGoviCurve } from "@/lib/iress/seed";
import {
  createRetailServiceRoleClient,
  isRetailSupabaseConfigured,
  createServiceRoleClient,
  isSupabaseConfigured,
} from "@/lib/supabase/server";
import type { Order, Quote } from "@/types/iress";

export type QuoteSource = "live" | "iress" | "seed-fallback" | "mock" | "supabase" | "unavailable";

export interface QuoteWithSource {
  quote: Quote;
  source: QuoteSource;
  symbol: string;
}

function newRequestID(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function seedQuoteFor(symbol: string, exchange = "JSE"): Quote {
  return iressQueries.quote(symbol, exchange);
}

function isLiveMode(): boolean {
  return iressConfig.mode === "live" || iressConfig.mode === "wsdl-stub";
}

function normaliseSymbol(raw: string): string {
  return raw.replace(/\.JSE$/i, "").replace(/\s+/g, "").toUpperCase();
}

function unavailableQuote(symbol: string, exchange = "JSE"): QuoteWithSource {
  return { symbol: normaliseSymbol(symbol), quote: emptyQuote(normaliseSymbol(symbol), exchange), source: "unavailable" };
}

interface IntradayRow {
  security_id: string;
  current_price: number;
  timestamp: string;
}

interface SecurityMetaRow {
  id: string;
  symbol: string;
  last_price: number | null;
  // Retail securities_c carries change_price/change_percent (Yahoo), not prev_close/currency.
  change_price: number | null;
  change_percent: number | null;
}

/** Build a Quote from a Supabase intraday tick + securities_c metadata.
 *  IRESS-first: when an institutional quote_snapshot row is supplied, the day
 *  change is derived from IRESS prev_close (scale-invariant); only without it
 *  do we fall back to Yahoo's securities_c.change_percent. */
function buildQuoteFromIntraday(
  meta: SecurityMetaRow | undefined,
  intraday: IntradayRow,
  symbol: string,
  exchange: string,
  iress?: { last: number | null; prev: number | null; asOf?: string | null },
): { quote: Quote; iressApplied: boolean } {
  const tickCents = Number(intraday.current_price) || 0;
  const metaCents = Number(meta?.last_price) || 0;
  // IRESS_PRICE_OVERLAY=0 (UAT phase): drop the IRESS snapshot so the quote is
  // sourced from the intraday tick / securities_c (Yahoo), not UAT test prices.
  const iq = iressPriceOverlayEnabled() ? iress : undefined;
  const iressLastCents = iq?.last != null && iq.last > 0 ? iq.last : 0;
  // Freshness gate: a worker tick or IRESS snapshot older than the shared
  // max-age window (worker stopped, weekend, CT backfill) is stale and must not
  // be shown as the live price. Same window as iress.ts and /api/equities.
  const maxAge = iressQuoteMaxAgeMs();
  const tickTs = new Date(intraday.timestamp).getTime();
  const tickFresh = Number.isFinite(tickTs) && Date.now() - tickTs <= maxAge;
  const iressTs = iq?.asOf ? new Date(iq.asOf).getTime() : NaN;
  const iressFresh = Number.isFinite(iressTs) && Date.now() - iressTs <= maxAge;
  // Divergence guard: a worker price more than IRESS_DIVERGENCE off the Yahoo
  // reference (securities_c.last_price) is almost certainly CT/test/stale data,
  // so ignore it and fall back to Yahoo. This stops CT values (e.g. NPN at R820
  // +35%) leaking into the ticker. When there is no Yahoo reference (metaCents
  // <=0) the freshness gate is the only backstop, so a stale value is still
  // rejected via tickFresh/iressFresh below.
  const agreesWithYahoo = (cents: number) =>
    metaCents <= 0 || (cents > 0 && Math.abs(cents - metaCents) / metaCents <= IRESS_DIVERGENCE);
  const tickOk = tickCents > 0 && tickFresh && agreesWithYahoo(tickCents);
  const iressOk = iressLastCents > 0 && iressFresh && agreesWithYahoo(iressLastCents);
  const priceCents = tickOk
    ? tickCents
    : iressOk
      ? iressLastCents
      : metaCents > 0
        ? metaCents
        : tickCents || iressLastCents;
  const last = priceCents / 100;
  let changePct: number;
  let prev: number;
  if (iressOk && iq?.prev != null && iq.prev > 0 && priceCents > 0) {
    // IRESS prev_close (cents) → change is scale-invariant.
    prev = iq.prev / 100;
    changePct = ((priceCents - iq.prev) / iq.prev) * 100;
  } else {
    // Yahoo fallback: securities_c has no prev_close, so derive it from the %.
    changePct = Number(meta?.change_percent) || 0;
    prev = changePct !== 0 ? last / (1 + changePct / 100) : last;
  }
  const change = last - prev;
  // Timestamp the quote with the source actually shown: the fresh tick / IRESS
  // time when used, else now (the Yahoo securities_c fallback is cron-fresh and
  // carries no per-row timestamp). Never stamp a stale tick time onto a Yahoo
  // price.
  const ts = tickOk ? tickTs : iressOk ? iressTs : Date.now();
  return {
    quote: {
      symbol,
      last,
      bid: last,
      ask: last,
      bidSize: 0,
      askSize: 0,
      open: last,
      high: last,
      low: last,
      close: prev,
      prevClose: prev,
      change,
      changePct,
      volume: 0,
      vwap: last,
      currency: "ZAR",
      marketState: "OPEN",
      ts,
    },
    // Credit IRESS only when the overlay actually drove the shown PRICE (no
    // fresher retail tick won) OR the day CHANGE (a usable prev_close existed) —
    // not merely because a fresh snapshot was present. Otherwise a row whose
    // price + change both came from the Yahoo tick/securities_c would be
    // mis-badged IRESS-PROD.
    iressApplied: iressOk && (!tickOk || (iq?.prev != null && iq.prev > 0)),
  };
}

/** Read IRESS L1 (last + prev_close, cents) from the institutional
 *  quote_snapshot_c, keyed by bare security code. Best-effort: returns an empty
 *  map (→ Yahoo fallback) if the institutional DB is unconfigured or errors. */
async function fetchIressSnapshot(
  bareSymbols: string[],
  exchange: string,
): Promise<Map<string, { last: number | null; prev: number | null; asOf: string | null }>> {
  const map = new Map<string, { last: number | null; prev: number | null; asOf: string | null }>();
  if (!isSupabaseConfigured() || bareSymbols.length === 0) return map;
  try {
    const inst = createServiceRoleClient();
    const codes = Array.from(new Set(bareSymbols.map((s) => s.toUpperCase())));
    const { data, error } = await inst
      .from("quote_snapshot_c")
      .select("security_code,exchange,last,prev_close,as_of,updated_at")
      .eq("exchange", exchange)
      .in("security_code", codes);
    if (error || !data) return map;
    for (const r of data as Array<{
      security_code: string;
      last: number | null;
      prev_close: number | null;
      as_of: string | null;
      updated_at: string | null;
    }>) {
      map.set(String(r.security_code).toUpperCase(), {
        last: r.last,
        prev: r.prev_close,
        asOf: r.as_of ?? r.updated_at,
      });
    }
  } catch {
    /* leave map empty → Yahoo fallback */
  }
  return map;
}

async function fetchQuotesFromSupabase(
  symbols: string[],
  exchange = "JSE",
): Promise<QuoteWithSource[]> {
  if (!isRetailSupabaseConfigured()) {
    throw new Error(
      "Retail Supabase not configured (RETAIL_SUPABASE_URL / RETAIL_SUPABASE_SERVICE_ROLE_KEY, or legacy SUPABASE_*)",
    );
  }
  const supabase = createRetailServiceRoleClient();
  const normalised = Array.from(new Set(symbols.map(normaliseSymbol)));
  if (normalised.length === 0) return [];

  // Retail securities_c stores JSE tickers with a `.JO` suffix (e.g. NPN.JO)
  // while callers pass bare codes (NPN). Query both forms and key results back
  // to the bare code the caller asked for.
  const bareKey = (s: string) => normaliseSymbol(s).replace(/\.(JO|JSE)$/i, "");
  const candidates = Array.from(new Set(normalised.flatMap((s) => [s, `${s}.JO`])));

  const { data: securities, error: secErr } = await supabase
    .from("securities_c")
    .select("id, symbol, last_price, change_price, change_percent")
    .in("symbol", candidates);
  if (secErr) {
    throw new Error(`securities_c read failed: ${secErr.message}`);
  }
  const metaRows = (securities ?? []) as SecurityMetaRow[];
  if (metaRows.length === 0) {
    return normalised.map((sym) => unavailableQuote(sym, exchange));
  }

  const ids = metaRows.map((r) => r.id);
  const { data: ticks, error: tickErr } = await supabase
    .from("stock_intraday_c")
    .select("security_id, current_price, timestamp")
    .in("security_id", ids)
    .order("timestamp", { ascending: false })
    .limit(Math.max(ids.length * 2, 50));
  if (tickErr) {
    throw new Error(`stock_intraday_c read failed: ${tickErr.message}`);
  }
  const tickRows = (ticks ?? []) as IntradayRow[];
  const latestBySecurity = new Map<string, IntradayRow>();
  for (const t of tickRows) {
    if (!latestBySecurity.has(t.security_id)) {
      latestBySecurity.set(t.security_id, t);
    }
  }

  const metaByBare = new Map(metaRows.map((m) => [bareKey(m.symbol), m]));

  // IRESS-first overlay: pull prev_close (+ last) from the institutional
  // quote_snapshot_c so the day change comes from IRESS, not Yahoo. Best-effort
  // + isolated — any failure leaves the Yahoo-derived change untouched.
  const iressByBare = await fetchIressSnapshot(normalised, exchange);

  const out: QuoteWithSource[] = [];

  for (const sym of normalised) {
    const meta = metaByBare.get(sym);
    if (!meta) {
      out.push(unavailableQuote(sym, exchange));
      continue;
    }
    const tick = latestBySecurity.get(meta.id);
    if (!tick) {
      out.push(unavailableQuote(sym, exchange));
      continue;
    }
    const built = buildQuoteFromIntraday(meta, tick, sym, exchange, iressByBare.get(sym));
    out.push({
      symbol: sym,
      quote: built.quote,
      // Attribute the row to IRESS-PROD when the overlay actually won, else the
      // Yahoo-fed securities_c/tick (kept as "supabase" for the retail DB origin).
      source: built.iressApplied ? "iress" : "supabase",
    });
  }

  return out;
}

/** Fetch a single quote — live when possible, seed on failure. */
export async function fetchQuote(
  symbol: string,
  exchange = "JSE",
): Promise<QuoteWithSource> {
  if (isUseSupabaseQuotesEnabled()) {
    try {
      const results = await fetchQuotesFromSupabase([symbol], exchange);
      if (results[0]) return results[0];
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[live-queries] supabase quote(${symbol}) failed: ${msg}`);
    }
    return unavailableQuote(symbol, exchange);
  }

  const results = await fetchQuotes([symbol], exchange);
  return results[0] ?? { quote: seedQuoteFor(symbol, exchange), source: "mock", symbol };
}

/** Batch-fetch quotes. Each symbol is tagged with its data source. */
export async function fetchQuotes(
  symbols: string[],
  exchange = "JSE",
): Promise<QuoteWithSource[]> {
  if (isUseSupabaseQuotesEnabled()) {
    try {
      const results = await fetchQuotesFromSupabase(symbols, exchange);
      return results;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[live-queries] supabase fetch failed: ${msg}`);
    }
    return symbols.map((symbol) => unavailableQuote(symbol, exchange));
  }

  if (!isLiveMode()) {
    return symbols.map((symbol) => ({
      symbol: normaliseSymbol(symbol),
      quote: seedQuoteFor(normaliseSymbol(symbol), exchange),
      source: "mock" as const,
    }));
  }

  const client = getIressClient("live");
  const results: QuoteWithSource[] = [];

  try {
    const session = await getMintSession();
    for (const symbol of symbols) {
      const stripped = normaliseSymbol(symbol);
      try {
        const res = await client.pricingQuoteGet({
          Header: {
            SessionKey: session.iressSessionKey,
            RequestID: newRequestID(`q-${stripped}`),
            Timeout: 25,
          },
          SecurityCode: stripped,
          Exchange: exchange,
        });
        const row = res.DataRows[0];
        if (row && row.last > 0) {
          results.push({ symbol: stripped, quote: { ...row, symbol: stripped }, source: "live" });
        } else {
          console.warn(`[live-queries] empty quote for ${stripped}, falling back to seed`);
          results.push({ symbol: stripped, quote: seedQuoteFor(stripped, exchange), source: "seed-fallback" });
        }
      } catch (err) {
        if (err instanceof IressError && err.code === 25001) {
          invalidateMintSession();
          throw err; // let outer withMintSession retry
        }
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[live-queries] PricingQuoteGet(${stripped}) failed: ${msg}`);
        results.push({ symbol: stripped, quote: seedQuoteFor(stripped, exchange), source: "seed-fallback" });
      }
    }
    return results;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[live-queries] session/quote batch failed: ${msg}`);
    return symbols.map((symbol) => {
      const stripped = normaliseSymbol(symbol);
      return { symbol: stripped, quote: seedQuoteFor(stripped, exchange), source: "seed-fallback" as const };
    });
  }
}

/** Safe wrapper that retries session once on 25001. */
export async function fetchQuotesSafe(symbols: string[], exchange = "JSE"): Promise<QuoteWithSource[]> {
  if (isUseSupabaseQuotesEnabled()) {
    try {
      return await fetchQuotesFromSupabase(symbols, exchange);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[live-queries] supabase fetchQuotesSafe failed: ${msg}`);
    }
    return symbols.map((symbol) => unavailableQuote(symbol, exchange));
  }
  try {
    return await withMintSession(async () => fetchQuotes(symbols, exchange));
  } catch {
    return symbols.map((symbol) => {
      const stripped = normaliseSymbol(symbol);
      return { symbol: stripped, quote: seedQuoteFor(stripped, exchange), source: "seed-fallback" as const };
    });
  }
}

/** Default JSE equity symbols from seed for batch quote probes. */
export const DEFAULT_QUOTE_SYMBOLS = ["NPN", "PRX", "FSR", "SBK", "AGL", "MTN", "SOL", "SHP"];

/** Poll pricingQuoteGetUpdates for streaming symbols (server-side). */
export async function pollQuoteUpdates(
  requestId: string,
): Promise<Array<{ sym: string; last: number }>> {
  if (!isLiveMode()) return [];

  try {
    const client = getIressClient("live");
    const res = await client.pricingQuoteGetUpdates({ RequestID: requestId });
    return res.DataRows.map((q) => ({ sym: q.symbol, last: q.last })).filter((t) => t.sym && t.last > 0);
  } catch {
    return [];
  }
}

/** Start a watch subscription for a symbol list; returns RequestID for updates. */
export async function startQuoteWatch(
  symbols: string[],
  exchange = "JSE",
): Promise<{ requestId: string; initial: QuoteWithSource[] } | null> {
  if (!isLiveMode() || symbols.length === 0) return null;

  const requestId = newRequestID("watch");
  const client = getIressClient("live");

  try {
    return await withMintSession(async (session) => {
      const initial: QuoteWithSource[] = [];
      for (const symbol of symbols) {
        const stripped = symbol.replace(/\.JSE$/i, "").trim();
        const res = await client.pricingQuoteGet({
          Header: {
            SessionKey: session.iressSessionKey,
            RequestID: requestId,
            Updates: true,
            Timeout: 25,
          },
          SecurityCode: stripped,
          Exchange: exchange,
        });
        const row = res.DataRows[0];
        if (row) {
          initial.push({ symbol: stripped, quote: { ...row, symbol: stripped }, source: "live" });
        }
      }
      return { requestId, initial };
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[live-queries] startQuoteWatch failed: ${msg}`);
    return null;
  }
}

/** Fetch orders for an account via OrderPadGetByAccount (live) with seed fallback. */
export async function fetchOrdersByAccount(
  accountCode: string,
  orderFilter: 1 | 2 | 3 | 4 | 5 = 1,
): Promise<{ orders: Order[]; source: QuoteSource }> {
  if (!isLiveMode() || !accountCode) {
    const orders = await iressQueries.orders();
    return { orders, source: "mock" };
  }

  const client = getIressClient("live");
  try {
    return await withMintSession(async (session) => {
      const iosKey = session.serviceKeys.IOSPlus;
      if (!iosKey) throw new Error("IOSPlus service session not available");

      const res = await client.orderPadGetByAccount({
        ServiceSessionKey: iosKey,
        AccountCode: accountCode,
        OrderFilter: orderFilter,
        RequestID: newRequestID("pad"),
      });
      return { orders: res.DataRows, source: "live" as const };
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[live-queries] orderPadGetByAccount failed: ${msg}`);
    const orders = await iressQueries.orders();
    return { orders, source: "seed-fallback" };
  }
}

/** Fetch a yield curve via TimeSeriesGet2 with seed fallback. */
export async function fetchCurveSeries(
  code: string,
): Promise<{ points: Array<{ t: number; v: number }>; source: QuoteSource }> {
  if (!isLiveMode()) {
    const seed = code.includes("SWAP") ? [] : zarGoviCurve.map((p, i) => ({
      t: Date.now() - (zarGoviCurve.length - 1 - i) * 30 * 86400_000,
      v: p.yield,
    }));
    return { points: seed, source: "mock" };
  }

  const client = getIressClient("live");
  const now = new Date();
  const from = new Date(now.getTime() - 365 * 86400_000).toISOString().slice(0, 10);
  const to = now.toISOString().slice(0, 10);

  try {
    return await withMintSession(async (session) => {
      const res = await client.timeSeriesGet2({
        Header: {
          SessionKey: session.iressSessionKey,
          RequestID: newRequestID(`ts-${code}`),
          Timeout: 30,
        },
        Code: code,
        From: from,
        To: to,
        // V4 `TimeSeriesGet2` expects the `<Interval>` STRING enum, e.g.
        // "Daily" — NOT the worker-friendly token "1d" and NOT a
        // `Frequency` Long. See
        // `iress-v4-docs/05-services/market-data/02-time-series-get-2.md`.
        Interval: "Daily",
      });
      if (res.DataRows.length > 0) {
        return { points: res.DataRows, source: "live" as const };
      }
      throw new Error(`empty TimeSeriesGet2 for ${code}`);
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[live-queries] timeSeriesGet2(${code}) failed: ${msg}`);
    const seed = zarGoviCurve.map((p, i) => ({
      t: Date.now() - (zarGoviCurve.length - 1 - i) * 30 * 86400_000,
      v: p.yield,
    }));
    return { points: seed, source: "seed-fallback" };
  }
}

/** Seed quote map for tick-stream bootstrap. */
export function seedQuoteMap(): Record<string, number> {
  const q = initialQuotes();
  return Object.fromEntries(Object.entries(q).map(([k, v]) => [k, v.last]));
}
