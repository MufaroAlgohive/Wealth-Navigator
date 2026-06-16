import { getIressClient, iressConfig, redactSessionKeyForLog } from "../../../src/lib/iress/index";
import { isIressSessionDeadError } from "../../../src/lib/iress/errors";
import { iressQueries } from "../../../src/lib/iress/mock";
import {
  describeQuoteRowKeys,
  quoteRawRowHasPriceData,
  quoteRawRowLast,
} from "../../../src/lib/iress/live";
import type { Quote } from "../../../src/types/iress";
import type { WorkerEnv } from "./env";
import type { WorkerMintSession, WorkerSessionManager } from "./session";
import type { WorkerSupabase } from "./supabase";
import { recordWorkerEvent } from "./events";
import { chooseDisplayCents } from "./scale";

function newRequestID(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** IRESS quotes are in currency units; `stock_intraday_c.current_price` is cents. */
export function quoteToCents(last: number): number {
  return Math.round(last * 100);
}

/** Normalise a user-supplied symbol to the canonical form IRESS expects. */
export function normaliseSymbol(raw: string): string {
  return raw.replace(/\.JSE$/i, "").replace(/\s+/g, "").toUpperCase();
}

type FetchLiveOutcome = "ok" | "no-row" | "no-trade" | "closed-with-data";

interface FetchLiveResult {
  row: Quote | null;
  rowKeys: string;
  outcome: FetchLiveOutcome;
  rawRow: Record<string, unknown> | null;
}

export async function fetchLiveQuote(
  session: WorkerMintSession,
  symbol: string,
  exchange: string,
): Promise<FetchLiveResult> {
  const client = getIressClient("live");
  const stripped = normaliseSymbol(symbol);
  const res = await client.pricingQuoteGet({
    Header: {
      SessionKey: session.iressSessionKey,
      RequestID: newRequestID(`w-q-${stripped}`),
      Timeout: 25,
    },
    SecurityCode: stripped,
    Exchange: exchange,
  });
  const row = res.DataRows[0];
  const rawRow = res.RawDataRows?.[0] ?? null;
  if (!row) {
    return { row: null, rowKeys: "<no row>", outcome: "no-row", rawRow: null };
  }
  if (row.last > 0) {
    return { row: { ...row, symbol: stripped }, rowKeys: describeQuoteRowKeys(row), outcome: "ok", rawRow };
  }
  // row.last <= 0. Closed market, pre-open, halt, or bogus Last. Before we
  // give up, peek at the raw row: the IRESS V4 server returns a non-zero
  // `LastPrice` / `PreviousClosePrice` even when the live `Last` is empty
  // (weekends, holidays, the close-of-day snapshot). The mapper collapses
  // these to `last=0` when there's no OHLC anchor to verify the scale, so
  // the worker must inspect the raw row to decide whether the data is
  // worth persisting for the weekend / holiday UI.
  if (rawRow && quoteRawRowHasPriceData(rawRow)) {
    const rawLast = quoteRawRowLast(rawRow);
    const synthetic: Quote = {
      ...row,
      symbol: stripped,
      last: rawLast,
      // Preserve the existing close/prevClose the mapper already extracted.
      prevClose: row.prevClose > 0 ? row.prevClose : rawLast,
      close: row.close > 0 ? row.close : rawLast,
    };
    return {
      row: synthetic,
      rowKeys: describeQuoteRowKeys(row),
      outcome: "closed-with-data",
      rawRow,
    };
  }
  // Truly no data — pre-open / halt / closed with empty fields.
  return { row, rowKeys: describeQuoteRowKeys(row), outcome: "no-trade", rawRow };
}

async function fetchMockQuote(symbol: string, exchange: string): Promise<Quote> {
  return iressQueries.quote(symbol, exchange);
}

export interface QuoteUpsertPlan {
  symbol: string;
  securityId: string;
  currentPriceCents: number;
  timestamp: string;
}

interface SecurityRow {
  id: string;
  symbol: string;
  last_price: number | null;
}

export interface SecurityRef {
  id: string;
  /** Existing reference price in cents (Yahoo-sourced today) — anchors IRESS scaling. */
  lastPriceCents: number;
}

async function loadSecurityMap(
  supabase: WorkerSupabase,
  symbols: string[],
): Promise<Map<string, SecurityRef>> {
  const { data, error } = await supabase
    .from("securities_c")
    .select("id, symbol, last_price")
    .in("symbol", symbols);
  if (error) {
    console.error(`[iress-ingest] securities_c lookup failed: ${error.message}`);
    return new Map();
  }
  const rows = (data ?? []) as SecurityRow[];
  return new Map(
    rows.map((row) => [row.symbol, { id: row.id, lastPriceCents: Number(row.last_price) || 0 }]),
  );
}

export interface MissingInstrument {
  symbol: string;
  exchange: string;
  observedAt: string;
}

export interface SyncResult {
  synced: number;
  requested: number;
  errors: number;
  empty: number;
  /** Number of writes that came from a `marketState=CLOSED` row with raw
   *  `LastPrice` / `PreviousClosePrice` data but no mapped `last`. These
   *  are real prices the UI should display during weekends / holidays. */
  closedWithData: number;
  plans: QuoteUpsertPlan[];
  missingInstruments: MissingInstrument[];
}

/**
 * Upsert an instrument into `securities_c` from an observed IRESS quote.
 * - Off by default; opt-in via `IRESS_WORKER_INSTRUMENT_SYNC=1`.
 * - Marks the row with `last_price` from the quote and `source` in the
 *   structured log line. (The existing `securities_c` schema has no `source`
 *   column — the marker is emitted to logs + heartbeat metadata only.)
 * - Never mutates columns the existing ingest pipeline touches
 *   (sector, name, asset_type) unless the row is brand new.
 */
async function upsertInstrumentFromQuote(
  supabase: WorkerSupabase,
  symbol: string,
  priceCents: number,
  env: WorkerEnv,
): Promise<void> {
  if (!env.instrumentSync) return;
  if (env.dryRun || !env.allowWrites) {
    console.info(
      JSON.stringify({
        level: "info",
        event: "would_upsert_instrument",
        source: "iress-worker",
        symbol,
        last_price: priceCents,
      }),
    );
    return;
  }
  const { error } = await supabase.from("securities_c").upsert(
    {
      symbol,
      last_price: priceCents,
    },
    { onConflict: "symbol" },
  );
  if (error) {
    console.warn(`[iress-ingest] instrument upsert(${symbol}) failed: ${error.message}`);
    return;
  }
  console.info(
    JSON.stringify({
      level: "info",
      event: "instrument_upserted",
      source: "iress-worker",
      symbol,
      last_price: priceCents,
    }),
  );
}

export async function syncWatchlistQuotes(
  env: WorkerEnv,
  sessions: WorkerSessionManager,
  supabase: WorkerSupabase | null,
): Promise<SyncResult> {
  // Yellow #18 — measure wall-clock for the latency chart. The
  // integration page's `buildLatencySeries` filters events whose
  // `data` payload carries a numeric `elapsedMs`. Adding the field
  // here populates the chart with one point per sync cycle.
  const t0 = Date.now();
  const defaultExchange = env.defaultExchange || "JSE";
  const isLive = iressConfig.mode === "live" || iressConfig.mode === "wsdl-stub";
  const quotes: Array<{ symbol: string; quote: Quote; exchange: string }> = [];
  let errorCount = 0;
  let emptyCount = 0;
  let closedWithDataCount = 0;
  let sessionFatal: string | null = null;

  if (isLive) {
    try {
      await sessions.withSession(async (session) => {
        console.info(
          `[iress-ingest] quote sync start iressKey=${redactSessionKeyForLog(session.iressSessionKey)} symbols=${env.watchlistSymbols.length}`,
        );
        for (const entry of env.watchlistEntries) {
          const symbol = normaliseSymbol(entry.symbol);
          const exchange = entry.exchange ?? defaultExchange;
          try {
            const { row, outcome, rowKeys, rawRow } = await fetchLiveQuote(
              session,
              symbol,
              exchange,
            );
            if (outcome === "ok" && row) {
              quotes.push({ symbol, quote: row, exchange });
            } else if (outcome === "closed-with-data" && row) {
              // IRESS V4 returns a `marketState=CLOSED` row whose mapped
              // `last` collapsed to 0 (no OHLC anchor) but whose raw
              // `LastPrice` / `PreviousClosePrice` carry real numbers.
              // The `fetchLiveQuote` helper built a synthetic Quote with
              // `last` extracted from the raw row, so we treat this as
              // a normal write — the weekend / holiday UI will then
              // surface the prior close instead of going blank.
              closedWithDataCount += 1;
              quotes.push({ symbol, quote: row, exchange });
              console.info(
                JSON.stringify({
                  level: "info",
                  event: "pricing_quote_get_closed_with_data",
                  source: "iress-worker",
                  symbol,
                  exchange,
                  last: row.last,
                  prevClose: row.prevClose,
                  marketState: row.marketState,
                  rowKeys,
                }),
              );
            } else if (outcome === "no-row") {
              emptyCount += 1;
              console.warn(
                `[iress-ingest] PricingQuoteGet(${symbol}) returned no DataRow (${exchange}) — likely unknown symbol or market closed; rowKeys=${rowKeys}`,
              );
              recordWorkerEvent({
                level: "warn",
                event: "pricing_quote_get_no_row",
                msg: `PricingQuoteGet(${symbol}) returned no DataRow (${exchange}) — likely unknown symbol or market closed`,
                data: { symbol, exchange, rowKeys },
              });
            } else {
              // "no-trade" — row present, mapped last<=0, raw row has no
              // price fields either. Pre-open / halt / closed with empty
              // fields, or a bogus Last rejected by resolveQuoteLast with
              // no anchor to salvage.
              emptyCount += 1;
              const state = row?.marketState ?? "?";
              const looksLikeFieldMismatch = state === "OPEN" && rowKeys !== "<empty row>";
              const looksLikeBogusLast =
                state === "CLOSED" && rowKeys.includes("Last") && !rowKeys.includes("Close");
              // "Hollow row" — the IRESS V4 server is saying the market is
              // OPEN for this symbol but every price field in the raw row
              // is zero / missing. The BHG (Bidcorp) case on DFM@Mint is
              // exactly this shape: the JSE equity board returns a row
              // whose only non-zero fields are `LastPrice` and
              // `PreviousClosePrice` (and even then those are stale and
              // rejected by `resolveQuoteLast`), so the mapper collapses
              // the row to `last=0` and the worker skips the write.
              // `marketState=OPEN` + no price data is the diagnostic
              // signal Charles needs to confirm we are on the wrong
              // board/exchange. Surface the full raw row so the next
              // probe can compare against the V4 doc field list.
              const rawHasPriceData = rawRow ? quoteRawRowHasPriceData(rawRow) : null;
              const isHollow = state === "OPEN" && rawHasPriceData === false;
              console.warn(
                `[iress-ingest] PricingQuoteGet(${symbol}) returned no trade (marketState=${state} last=0)${looksLikeFieldMismatch ? " [field-name mismatch suspected]" : looksLikeBogusLast ? " [bogus Last skipped — no Close/OHLC anchor]" : ""} — ${state === "OPEN" ? "mid-session zero — check row keys vs mapQuote" : "pre-open/halt/closed"}; rowKeys=${rowKeys}`,
              );
              recordWorkerEvent({
                level: "warn",
                event: "pricing_quote_get_no_trade",
                msg: `PricingQuoteGet(${symbol}) no trade (marketState=${state})`,
                data: {
                  symbol,
                  exchange,
                  marketState: state,
                  fieldMismatchSuspected: looksLikeFieldMismatch,
                  bogusLastSuspected: looksLikeBogusLast,
                  rawHasPriceData,
                },
              });
              if (isHollow && rawRow) {
                // Sibling event to `pricing_quote_get_no_trade` — same
                // row, but the diagnostic shape is specific enough to
                // deserve its own event kind so the integration page can
                // render a focused "wrong board/exchange" hint without
                // filtering the no-trade stream.
                const rawRowKeys = Object.keys(rawRow).sort();
                const rawRowNonZero: Record<string, number> = {};
                for (const [k, v] of Object.entries(rawRow)) {
                  if (v === undefined || v === null || v === "") continue;
                  const n = Number(v);
                  if (Number.isFinite(n) && n !== 0) rawRowNonZero[k] = n;
                }
                // Pull `marketState` from the RAW row, not the mapped
                // quote, so the operator sees the same `MarketState` /
                // `QuoteState` / `TradingStatus` value the raw mapper
                // looked at. The mapped `row.marketState` is the same
                // string after `mapQuote`, but recording both lets the
                // integration page diff them when one is missing.
                const rawMarketState = String(
                  rawRow["MarketState"] ?? rawRow["QuoteState"] ?? rawRow["TradingStatus"] ?? "",
                );
                recordWorkerEvent({
                  level: "warn",
                  event: "quote_hollow_row",
                  msg: `PricingQuoteGet(${symbol}) returned a hollow row — likely wrong Board/Exchange for this IRESS profile. Ask Charles to confirm the listing.`,
                  data: {
                    symbol,
                    exchange,
                    marketState: rawMarketState || state,
                    rawRowKeys,
                    rawRowNonZero,
                  },
                });
              }
            }
          } catch (err) {
            if (isIressSessionDeadError(err)) throw err;
            errorCount += 1;
            const msg = err instanceof Error ? err.message : String(err);
            const stack = err instanceof Error ? err.stack : undefined;
            console.warn(
              `[iress-ingest] PricingQuoteGet(${symbol}) failed: ${msg}`,
              stack ?? "",
            );
            // Surface for the integration page so the operator can see
            // "PricingQuoteGet failed for NPN (25034 entitlement check
            // failed)" without tailing Railway logs.
            const code =
              err && typeof err === "object" && "code" in err
                ? Number((err as { code: unknown }).code)
                : 0;
            recordWorkerEvent({
              level: "warn",
              event: "pricing_quote_get_failed",
              msg: `PricingQuoteGet(${symbol}) failed: ${msg}`,
              data: { symbol, exchange, code },
            });
          }
        }
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      sessionFatal = msg;
      console.warn(`[iress-ingest] quote sync session failed: ${msg}`);
      const code =
        err && typeof err === "object" && "code" in err
          ? Number((err as { code: unknown }).code)
          : 0;
      recordWorkerEvent({
        level: code === 25008 ? "error" : "warn",
        event: "quote_sync_session_failed",
        msg,
        data: { code, iressMode: env.iressMode },
      });
    }
  } else {
    for (const entry of env.watchlistEntries) {
      const symbol = normaliseSymbol(entry.symbol);
      const exchange = entry.exchange ?? defaultExchange;
      quotes.push({ symbol, quote: await fetchMockQuote(symbol, exchange), exchange });
    }
  }

  // Always log the sync outcome so Railway logs show the loop finished —
  // even when no quotes landed (gating this on synced>0 is what hid the
  // "no rows" failure mode from the user).
  const elapsedMs = Date.now() - t0; // Yellow #18
  console.info(
    JSON.stringify({
      level: "info",
      event: "quote_sync_complete",
      source: "iress-worker",
      requested: env.watchlistSymbols.length,
      ok: quotes.length,
      closedWithData: closedWithDataCount,
      empty: emptyCount,
      errors: errorCount,
      elapsedMs,
      sessionFatal: sessionFatal ?? null,
    }),
  );
  recordWorkerEvent({
    level: errorCount > 0 || sessionFatal ? "warn" : "info",
    event: "quote_sync_complete",
    msg:
      errorCount > 0
        ? `Watchlist sync: ${errorCount} errors`
        : emptyCount === env.watchlistSymbols.length && env.watchlistSymbols.length > 0
          ? `Watchlist sync: every symbol returned no trade (${emptyCount}/${env.watchlistSymbols.length}) — likely entitlement / market closed`
          : `Watchlist sync: ${quotes.length} ok / ${closedWithDataCount} closed-with-data / ${emptyCount} empty / ${errorCount} errors (${elapsedMs}ms)`,
    data: {
      requested: env.watchlistSymbols.length,
      ok: quotes.length,
      closedWithData: closedWithDataCount,
      empty: emptyCount,
      errors: errorCount,
      elapsedMs, // Yellow #18 — surfaces in the integration page's latency chart
      sessionFatal: sessionFatal ?? null,
    },
  });

  if (quotes.length === 0) {
    return {
      synced: 0,
      requested: env.watchlistSymbols.length,
      errors: errorCount,
      empty: emptyCount,
      closedWithData: closedWithDataCount,
      plans: [],
      missingInstruments: [],
    };
  }

  const symbols = quotes.map((q) => q.symbol);
  let securityMap = new Map<string, SecurityRef>();
  if (supabase && env.allowWrites && !env.dryRun) {
    securityMap = await loadSecurityMap(supabase, symbols);
  }

  const timestamp = new Date().toISOString();
  const plans: QuoteUpsertPlan[] = [];
  const missingInstruments: MissingInstrument[] = [];
  // Full IRESS L1 snapshot per security → quote_snapshot_c (Security page's
  // "Quote · IRESS L1" panel). Prices stored in the same cents scale as
  // last_price (chooseDisplayCents) so the BFF can /100 to Rands uniformly.
  const snapshotRows: Array<Record<string, unknown>> = [];

  for (const { symbol, quote, exchange: qExchange } of quotes) {
    const ref = securityMap.get(symbol);
    const securityId = ref?.id;
    // Reference-anchored scaling: pick the cents value whose magnitude matches
    // the existing securities_c.last_price, fixing the 100x cents/Rand
    // mis-scale (see scale.ts). Falls back to Rands->cents with no reference.
    const choice = chooseDisplayCents(quote.last, ref?.lastPriceCents ?? 0);
    const priceCents = choice.cents;
    const plan: QuoteUpsertPlan = {
      symbol,
      securityId: securityId ?? `unknown-${symbol}`,
      currentPriceCents: priceCents,
      timestamp,
    };
    plans.push(plan);

    // Snapshot the full L1 block (scaled to cents like last_price). Keyed on
    // security_code, so it's captured even when there's no securities_c UUID.
    const m = choice.centsMultiplier;
    const px = (v: number) => (v > 0 ? Math.round(v * m) : null);
    snapshotRows.push({
      security_code: symbol,
      exchange: qExchange,
      last: priceCents,
      open: px(quote.open),
      high: px(quote.high),
      low: px(quote.low),
      bid: px(quote.bid),
      ask: px(quote.ask),
      prev_close: px(quote.prevClose),
      volume: quote.volume > 0 ? quote.volume : null,
      vwap: px(quote.vwap),
      currency: quote.currency || null,
      market_state: quote.marketState || null,
      as_of: quote.ts > 0 ? new Date(quote.ts).toISOString() : timestamp,
      source: "iress-worker",
      updated_at: timestamp,
    });

    if (env.dryRun || !env.allowWrites) {
      console.info(
        `[iress-ingest] would upsert stock_intraday_c`,
        JSON.stringify({ ...plan, exchange: qExchange, scaleBasis: choice.basis }),
      );
      continue;
    }

    if (!supabase) continue;
    if (!securityId) {
      const missing: MissingInstrument = { symbol, exchange: qExchange, observedAt: timestamp };
      missingInstruments.push(missing);
      console.warn(
        JSON.stringify({
          level: "warn",
          event: "missing_security",
          workerId: env.workerId,
          symbol,
          exchange: qExchange,
          observedAt: timestamp,
          msg: `no securities_c row for ${symbol} — skipping intraday write`,
        }),
      );
      // Best-effort: optionally upsert from IRESS data so the next tick has a UUID.
      await upsertInstrumentFromQuote(supabase, symbol, priceCents, env);
      continue;
    }

    const { error: intradayErr } = await supabase.from("stock_intraday_c").insert({
      security_id: securityId,
      current_price: priceCents,
      timestamp: plan.timestamp,
    });
    if (intradayErr) {
      console.error(
        `[iress-ingest] stock_intraday_c insert(${symbol}): ${intradayErr.message}`,
      );
      continue;
    }

    const prevCloseCents =
      quote.prevClose > 0 ? Math.round(quote.prevClose * choice.centsMultiplier) : null;
    const { error: secErr } = await supabase
      .from("securities_c")
      .update({
        last_price: priceCents,
        ...(prevCloseCents != null ? { prev_close: prevCloseCents } : {}),
      })
      .eq("id", securityId);
    if (secErr) {
      console.warn(
        `[iress-ingest] securities_c.last_price update(${symbol}): ${secErr.message}`,
      );
    }
  }

  // Persist the L1 snapshot (Prev Close / Open / Bid / Ask / Range / Volume) for
  // the Security page. Best-effort + isolated: a failure (e.g. table not yet
  // migrated) must NOT affect the quote / intraday writes above.
  if (supabase && env.allowWrites && !env.dryRun && snapshotRows.length > 0) {
    const { error: snapErr } = await supabase
      .from("quote_snapshot_c")
      .upsert(snapshotRows, { onConflict: "security_code,exchange" });
    if (snapErr) {
      console.warn(`[iress-ingest] quote_snapshot_c upsert failed: ${snapErr.message}`);
    } else {
      console.info(JSON.stringify({ level: "info", event: "quote_snapshot_c_upserted", count: snapshotRows.length }));
    }
  }

  return {
    synced: plans.length,
    requested: env.watchlistSymbols.length,
    errors: errorCount,
    empty: emptyCount,
    closedWithData: closedWithDataCount,
    plans,
    missingInstruments,
  };
}
