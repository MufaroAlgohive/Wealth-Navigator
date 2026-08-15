import { createRetailServiceRoleClient } from "../src/lib/supabase/server";

const TARGETS = ["MyGrowthFund", "MINT Diversified Basket"];
const db = createRetailServiceRoleClient();

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
  investor_environment: string | null;
}>(
  "strategies",
  db
    .from("strategies_c")
    .select("id,name,created_at,investor_environment")
    .in("name", TARGETS),
);
const strategyIds = strategies.map((strategy) => strategy.id);

const [batches, holdings, compositions] = await Promise.all([
  many<Record<string, unknown>>(
    "rebalance batches",
    db
      .from("rebalance_batch")
      .select(
        "id,strategy_id,status,settlement_state,effective_date,created_at,settled_at,family_member_id,holdings_snapshot_before,holdings_snapshot_after,holdings_snapshot_planned,pending_swap_snapshot,net_proceeds",
      )
      .in("strategy_id", strategyIds)
      .order("created_at"),
  ),
  many<{
    id: string;
    user_id: string;
    family_member_id: string | null;
    strategy_id: string | null;
    security_id: string;
    quantity: number | null;
    is_active: boolean;
    trade_side: string;
    transaction_id: string | null;
    rebalance_batch_id: string | null;
    created_at: string;
    Fill_date: string | null;
  }>(
    "holdings",
    db
      .from("stock_holdings_c")
      .select(
        'id,user_id,family_member_id,strategy_id,security_id,quantity,is_active,trade_side,transaction_id,rebalance_batch_id,created_at,"Fill_date"',
      )
      .in("strategy_id", strategyIds)
      .order("created_at"),
  ),
  many<Record<string, unknown>>(
    "composition history",
    db
      .from("strategy_composition_log_c")
      .select("strategy_id,effective_from,effective_to,holdings,created_at")
      .in("strategy_id", strategyIds)
      .order("effective_from"),
  ),
]);

const batchIds = batches.map((batch) => String(batch.id));
const [events, cashEvents, reserveEvents, reconciliations, residuals] = await Promise.all([
  batchIds.length
    ? many<Record<string, unknown>>(
        "rebalance events",
        db
          .from("rebalance_event")
          .select(
            "id,batch_id,user_id,family_member_id,security_id,trade_side,quantity,price_at_commit,avg_fill,fill_date,created_at",
          )
          .in("batch_id", batchIds)
          .order("created_at"),
      )
    : [],
  batchIds.length
    ? many<Record<string, unknown>>(
        "cash events",
        db
          .from("strategy_rebalance_cash_events_c")
          .select("batch_id,strategy_id,user_id,family_member_id,event_type,opening_balance_cents,amount_cents,closing_balance_cents,effective_at")
          .in("batch_id", batchIds)
          .order("effective_at"),
      )
    : [],
  batchIds.length
    ? many<Record<string, unknown>>(
        "reserve events",
        db
          .from("strategy_rebalance_reserve_events_c")
          .select("batch_id,strategy_id,user_id,family_member_id,requested_cents,consumed_cents,shortfall_cents,reserve_before_cents,reserve_after_cents,effective_at")
          .in("batch_id", batchIds)
          .order("effective_at"),
      )
    : [],
  batchIds.length
    ? many<Record<string, unknown>>(
        "CA reconciliations",
        db
          .from("strategy_rebalance_ca_reconciliation_c")
          .select("batch_id,strategy_id,model_capital_cents,securities_value_cents,strategy_ca_cents,affected_owner_count,reconciled_owner_count,capital_source,reconciled_at")
          .in("batch_id", batchIds)
          .order("reconciled_at"),
      )
    : [],
  many<Record<string, unknown>>(
    "residual balances",
    db
      .from("strategy_rebalance_residuals")
      .select("user_id,family_member_id,strategy_id,balance_cents,updated_at")
      .in("strategy_id", strategyIds),
  ),
]);

const userIds = [
  ...new Set([
    ...holdings.map((row) => row.user_id),
    ...events.map((row) => String(row.user_id)),
  ].filter(Boolean)),
];
const familyIds = [
  ...new Set([
    ...holdings.map((row) => row.family_member_id),
    ...events.map((row) => (row.family_member_id ? String(row.family_member_id) : null)),
  ].filter((id): id is string => Boolean(id))),
];
const securityIds = [
  ...new Set([
    ...holdings.map((row) => row.security_id),
    ...events.map((row) => String(row.security_id)),
  ].filter(Boolean)),
];
const [profiles, familyMembers, securities] = await Promise.all([
  userIds.length
    ? many<{ id: string; first_name: string | null; last_name: string | null; email: string | null; mint_number: string | null }>(
        "profiles",
        db.from("profiles").select("id,first_name,last_name,email,mint_number").in("id", userIds),
      )
    : [],
  familyIds.length
    ? many<{ id: string; first_name: string | null; last_name: string | null; mint_number: string | null; primary_user_id: string | null }>(
        "family members",
        db
          .from("family_members")
          .select("id,first_name,last_name,mint_number,primary_user_id")
          .in("id", familyIds),
      )
    : [],
  securityIds.length
    ? many<{ id: string; symbol: string; name: string | null }>(
        "securities",
        db.from("securities_c").select("id,symbol,name").in("id", securityIds),
      )
    : [],
]);

const profileById = new Map(profiles.map((row) => [row.id, row]));
const familyById = new Map(familyMembers.map((row) => [row.id, row]));
const securityById = new Map(securities.map((row) => [row.id, row]));
const ownerLabel = (userId: string, familyMemberId: string | null) => {
  if (familyMemberId) {
    const member = familyById.get(familyMemberId);
    return member
      ? `${member.first_name ?? ""} ${member.last_name ?? ""}`.trim() || member.mint_number || familyMemberId
      : familyMemberId;
  }
  const profile = profileById.get(userId);
  return profile
    ? `${profile.first_name ?? ""} ${profile.last_name ?? ""}`.trim() || profile.email || profile.mint_number || userId
    : userId;
};

const report = strategies.map((strategy) => {
  const ownBatches = batches.filter((row) => row.strategy_id === strategy.id);
  const ownBatchIds = new Set(ownBatches.map((row) => String(row.id)));
  const ownHoldings = holdings.filter((row) => row.strategy_id === strategy.id);
  const ownEvents = events
    .filter((row) => ownBatchIds.has(String(row.batch_id)))
    .map((row) => ({
      ...row,
      owner: ownerLabel(String(row.user_id), row.family_member_id ? String(row.family_member_id) : null),
      security: securityById.get(String(row.security_id)) ?? row.security_id,
    })) as Array<Record<string, unknown> & {
      batch_id: unknown;
      user_id: unknown;
      family_member_id: unknown;
      trade_side: unknown;
      quantity: unknown;
      fill_date: unknown;
      owner: string;
      security: unknown;
    }>;
  const owners = new Map<string, Record<string, unknown>>();
  for (const holding of ownHoldings) {
    const key = `${holding.user_id}|${holding.family_member_id ?? ""}`;
    const owner = owners.get(key) ?? {
      user_id: holding.user_id,
      family_member_id: holding.family_member_id,
      owner: ownerLabel(holding.user_id, holding.family_member_id),
      active_holdings: [],
      inactive_holdings: [],
      event_count: ownEvents.filter(
        (event) =>
          event.user_id === holding.user_id &&
          (event.family_member_id ?? null) === (holding.family_member_id ?? null),
      ).length,
    };
    const line = {
      id: holding.id,
      security: securityById.get(holding.security_id) ?? holding.security_id,
      quantity: holding.quantity,
      trade_side: holding.trade_side,
      transaction_id: holding.transaction_id,
      rebalance_batch_id: holding.rebalance_batch_id,
      created_at: holding.created_at,
      fill_date: holding.Fill_date,
    };
    (owner[holding.is_active ? "active_holdings" : "inactive_holdings"] as unknown[]).push(line);
    owners.set(key, owner);
  }
  return {
    strategy,
    composition_history: compositions.filter((row) => row.strategy_id === strategy.id),
    batches: ownBatches,
    owners: [...owners.values()],
    events: ownEvents,
    cash_events: cashEvents.filter((row) => row.strategy_id === strategy.id),
    reserve_events: reserveEvents.filter((row) => row.strategy_id === strategy.id),
    ca_reconciliations: reconciliations.filter((row) => row.strategy_id === strategy.id),
    residuals: residuals.filter((row) => row.strategy_id === strategy.id),
    evidence_summary: {
      current_owner_count: owners.size,
      batch_count: ownBatches.length,
      event_count: ownEvents.length,
      family_scoped_event_count: ownEvents.filter((row) => row.family_member_id).length,
      holdings_linked_to_batch_count: ownHoldings.filter((row) => row.rebalance_batch_id).length,
    },
  };
});

const summaryOnly = process.env.AUDIT_SUMMARY_ONLY === "1";
const output = summaryOnly
  ? report.map((strategy) => ({
      strategy: strategy.strategy.name,
      evidence_summary: strategy.evidence_summary,
      batches: strategy.batches.map((batch) => ({
        id: batch.id,
        effective_date: batch.effective_date,
        status: batch.status,
        settlement_state: batch.settlement_state,
      })),
      owners: strategy.owners.map((owner) => ({
        owner: owner.owner,
        user_id: owner.user_id,
        family_member_id: owner.family_member_id,
        event_count: owner.event_count,
        active: (owner.active_holdings as Array<Record<string, unknown>>).map((holding) => ({
          symbol: (holding.security as { symbol?: string } | undefined)?.symbol,
          quantity: holding.quantity,
          fill_date: holding.fill_date,
          rebalance_batch_id: holding.rebalance_batch_id,
        })),
      })),
      events: strategy.events.map((event) => ({
        batch_id: event.batch_id,
        owner: event.owner,
        side: event.trade_side,
        symbol: (event.security as { symbol?: string } | undefined)?.symbol,
        quantity: event.quantity,
        fill_date: event.fill_date,
      })),
      ca_reconciliations: strategy.ca_reconciliations,
    }))
  : report;

console.log(JSON.stringify({ generated_at: new Date().toISOString(), report: output }, null, 2));
