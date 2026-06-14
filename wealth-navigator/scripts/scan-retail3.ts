/**
 * READ-ONLY: confirm which retail tables are populated for the panels we can
 * serve without IRESS (fundamentals, movers, sector heatmap, news, client book).
 * Run from wealth-navigator/:  bun run scripts/scan-retail3.ts
 */
import { createClient } from "@supabase/supabase-js";

const url = process.env.RETAIL_SUPABASE_URL;
const key = process.env.RETAIL_SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Missing RETAIL_SUPABASE_* in .env.local");
  process.exit(1);
}
const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

type Mod = (q: ReturnType<ReturnType<typeof db.from>["select"]>) => unknown;
async function count(table: string, mod?: Mod): Promise<number | string> {
  const q = db.from(table).select("*", { count: "exact", head: true });
  if (mod) mod(q);
  const r = await q;
  return r.error ? `ERR ${r.error.message}` : (r.count ?? 0);
}

async function main(): Promise<void> {
  const out: Record<string, unknown> = {};
  out.securities_total = await count("securities_c");
  out.securities_change_pct_populated = await count("securities_c", (q) => q.not("change_percent", "is", null));
  out.securities_pe_populated = await count("securities_c", (q) => q.not("pe", "is", null));
  out.news_articles = await count("News_articles");
  out.stock_holdings = await count("stock_holdings_c");
  out.stock_holdings_active = await count("stock_holdings_c", (q) => q.eq("is_active", true));
  out.client_strategy_returns = await count("client_strategy_returns_c");
  out.strategies_returns = await count("strategies_returns_c");
  out.stock_returns = await count("stock_returns_c");

  const news = await db.from("News_articles").select("title,category,published_at").order("published_at", { ascending: false }).limit(3);
  out.recent_news = news.error ? `ERR ${news.error.message}` : news.data;

  const sectors = await db.from("securities_c").select("sector");
  out.distinct_sectors = sectors.error
    ? `ERR ${sectors.error.message}`
    : Array.from(new Set((sectors.data ?? []).map((r) => (r as { sector: string | null }).sector))).filter(Boolean).sort();

  console.log(JSON.stringify(out, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
