/**
 * GET /api/news
 *
 * Real SA financial news, merged from three real sources:
 *   1. Live public RSS (Moneyweb, BusinessTech) — always fetched.
 *   2. The retail `News_articles` table (Alliance News wire) when configured.
 *   3. The institutional `news_item_c` table — JSE SENS announcements
 *      persisted by the worker via `NewsHeadlineGet` (vendor `SENSD`,
 *      see `wealth-navigator/docs/SENS_NEWSHEADLINE_WIRE.md`).
 *
 * Items carry `category` `"WIRE"` for RSS / Alliance, and `"SENS"` for
 * IRESS-persisted JSE SENS rows. RSS / Alliance is NOT presented as
 * official SENS regulatory announcements.
 *
 * `?category=SENS` returns only the institutional `news_item_c` rows
 * (when the table is populated) — the historical blocked-vendor guard
 * was removed 2026-07-20 once `NewsHeadlineGet` (vendor `SENSD`) was
 * confirmed working and the worker persistence leg was wired.
 */
import { XMLParser } from "fast-xml-parser";

import { isUseSupabaseQuotesEnabled } from "@/lib/data-policy";
import {
  createInstitutionalServiceRoleClient,
  createRetailServiceRoleClient,
  isInstitutionalSupabaseConfigured,
  isRetailSupabaseConfigured,
} from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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

interface NewsRow {
  id: string;
  source: string | null;
  title: string;
  body_text: string | null;
  published_at: string;
  companies: string[] | null;
}

interface SensRow {
  item_id: string;
  source: string | null;
  category: string | null;
  severity: string | null;
  ticker: string | null;
  headline: string;
  body: string | null;
  url: string | null;
  published_at: string;
  payload: { tickers?: string[] } | null;
}

const RSS_FEEDS: Array<{ url: string; publisher: string }> = [
  { url: "https://www.moneyweb.co.za/feed/", publisher: "Moneyweb" },
  { url: "https://businesstech.co.za/news/feed/", publisher: "BusinessTech" },
];

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_" });

function stripHtml(s: string): string {
  return s
    .replace(/<[^>]*>/g, "")
    .replace(/&[a-z#0-9]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function wireToItem(r: NewsRow): NewsItem {
  const tickers = Array.isArray(r.companies) ? r.companies.filter(Boolean) : [];
  return {
    id: r.id,
    source: r.source ?? "Wire",
    category: "WIRE",
    severity: "low",
    ticker: tickers[0] ?? null,
    issuer: null,
    headline: stripHtml(r.title),
    // Alliance News wire bodies routinely contain embedded HTML tables (e.g.
    // "Global economic events calendar"), which previously rendered as raw
    // markup in the preview instead of readable text — `stripHtml` handles
    // that. Full text is returned uncapped; list-card callers apply their
    // own CSS line-clamp for a short preview, and the "full read" dialog
    // (PR #147) shows the whole thing.
    body: r.body_text ? stripHtml(r.body_text) : null,
    url: null,
    publishedAt: r.published_at,
    ts: new Date(r.published_at).getTime(),
    priority: "low",
    tickers,
  };
}

function sensRowToItem(r: SensRow): NewsItem {
  const tickers = Array.isArray(r.payload?.tickers) ? (r.payload as { tickers: string[] }).tickers.filter(Boolean) : [];
  const source = (r.source ?? "SENSD").toUpperCase();
  return {
    id: r.item_id,
    source,
    category: "SENS",
    severity: r.severity ?? "regulatory",
    ticker: r.ticker ?? tickers[0] ?? null,
    issuer: null,
    headline: stripHtml(r.headline),
    // Full SENS body text, uncapped — see the RSS/wire note above.
    body: r.body ? stripHtml(r.body) : null,
    url: r.url ?? null,
    publishedAt: r.published_at,
    ts: new Date(r.published_at).getTime(),
    priority: "high",
    tickers,
  };
}

async function fetchRss(url: string, publisher: string): Promise<NewsItem[]> {
  try {
    const r = await fetch(url, { next: { revalidate: 300 }, headers: { "User-Agent": "MintOEMS/1.0" } });
    if (!r.ok) return [];
    const doc = parser.parse(await r.text()) as { rss?: { channel?: { item?: unknown } } };
    const raw = doc?.rss?.channel?.item;
    const items = Array.isArray(raw) ? raw : raw ? [raw] : [];
    return items.slice(0, 15).map((it, idx) => {
      const i = it as Record<string, unknown>;
      const title = stripHtml(String(i.title ?? ""));
      const link = typeof i.link === "string" ? i.link : String(i.link ?? "");
      const pub = typeof i.pubDate === "string" ? Date.parse(i.pubDate) : Number.NaN;
      const ts = Number.isFinite(pub) ? pub : Date.now();
      return {
        id: `rss-${publisher}-${idx}-${link}`,
        source: publisher,
        category: "WIRE",
        severity: "low",
        ticker: null,
        issuer: null,
        headline: title,
        // Full RSS description, uncapped. Neither configured feed (Moneyweb,
        // BusinessTech) carries a `content:encoded` full-article field —
        // confirmed by inspecting both feeds' raw XML — so `description` is
        // the fullest text available here; list cards apply their own
        // CSS line-clamp, the "full read" dialog (PR #147) shows it all.
        body: typeof i.description === "string" ? stripHtml(i.description) : null,
        url: link,
        publishedAt: new Date(ts).toISOString(),
        ts,
        priority: "low",
        tickers: [],
      };
    });
  } catch {
    return [];
  }
}

/**
 * SENS-only read: pulls from the institutional `news_item_c` table
 * (populated by the worker `NewsHeadlineGet` loop). Returns an empty
 * array (with the right `source` reason) when the institutional client
 * isn't configured so the UI keeps the honest empty state.
 */
async function fetchSens(limit: number): Promise<{
  items: NewsItem[];
  source: string;
  reason?: string;
}> {
  if (!isUseSupabaseQuotesEnabled() || !isInstitutionalSupabaseConfigured()) {
    return {
      items: [],
      source: "unconfigured",
      reason: "institutional_supabase_not_configured",
    };
  }
  try {
    const supabase = createInstitutionalServiceRoleClient();
    const { data, error } = await supabase
      .from("news_item_c")
      .select("item_id, source, category, severity, ticker, headline, body, url, published_at, payload")
      .eq("category", "SENS")
      .order("published_at", { ascending: false })
      .limit(limit);
    if (error) {
      return { items: [], source: "error", reason: error.message };
    }
    const items = ((data ?? []) as SensRow[]).map(sensRowToItem);
    return { items, source: items.length ? "supabase" : "empty" };
  } catch (err) {
    return {
      items: [],
      source: "error",
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const limit = Math.min(Number(url.searchParams.get("limit") ?? 50), 200);
  const category = url.searchParams.get("category") ?? undefined;

  // SENS-only request → read straight from the institutional table.
  // The historical "blocked-vendor" guard was removed once the IRESS
  // NewsHeadlineGet + worker persistence path was confirmed working.
  if (category && category.toUpperCase() === "SENS") {
    const sens = await fetchSens(limit);
    return Response.json({
      items: sens.items,
      source: sens.source,
      count: sens.items.length,
      ...(sens.reason !== undefined ? { reason: sens.reason } : {}),
      message:
        sens.items.length === 0 && sens.source === "empty"
          ? "No SENS announcements persisted yet — worker needs `IRESS_NEWS_INGEST=1` enabled."
          : undefined,
    });
  }

  // 1) Live RSS — always (no Supabase dependency).
  const rssResults = await Promise.all(RSS_FEEDS.map((f) => fetchRss(f.url, f.publisher)));
  const rssItems = rssResults.flat();

  // 2) Retail Alliance wire — when configured.
  let wireItems: NewsItem[] = [];
  if (isUseSupabaseQuotesEnabled() && isRetailSupabaseConfigured()) {
    try {
      const supabase = createRetailServiceRoleClient();
      const { data } = await supabase
        .from("News_articles")
        .select("id, source, title, body_text, published_at, companies")
        .order("published_at", { ascending: false })
        .limit(limit);
      wireItems = ((data ?? []) as NewsRow[]).map(wireToItem);
    } catch {
      /* wire optional — RSS still carries the feed */
    }
  }

  // Merge, dedupe by headline, newest first.
  const seen = new Set<string>();
  const items = [...rssItems, ...wireItems]
    .filter((i) => i.headline && i.headline.length > 3)
    .sort((a, b) => b.ts - a.ts)
    .filter((i) => {
      const k = i.headline.toLowerCase().slice(0, 80);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .slice(0, limit);

  const source =
    rssItems.length && wireItems.length
      ? "rss+wire"
      : rssItems.length
        ? "rss"
        : wireItems.length
          ? "supabase"
          : "unavailable";
  return Response.json({
    items,
    count: items.length,
    source,
    sourceLabel: "Moneyweb · BusinessTech (RSS)" + (wireItems.length ? " + Alliance wire" : ""),
    reason: items.length === 0 ? "empty" : undefined,
  });
}
