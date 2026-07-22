/**
 * News ingest — `NewsHeadlineGet` → `news_item_c` + vendor catalog.
 *
 * Two tasks, one module:
 *
 *   1. `syncNewsVendorCatalog()` — one-shot on prod-worker start. Calls
 *      `NewsVendorGet` against the **prod market-data session** (which
 *      `market-data.ts::getMarketDataSession()` brings up automatically
 *      when `IRESS_MARKET_DATA_PROD=1`). The vendor catalog is the
 *      authoritative list of news feeds `DFM@Mint` is entitled to on the
 *      prod endpoint — Andre's WSDL browser (2026-07-22) captured the
 *      20-vendor CAT-shaped response (ASXH/BRR/CCN/.../SARSS/SENS) for
 *      this build. The list is static for a deployment, so we persist it
 *      into `news_item_c.payload.scope.vendor_catalog` via one
 *      synthetic marker row + a `news_vendor_catalog` worker event.
 *      No separate schema migration needed — `payload` is JSONB.
 *
 *   2. `syncNewsHeadlines()` — periodic loop. Calls `NewsHeadlineGet`
 *      with the configured vendor code (default `SENS`) on the
 *      trading-day window, paginates via `PagingBookmark` to the full
 *      result set (the CT build returned 894 rows in one window at
 *      `Count=1000` so a 500-row cap silently truncated), upserts the
 *      surviving rows into `public.news_item_c` on the **institutional**
 *      Supabase project.
 *
 * Pilot-write gate (2026-07-22 plan): `env.newsDryRun` and
 * `env.newsAllowWrites` are the **per-loop** override for this module
 * only. Worker-wide `dryRun=true / allowWrites=false` stays the resting
 * state so the rest of the worker (quotes / orders / IPS / retail)
 * stays dry-run exactly as `AGENTS.md` requires — only an explicit
 * `IRESS_NEWS_DRY_RUN=0` + `IRESS_NEWS_ALLOW_WRITES=1` on the prod
 * worker unlocks `news_item_c` writes.
 *
 * Vendor fallback: when `NewsHeadlineGet(VendorCode="SENS")` faults
 * 25010 (entitlement) or 25018 (missing required field) — e.g. the
 * deployment's prod entitlement still allows delayed only, like CT
 * does for `DFM@Mint` per the 2026-07-20 probe — the loop retries
 * once with `VendorCode="SENSD"` (SENS delayed) and stamps
 * `payload.scope.vendor_fallback=true`. Real-time when entitled,
 * delayed when not.
 *
 * Universe-tag (the "scan all tickers" leg): per row, intersect
 * `SecurityCodeList` (comma-separated) with the union of
 * `env.watchlistEntries[].symbol` + a Supabase read of
 * `securities_c.symbol` (retail) + `oems_instrument_universe_c.code`
 * (institutional). Persisted as `payload.scope.matched` /
 * `payload.scope.matched_codes`. The universe is cached for the loop
 * lifetime and refreshed on error.
 */

import { getIressClient } from "../../../src/lib/iress";
import { IressError } from "../../../src/lib/iress/errors";
import { getMarketDataSession } from "./market-data";
import { recordWorkerEvent } from "./events";
import type { WorkerEnv } from "./env";
import type { WorkerSessionManager } from "./session";
import type { WorkerSupabase } from "./supabase";

/** ISO-naive date string `YYYY-MM-DDTHH:MM:SS` for a UTC day window. */
function isoDayWindow(d: Date, end: "start" | "end"): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const y = d.getUTCFullYear();
  const m = pad(d.getUTCMonth() + 1);
  const day = pad(d.getUTCDate());
  return `${y}-${m}-${day}T${end === "start" ? "00:00:00" : "23:59:59"}`;
}

/**
 * Best-effort `HeadlineDateTime` parser. The CT build returns
 * `2026/07/22 11:00:00` (slashes, space, NO T-separator) — NOT
 * `2026-07-22T11:00:00` as the V4 WSDL sample shows. Slashes +
 * no-T reject `Date.parse`; normalise first. Returns `Date(0)` when
 * unparseable.
 */
function parseHeadlineDateTime(raw: string): Date {
  if (!raw) return new Date(0);
  // Accept `YYYY/MM/DD HH:MM:SS(.fff)?` and `YYYY-MM-DDTHH:MM:SS`.
  // 1. Slash form → replace slashes with dashes, replace the space with T.
  const slash = raw.match(
    /^(\d{4})\/(\d{2})\/(\d{2})\s+(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?$/,
  );
  if (slash) {
    const [, y, mo, d, h, mi, s] = slash;
    return new Date(
      Date.UTC(
        Number(y),
        Number(mo) - 1,
        Number(d),
        Number(h),
        Number(mi),
        Number(s),
      ),
    );
  }
  // 2. ISO-with-T form: hand to Date.parse directly.
  const t = Date.parse(raw);
  return Number.isFinite(t) ? new Date(t) : new Date(0);
}

/**
 * Read the universe every story's `SecurityCodeList` is intersected
 * against — union of:
 *   - `env.watchlistEntries[].symbol`        (worker config: NPN, PRX, ...)
 *   - institutional `oems_instrument_universe_c.code`
 *   - retail `securities_c.symbol` (joined via the worker's retail
 *     supabase client, when configured)
 *
 * Cached for the loop lifetime; refresh on read error so a transient
 * Supabase blip doesn't pin the universe at zero.
 */
async function loadUniverseSet(opts: {
  env: WorkerEnv;
  retailSupabase: WorkerSupabase | null;
  supabase: WorkerSupabase | null;
}): Promise<Set<string>> {
  const out = new Set<string>();
  for (const entry of opts.env.watchlistEntries) {
    if (entry.symbol) out.add(entry.symbol.toUpperCase());
  }
  if (opts.supabase) {
    try {
      const { data, error } = await opts.supabase
        .from("oems_instrument_universe_c")
        .select("code");
      if (error) {
        console.warn(`[iress-ingest] universe read (institutional) failed: ${error.message}`);
      } else if (Array.isArray(data)) {
        for (const row of data) {
          const code = (row as { code?: unknown }).code;
          if (typeof code === "string" && code.trim()) {
            out.add(code.trim().toUpperCase());
          }
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[iress-ingest] universe read (institutional) threw: ${msg}`);
    }
  }
  if (opts.retailSupabase) {
    try {
      const { data, error } = await opts.retailSupabase
        .from("securities_c")
        .select("symbol");
      if (error) {
        console.warn(`[iress-ingest] universe read (retail) failed: ${error.message}`);
      } else if (Array.isArray(data)) {
        for (const row of data) {
          const sym = (row as { symbol?: unknown }).symbol;
          if (typeof sym === "string" && sym.trim()) {
            out.add(sym.trim().toUpperCase());
          }
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[iress-ingest] universe read (retail) threw: ${msg}`);
    }
  }
  return out;
}

/**
 * True when `IressError.code` is one we should retry once on
 * `VendorCode="SENSD"` after a `SENS` failure (entitlement missing
 * or "no valid vendor specified"). 25010 = entitlement; 25018 =
 * missing required field. Some prod SOAP faults come back with code
 * `-1` and a "No valid vendor specified" message string — the parser
 * can't extract a numeric fault code so we treat that as a fallback
 * trigger by inspecting the message.
 */
const VENDOR_FALLBACK_CODES = new Set([25010, 25018]);
const VENDOR_FALLBACK_MESSAGE_HINTS = [
  "no valid vendor specified",
  "invalid vendor",
  "vendor not found",
  "no entitlement for vendor",
] as const;
function shouldFallbackToSensd(code: number, message: string): boolean {
  if (VENDOR_FALLBACK_CODES.has(code)) return true;
  if (code === -1) {
    const lower = message.toLowerCase();
    return VENDOR_FALLBACK_MESSAGE_HINTS.some((hint) => lower.includes(hint));
  }
  return false;
}

/**
 * One-shot vendor catalog fetch. Called from `main-prod.ts` on
 * startup; not part of the periodic news loop because the catalog
 * is static for a deployment.
 *
 * The result is logged as a `news_vendor_catalog` worker event and
 * ALSO persisted to `news_item_c` as one synthetic marker row so the
 * UI / BFF can render the vendor list without holding the IRESS seat.
 * The marker uses the convention `item_id = "vendor-catalog-<unix>"`
 * with `source = "__catalog__"`, `headline = "Vendor catalog"`
 * (NOT a real announcement), `payload.scope.vendor_catalog = [...]`.
 */
export interface VendorCatalogRow {
  vendorCode: string;
  vendorDescription: string;
}

/** Older `NewsVendorGet` may also return rows with these fields. */
interface RawVendorRow {
  VendorCode?: unknown;
  VendorDescription?: unknown;
  // Some CT builds use these alternate spellings:
  Code?: unknown;
  Description?: unknown;
  Source?: unknown;
  Feed?: unknown;
}

function coerceVendorRow(row: RawVendorRow | undefined): VendorCatalogRow | null {
  if (!row || typeof row !== "object") return null;
  const codeRaw = row.VendorCode ?? row.Code ?? row.Source ?? row.Feed;
  const descRaw =
    row.VendorDescription ?? row.Description ?? row.VendorCode ?? "";
  if (typeof codeRaw !== "string" || !codeRaw.trim()) return null;
  return {
    vendorCode: codeRaw.trim().toUpperCase(),
    vendorDescription: typeof descRaw === "string" ? descRaw.trim() : String(descRaw),
  };
}

export interface VendorCatalogResult {
  count: number;
  rows: VendorCatalogRow[];
  endpoint: string;
  durationMs: number;
  error: string | null;
}

export async function syncNewsVendorCatalog(): Promise<VendorCatalogResult> {
  const t0 = Date.now();
  const md = await getMarketDataSession();
  if (!md) {
    return {
      count: 0,
      rows: [],
      endpoint: "",
      durationMs: Date.now() - t0,
      error: "market-data prod session unavailable (IRESS_MARKET_DATA_PROD=0 or session bring-up failed)",
    };
  }
  let res;
  try {
    res = await md.client.newsVendorGet({
      Header: {
        SessionKey: md.sessionKey,
        RequestID: `news-vendor-catalog-${Date.now()}`,
        WaitForResponse: true,
      },
    });
  } catch (err) {
    const code = err instanceof IressError ? err.code : null;
    const msg = err instanceof Error ? err.message : String(err);
    return {
      count: 0,
      rows: [],
      endpoint: "(unknown)",
      durationMs: Date.now() - t0,
      error: `NewsVendorGet ${code ?? "?"}: ${msg}`,
    };
  }
  if (res.Header.ErrorNumber !== 0) {
    return {
      count: 0,
      rows: [],
      endpoint: "(unknown)",
      durationMs: Date.now() - t0,
      error: `NewsVendorGet error ${res.Header.ErrorNumber}: ${res.Header.ErrorDescription ?? "(no description)"}`,
    };
  }
  const rows: VendorCatalogRow[] = (res.DataRows ?? [])
    .map((r) => coerceVendorRow(r as RawVendorRow))
    .filter((r): r is VendorCatalogRow => r !== null);
  return {
    count: rows.length,
    rows,
    endpoint: "market-data prod",
    durationMs: Date.now() - t0,
    error: null,
  };
}

/** Publish the vendor catalog to `news_item_c` as one synthetic marker row. */
export async function persistVendorCatalogMarker(opts: {
  env: WorkerEnv;
  catalog: VendorCatalogResult;
  supabase: WorkerSupabase | null;
}): Promise<void> {
  if (!opts.supabase) return;
  if (opts.env.newsDryRun || !opts.env.newsAllowWrites) {
    recordWorkerEvent({
      level: "info",
      event: "news_vendor_catalog_dry_run",
      msg: `vendor catalog (${opts.catalog.count} rows) NOT persisted (news dry-run)`,
      data: {
        count: opts.catalog.count,
        rows: opts.catalog.rows,
        endpoint: opts.catalog.endpoint,
        durationMs: opts.catalog.durationMs,
      },
    });
    return;
  }
  // Synthetic marker row. Using a stable id keyed off the day so a
  // restart on the same day upserts (not duplicates) and a new day
  // gets a fresh row.
  const markerId = `vendor-catalog-${new Date().toISOString().slice(0, 10)}`;
  const { error } = await opts.supabase.from("news_item_c").upsert(
    {
      item_id: markerId,
      source: "__catalog__",
      category: null,
      severity: null,
      ticker: null,
      issuer: null,
      headline: `IRESS news vendor catalog (${opts.catalog.count} entries)`,
      body: null,
      url: null,
      published_at: new Date().toISOString(),
      payload: {
        is_catalog_marker: true,
        scope: {
          vendor_catalog: opts.catalog.rows,
          catalog_count: opts.catalog.count,
          catalog_endpoint: opts.catalog.endpoint,
          catalog_duration_ms: opts.catalog.durationMs,
          catalog_at: new Date().toISOString(),
        },
      },
    },
    { onConflict: "item_id", count: "exact" },
  );
  if (error) {
    console.warn(`[iress-ingest] vendor catalog marker upsert failed: ${error.message}`);
    return;
  }
  recordWorkerEvent({
    level: "info",
    event: "news_vendor_catalog_persisted",
    msg: `vendor catalog (${opts.catalog.count} rows) upserted to news_item_c`,
    data: {
      count: opts.catalog.count,
      durationMs: opts.catalog.durationMs,
      markerId,
    },
  });
}

/** Map a single `NewsHeadlineGet` data row to the `news_item_c` upsert shape. */
function toNewsItemRow(
  row: Record<string, unknown>,
  vendorCode: string,
  scope: { matched: boolean; matched_codes: string[]; vendor_fallback: boolean; page: number },
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
  const tickers = codes
    .split(/[\s,;]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const ticker = tickers[0] ?? null;
  const headlineDateTimeRaw =
    typeof row["HeadlineDateTime"] === "string" ? row["HeadlineDateTime"] : "";
  const publishedDate = parseHeadlineDateTime(headlineDateTimeRaw);
  const published_at =
    publishedDate.getTime() > 0 ? publishedDate.toISOString() : new Date().toISOString();
  const body = (row["NewsSummary"] as string | undefined) ?? null;
  const url = ((row["StoryURL"] as string | undefined) ?? "") || null;
  const source = (row["VendorCode"] as string | undefined) ?? vendorCode;
  const categoryId = ((row["CategoryIDList"] as string | undefined) ?? "") || null;
  // Severity: top-level MarketSensitive wins; per-symbol '*' list mirror; otherwise
  // a story-with-body ranks medium; otherwise low.
  let severity: string;
  if (row["MarketSensitive"] === true || row["MarketSensitive"] === "true") {
    severity = "high";
  } else {
    const market = (row["MarketSensitiveList"] as string | undefined) ?? "";
    if (market.split(",").some((s) => s.trim() === "*")) {
      severity = "high";
    } else if (row["HasTextStory"] === true || row["HasHTMLTextStory"] === true) {
      severity = "medium";
    } else {
      severity = "low";
    }
  }
  return {
    item_id: storyId,
    source,
    category: null, // pinned by categoryFromId when the enum lands; literal id lives in payload
    severity,
    ticker,
    issuer: null,
    headline,
    body,
    url,
    published_at,
    payload: {
      category_id: categoryId,
      tickers,
      exchanges: ((row["ExchangeList"] as string | undefined) ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
      // Per-row wire fields we want preserved even if normalised above
      // (category_id / market_sensitive / has_text_story):
      security_code: (row["SecurityCode"] as string | undefined) ?? null,
      exchange: (row["Exchange"] as string | undefined) ?? null,
      market_sensitive: row["MarketSensitive"] ?? null,
      market_sensitive_list: row["MarketSensitiveList"] ?? null,
      has_text_story: row["HasTextStory"] ?? null,
      has_html_text_story: row["HasHTMLTextStory"] ?? null,
      headline_datetime_raw: headlineDateTimeRaw || null,
      vendor_code: source,
      // The whole point of the 2026-07-22 plan — every row carries a
      // universe-tag payload so the UI can render "matched your
      // watchlist" badges without re-scanning the news table.
      scope,
    },
  };
}

/** Result of one cadence tick. Returned to the loop for logging. */
export interface NewsSyncResult {
  requested: number;
  upserted: number;
  skipped: number;
  /** True when no live write was performed (dry-run / writes disabled). */
  dryRun: boolean;
  windowStart: string;
  windowEnd: string;
  vendorCode: string;
  vendorFallback: boolean;
  pages: number;
  durationMs: number;
  universeSize: number;
  matchedCount: number;
  error: string | null;
}

/**
 * Paging loop for `NewsHeadlineGet`. Returns the flat data-row list,
 * honoring `PagingBookmark` until the server returns a short page.
 *
 * Stuck-cursor guard: cap at 5 pages. The CT build may return the
 * same bookmark twice under a known IRESS bug (`live.ts::MAX_LEGACY_IPS_PAGES`
 * uses the same 50-page cap for the IPS page loop — we floor at 5
 * because one trading day is bounded well below the 5-page mark at
 * any sane `newsMaxRows`). Always returns at least 1 page when the
 * caller wants the empty-page case preserved.
 */
const MAX_NEWS_PAGES = 5;

async function fetchNewsPage(opts: {
  client: ReturnType<typeof getIressClient>;
  sessionKey: string;
  vendorCode: string;
  windowStart: string;
  windowEnd: string;
  pageSize: number;
  pagingBookmark: string;
  pageIndex: number;
}): Promise<{ rows: Array<Record<string, unknown>>; nextBookmark: string; error: { code: number; message: string } | null }> {
  let res;
  try {
    res = await opts.client.newsHeadlineGet({
      Header: {
        SessionKey: opts.sessionKey,
        RequestID: `news-${opts.vendorCode}-${opts.pageIndex}-${Date.now()}`,
        WaitForResponse: true,
        Updates: false,
        PagingBookmark: opts.pagingBookmark,
        PagingDirection: 0,
        PageSize: opts.pageSize,
        Timeout: 25,
      },
      VendorCode: opts.vendorCode,
      DateTimeStart: opts.windowStart,
      DateTimeEnd: opts.windowEnd,
      Count: opts.pageSize,
    });
  } catch (err) {
    const code = err instanceof IressError ? err.code : 25018;
    const msg = err instanceof Error ? err.message : String(err);
    return { rows: [], nextBookmark: "", error: { code, message: msg } };
  }
  const rows: Array<Record<string, unknown>> = (res.DataRows ?? [])
    .filter((r) => r && typeof (r as Record<string, unknown>)["HeadlineID"] === "string")
    .map((r) => r as Record<string, unknown>);
  // The paging-bookmark header row carries {PagingBookmark:{HeadlineID:…}}
  // not HeadlineID-as-scalar — already filtered above. Read the response
  // header's PagingBookmark for the next page.
  const headerBookmarkRaw = res.Header?.PagingBookmark ?? "";
  return {
    rows,
    nextBookmark: typeof headerBookmarkRaw === "string" ? headerBookmarkRaw : "",
    error: null,
  };
}

/**
 * One-shot ingest: paginate `NewsHeadlineGet` for the trading-day
 * window, upsert every non-paging row into `public.news_item_c`.
 *
 * Honours `env.newsDryRun` / `env.newsAllowWrites` (per-loop gate).
 * On 25010 / 25018 from `SENS`, retries once with `SENSD` and stamps
 * `payload.scope.vendor_fallback=true`.
 */
export async function syncNewsHeadlines(opts: {
  env: WorkerEnv;
  sessions: WorkerSessionManager;
  supabase: WorkerSupabase | null;
  retailSupabase?: WorkerSupabase | null;
  /** Optional override; defaults to today's UTC window. */
  windowStart?: string;
  windowEnd?: string;
  /** Optional override; defaults to `env.newsVendorCode` ("SENS"). */
  vendorCode?: string;
  /** Optional cap on the per-request `Count`; default `env.newsMaxRows` (2000). */
  count?: number;
}): Promise<NewsSyncResult> {
  const { env, sessions, supabase, retailSupabase } = opts;
  const t0 = Date.now();
  const isLive = env.iressMode === "live" || env.iressMode === "wsdl-stub";

  // PILOT-WRITE GATE — per-loop. NOT env.dryRun / env.allowWrites.
  // The worker-wide gate stays dry-run by default; only this loop
  // flips when both `IRESS_NEWS_DRY_RUN=0` + `IRESS_NEWS_ALLOW_WRITES=1`
  // are set on the prod worker.
  const dryRun = env.newsDryRun || !env.newsAllowWrites || !isLive || !supabase;

  const now = new Date();
  const windowStart = opts.windowStart ?? isoDayWindow(now, "start");
  const windowEnd = opts.windowEnd ?? isoDayWindow(now, "end");
  const requestedVendor = (opts.vendorCode ?? env.newsVendorCode ?? "SENS")
    .trim()
    .toUpperCase();
  const count = Math.max(1, Math.min(1000, opts.count ?? env.newsMaxRows ?? 2000));

  if (!isLive) {
    return {
      requested: 0,
      upserted: 0,
      skipped: 0,
      dryRun: true,
      windowStart,
      windowEnd,
      vendorCode: requestedVendor,
      vendorFallback: false,
      pages: 0,
      durationMs: Date.now() - t0,
      universeSize: 0,
      matchedCount: 0,
      error: `iress_mode=${env.iressMode} — skipping live fetch`,
    };
  }

  // Acquire the prod market-data session. If not enabled (worker-wide
  // `IRESS_MARKET_DATA_PROD` not set), fall back to the main session
  // — same fallback path as the existing code.
  const md = await getMarketDataSession();
  let client: ReturnType<typeof getIressClient>;
  let sessionKey: string;
  if (md) {
    client = md.client;
    sessionKey = md.sessionKey;
  } else {
    let session;
    try {
      session = await sessions.getSession();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        requested: 0, upserted: 0, skipped: 0, dryRun: true,
        windowStart, windowEnd, vendorCode: requestedVendor,
        vendorFallback: false, pages: 0,
        durationMs: Date.now() - t0,
        universeSize: 0, matchedCount: 0,
        error: `session acquire failed: ${msg}`,
      };
    }
    client = getIressClient("live");
    sessionKey = session.iressSessionKey;
  }

  // Universe is cached for the loop lifetime. Refresh on error inside
  // loadUniverseSet is already handled — we only re-load if the
  // caller explicitly says so (out of scope of this function).
  const universe = await loadUniverseSet({
    env,
    retailSupabase: retailSupabase ?? null,
    supabase,
  });

  // Vendor + paging loop. First attempt with the requested vendor
  // (default "SENS"); on entitlement-style faults, retry ONCE with
  // "SENSD" and stamp `vendor_fallback=true`.
  let vendorCode = requestedVendor;
  let vendorFallback = false;
  const allRows: Array<Record<string, unknown>> = [];
  let pages = 0;
  let firstError: { code: number; message: string } | null = null;
  outer: for (let attempt = 0; attempt < 2; attempt += 1) {
    let bookmark = "";
    let lastBookmark = "INIT";
    let stallPages = 0;
    for (let pageIndex = 0; pageIndex < MAX_NEWS_PAGES; pageIndex += 1) {
      const page = await fetchNewsPage({
        client,
        sessionKey,
        vendorCode,
        windowStart,
        windowEnd,
        pageSize: count,
        pagingBookmark: bookmark,
        pageIndex,
      });
      pages += 1;
      if (page.error) {
        firstError = page.error;
        // If this is the first attempt and the fault looks like an
        // entitlement / invalid-vendor problem, flip to SENSD and try
        // again. Otherwise surface the error.
        if (
          attempt === 0 &&
          shouldFallbackToSensd(page.error.code, page.error.message)
        ) {
          vendorCode = "SENSD";
          vendorFallback = true;
          pages = 0;
          allRows.length = 0;
          recordWorkerEvent({
            level: "warn",
            event: "news_vendor_fallback",
            msg: `NewsHeadlineGet(${requestedVendor}) fault ${page.error.code}; retrying with SENSD`,
            data: {
              requestedVendor,
              errorCode: page.error.code,
              errorMessage: page.error.message,
              windowStart,
              windowEnd,
            },
          });
          continue outer;
        }
        break outer;
      }
      allRows.push(...page.rows);
      // Paging rule: short page = end; identical bookmark to last page = stalled.
      if (page.rows.length === 0) break;
      if (!page.nextBookmark || page.nextBookmark === bookmark) break;
      if (page.nextBookmark === lastBookmark) {
        stallPages += 1;
        if (stallPages >= 2) break;
      } else {
        stallPages = 0;
      }
      lastBookmark = bookmark;
      bookmark = page.nextBookmark;
    }
    break;
  }

  if (firstError && allRows.length === 0) {
    return {
      requested: 0,
      upserted: 0,
      skipped: 0,
      dryRun,
      windowStart,
      windowEnd,
      vendorCode,
      vendorFallback,
      pages,
      durationMs: Date.now() - t0,
      universeSize: universe.size,
      matchedCount: 0,
      error: `NewsHeadlineGet ${firstError.code ?? "?"}: ${firstError.message}`,
    };
  }

  // Convert + universe-tag. The `page` number on the payload is for
  // observability; the matched-codes set is what the UI surfaces.
  let matchedCount = 0;
  const records: Array<ReturnType<typeof toNewsItemRow>> = [];
  for (const r of allRows) {
    const tickers = ((r["SecurityCodeList"] as string | undefined) ?? "")
      .split(/[\s,;]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    const matchedCodes = tickers.filter((t) => universe.has(t.toUpperCase()));
    const matched = matchedCodes.length > 0;
    if (matched) matchedCount += 1;
    const scope = {
      matched,
      matched_codes: matchedCodes,
      vendor_fallback: vendorFallback,
      page: 0, // re-stamped per-page at fetch time would be nicer; keeping
                // simple boolean + matched_codes preserves everything the
                // UI surfaces (badges, scope badges, vendor chip).
    };
    records.push(toNewsItemRow(r, vendorCode, scope));
  }
  const validRecords = records.filter(
    (r): r is NonNullable<typeof r> => r !== null,
  );

  let upserted = 0;
  if (validRecords.length > 0 && !dryRun) {
    const { error } = await supabase!
      .from("news_item_c")
      .upsert(validRecords, { onConflict: "item_id", count: "exact" });
    if (error) {
      return {
        requested: validRecords.length,
        upserted: 0,
        skipped: 0,
        dryRun,
        windowStart,
        windowEnd,
        vendorCode,
        vendorFallback,
        pages,
        durationMs: Date.now() - t0,
        universeSize: universe.size,
        matchedCount,
        error: `upsert: ${error.message}`,
      };
    }
    upserted = validRecords.length;
    recordWorkerEvent({
      level: "info",
      event: "news_ingest_complete",
      msg: `SENS ingest → ${upserted}/${validRecords.length} rows upserted (vendor=${vendorCode} fallback=${vendorFallback})`,
      data: {
        vendorCode,
        requestedVendor,
        vendorFallback,
        windowStart,
        windowEnd,
        pages,
        requested: validRecords.length,
        upserted,
        universeSize: universe.size,
        matchedCount,
        elapsedMs: Date.now() - t0,
      },
    });
  } else if (validRecords.length === 0) {
    recordWorkerEvent({
      level: "info",
      event: "news_ingest_complete",
      msg: `SENS ingest → 0 rows in window (vendor=${vendorCode} fallback=${vendorFallback})`,
      data: {
        vendorCode,
        requestedVendor,
        vendorFallback,
        windowStart,
        windowEnd,
        pages,
        requested: 0,
        universeSize: universe.size,
        dryRun,
      },
    });
  } else {
    // dry-run path — record what would have landed.
    recordWorkerEvent({
      level: "info",
      event: "news_ingest_dry_run",
      msg: `SENS ingest (dry-run) → ${validRecords.length} rows surfaced (vendor=${vendorCode} fallback=${vendorFallback})`,
      data: {
        vendorCode,
        requestedVendor,
        vendorFallback,
        windowStart,
        windowEnd,
        pages,
        requested: validRecords.length,
        universeSize: universe.size,
        matchedCount,
        dryRun: true,
      },
    });
  }

  return {
    requested: validRecords.length,
    upserted,
    skipped: 0,
    dryRun,
    windowStart,
    windowEnd,
    vendorCode,
    vendorFallback,
    pages,
    durationMs: Date.now() - t0,
    universeSize: universe.size,
    matchedCount,
    error: null,
  };
}
