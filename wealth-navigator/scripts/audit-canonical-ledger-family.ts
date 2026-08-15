import { createRetailServiceRoleClient } from "../src/lib/supabase/server";

const db = createRetailServiceRoleClient();

async function rows<T>(label: string, query: PromiseLike<{ data: T | null; error: { message: string } | null }>) {
  const { data, error } = await query;
  if (error) throw new Error(`${label}: ${error.message}`);
  return data ?? [];
}

const strategies = await rows(
  "active strategies",
  db
    .from("strategies_c")
    .select("id, name, created_at, status")
    .eq("status", "active")
    .neq("name", "Test Strategy")
    .order("name"),
);
const ids = strategies.map((strategy) => strategy.id);
const [compositions, batches, ledger, publications, rules] = await Promise.all([
  rows(
    "composition logs",
    db
      .from("strategy_composition_log_c")
      .select("strategy_id, effective_from, effective_to")
      .in("strategy_id", ids)
      .order("effective_from"),
  ),
  rows(
    "rebalance batches",
    db
      .from("rebalance_batch")
      .select("strategy_id, id, status, settlement_state, effective_date, settled_at")
      .in("strategy_id", ids),
  ),
  rows(
    "canonical ledger",
    db
      .from("strategy_canonical_daily_ledger_c")
      .select("strategy_id, as_of_date, certification_status, ledger_version")
      .in("strategy_id", ids)
      .order("as_of_date"),
  ),
  rows(
    "guarded publications",
    db
      .from("strategy_return_publication_audit_c")
      .select("strategy_id, as_of_date, complete_value_cents, ytd_pct")
      .in("strategy_id", ids)
      .order("as_of_date"),
  ),
  rows(
    "valuation rules",
    db
      .from("strategy_valuation_rules_c")
      .select("strategy_id, effective_from, status, methodology_version")
      .in("strategy_id", ids)
      .eq("status", "ACTIVE"),
  ),
]);

const report = strategies.map((strategy) => {
  const ownCompositions = compositions.filter((row) => row.strategy_id === strategy.id);
  const ownBatches = batches.filter((row) => row.strategy_id === strategy.id);
  const ownLedger = ledger.filter((row) => row.strategy_id === strategy.id);
  const ownPublications = publications.filter((row) => row.strategy_id === strategy.id);
  const ownRule = rules.find((row) => row.strategy_id === strategy.id) ?? null;
  const staticCandidate = ownCompositions.length === 1 && ownBatches.length === 0;
  return {
    strategy: strategy.name,
    created_at: strategy.created_at,
    composition_count: ownCompositions.length,
    composition_dates: ownCompositions.map((row) => row.effective_from),
    rebalance_batch_count: ownBatches.length,
    settled_batch_count: ownBatches.filter(
      (row) => row.status === "SETTLED" && row.settlement_state === "COMPLETE",
    ).length,
    canonical_row_count: ownLedger.length,
    canonical_statuses: [...new Set(ownLedger.map((row) => row.certification_status))],
    canonical_first_date: ownLedger.at(0)?.as_of_date ?? null,
    canonical_last_date: ownLedger.at(-1)?.as_of_date ?? null,
    active_rule: ownRule,
    latest_guarded_publication: ownPublications.at(-1) ?? null,
    classification: staticCandidate ? "STATIC_DRAFT_CANDIDATE" : "EVIDENCE_DEPENDENT",
  };
});

console.log(JSON.stringify({ generated_at: new Date().toISOString(), report }, null, 2));
