import { createRetailServiceRoleClient } from "../src/lib/supabase/server";

type HoldingSpec = { symbol?: string; quantity?: number; shares?: number };
type Strategy = { id: string; name: string; holdings: HoldingSpec[] | null };
type Rule = {
  strategy_id: string;
  effective_from: string;
  continuity_cash_per_lot_cents: number;
};
type Composition = {
  strategy_id: string;
  effective_from: string;
  effective_to: string | null;
  holdings: HoldingSpec[] | null;
};
type Holding = {
  id: string;
  transaction_id: string;
  strategy_id: string;
  user_id: string;
  family_member_id: string | null;
  security_id: string;
  quantity: number;
  is_active: boolean | null;
  Status: string | null;
  created_at: string;
};
type Transaction = {
  id: string;
  user_id: string;
  family_member_id: string | null;
  direction: string;
  status: string;
  reversed: boolean | null;
  base_amount_cents: number | null;
  buffer_cents: number | null;
  buffer_consumed_cents: number | null;
  transaction_date: string | null;
  created_at: string;
  strategy_id: string | null;
  strategy_model_lots: number | null;
  strategy_model_cash_cents: number | null;
  model_cash_allocated_at: string | null;
};

const db = createRetailServiceRoleClient();

async function many<T>(
  label: string,
  query: PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
): Promise<T[]> {
  const { data, error } = await query;
  if (error) throw new Error(`${label}: ${error.message}`);
  return data ?? [];
}

const ruleRows = await many<Rule>(
  "non-zero ACTIVE model cash rules",
  db
    .from("strategy_valuation_rules_c")
    .select("strategy_id,effective_from,continuity_cash_per_lot_cents")
    .eq("status", "ACTIVE")
    .gt("continuity_cash_per_lot_cents", 0),
);
const candidateStrategyIds = [...new Set(ruleRows.map((row) => row.strategy_id))];

const [strategies, compositions, holdings, residuals] = await Promise.all([
  many<Strategy>(
    "strategies",
    db.from("strategies_c").select("id,name,holdings").in("id", candidateStrategyIds),
  ),
  many<Composition>(
    "composition history",
    db
      .from("strategy_composition_log_c")
      .select("strategy_id,effective_from,effective_to,holdings")
      .in("strategy_id", candidateStrategyIds)
      .order("effective_from"),
  ),
  many<Holding>(
    "transaction-linked holdings",
    db
      .from("stock_holdings_c")
      .select("id,transaction_id,strategy_id,user_id,family_member_id,security_id,quantity,is_active,Status,created_at")
      .in("strategy_id", candidateStrategyIds)
      .not("transaction_id", "is", null),
  ),
  many<{
    user_id: string;
    family_member_id: string | null;
    strategy_id: string;
    balance_cents: number;
  }>(
    "strategy residual balances",
    db
      .from("strategy_rebalance_residuals")
      .select("user_id,family_member_id,strategy_id,balance_cents")
      .in("strategy_id", candidateStrategyIds),
  ),
]);

// Historical UAT/Test Strategy books are deliberately outside the public
// strategy-cash repair. They remain available to the rebalance test workflow,
// but can never become a live backfill candidate through this audit.
const eligibleStrategyIds = new Set(
  strategies.filter((row) => row.name !== "Test Strategy").map((row) => row.id),
);
const rules = ruleRows.filter((row) => eligibleStrategyIds.has(row.strategy_id));
const strategyIds = [...eligibleStrategyIds];

const transactionIds = [...new Set(holdings.map((row) => row.transaction_id))];
const securityIds = [...new Set(holdings.map((row) => row.security_id))];
const userIds = [...new Set(holdings.map((row) => row.user_id))];
const familyIds = [
  ...new Set(holdings.map((row) => row.family_member_id).filter((id): id is string => Boolean(id))),
];

const [transactions, securities, profiles, familyMembers] = await Promise.all([
  transactionIds.length
    ? many<Transaction>(
        "purchase transactions",
        db
          .from("transactions")
          .select(
            "id,user_id,family_member_id,direction,status,reversed,base_amount_cents,buffer_cents,buffer_consumed_cents,transaction_date,created_at,strategy_id,strategy_model_lots,strategy_model_cash_cents,model_cash_allocated_at",
          )
          .in("id", transactionIds),
      )
    : [],
  securityIds.length
    ? many<{ id: string; symbol: string }>(
        "securities",
        db.from("securities_c").select("id,symbol").in("id", securityIds),
      )
    : [],
  userIds.length
    ? many<{
        id: string;
        first_name: string | null;
        last_name: string | null;
        email: string | null;
        mint_number: string | null;
        is_test: boolean | null;
      }>(
        "profiles",
        db
          .from("profiles")
          .select("id,first_name,last_name,email,mint_number,is_test")
          .in("id", userIds),
      )
    : [],
  familyIds.length
    ? many<{
        id: string;
        first_name: string | null;
        last_name: string | null;
        mint_number: string | null;
        primary_user_id: string | null;
      }>(
        "family members",
        db
          .from("family_members")
          .select("id,first_name,last_name,mint_number,primary_user_id")
          .in("id", familyIds),
      )
    : [],
]);

const strategyById = new Map(strategies.map((row) => [row.id, row]));
const ruleByStrategy = new Map(rules.map((row) => [row.strategy_id, row]));
const securityById = new Map(securities.map((row) => [row.id, row.symbol]));
const transactionById = new Map(transactions.map((row) => [String(row.id), row]));
const profileById = new Map(profiles.map((row) => [row.id, row]));
const familyById = new Map(familyMembers.map((row) => [row.id, row]));

const ownerKey = (userId: string, familyMemberId: string | null) =>
  `${userId}:${familyMemberId ?? "self"}`;
const residualByOwnerStrategy = new Map(
  residuals.map((row) => [
    `${ownerKey(row.user_id, row.family_member_id)}:${row.strategy_id}`,
    Number(row.balance_cents || 0),
  ]),
);

const ownerIdentity = (userId: string, familyMemberId: string | null) => {
  if (familyMemberId) {
    const member = familyById.get(familyMemberId);
    return {
      label:
        `${member?.first_name ?? ""} ${member?.last_name ?? ""}`.trim() ||
        member?.mint_number ||
        familyMemberId,
      email: profileById.get(userId)?.email ?? null,
      mint_number: member?.mint_number ?? null,
      profile_is_test: profileById.get(userId)?.is_test ?? null,
    };
  }
  const profile = profileById.get(userId);
  return {
    label:
      `${profile?.first_name ?? ""} ${profile?.last_name ?? ""}`.trim() ||
      profile?.email ||
      profile?.mint_number ||
      userId,
    email: profile?.email ?? null,
    mint_number: profile?.mint_number ?? null,
    profile_is_test: profile?.is_test ?? null,
  };
};

const modelAt = (strategy: Strategy, when: string): HoldingSpec[] => {
  const date = when.slice(0, 10);
  const intervals = compositions
    .filter((row) => row.strategy_id === strategy.id)
    .filter(
      (row) =>
        row.effective_from <= date &&
        (row.effective_to === null || row.effective_to >= date),
    )
    .sort((a, b) => b.effective_from.localeCompare(a.effective_from));
  return intervals[0]?.holdings ?? strategy.holdings ?? [];
};

const grouped = new Map<string, Holding[]>();
for (const row of holdings) {
  if (row.is_active === false || String(row.Status ?? "").toLowerCase() !== "active") continue;
  const key = `${row.transaction_id}:${row.strategy_id}:${ownerKey(row.user_id, row.family_member_id)}`;
  const rows = grouped.get(key) ?? [];
  rows.push(row);
  grouped.set(key, rows);
}

const auditRows = [];
for (const rows of grouped.values()) {
  const first = rows[0];
  const strategy = strategyById.get(first.strategy_id);
  const rule = ruleByStrategy.get(first.strategy_id);
  const tx = transactionById.get(String(first.transaction_id));
  if (!strategy || !rule || !tx) continue;

  const txAt = tx.transaction_date ?? tx.created_at;
  if (txAt.slice(0, 10) < rule.effective_from) continue;

  const model = modelAt(strategy, txAt);
  const modelBySymbol = new Map(
    model
      .map((row) => [
        String(row.symbol ?? "").toUpperCase(),
        Math.floor(Number(row.quantity ?? row.shares ?? 0)),
      ] as const)
      .filter(([symbol, quantity]) => Boolean(symbol) && quantity > 0),
  );
  const actualBySymbol = new Map<string, number>();
  for (const row of rows) {
    const symbol = String(securityById.get(row.security_id) ?? "").toUpperCase();
    actualBySymbol.set(symbol, (actualBySymbol.get(symbol) ?? 0) + Number(row.quantity || 0));
  }

  const ratios = [...modelBySymbol.entries()].map(([symbol, modelQuantity]) => ({
    symbol,
    model_quantity: modelQuantity,
    actual_quantity: actualBySymbol.get(symbol) ?? 0,
    ratio: (actualBySymbol.get(symbol) ?? 0) / modelQuantity,
  }));
  const extraSymbols = [...actualBySymbol.keys()].filter((symbol) => !modelBySymbol.has(symbol));
  const firstRatio = ratios[0]?.ratio ?? 0;
  const exactLots =
    ratios.length > 0 &&
    extraSymbols.length === 0 &&
    Number.isInteger(firstRatio) &&
    firstRatio > 0 &&
    ratios.every((row) => row.ratio === firstRatio)
      ? firstRatio
      : null;
  const expectedCashCents = exactLots === null
    ? null
    : exactLots * Number(rule.continuity_cash_per_lot_cents || 0);

  const identity = ownerIdentity(first.user_id, first.family_member_id);
  let classification = "AMBIGUOUS_MODEL_LOTS";
  if (tx.direction !== "debit" || tx.status !== "posted" || tx.reversed) {
    classification = "INELIGIBLE_TRANSACTION_STATE";
  } else if (tx.model_cash_allocated_at) {
    classification =
      Number(tx.strategy_model_lots) === exactLots &&
      Number(tx.strategy_model_cash_cents) === expectedCashCents
        ? "ALREADY_ALLOCATED_MATCH"
        : "ALLOCATED_MISMATCH_REVIEW";
  } else if (identity.profile_is_test === true) {
    classification = "EXCLUDED_TEST_PROFILE";
  } else if (exactLots !== null && Number(tx.base_amount_cents || 0) >= Number(expectedCashCents || 0)) {
    classification = "BACKFILL_CANDIDATE_REQUIRES_OWNER_APPROVAL";
  } else if (exactLots !== null) {
    classification = "INSUFFICIENT_BASE_AMOUNT_REVIEW";
  }

  auditRows.push({
    classification,
    strategy: strategy.name,
    strategy_id: strategy.id,
    transaction_id: String(tx.id),
    transaction_at: txAt,
    owner: identity,
    user_id: first.user_id,
    family_member_id: first.family_member_id,
    exact_model_lots: exactLots,
    cash_per_lot_cents: Number(rule.continuity_cash_per_lot_cents || 0),
    expected_model_cash_cents: expectedCashCents,
    current_owner_residual_cents:
      residualByOwnerStrategy.get(
        `${ownerKey(first.user_id, first.family_member_id)}:${strategy.id}`,
      ) ?? 0,
    transaction: {
      base_amount_cents: Number(tx.base_amount_cents || 0),
      execution_reserve_cents: Number(tx.buffer_cents || 0),
      execution_reserve_consumed_cents: Number(tx.buffer_consumed_cents || 0),
      recorded_strategy_id: tx.strategy_id,
      recorded_model_lots: tx.strategy_model_lots,
      recorded_model_cash_cents: tx.strategy_model_cash_cents,
      model_cash_allocated_at: tx.model_cash_allocated_at,
    },
    ratio_evidence: ratios,
    extra_symbols: extraSymbols,
  });
}

auditRows.sort((a, b) =>
  a.strategy.localeCompare(b.strategy) || a.transaction_at.localeCompare(b.transaction_at),
);
const classifications = auditRows.reduce<Record<string, number>>((out, row) => {
  out[row.classification] = (out[row.classification] ?? 0) + 1;
  return out;
}, {});

console.log(JSON.stringify({
  generated_at: new Date().toISOString(),
  mode: "READ_ONLY_NO_WRITES",
  rule_scope: rules,
  summary: {
    audited_purchase_groups: auditRows.length,
    classifications,
  },
  rows: auditRows,
}, null, 2));
