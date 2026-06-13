/**
 * READ-ONLY follow-up scan: real securities_c shape + symbol convention.
 * Run from wealth-navigator/:  bun run scripts/scan-retail2.ts
 */
import { createClient } from "@supabase/supabase-js";

const url = process.env.RETAIL_SUPABASE_URL;
const key = process.env.RETAIL_SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Missing RETAIL_SUPABASE_URL / RETAIL_SUPABASE_SERVICE_ROLE_KEY in .env.local");
  process.exit(1);
}
const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

async function main(): Promise<void> {
  const cnt = await db.from("securities_c").select("*", { count: "exact", head: true });
  const all = await db.from("securities_c").select("*").order("symbol");
  const rows = (all.data ?? []) as Array<Record<string, unknown>>;

  const fs = await import("node:fs/promises");
  await fs.writeFile("scripts/scan-securities.json", JSON.stringify(rows, null, 2));

  // Symbol convention probe: do retail symbols carry the .JO suffix or are they bare?
  const jo = await db.from("securities_c").select("symbol,name").in("symbol", ["MTN.JO", "STX40.JO", "NPN.JO", "SBK.JO", "CLS.JO"]);
  const bare = await db.from("securities_c").select("symbol,name").in("symbol", ["MTN", "STX40", "NPN", "SBK", "CLS"]);

  const summary = {
    securities_count: cnt.count,
    columns: rows[0] ? Object.keys(rows[0]) : [],
    first_30: rows.slice(0, 30).map((r) => ({ symbol: r.symbol, name: r.name, sector: r.sector, last_price: r.last_price })),
    symbol_probe_dotJO_found: (jo.data ?? []).map((r) => r.symbol),
    symbol_probe_bare_found: (bare.data ?? []).map((r) => r.symbol),
  };
  console.log(JSON.stringify(summary, null, 2));
  console.log("\n[scan-retail2] full securities → wealth-navigator/scripts/scan-securities.json");
}

main().catch((e) => {
  console.error("[scan-retail2] failed:", e instanceof Error ? e.message : e);
  process.exit(1);
});
