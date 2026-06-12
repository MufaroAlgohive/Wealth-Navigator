import { getIressClient, iressConfig, redactSessionKeyForLog } from "../../../src/lib/iress/index";
import { isIressSessionDeadError } from "../../../src/lib/iress/errors";
import { iressQueries } from "../../../src/lib/iress/mock";
import { describeQuoteRowKeys } from "../../../src/lib/iress/live";
import type { Quote } from "../../../src/types/iress";
import type { WorkerEnv } from "./env";
import type { WorkerMintSession, WorkerSessionManager } from "./session";
import type { WorkerSupabase } from "./supabase";

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

async function fetchLiveQuote(
  session: WorkerMintSession,
  symbol: string,
  exchange: string,
): Promise<{ row: Quote | null; rowKeys: string; outcome: "ok" | "no-row" | "no-trade" }> {
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
  if (!row) {
    return { row: null, rowKeys: "<no row>", outcome: "no-row" };
  }
  if (row.last <= 0) {
    // Pre-open / halt / closed — surface a warning so the worker log
    // shows why the symbol was skipped instead of going silent. The
    // parsed row's available keys are echoed so a future field-name
    // mismatch (e.g. real IRESS using <Last> vs our <LastTrade> mapper)
    // shows up in one structured line and the next fix is a one-line
    // edit to `mapQuote` in `src/lib/iress/live.ts`.
    return { row, rowKeys: describeQuoteRowKeys(row), outcome: "no-trade" };
  }
  return { row: { ...row, symbol: stripped }, rowKeys: describeQuoteRowKeys(row), outcome: "ok" };
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
}

async function loadSecurityMap(
  supabase: WorkerSupabase,
  symbols: string[],
): Promise<Map<string, string>> {
  const { data, error } = await supabase
    .from("securities_c")
    .select("id, symbol")
    .in("symbol", symbols);
  if (error) {
    console.error(`[iress-ingest] securities_c lookup failed: ${error.message}`);
    return new Map();
  }
  const rows = (data ?? []) as SecurityRow[];
  return new Map(rows.map((row) => [row.symbol, row.id]));
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
  const exchange = env.defaultExchange || "JSE";
  const isLive = iressConfig.mode === "live" || iressConfig.mode === "wsdl-stub";
  const quotes: Array<{ symbol: string; quote: Quote }> = [];
  let errorCount = 0;
  let emptyCount = 0;
  let sessionFatal: string | null = null;

  if (isLive) {
    try {
      await sessions.withSession(async (session) => {
        console.info(
          `[iress-ingest] quote sync start iressKey=${redactSessionKeyForLog(session.iressSessionKey)} exchange=${exchange} symbols=${env.watchlistSymbols.length}`,
        );
        for (const symbol of env.watchlistSymbols) {
          const normalised = normaliseSymbol(symbol);
          try {
            const { row, outcome, rowKeys } = await fetchLiveQuote(session, normalised, exchange);
            if (outcome === "ok" && row) {
              quotes.push({ symbol: normalised, quote: row });
            } else if (outcome === "no-row") {
              emptyCount += 1;
              console.warn(
                `[iress-ingest] PricingQuoteGet(${normalised}) returned no DataRow (${exchange}) — likely unknown symbol or market closed; rowKeys=${rowKeys}`,
              );
            } else {
              // "no-trade" — row present, last<=0. Pre-open / halt / closed.
              // Mid-session last=0 with marketState=OPEN is a strong signal
              // that the mapper read the wrong field name (e.g. real IRESS
              // returns <Last> but we looked for <LastTrade>); log the
              // available row keys so the next fix is a one-line addition
              // to `mapQuote` in src/lib/iress/live.ts.
              emptyCount += 1;
              const state = row?.marketState ?? "?";
              const looksLikeFieldMismatch = state === "OPEN" && rowKeys !== "<empty row>";
              console.warn(
                `[iress-ingest] PricingQuoteGet(${normalised}) returned no trade (marketState=${state} last=0)${looksLikeFieldMismatch ? " [field-name mismatch suspected]" : ""} — ${state === "OPEN" ? "mid-session zero — check row keys vs mapQuote" : "pre-open/halt/closed"}; rowKeys=${rowKeys}`,
              );
            }
          } catch (err) {
            if (isIressSessionDeadError(err)) throw err;
            errorCount += 1;
            const msg = err instanceof Error ? err.message : String(err);
            const stack = err instanceof Error ? err.stack : undefined;
            console.warn(
              `[iress-ingest] PricingQuoteGet(${normalised}) failed: ${msg}`,
              stack ?? "",
            );
          }
        }
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      sessionFatal = msg;
      console.warn(`[iress-ingest] quote sync session failed: ${msg}`);
    }
  } else {
    for (const raw of env.watchlistSymbols) {
      const normalised = normaliseSymbol(raw);
      quotes.push({ symbol: normalised, quote: await fetchMockQuote(normalised, exchange) });
    }
  }

  // Always log the sync outcome so Railway logs show the loop finished —
  // even when no quotes landed (gating this on synced>0 is what hid the
  // "no rows" failure mode from the user).
  console.info(
    JSON.stringify({
      level: "info",
      event: "quote_sync_complete",
      source: "iress-worker",
      requested: env.watchlistSymbols.length,
      ok: quotes.length,
      empty: emptyCount,
      errors: errorCount,
      sessionFatal: sessionFatal ?? null,
    }),
  );

  if (quotes.length === 0) {
    return {
      synced: 0,
      requested: env.watchlistSymbols.length,
      errors: errorCount,
      empty: emptyCount,
      plans: [],
      missingInstruments: [],
    };
  }

  const symbols = quotes.map((q) => q.symbol);
  let securityMap = new Map<string, string>();
  if (supabase && env.allowWrites && !env.dryRun) {
    securityMap = await loadSecurityMap(supabase, symbols);
  }

  const timestamp = new Date().toISOString();
  const plans: QuoteUpsertPlan[] = [];
  const missingInstruments: MissingInstrument[] = [];

  for (const { symbol, quote } of quotes) {
    const securityId = securityMap.get(symbol);
    const priceCents = quoteToCents(quote.last);
    const plan: QuoteUpsertPlan = {
      symbol,
      securityId: securityId ?? `unknown-${symbol}`,
      currentPriceCents: priceCents,
      timestamp,
    };
    plans.push(plan);

    if (env.dryRun || !env.allowWrites) {
      console.info(
        `[iress-ingest] would upsert stock_intraday_c`,
        JSON.stringify(plan),
      );
      continue;
    }

    if (!supabase) continue;
    if (!securityId) {
      const missing: MissingInstrument = { symbol, exchange, observedAt: timestamp };
      missingInstruments.push(missing);
      console.warn(
        JSON.stringify({
          level: "warn",
          event: "missing_security",
          workerId: env.workerId,
          symbol,
          exchange,
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

    const { error: secErr } = await supabase
      .from("securities_c")
      .update({ last_price: priceCents })
      .eq("id", securityId);
    if (secErr) {
      console.warn(
        `[iress-ingest] securities_c.last_price update(${symbol}): ${secErr.message}`,
      );
    }
  }

  return {
    synced: plans.length,
    requested: env.watchlistSymbols.length,
    errors: errorCount,
    empty: emptyCount,
    plans,
    missingInstruments,
  };
}
