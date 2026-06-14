/**
 * READ-ONLY: diagnose why /api/client-book returns unavailable.
 * Run from wealth-navigator/:  bun run scripts/scan-clientbook.ts
 */
import { createClient } from "@supabase/supabase-js";

const url = process.env.RETAIL_SUPABASE_URL;
const key = process.env.RETAIL_SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) { console.error("Missing RETAIL_SUPABASE_*"); process.exit(1); }
const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

async function main(): Promise<void> {
  const sample = await db.from("client_strategy_returns_c").select("*").limit(2);
  console.log("columns:", sample.data?.[0] ? Object.keys(sample.data[0]) : `ERR ${sample.error?.message}`);
  console.log("sample row:", JSON.stringify(sample.data?.[0] ?? null, null, 2));

  const latest = await db.from("client_strategy_returns_c").select("as_of_date").order("as_of_date", { ascending: false }).limit(1);
  console.log("latest as_of_date:", latest.data?.[0]?.as_of_date ?? `ERR ${latest.error?.message}`);

  // Try the exact select the route uses (quoted digit-leading cols):
  const probe = await db.from("client_strategy_returns_c").select('user_id,basket_value,"1d_pnl","ytd_pnl",as_of_date').limit(2);
  console.log("route-style select error:", probe.error?.message ?? "OK", "rows:", probe.data?.length);

  const d = latest.data?.[0]?.as_of_date;
  if (d) {
    const rows = await db.from("client_strategy_returns_c").select("user_id,basket_value").eq("as_of_date", d);
    if (rows.error) { console.log("latest-date rows ERR:", rows.error.message); }
    else {
      const aum = (rows.data ?? []).reduce((a, r) => a + (Number((r as { basket_value: number }).basket_value) || 0), 0);
      const users = new Set((rows.data ?? []).map((r) => (r as { user_id: string }).user_id)).size;
      console.log(`latest-date rows: ${rows.data?.length}  AUM(Rands)=${aum}  distinctUsers=${users}`);
    }
  }
  const sh = await db.from("stock_holdings_c").select("*", { count: "exact", head: true }).eq("is_active", true);
  console.log("active holdings:", sh.count ?? `ERR ${sh.error?.message}`);
}
main().catch((e) => console.error(e));
