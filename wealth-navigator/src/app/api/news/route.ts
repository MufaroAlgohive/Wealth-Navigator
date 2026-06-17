/**
 * GET /api/news
 *
 * Real SA financial news, merged from two real sources:
 *   1. Live public RSS (Moneyweb, BusinessTech) — always fetched, keeps the
 *      feed fresh. The official JSE SENS web feed is a paid subscription IRESS
 *      V4 doesn't expose, so this is the "real alternative source".
 *   2. The retail `News_articles` table (Alliance News wire) when configured.
 *
 * Items are tagged with their publisher and category "WIRE" — NOT presented as
 * official SENS regulatory announcements (a SENS-only request returns empty).
 * Server-side fetch + Next data cache (5 min) so upstreams are never hammered.
 */
import { XMLParser } from "fast-xml-parser";

import { createRetailServiceRoleClient, isRetailSupabaseConfigured } from "@/lib/supabase/server";
import { isUseSupabaseQuotesEnabled } from "@/lib/data-policy";

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

const RSS_FEEDS: Array<{ url: string; publisher: string }> = [
  { url: "https://www.moneyweb.co.za/feed/", publisher: "Moneyweb" },
  { url: "https://businesstech.co.za/news/feed/", publisher: "BusinessTech" },
];

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_" });

function stripHtml(s: string): string {
  return s.replace(/<[^>]*>/g, "").replace(/&[a-z#0-9]+;/gi, " ").replace(/\s+/g, " ").trim();
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
    headline: r.title,
    body: r.body_text ?? null,
    url: null,
    publishedAt: r.published_at,
    ts: new Date(r.published_at).getTime(),
    priority: "low",
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
      const pub = typeof i.pubDate === "string" ? Date.parse(i.pubDate) : NaN;
      const ts = Number.isFinite(pub) ? pub : Date.now();
      return {
        id: `rss-${publisher}-${idx}-${link}`,
        source: publisher,
        category: "WIRE",
        severity: "low",
        ticker: null,
        issuer: null,
        headline: title,
        body: typeof i.description === "string" ? stripHtml(i.description).slice(0, 200) : null,
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

export async function GET(req: Request) {
  const url = new URL(req.url);
  const limit = Math.min(Number(url.searchParams.get("limit") ?? 50), 200);
  const category = url.searchParams.get("category") ?? undefined;

  // SENS = official regulatory announcements (paid web feed); we have no data.
  if (category && category.toUpperCase() === "SENS") {
    return Response.json({ items: [], source: "unavailable", count: 0, reason: "empty" });
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

  const source = rssItems.length && wireItems.length ? "rss+wire" : rssItems.length ? "rss" : wireItems.length ? "supabase" : "unavailable";
  return Response.json({
    items,
    count: items.length,
    source,
    sourceLabel: "Moneyweb · BusinessTech (RSS)" + (wireItems.length ? " + Alliance wire" : ""),
    reason: items.length === 0 ? "empty" : undefined,
  });
}
