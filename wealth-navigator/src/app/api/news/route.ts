/**
 * GET /api/news
 *
 * DB-first read of `news_item_c` (wire / SENS / regulatory news).
 * Empty in v1; the page renders the "News feed not configured" empty
 * state.
 */
import { createServiceRoleClient, isSupabaseConfigured } from "@/lib/supabase/server";
import { isUseSupabaseQuotesEnabled } from "@/lib/data-policy";
import { isSupabaseSchemaMissing, type BffUnavailableReason } from "@/lib/bff-reasons";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface NewsRow {
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
}

function mapRow(r: NewsRow) {
  return {
    id: r.item_id,
    source: r.source,
    category: r.category ?? "GENERAL",
    severity: r.severity ?? "low",
    ticker: r.ticker ?? null,
    issuer: r.issuer ?? null,
    headline: r.headline,
    body: r.body ?? null,
    url: r.url ?? null,
    publishedAt: r.published_at,
    ts: new Date(r.published_at).getTime(),
    priority: r.severity === "regulatory" || r.severity === "high" ? "high" : "low",
    tickers: r.ticker ? [r.ticker] : [],
  };
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const limit = Math.min(Number(url.searchParams.get("limit") ?? 50), 200);
  const category = url.searchParams.get("category") ?? undefined;

  if (!isUseSupabaseQuotesEnabled()) {
    return Response.json({ items: [], source: "unavailable", reason: "supabase_quotes_disabled" });
  }
  if (!isSupabaseConfigured()) {
    return Response.json(
      { items: [], source: "unavailable", reason: "supabase_not_configured" },
      { status: 503 },
    );
  }
  const supabase = createServiceRoleClient();
  let q = supabase.from("news_item_c").select("*").order("published_at", { ascending: false });
  if (category) q = q.eq("category", category);
  q = q.limit(limit);
  const { data, error } = await q;
  if (error) {
    return Response.json(
      {
        items: [],
        source: "unavailable",
        reason: "supabase_query_failed" as BffUnavailableReason,
        error: error.message,
        migration: isSupabaseSchemaMissing(error)
          ? "supabase/migrations/20260613000007_news_universe.sql"
          : undefined,
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
    message:
      items.length === 0
        ? "News + SENS feed requires a vendor contract (Reuters / Bloomberg / Moneyweb) or a SENS subscription. v1 returns an empty list."
        : undefined,
  });
}
