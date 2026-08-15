import { createRetailServiceRoleClient } from "../src/lib/supabase/server";

const asOfDate = process.env.EOD_RETURN_RECOVERY_DATE;
if (!asOfDate || !/^\d{4}-\d{2}-\d{2}$/.test(asOfDate)) {
  throw new Error("EOD_RETURN_RECOVERY_DATE=YYYY-MM-DD is required");
}

const db = createRetailServiceRoleClient();
const { data: strategies, error: strategyError } = await db
  .from("strategies_c")
  .select("id, name")
  .neq("name", "Test Strategy");
if (strategyError) throw new Error(strategyError.message);

const strategyIds = (strategies ?? []).map((strategy) => strategy.id);
const { data: publications, error: publicationError } = await db
  .from("strategy_return_publication_audit_c")
  .select(
    "strategy_id, as_of_date, securities_value_cents, continuity_cash_cents, complete_value_cents, chain_factor, ytd_pct, composition_effective_from, checks, published_at",
  )
  .in("strategy_id", strategyIds)
  .eq("as_of_date", asOfDate);
if (publicationError) throw new Error(publicationError.message);

const strategyNames = new Map((strategies ?? []).map((strategy) => [strategy.id, strategy.name]));
const rows = (publications ?? [])
  .map((publication) => {
    const identityPassed =
      Number(publication.complete_value_cents) ===
      Number(publication.securities_value_cents) + Number(publication.continuity_cash_cents);
    return {
      strategy: strategyNames.get(publication.strategy_id) ?? publication.strategy_id,
      as_of_date: publication.as_of_date,
      securities_value_cents: publication.securities_value_cents,
      continuity_cash_cents: publication.continuity_cash_cents,
      complete_value_cents: publication.complete_value_cents,
      chain_factor: publication.chain_factor,
      ytd_pct: publication.ytd_pct,
      composition_effective_from: publication.composition_effective_from,
      checks: publication.checks,
      published_at: publication.published_at,
      complete_value_identity_passed: identityPassed,
    };
  })
  .sort((left, right) => left.strategy.localeCompare(right.strategy));

console.log(JSON.stringify({ as_of_date: asOfDate, row_count: rows.length, rows }, null, 2));
if (rows.some((row) => !row.complete_value_identity_passed)) process.exitCode = 1;
