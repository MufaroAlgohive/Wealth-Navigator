/**
 * READ-ONLY: real columns + recent rows of retail News_articles.
 * Run from wealth-navigator/:  bun run scripts/scan-news.ts
 */
import { createClient } from "@supabase/supabase-js";

const url = process.env.RETAIL_SUPABASE_URL;
const key = process.env.RETAIL_SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Missing RETAIL_SUPABASE_* in .env.local");
  process.exit(1);
}
const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

async function main(): Promise<void> {
  const sample = await db.from("News_articles").select("*").limit(3);
  if (sample.error) {
    console.error("News_articles read failed:", sample.error.message);
    return;
  }
  const rows = sample.data ?? [];
  console.log("columns:", rows[0] ? Object.keys(rows[0]) : "(no rows)");
  console.log("sample:", JSON.stringify(rows, null, 2).slice(0, 1500));
  const cnt = await db.from("News_articles").select("*", { count: "exact", head: true });
  console.log("count:", cnt.count);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
