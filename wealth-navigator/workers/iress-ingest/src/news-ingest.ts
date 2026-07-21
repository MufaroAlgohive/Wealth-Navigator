/**
 * News ingest — `NewsHeadlineGet` → `news_item_c`.
 *
 * Until 2026-07-20 the SENS feed was wired through the worker but never
 * reached the UI: the IRESS V4 verb we were calling (`NewsVendorGet`)
 * returns only the vendor catalog (1 row), not stories. The real
 * story-fetching verb is `NewsHeadlineGet` with `VendorCode=SENSD`,
 * `DateTimeStart`, `DateTimeEnd`, `Count`, run on the prod market-data
 * session. See `wealth-navigator/docs/SENS_NEWSHEADLINE_WIRE.md` for
 * the captured envelope.
 *
 * This module is the **persistence** leg of the SENS fix (Step 3 of the
 * 2026-07-20 plan). It pulls today's SENS announcements on a slow
 * cadence (default 6 h, env-overridable) and upserts them into
 * `public.news_item_c` on the **institutional** Supabase project
 * (separate from `securities_c`/`stock_intraday_c` on the retail
 * project — the table lives on the institutional side per the
 * `20260613000004_oems_instrument_universe.sql` migration).
 *
 * The loop is **opt-in** (env `IRESS_NEWS_INGEST=1`) and still honours
 * the worker's `dryRun` / `allowWrites` gates. Default is
 * shadow-only — same posture as `syncRetailPrices`.
 */

import { getIressClient } from "../../../src/lib/iress";
import { IressError } from "../../../src/lib/iress/errors";
import { getMarketDataSession } from "./market-data";
import { recordWorkerEvent } from "./events";
import type { WorkerEnv } from "./env";
import type { WorkerSessionManager } from "./session";
import type { WorkerSupabase } from "./supabase";

export interface NewsSyncResult {
  requested: number;
  upserted: number;
  skipped: number;
  /** True when no live write was performed (dry-run / writes disabled). */
  dryRun: boolean;
  windowStart: string;
  windowEnd: string;
  vendorCode: string;
  durationMs: number;
  error: string | null;
}

/** ISO-naive date string `YYYY-MM-DDTHH:MM:SS` for a UTC day window. */
function isoDayWindow(d: Date, end: "start" | "end"): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const y = d.getUTCFullYear();
  const m = pad(d.getUTCMonth() + 1);
  const day = pad(d.getUTCDate());
  return `${y}-${m}-${day}T${end === "start" ? "00:00:00" : "23:59:59"}`;
}

/** Category ID list → SENS category enum (best-guess, falls back to `null`). */
function categoryFromId(id: string | null): string | null {
  if (!id) return null;
  // SENS uses 100_000_000 + sub-id. The CT build returned 105000000 for
  // every 2026-07-20 announcement (corporate-actions bucket). We
  // deliberately don't fabricate a mapping — leave the literal id in
  // `payload.category_id` so the UI / data team can pin the enum later.
  return null;
}

function severityFromIr(row: Record<string, unknown>): string {
  // Top-level MarketSensitive boolean mirrors the per-symbol list.
  if (row["MarketSensitive"] === true || row["MarketSensitive"] === "true") return "high";
  const market = (row["MarketSensitiveList"] as string | undefined) ?? "";
  if (market.split(",").some((s) => s.trim() === "*")) return "high";
  // Anything carrying an HTML / plain-text body is at least a medium
  // signal (vs. the headline-only AT THE MARKET markers).
  if (row["HasTextStory"] === true || row["HasHTMLTextStory"] === true) return "medium";
  return "low";
}

/** Map a single `NewsHeadlineGet` data row to the `news_item_c` upsert shape. */
function toNewsItemRow(
  row: Record<string, unknown>,
  vendorCode: string,
): {
  item_id: string;
  source: string;
  category: string | null;
  severity: string | null;
  ticker: string | null;
  issuer: string | null;
  headline: string;
  body: string | null;
  url: string | null;
  published_at: string;
  payload: Record<string, unknown>;
} | null {
  const storyId = row["HeadlineID"];
  if (typeof storyId !== "string" || !storyId) return null;
  const headline = row["HeadlineText"];
  if (typeof headline !== "string" || !headline) return null;
  const codes = (row["SecurityCodeList"] as string | undefined) ?? "";
  const tickers = codes.split(",").map((s) => s.trim()).filter(Boolean);
  const ticker = tickers[0] ?? null;
  const published = row["HeadlineDateTime"];
  const published_at =
    typeof published === "string" ? published : new Date().toISOString();
  const body = (row["NewsSummary"] as string | undefined) ?? null;
  const url = ((row["StoryURL"] as string | undefined) ?? "") || null;
  const source = (row["VendorCode"] as string | undefined) ?? vendorCode;
  const categoryId = ((row["CategoryIDList"] as string | undefined) ?? "") || null;
  return {
    item_id: storyId,
    source,
    category: categoryFromId(categoryId),
    severity: severityFromIr(row),
    ticker,
    issuer: null,
    headline,
    body,
    url,
    published_at,
    payload: {
      category_id: categoryId,
      tickers,
      exchanges: ((row["ExchangeList"] as string | undefined) ?? "").split(",").map((s) => s.trim()).filter(Boolean),
      market_sensitive_list: row["MarketSensitiveList"] ?? null,
      has_text_story: row["HasTextStory"] ?? null,
      has_html_text_story: row["HasHTMLTextStory"] ?? null,
      vendor_code: source,
    },
  };
}

/**
 * One-shot ingest: call `NewsHeadlineGet` with the trading-day window,
 * upsert each non-paging row into `public.news_item_c`.
 *
 * Honours `env.dryRun` / `env.allowWrites`: when either is off, the
 * function returns `dryRun: true` with no Supabase writes. Errors
 * surface in the `error` field so the loop can log and continue.
 */
export async function syncNewsHeadlines(opts: {
  env: WorkerEnv;
  sessions: WorkerSessionManager;
  supabase: WorkerSupabase | null;
  /** Optional override; defaults to today's UTC window. */
  windowStart?: string;
  windowEnd?: string;
  /** Optional override; defaults to "SENSD" (the vendor code CT accepts). */
  vendorCode?: string;
  /** Optional cap on the per-request `Count`; default 500. */
  count?: number;
}): Promise<NewsSyncResult> {
  const { env, sessions, supabase } = opts;
  const t0 = Date.now();
  const isLive = env.iressMode === "live" || env.iressMode === "wsdl-stub";
  const dryRun = env.dryRun || !env.allowWrites || !isLive || !supabase;

  const now = new Date();
  const windowStart = opts.windowStart ?? isoDayWindow(now, "start");
  const windowEnd = opts.windowEnd ?? isoDayWindow(now, "end");
  const vendorCode = opts.vendorCode ?? "SENSD";
  const count = Math.max(1, Math.min(1000, opts.count ?? 500));

  if (!isLive) {
    return {
      requested: 0,
      upserted: 0,
      skipped: 0,
      dryRun: true,
      windowStart,
      windowEnd,
      vendorCode,
      durationMs: Date.now() - t0,
      error: `iress_mode=${env.iressMode} — skipping live fetch`,
    };
  }

  let session;
  try {
    session = await sessions.getSession();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      requested: 0, upserted: 0, skipped: 0, dryRun: true,
      windowStart, windowEnd, vendorCode, durationMs: Date.now() - t0,
      error: `session acquire failed: ${msg}`,
    };
  }

  // News is market data — run on the prod market-data session when
  // present (it carries the SENSD entitlement on this CT build).
  const md = await getMarketDataSession();
  const client = md ? md.client : getIressClient("live");
  const sessionKey = md ? md.sessionKey : session.iressSessionKey;

  let res;
  try {
    res = await client.newsHeadlineGet({
      Header: {
        SessionKey: sessionKey,
        RequestID: `news-persist-${now.getTime()}`,
        WaitForResponse: true,
        Updates: false,
        PagingBookmark: "",
        PagingDirection: 0,
        PageSize: count,
        Timeout: 25,
      },
      VendorCode: vendorCode,
      DateTimeStart: windowStart,
      DateTimeEnd: windowEnd,
      Count: count,
    });
  } catch (err) {
    const e = err as unknown;
    const msg = e instanceof Error ? e.message : String(e);
    const code = e instanceof IressError ? e.code : null;
    return {
      requested: 0, upserted: 0, skipped: 0, dryRun,
      windowStart, windowEnd, vendorCode, durationMs: Date.now() - t0,
      error: `NewsHeadlineGet ${code ?? "?"}: ${msg}`,
    };
  }

  // Drop the paging-bookmark header row (no HeadlineID).
  const dataRows = (res.DataRows ?? []).filter(
    (r) => r && typeof (r as Record<string, unknown>)["HeadlineID"] === "string",
  );
  const records = dataRows
    .map((r) => toNewsItemRow(r as Record<string, unknown>, vendorCode))
    .filter((r): r is NonNullable<typeof r> => r !== null);

  let upserted = 0;
  let skipped = 0;
  if (records.length > 0 && !dryRun) {
    const { error } = await supabase!
      .from("news_item_c")
      .upsert(records, { onConflict: "item_id", count: "exact" });
    if (error) {
      return {
        requested: records.length, upserted: 0, skipped: 0, dryRun,
        windowStart, windowEnd, vendorCode, durationMs: Date.now() - t0,
        error: `upsert: ${error.message}`,
      };
    }
    upserted = records.length;
    recordWorkerEvent({
      level: "info",
      event: "news_ingest_complete",
      msg: `SENS ingest → ${upserted}/${records.length} rows upserted (vendor=${vendorCode})`,
      data: {
        vendorCode,
        windowStart,
        windowEnd,
        requested: records.length,
        upserted,
        elapsedMs: Date.now() - t0,
      },
    });
  } else if (records.length === 0) {
    skipped = 0;
    recordWorkerEvent({
      level: "info",
      event: "news_ingest_complete",
      msg: `SENS ingest → 0 rows in window (vendor=${vendorCode})`,
      data: { vendorCode, windowStart, windowEnd, requested: 0, dryRun },
    });
  } else {
    // dryRun — record the shadow event without write.
    recordWorkerEvent({
      level: "info",
      event: "news_ingest_dry_run",
      msg: `SENS ingest (dry-run) → ${records.length} rows surfaced (vendor=${vendorCode})`,
      data: {
        vendorCode,
        windowStart,
        windowEnd,
        requested: records.length,
        dryRun: true,
      },
    });
  }

  return {
    requested: records.length,
    upserted,
    skipped,
    dryRun,
    windowStart,
    windowEnd,
    vendorCode,
    durationMs: Date.now() - t0,
    error: null,
  };
}
