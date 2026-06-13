/**
 * READ-ONLY scan of the RETAIL prod DB (mfxng…) for the linking plan.
 *
 * Reads RETAIL_SUPABASE_URL / RETAIL_SUPABASE_SERVICE_ROLE_KEY from the
 * environment. Bun auto-loads `wealth-navigator/.env.local`, so add the two
 * vars there (gitignored) — never paste the key into chat or commit it.
 *
 * SELECT-only. Reads the market / strategy / reference tables in full, and
 * AGGREGATE COUNTS ONLY on `profiles` (no customer identities / PII rows).
 * Performs NO writes.
 *
 * Run from the wealth-navigator/ folder:
 *   bun run scripts/scan-retail.ts
 */
import { createClient } from "@supabase/supabase-js";

const url = process.env.RETAIL_SUPABASE_URL;
const key = process.env.RETAIL_SUPABASE_SERVICE_ROLE_KEY;

if (!url || !key) {
  console.error(
    "[scan-retail] Missing RETAIL_SUPABASE_URL / RETAIL_SUPABASE_SERVICE_ROLE_KEY.\n" +
      "Add them to wealth-navigator/.env.local (gitignored), then re-run.",
  );
  process.exit(1);
}

const db = createClient(url, key, {
  auth: { persistSession: false, autoRefreshToken: false },
});

async function main(): Promise<void> {
  const out: Record<string, unknown> = {};

  // securities_c — full instrument universe (no PII)
  const sec = await db
    .from("securities_c")
    .select("symbol,name,sector,asset_type,last_price,ytd_start_price")
    .order("symbol");
  out.securities_error = sec.error?.message ?? null;
  out.securities_count = sec.data?.length ?? null;
  out.securities = sec.data ?? [];

  // strategies_c — model-portfolio catalogue + holdings JSON (no PII)
  const strat = await db
    .from("strategies_c")
    .select("id,name,risk_level,min_investment,holdings")
    .order("name");
  out.strategies_error = strat.error?.message ?? null;
  out.strategies = strat.data ?? [];

  // strategy_metrics — latest snapshots
  const met = await db
    .from("strategy_metrics")
    .select("strategy_id,as_of_date,last_close,r_ytd,r_1m")
    .order("as_of_date", { ascending: false })
    .limit(50);
  out.strategy_metrics_error = met.error?.message ?? null;
  out.strategy_metrics_latest = met.data ?? [];

  // stock_intraday_c — count + freshness + recent ticks
  // (answers "is something already writing prices, and how recently?")
  const icount = await db
    .from("stock_intraday_c")
    .select("*", { count: "exact", head: true });
  out.intraday_error = icount.error?.message ?? null;
  out.intraday_rows = icount.count ?? null;
  const newest = await db
    .from("stock_intraday_c")
    .select("security_id,timestamp")
    .order("timestamp", { ascending: false })
    .limit(20);
  out.intraday_recent = newest.data ?? [];
  const oldest = await db
    .from("stock_intraday_c")
    .select("timestamp")
    .order("timestamp", { ascending: true })
    .limit(1);
  out.intraday_earliest = oldest.data?.[0]?.timestamp ?? null;

  // profiles — AGGREGATE COUNTS ONLY (head:true returns no rows → no PII)
  const ptotal = await db.from("profiles").select("*", { count: "exact", head: true });
  out.profiles_error = ptotal.error?.message ?? null;
  out.profiles_total = ptotal.count ?? null;
  const pmint = await db
    .from("profiles")
    .select("*", { count: "exact", head: true })
    .not("mint_number", "is", null);
  out.profiles_with_mint_number = pmint.count ?? null;

  const fs = await import("node:fs/promises");
  await fs.writeFile("scripts/scan-output.json", JSON.stringify(out, null, 2));

  const securities = (out.securities as Array<Record<string, unknown>>) ?? [];
  const strategies = (out.strategies as Array<Record<string, unknown>>) ?? [];
  const summary = {
    securities_count: out.securities_count,
    securities_error: out.securities_error,
    sectors: Array.from(new Set(securities.map((s) => s.sector))).sort(),
    asset_types: Array.from(new Set(securities.map((s) => s.asset_type))).sort(),
    securities_sample: securities.slice(0, 40).map((s) => ({
      symbol: s.symbol,
      name: s.name,
      sector: s.sector,
      type: s.asset_type,
      last_price: s.last_price,
    })),
    strategies_count: strategies.length,
    strategies_error: out.strategies_error,
    strategies: strategies.map((s) => ({
      name: s.name,
      risk_level: s.risk_level,
      min_investment: s.min_investment,
      holdings_preview: JSON.stringify(s.holdings).slice(0, 400),
    })),
    strategy_metrics_count: (out.strategy_metrics_latest as unknown[])?.length ?? 0,
    strategy_metrics_error: out.strategy_metrics_error,
    intraday_rows: out.intraday_rows,
    intraday_earliest: out.intraday_earliest,
    intraday_recent_first5: (out.intraday_recent as unknown[])?.slice(0, 5),
    intraday_error: out.intraday_error,
    profiles_total: out.profiles_total,
    profiles_with_mint_number: out.profiles_with_mint_number,
    profiles_error: out.profiles_error,
  };
  console.log(JSON.stringify(summary, null, 2));
  console.log("\n[scan-retail] full detail → wealth-navigator/scripts/scan-output.json");
}

main().catch((e) => {
  console.error("[scan-retail] failed:", e instanceof Error ? e.message : e);
  process.exit(1);
});
