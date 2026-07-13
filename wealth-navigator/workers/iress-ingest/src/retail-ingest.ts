/**
 * Retail price ingest — the IRESS replacement for the Yahoo feed.
 *
 * Reads the retail `securities_c` universe (`.JO` symbols), polls IRESS
 * `PricingQuoteGet` per symbol (bare code), reference-anchors the price to the
 * existing `securities_c.last_price` (see scale.ts), and — only when writes are
 * explicitly enabled — updates `securities_c.last_price` + appends
 * `stock_intraday_c` for the symbols IRESS can price. Symbols IRESS does not
 * cover are left untouched, so Yahoo keeps them fresh and nothing goes stale.
 *
 * ── SAFETY (this writes to a LIVE consumer DB, so the guards are strict) ──────
 *  - DORMANT unless `IRESS_RETAIL_INGEST=1` AND `RETAIL_SUPABASE_URL` is
 *    explicitly set (no legacy fallback) — both checked in main.ts before this
 *    loop is ever started.
 *  - Gated by its OWN switch `IRESS_RETAIL_DRY_RUN` (default: shadow), separate
 *    from the worker-wide dryRun/allowWrites (which govern the institutional
 *    feed). Default behaviour shadow-logs the IRESS-vs-Yahoo comparison and
 *    writes NOTHING; only `IRESS_RETAIL_DRY_RUN=0` enables live retail writes.
 *  - Touches ONLY `securities_c.last_price` and `stock_intraday_c` — the same
 *    fields the Yahoo feed already writes. It NEVER reads or writes any customer
 *    table (profiles / wallets / holdings / transactions / KYC).
 *  - No DDL. `price_source` is written only when `RETAIL_PRICE_SOURCE_COL=1`
 *    (i.e. after the review-only migration is applied), so an unmigrated DB
 *    can never error on an unknown column.
 *  - Per-symbol authority: only symbols IRESS prices (outcome ok /
 *    closed-with-data, last > 0) are written; everything else is skipped.
 */
import { fetchLiveQuote, normaliseSymbol } from "./quotes";
import { chooseDisplayCents } from "./scale";
import { isIressSessionDeadError } from "../../../src/lib/iress/errors";
import type { WorkerEnv } from "./env";
import type { WorkerSessionManager } from "./session";
import type { WorkerSupabase } from "./supabase";
import { recordWorkerEvent } from "./events";

export interface RetailSecurity {
  id: string;
  symbol: string;
  isin: string | null;
  last_price: number | null;
}

/** "MTN.JO" / " stx40.jo " -> "MTN" / "STX40" (bare IRESS code). */
export function toIressCode(symbol: string): string {
  // Normalise (trim whitespace + uppercase) BEFORE stripping the suffix, so a
  // trailing space can't defeat the end-anchored `.JO`/`.JSE` match.
  return normaliseSymbol(symbol).replace(/\.(JO|JSE)$/i, "");
}

export interface RetailSyncResult {
  requested: number;
  covered: number;
  written: number;
  skipped: number;
  /** True when no live write was performed (dry-run / writes disabled). */
  dryRun: boolean;
  sample: Array<{ symbol: string; iressCents: number; yahooCents: number | null; basis: string }>;
}

export async function loadRetailUniverse(retail: WorkerSupabase): Promise<RetailSecurity[]> {
  const { data, error } = await retail
    .from("securities_c")
    .select("id, symbol, isin, last_price");
  if (error) {
    console.error(`[retail-ingest] securities_c read failed: ${error.message}`);
    return [];
  }
  return (data ?? []) as RetailSecurity[];
}

export async function syncRetailPrices(opts: {
  env: WorkerEnv;
  sessions: WorkerSessionManager;
  retail: WorkerSupabase | null;
  /**
   * Institutional client (OEMS-owned). When provided, the same per-symbol IRESS
   * quotes this loop already fetches are persisted to `quote_snapshot_c` so the
   * dashboard's IRESS-first overlay (last + change% from prev_close) covers the
   * FULL JSE universe, not just the 15s watchlist. This write is independent of
   * the retail customer-DB gate (IRESS_RETAIL_DRY_RUN) — it never touches a
   * customer table.
   */
  institutional?: WorkerSupabase | null;
  exchange?: string;
  /** Optional cap (e.g. a small shadow run). */
  limit?: number;
}): Promise<RetailSyncResult> {
  const { env, sessions, retail } = opts;
  const institutional = opts.institutional ?? null;
  const exchange = opts.exchange ?? env.defaultExchange ?? "JSE";
  // Retail writes use their OWN explicit gate (default: shadow), independent of
  // the worker-wide dryRun/allowWrites that govern the institutional feed. Flip
  // IRESS_RETAIL_DRY_RUN=0 only after the shadow run validates coverage + scaling.
  // HARD UAT GUARD (re-contamination fix, 2026-07-13): NEVER write retail prices
  // while pointed at the CT/UAT IRESS endpoint (webservices-ct) or in UAT mode.
  // Those are TEST prices and corrupt the live consumer's securities_c.last_price
  // / stock_intraday_c. This cannot be overridden by IRESS_RETAIL_DRY_RUN; only a
  // real PROD market-data feed may ever write retail.
  const iressBaseUrl = process.env.IRESS_BASE_URL ?? "";
  const onUatEndpoint =
    /webservices-ct/i.test(iressBaseUrl) ||
    ["1", "true"].includes((process.env.IRESS_UAT_MODE ?? "").trim().toLowerCase());
  const writesOn = process.env.IRESS_RETAIL_DRY_RUN === "0" && Boolean(retail) && !onUatEndpoint;
  // UAT phase: IRESS returns TEST prices, so do not persist them to the
  // institutional quote_snapshot_c either (it is read-gated today, but writing
  // test prices to a shared table is a latent leak for any future reader).
  const priceOverlayOff = process.env.IRESS_PRICE_OVERLAY === "0";
  const setSourceCol = process.env.RETAIL_PRICE_SOURCE_COL === "1";

  if (!retail) {
    return { requested: 0, covered: 0, written: 0, skipped: 0, dryRun: true, sample: [] };
  }

  const universe = await loadRetailUniverse(retail);
  const list = opts.limit && opts.limit > 0 ? universe.slice(0, opts.limit) : universe;
  const ts = new Date().toISOString();

  let covered = 0;
  let written = 0;
  let skipped = 0;
  const sample: RetailSyncResult["sample"] = [];
  // Institutional L1 snapshot rows (full universe) → quote_snapshot_c. Collected
  // regardless of the retail write gate; upserted after the session loop.
  const snapshotRows: Array<Record<string, unknown>> = [];

  await sessions.withSession(async (session) => {
    for (const sec of list) {
      const iressCode = toIressCode(sec.symbol);
      let lastRands = 0;
      let outcome = "error";
      let quoteRow: Awaited<ReturnType<typeof fetchLiveQuote>>["row"] | null = null;
      try {
        const r = await fetchLiveQuote(session, iressCode, exchange);
        outcome = r.outcome;
        quoteRow = r.row ?? null;
        lastRands = r.row?.last ?? 0;
      } catch (err) {
        if (isIressSessionDeadError(err)) throw err; // let withSession recover + retry
        skipped += 1;
        continue;
      }

      const isCovered = (outcome === "ok" || outcome === "closed-with-data") && lastRands > 0;
      if (!isCovered) {
        skipped += 1; // IRESS can't price it now → leave Yahoo's value untouched
        continue;
      }
      covered += 1;

      const refCents = Number(sec.last_price) || 0;
      const choice = chooseDisplayCents(lastRands, refCents);
      if (sample.length < 15) {
        sample.push({ symbol: sec.symbol, iressCents: choice.cents, yahooCents: refCents || null, basis: choice.basis });
      }

      // Build the institutional L1 snapshot (cents scale matching securities_c),
      // so the dashboard overlay has IRESS last + prev_close for this symbol.
      if (institutional) {
        const mlt = choice.centsMultiplier;
        const px = (v: number | null | undefined) => (v != null && v > 0 ? Math.round(v * mlt) : null);
        snapshotRows.push({
          security_code: iressCode,
          exchange,
          last: choice.cents,
          open: px(quoteRow?.open),
          high: px(quoteRow?.high),
          low: px(quoteRow?.low),
          bid: px(quoteRow?.bid),
          ask: px(quoteRow?.ask),
          prev_close: px(quoteRow?.prevClose),
          volume: quoteRow?.volume && quoteRow.volume > 0 ? quoteRow.volume : null,
          vwap: px(quoteRow?.vwap),
          currency: quoteRow?.currency || null,
          market_state: quoteRow?.marketState || null,
          as_of: quoteRow?.ts && quoteRow.ts > 0 ? new Date(quoteRow.ts).toISOString() : ts,
          source: "iress-retail-universe",
          updated_at: ts,
        });
      }

      if (!writesOn) continue; // shadow: comparison captured, nothing written to RETAIL

      // `symbol` is NOT NULL on the production stock_intraday_c (a denormalised
      // column the legacy Yahoo feed populated). Omitting it makes every insert
      // fail with "null value in column symbol", so the IRESS retail feed never
      // lands. Write the same `.JO` symbol securities_c uses.
      //
      // Upsert (not insert) on the (symbol, timestamp) unique key: `ts` is fixed
      // for the whole cycle, so if withSession reconnects mid-loop and re-runs,
      // the symbols already written this cycle would otherwise fail with a
      // duplicate-key violation. Upserting makes the re-run idempotent.
      const { error: tickErr } = await retail.from("stock_intraday_c").upsert(
        {
          security_id: sec.id,
          symbol: sec.symbol,
          current_price: choice.cents,
          timestamp: ts,
        },
        { onConflict: "symbol,timestamp" },
      );
      if (tickErr) {
        console.error(`[retail-ingest] stock_intraday_c insert(${sec.symbol}): ${tickErr.message}`);
        continue;
      }
      const update: Record<string, unknown> = { last_price: choice.cents };
      // Yahoo parity: derive `change_percent` from the IRESS quote so the CRM's
      // change column stays correct without Yahoo. `last` and `prevClose` are
      // both in rands here, so the ratio is scale-free — independent of the
      // cents-scale anchoring applied to `last_price` (see scale.ts). Only the
      // ratio is written; `change_price` (cents) is intentionally left to the
      // existing feed until the cents scale per symbol is verified.
      const prevCloseRands = quoteRow?.prevClose ?? 0;
      if (prevCloseRands > 0 && lastRands > 0) {
        update["change_percent"] =
          Math.round(((lastRands - prevCloseRands) / prevCloseRands) * 10000) / 100;
      }
      if (setSourceCol) update["price_source"] = "iress";
      const { error: secErr } = await retail.from("securities_c").update(update).eq("id", sec.id);
      if (secErr) {
        console.warn(`[retail-ingest] securities_c update(${sec.symbol}): ${secErr.message}`);
        continue;
      }
      written += 1;
    }
  });

  // Persist the full-universe IRESS L1 snapshot → institutional quote_snapshot_c.
  // Best-effort + isolated: a failure here must NOT affect the retail result.
  // This powers the dashboard's IRESS-first price/change overlay across all 246
  // names (not just the 15s watchlist) and the Security L1 panel for any symbol.
  if (institutional && snapshotRows.length > 0 && priceOverlayOff) {
    console.info(
      JSON.stringify({ level: "info", event: "quote_snapshot_c_skipped_uat", reason: "IRESS_PRICE_OVERLAY=0", count: snapshotRows.length }),
    );
  } else if (institutional && snapshotRows.length > 0) {
    // De-dupe by (security_code, exchange): two securities_c symbols can map to
    // the same bare IRESS code, and Postgres rejects an upsert batch that
    // touches the same ON CONFLICT key twice ("cannot affect row a second
    // time"). Keep the last occurrence per key.
    const dedupedSnapshot = Array.from(
      new Map(snapshotRows.map((r) => [`${r.security_code}|${r.exchange}`, r])).values(),
    );
    const { error: snapErr } = await institutional
      .from("quote_snapshot_c")
      .upsert(dedupedSnapshot, { onConflict: "security_code,exchange" });
    if (snapErr) {
      console.warn(`[retail-ingest] quote_snapshot_c upsert failed: ${snapErr.message}`);
    } else {
      console.info(
        JSON.stringify({ level: "info", event: "quote_snapshot_c_universe_upserted", count: dedupedSnapshot.length }),
      );
    }
  }

  recordWorkerEvent({
    level: "info",
    event: "retail_ingest_complete",
    msg: `retail price ingest ${writesOn ? "WRITE" : "shadow"}: ${covered}/${list.length} covered, ${written} written, ${skipped} skipped`,
    data: { requested: list.length, covered, written, skipped, writesOn, sample: sample.slice(0, 5) },
  });

  return { requested: list.length, covered, written, skipped, dryRun: !writesOn, sample };
}
