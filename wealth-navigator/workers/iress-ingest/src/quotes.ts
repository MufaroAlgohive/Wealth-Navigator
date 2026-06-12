import { getIressClient, iressConfig, redactSessionKeyForLog } from "../../../src/lib/iress/index";
import { isIressSessionDeadError } from "../../../src/lib/iress/errors";
import { iressQueries } from "../../../src/lib/iress/mock";
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
): Promise<Quote | null> {
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
  if (!row || row.last <= 0) return null;
  return { ...row, symbol: stripped };
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
  const exchange = "JSE";
  const isLive = iressConfig.mode === "live" || iressConfig.mode === "wsdl-stub";
  const quotes: Array<{ symbol: string; quote: Quote }> = [];

  if (isLive) {
    try {
      await sessions.withSession(async (session) => {
        console.info(
          `[iress-ingest] quote sync start iressKey=${redactSessionKeyForLog(session.iressSessionKey)} symbols=${env.watchlistSymbols.length}`,
        );
        for (const symbol of env.watchlistSymbols) {
          const normalised = normaliseSymbol(symbol);
          try {
            const quote = await fetchLiveQuote(session, normalised, exchange);
            if (quote) quotes.push({ symbol: normalised, quote });
          } catch (err) {
            if (isIressSessionDeadError(err)) throw err;
            const msg = err instanceof Error ? err.message : String(err);
            console.warn(`[iress-ingest] PricingQuoteGet(${normalised}) failed: ${msg}`);
          }
        }
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[iress-ingest] quote sync session failed: ${msg}`);
    }
  } else {
    for (const raw of env.watchlistSymbols) {
      const normalised = normaliseSymbol(raw);
      quotes.push({ symbol: normalised, quote: await fetchMockQuote(normalised, exchange) });
    }
  }

  if (quotes.length === 0) {
    return { synced: 0, plans: [], missingInstruments: [] };
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

  return { synced: plans.length, plans, missingInstruments };
}
