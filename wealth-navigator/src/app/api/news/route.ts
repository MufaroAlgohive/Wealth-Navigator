/**
 * GET /api/news
 *
 * DB-first read of the retail `News_articles` table (Alliance News wire feed,
 * ~4,800 rows) from the RETAIL prod DB. Maps the wire schema to the NewsItem
 * shape the UI expects.
 *
 * NOTE: this is editorial / wire news — NOT JSE SENS regulatory announcements
 * (which require a separate SENS subscription). Everything here is tagged
 * category "WIRE", so a SENS-only tab stays empty until a SENS feed lands.
 */
import { createRetailServiceRoleClient, isRetailSupabaseConfigured } from "@/lib/supabase/server";
import { isUseSupabaseQuotesEnabled } from "@/lib/data-policy";
import { type BffUnavailableReason } from "@/lib/bff-reasons";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface NewsRow {
  id: string;
  source: string | null;
  title: string;
  body_text: string | null;
  published_at: string;
  companies: string[] | null;
}

function mapRow(r: NewsRow) {
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

export async function GET(req: Request) {
  const url = new URL(req.url);
  const limit = Math.min(Number(url.searchParams.get("limit") ?? 50), 200);
  const category = url.searchParams.get("category") ?? undefined;

  if (!isUseSupabaseQuotesEnabled()) {
    return Response.json({ items: [], source: "unavailable", reason: "supabase_quotes_disabled" });
  }
  if (!isRetailSupabaseConfigured()) {
    return Response.json(
      { items: [], source: "unavailable", reason: "supabase_not_configured" },
      { status: 503 },
    );
  }
  // These are wire articles only — a SENS-specific request has no data yet.
  if (category && category.toUpperCase() === "SENS") {
    return Response.json({ items: [], source: "unavailable", count: 0, reason: "empty" });
  }

  const supabase = createRetailServiceRoleClient();
  const { data, error } = await supabase
    .from("News_articles")
    .select("id, source, title, body_text, published_at, companies")
    .order("published_at", { ascending: false })
    .limit(limit);
  if (error) {
    return Response.json(
      {
        items: [],
        source: "unavailable",
        reason: "supabase_query_failed" as BffUnavailableReason,
        error: error.message,
      },
      { status: 200 },
    );
  }
  const items = ((data ?? []) as NewsRow[]).map(mapRow);
  return Response.json({
    items,
    source: items.length > 0 ? "supabase" : "unavailable",
    count: items.length,
    reason: items.length === 0 ? "empty" : undefined,
  });
}
