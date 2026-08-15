import {
  createInstitutionalServiceRoleClient,
  createRetailServiceRoleClient,
  isInstitutionalSupabaseConfigured,
} from "../src/lib/supabase/server";

const TARGETS = ["MINT Diversified Basket", "MINT Multi-sector"];
const db = createRetailServiceRoleClient();

const read = async <T>(label: string, query: PromiseLike<{ data: T | null; error: { message: string } | null }>) => {
  const { data, error } = await query;
  if (error) throw new Error(`${label}: ${error.message}`);
  return data;
};

const strategies =
  (await read(
    "strategies",
    db.from("strategies_c").select("id, name").in("name", TARGETS),
  )) ?? [];
const strategyIds = strategies.map((strategy) => strategy.id);

const [compositions, batches] = await Promise.all([
  read(
    "composition logs",
    db
      .from("strategy_composition_log_c")
      .select("strategy_id, effective_from, effective_to, holdings, created_at")
      .in("strategy_id", strategyIds)
      .order("effective_from"),
  ),
  read(
    "rebalance batches",
    db
      .from("rebalance_batch")
      .select(
        "id, strategy_id, status, settlement_state, effective_date, settled_at, created_at, sell_security_id, buy_security_id, extra_buy_security_id, total_sell_quantity, total_buy_quantity, total_extra_buy_quantity, net_proceeds, strategy_name_snapshot, holdings_snapshot_before, holdings_snapshot_after, holdings_snapshot_planned",
      )
      .in("strategy_id", strategyIds)
      .order("effective_date"),
  ),
]);

const batchIds = (batches ?? []).map((batch) => batch.id);
const [events, cashEvents, reserveEvents, reconciliations] = batchIds.length
  ? await Promise.all([
      read(
        "rebalance events",
        db
          .from("rebalance_event")
          .select("id, batch_id, security_id, trade_side, quantity, price_at_commit, avg_fill, fill_date, created_at")
          .in("batch_id", batchIds),
      ),
      read(
        "rebalance cash events",
        db
          .from("strategy_rebalance_cash_events_c")
          .select("batch_id, event_type, amount_cents, opening_balance_cents, closing_balance_cents, effective_at")
          .in("batch_id", batchIds),
      ),
      read(
        "rebalance reserve events",
        db
          .from("strategy_rebalance_reserve_events_c")
          .select("batch_id, requested_cents, consumed_cents, shortfall_cents, reserve_before_cents, reserve_after_cents, effective_at")
          .in("batch_id", batchIds),
      ),
      read(
        "rebalance reconciliations",
        db
          .from("strategy_rebalance_ca_reconciliation_c")
          .select("batch_id, strategy_id, model_capital_cents, securities_value_cents, strategy_ca_cents, affected_owner_count, reconciled_owner_count, capital_source, checks, reconciled_at")
          .in("batch_id", batchIds),
      ),
    ])
  : [[], [], [], []];

const names = new Map(strategies.map((strategy) => [strategy.id, strategy.name]));
const report = strategies.map((strategy) => {
  const strategyBatches = (batches ?? []).filter((batch) => batch.strategy_id === strategy.id);
  const ids = new Set(strategyBatches.map((batch) => batch.id));
  return {
    strategy: strategy.name,
    compositions: (compositions ?? []).filter((row) => row.strategy_id === strategy.id),
    batches: strategyBatches,
    events: (events ?? []).filter((row) => ids.has(row.batch_id)),
    cash_events: (cashEvents ?? []).filter((row) => ids.has(row.batch_id)),
    reserve_events: (reserveEvents ?? []).filter((row) => ids.has(row.batch_id)),
    reconciliations: (reconciliations ?? []).filter((row) => ids.has(row.batch_id)),
  };
});

let institutionalEvidence: unknown = { available: false };
if (isInstitutionalSupabaseConfigured()) {
  const institutional = createInstitutionalServiceRoleClient();
  const orders =
    (await read(
      "institutional order audit",
      institutional
        .from("oems_order_audit")
        .select("order_id, symbol, side, quantity, price_cents, status, source, payload, created_at, updated_at")
        .in("symbol", ["GRT", "GRT.JO", "NY1", "NY1.JO"])
        .order("created_at"),
    )) ?? [];
  const orderIds = orders.map((order) => order.order_id);
  const settlements = orderIds.length
    ? ((await read(
        "institutional fill settlement",
        institutional
          .from("oems_fill_settlement_c")
          .select("order_id, symbol, side, settled_qty, settled_cash_rands, holding_ids, last_error, first_settled_at, last_settled_at")
          .in("order_id", orderIds),
      )) ?? [])
    : [];
  institutionalEvidence = { available: true, orders, settlements };
}

console.log(
  JSON.stringify(
    {
      generated_at: new Date().toISOString(),
      target_count: TARGETS.length,
      found_count: strategies.length,
      unknown_strategy_ids: strategyIds.filter((id) => !names.has(id)),
      report,
      institutional_evidence: institutionalEvidence,
    },
    null,
    2,
  ),
);
