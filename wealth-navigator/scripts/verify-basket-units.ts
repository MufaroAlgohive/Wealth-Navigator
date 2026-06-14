/**
 * READ-ONLY: confirm the unit of client_strategy_returns_c.basket_value
 * by reconciling it against stock_holdings_c (qty * price) for one user.
 * Run from wealth-navigator/:  bun run scripts/verify-basket-units.ts
 */
import { createClient } from "@supabase/supabase-js";

const url = process.env.RETAIL_SUPABASE_URL;
const key = process.env.RETAIL_SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) { console.error("Missing RETAIL_SUPABASE_*"); process.exit(1); }
const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

async function main(): Promise<void> {
  // latest snapshot date
  const latest = await db.from("client_strategy_returns_c")
    .select("as_of_date").order("as_of_date", { ascending: false }).limit(1);
  const asOf = latest.data?.[0]?.as_of_date as string | undefined;
  console.log("latest as_of_date:", asOf);

  const rows = await db.from("client_strategy_returns_c")
    .select("user_id,family_member_id,strategy_id,basket_value")
    .eq("as_of_date", asOf);
  if (rows.error) { console.log("returns ERR:", rows.error.message); return; }
  console.log("returns rows:", rows.data?.length);
  for (const r of rows.data ?? []) {
    console.log("  return:", JSON.stringify(r));
  }

  // stock_holdings_c structure
  const hsample = await db.from("stock_holdings_c").select("*").limit(1);
  console.log("\nstock_holdings_c columns:",
    hsample.data?.[0] ? Object.keys(hsample.data[0]) : `ERR ${hsample.error?.message}`);
  console.log("stock_holdings_c sample:", JSON.stringify(hsample.data?.[0] ?? null, null, 2));

  // Reconcile for the first user that has holdings.
  const users = [...new Set((rows.data ?? []).map((r) => (r as { user_id: string }).user_id))];
  for (const uid of users) {
    const h = await db.from("stock_holdings_c").select("*").eq("user_id", uid).eq("is_active", true);
    if (h.error) { console.log(`holdings ERR for ${uid}:`, h.error.message); continue; }
    if (!h.data?.length) continue;
    console.log(`\n=== user ${uid}: ${h.data.length} active holdings ===`);
    let sumGuess = 0;
    for (const row of h.data) {
      const rec = row as Record<string, unknown>;
      console.log("   holding:", JSON.stringify(rec));
    }
    const basket = (rows.data ?? [])
      .filter((r) => (r as { user_id: string }).user_id === uid)
      .reduce((a, r) => a + (Number((r as { basket_value: number }).basket_value) || 0), 0);
    console.log(`   basket_value (sum for user) = ${basket}`);
    break; // one user is enough to read the unit
  }
}
main().catch((e) => console.error(e));
