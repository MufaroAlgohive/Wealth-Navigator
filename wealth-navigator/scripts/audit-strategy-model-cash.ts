import { createRetailServiceRoleClient } from "../src/lib/supabase/server";

const db = createRetailServiceRoleClient();

async function one<T>(
  label: string,
  query: PromiseLike<{ data: T | null; error: { message: string } | null }>,
): Promise<T | null> {
  const { data, error } = await query;
  if (error) throw new Error(`${label}: ${error.message}`);
  return data ?? null;
}

async function many<T>(
  label: string,
  query: PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
): Promise<T[]> {
  const { data, error } = await query;
  if (error) throw new Error(`${label}: ${error.message}`);
  return data ?? [];
}

const strategies = await many<{
  id: string;
  name: string;
  created_at: string;
  holdings: unknown;
}>(
  "active strategies",
  db
    .from("strategies_c")
    .select("id,name,created_at,holdings")
    .eq("status", "active")
    .neq("name", "Test Strategy")
    .order("name"),
);

const report = [];
for (const strategy of strategies) {
  const [composition, rule, ledger, publication, reconciliation] = await Promise.all([
    one<Record<string, unknown>>(
      `${strategy.name} composition`,
      db
        .from("strategy_composition_log_c")
        .select("effective_from,effective_to,holdings,created_at")
        .eq("strategy_id", strategy.id)
        .is("effective_to", null)
        .order("effective_from", { ascending: false })
        .limit(1)
        .maybeSingle(),
    ),
    one<Record<string, unknown>>(
      `${strategy.name} ACTIVE valuation rule`,
      db
        .from("strategy_valuation_rules_c")
        .select("effective_from,status,securities_value_per_lot_cents,continuity_cash_per_lot_cents,complete_value_per_lot_cents,methodology_version,source_evidence,approved_at")
        .eq("strategy_id", strategy.id)
        .eq("status", "ACTIVE")
        .order("effective_from", { ascending: false })
        .limit(1)
        .maybeSingle(),
    ),
    one<Record<string, unknown>>(
      `${strategy.name} canonical ledger`,
      db
        .from("strategy_canonical_daily_ledger_c")
        .select("as_of_date,certification_status,securities_value_cents,continuity_cash_cents,complete_value_cents,ledger_version,source_evidence")
        .eq("strategy_id", strategy.id)
        .order("as_of_date", { ascending: false })
        .limit(1)
        .maybeSingle(),
    ),
    one<Record<string, unknown>>(
      `${strategy.name} guarded publication`,
      db
        .from("strategy_return_publication_audit_c")
        .select("as_of_date,securities_value_cents,continuity_cash_cents,complete_value_cents,published_at,checks")
        .eq("strategy_id", strategy.id)
        .order("as_of_date", { ascending: false })
        .limit(1)
        .maybeSingle(),
    ),
    one<Record<string, unknown>>(
      `${strategy.name} latest CA reconciliation`,
      db
        .from("strategy_rebalance_ca_reconciliation_c")
        .select("batch_id,model_capital_cents,securities_value_cents,strategy_ca_cents,capital_source,reconciled_at")
        .eq("strategy_id", strategy.id)
        .order("reconciled_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
    ),
  ]);

  const currentHoldings = (composition?.holdings ?? strategy.holdings) as unknown;
  const explicitCashLegs = Array.isArray(currentHoldings)
    ? currentHoldings.filter((holding) => {
        if (!holding || typeof holding !== "object") return false;
        const row = holding as Record<string, unknown>;
        const symbol = String(row.symbol ?? row.ticker ?? row.name ?? "").toUpperCase();
        return symbol === "CASH" || symbol.includes("CASH ASSET");
      })
    : [];

  report.push({
    strategy: strategy.name,
    strategy_id: strategy.id,
    current_composition_effective_from: composition?.effective_from ?? null,
    explicit_cash_legs: explicitCashLegs,
    active_rule: rule
      ? {
          effective_from: rule.effective_from,
          cash_cents: rule.continuity_cash_per_lot_cents,
          complete_value_cents: rule.complete_value_per_lot_cents,
          methodology_version: rule.methodology_version,
          approved_at: rule.approved_at,
        }
      : null,
    latest_canonical_ledger: ledger
      ? {
          as_of_date: ledger.as_of_date,
          certification_status: ledger.certification_status,
          cash_cents: ledger.continuity_cash_cents,
          complete_value_cents: ledger.complete_value_cents,
          ledger_version: ledger.ledger_version,
        }
      : null,
    latest_guarded_publication: publication
      ? {
          as_of_date: publication.as_of_date,
          cash_cents: publication.continuity_cash_cents,
          complete_value_cents: publication.complete_value_cents,
          published_at: publication.published_at,
        }
      : null,
    latest_rebalance_ca_reconciliation: reconciliation,
  });
}

console.log(JSON.stringify({ generated_at: new Date().toISOString(), report }, null, 2));
