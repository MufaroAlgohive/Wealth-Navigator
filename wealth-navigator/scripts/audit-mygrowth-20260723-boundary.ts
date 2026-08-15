import { createHash } from "node:crypto";

import { createRetailServiceRoleClient } from "../src/lib/supabase/server";

const STRATEGY_NAME = "MyGrowthFund";
const BATCH_ID = "414ccb97-c3b4-4992-b0f2-e7a0515f11ed";
const BOUNDARY_DATE = "2026-07-23";
const db = createRetailServiceRoleClient();

type Holding = { ticker: string; units: number };

function bare(symbol: string): string {
  return symbol.trim().toUpperCase().replace(/\.(JO|JSE)$/i, "");
}

function parseHoldings(value: unknown): Holding[] {
  return (Array.isArray(value) ? value : [])
    .map((row) => ({
      ticker: bare(String(row.ticker ?? row.symbol ?? "")),
      units: Number(row.quantity ?? row.shares ?? 0),
    }))
    .filter((row) => row.ticker && row.units > 0);
}

async function one<T>(
  label: string,
  query: PromiseLike<{ data: T | null; error: { message: string } | null }>,
): Promise<T> {
  const { data, error } = await query;
  if (error) throw new Error(`${label}: ${error.message}`);
  if (!data) throw new Error(`${label}: no row`);
  return data;
}

async function many<T>(
  label: string,
  query: PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
): Promise<T[]> {
  const { data, error } = await query;
  if (error) throw new Error(`${label}: ${error.message}`);
  return data ?? [];
}

const strategy = await one<{ id: string; name: string }>(
  "MyGrowth strategy",
  db.from("strategies_c").select("id,name").eq("name", STRATEGY_NAME).maybeSingle(),
);
const batch = await one<{
  id: string;
  strategy_id: string;
  status: string;
  settlement_state: string;
  effective_date: string;
  created_by: string | null;
  settled_by: string | null;
  holdings_snapshot_before: unknown;
  holdings_snapshot_after: unknown;
}>(
  "23 July batch",
  db
    .from("rebalance_batch")
    .select("id,strategy_id,status,settlement_state,effective_date,created_by,settled_by,holdings_snapshot_before,holdings_snapshot_after")
    .eq("id", BATCH_ID)
    .maybeSingle(),
);
if (
  batch.strategy_id !== strategy.id ||
  batch.status !== "SETTLED" ||
  batch.settlement_state !== "COMPLETE" ||
  batch.effective_date !== BOUNDARY_DATE
) {
  throw new Error("target is not the expected COMPLETE settled MyGrowth boundary");
}
const reconciliationActor = batch.settled_by ?? batch.created_by;
if (!reconciliationActor) throw new Error("boundary has no authoritative actor for reconciliation evidence");

const [events, cashEvents, reserveEvents, existingReconciliations, laterReconciliations] = await Promise.all([
  many<{
    user_id: string;
    family_member_id: string | null;
    security_id: string;
    trade_side: "BUY" | "SELL";
    quantity: number;
    avg_fill: number;
    fill_date: string;
  }>(
    "boundary fills",
    db
      .from("rebalance_event")
      .select("user_id,family_member_id,security_id,trade_side,quantity,avg_fill,fill_date")
      .eq("batch_id", BATCH_ID),
  ),
  many<{
    user_id: string;
    family_member_id: string | null;
    event_type: string;
    opening_balance_cents: number;
    amount_cents: number;
    closing_balance_cents: number;
  }>(
    "boundary cash events",
    db
      .from("strategy_rebalance_cash_events_c")
      .select("user_id,family_member_id,event_type,opening_balance_cents,amount_cents,closing_balance_cents")
      .eq("batch_id", BATCH_ID),
  ),
  many<{
    user_id: string;
    family_member_id: string | null;
    requested_cents: number;
    consumed_cents: number;
    shortfall_cents: number;
    reserve_before_cents: number;
    reserve_after_cents: number;
  }>(
    "boundary reserve events",
    db
      .from("strategy_rebalance_reserve_events_c")
      .select("user_id,family_member_id,requested_cents,consumed_cents,shortfall_cents,reserve_before_cents,reserve_after_cents")
      .eq("batch_id", BATCH_ID),
  ),
  many<Record<string, unknown>>(
    "existing boundary reconciliation",
    db.from("strategy_rebalance_ca_reconciliation_c").select("*").eq("batch_id", BATCH_ID),
  ),
  many<{
    batch_id: string;
    strategy_ca_cents: number;
    reconciled_at: string;
  }>(
    "later CA reconciliations",
    db
      .from("strategy_rebalance_ca_reconciliation_c")
      .select("batch_id,strategy_ca_cents,reconciled_at")
      .eq("strategy_id", strategy.id)
      .order("reconciled_at"),
  ),
]);
if (existingReconciliations.length > 1) throw new Error("boundary has duplicate CA reconciliations");
if (events.length === 0 || events.some((row) => row.fill_date !== BOUNDARY_DATE || !(Number(row.avg_fill) > 0))) {
  throw new Error("boundary fills are incomplete or not dated 23 July");
}

const securityIds = [...new Set(events.map((row) => row.security_id))];
const securities = await many<{ id: string; symbol: string }>(
  "event securities",
  db.from("securities_c").select("id,symbol").in("id", securityIds),
);
const tickerBySecurity = new Map(securities.map((row) => [row.id, bare(row.symbol)]));

const before = parseHoldings(batch.holdings_snapshot_before);
const after = parseHoldings(batch.holdings_snapshot_after);
const beforeUnits = new Map(before.map((row) => [row.ticker, row.units] as const));
const afterUnits = new Map(after.map((row) => [row.ticker, row.units] as const));
const allTickers = [...new Set([...beforeUnits.keys(), ...afterUnits.keys()])];
const expectedDelta = new Map(
  allTickers.map((ticker) => [ticker, (afterUnits.get(ticker) ?? 0) - (beforeUnits.get(ticker) ?? 0)] as const),
);

const ownerKey = (userId: string, familyMemberId: string | null) =>
  `${userId}:${familyMemberId ?? "self"}`;
const eventOwners = [...new Set(events.map((row) => ownerKey(row.user_id, row.family_member_id)))];
const cashOwners = new Set(cashEvents.map((row) => ownerKey(row.user_id, row.family_member_id)));
const reserveOwners = new Set(reserveEvents.map((row) => ownerKey(row.user_id, row.family_member_id)));
if (
  eventOwners.length !== 2 ||
  cashOwners.size !== eventOwners.length ||
  reserveOwners.size !== eventOwners.length ||
  eventOwners.some((key) => !cashOwners.has(key) || !reserveOwners.has(key))
) {
  throw new Error("fill/cash/reserve owner sets do not match exactly");
}

const ownerChecks = eventOwners.map((key) => {
  const ownerEvents = events.filter((row) => ownerKey(row.user_id, row.family_member_id) === key);
  const cash = cashEvents.find((row) => ownerKey(row.user_id, row.family_member_id) === key)!;
  const reserve = reserveEvents.find((row) => ownerKey(row.user_id, row.family_member_id) === key)!;
  const actualDelta = new Map<string, number>();
  let sellProceedsCents = 0;
  let buyCostCents = 0;
  for (const event of ownerEvents) {
    const ticker = tickerBySecurity.get(event.security_id);
    if (!ticker) throw new Error(`unknown event security ${event.security_id}`);
    const signedQuantity = event.trade_side === "BUY" ? Number(event.quantity) : -Number(event.quantity);
    actualDelta.set(ticker, (actualDelta.get(ticker) ?? 0) + signedQuantity);
    const value = Math.round(Number(event.quantity) * Number(event.avg_fill));
    if (event.trade_side === "SELL") sellProceedsCents += value;
    else buyCostCents += value;
  }
  const deltaMatches = allTickers.every(
    (ticker) => (actualDelta.get(ticker) ?? 0) === (expectedDelta.get(ticker) ?? 0),
  );
  const grossResidualCents = sellProceedsCents - buyCostCents;
  const expectedCashCents = grossResidualCents - Number(reserve.shortfall_cents);
  const cashIdentity =
    cash.event_type === "REBALANCE_RESIDUAL" &&
    Number(cash.amount_cents) === expectedCashCents &&
    Number(cash.closing_balance_cents) === Number(cash.opening_balance_cents) + Number(cash.amount_cents);
  const reserveIdentity =
    Number(reserve.requested_cents) === Number(reserve.consumed_cents) + Number(reserve.shortfall_cents) &&
    Number(reserve.reserve_after_cents) === Number(reserve.reserve_before_cents) - Number(reserve.consumed_cents);
  return {
    owner_key: key,
    delta_matches_model: deltaMatches,
    sell_proceeds_cents: sellProceedsCents,
    buy_cost_cents: buyCostCents,
    gross_residual_cents: grossResidualCents,
    residual_credited_cents: Number(cash.amount_cents),
    fee_requested_cents: Number(reserve.requested_cents),
    reserve_consumed_cents: Number(reserve.consumed_cents),
    fee_shortfall_cents: Number(reserve.shortfall_cents),
    cash_identity_passes: cashIdentity,
    reserve_identity_passes: reserveIdentity,
  };
});
if (
  ownerChecks.some(
    (row) => !row.delta_matches_model || !row.cash_identity_passes || !row.reserve_identity_passes,
  )
) {
  throw new Error(`owner accounting identity failed: ${JSON.stringify(ownerChecks)}`);
}

const afterTickers = after.map((row) => row.ticker);
const closes = await many<{
  symbol: string;
  as_of_date: string;
  current_price: number;
  fetched_at: string;
}>(
  "exact boundary closes",
  db
    .from("stock_returns_c")
    .select("symbol,as_of_date,current_price,fetched_at")
    .in("symbol", afterTickers.flatMap((ticker) => [ticker, `${ticker}.JO`]))
    .eq("as_of_date", BOUNDARY_DATE)
    .order("fetched_at"),
);
const latestClose = new Map<string, { cents: number; fetched_at: string }>();
for (const row of closes) {
  if (Number(row.current_price) > 0) {
    latestClose.set(bare(row.symbol), {
      cents: Number(row.current_price),
      fetched_at: row.fetched_at,
    });
  }
}
if (afterTickers.some((ticker) => !latestClose.has(ticker))) {
  throw new Error(`missing exact boundary close(s): ${afterTickers.filter((ticker) => !latestClose.has(ticker)).join(",")}`);
}
const modelLegs = after.map((holding) => ({
  ticker: holding.ticker,
  units: holding.units,
  close_cents: latestClose.get(holding.ticker)!.cents,
  market_value_cents: holding.units * latestClose.get(holding.ticker)!.cents,
  fetched_at: latestClose.get(holding.ticker)!.fetched_at,
}));
const securitiesValueCents = modelLegs.reduce((sum, row) => sum + row.market_value_cents, 0);

const subsequentZeroCa = laterReconciliations.find(
  (row) => row.reconciled_at.slice(0, 10) > BOUNDARY_DATE && Number(row.strategy_ca_cents) === 0,
);
if (!subsequentZeroCa) throw new Error("no subsequent authoritative zero-CA checkpoint");

const checks = {
  audit_version: "MYGROWTH_20260723_HISTORICAL_REPAIR_V1",
  boundary_date: BOUNDARY_DATE,
  model_delta: Object.fromEntries(expectedDelta),
  event_owner_count: eventOwners.length,
  owner_checks: ownerChecks,
  all_execution_surplus_credited_to_owner_residual: true,
  all_rebalance_fees_funded_by_execution_reserve: ownerChecks.every((row) => row.fee_shortfall_cents === 0),
  explicit_model_cash_leg_present: false,
  subsequent_zero_ca_checkpoint: subsequentZeroCa,
  exact_close_model_legs: modelLegs,
  derivation: "CA is zero; owner residual and execution reserve are not public model CA",
};
const evidenceHash = createHash("sha256").update(JSON.stringify(checks)).digest("hex");
const candidate = {
  batch_id: BATCH_ID,
  strategy_id: strategy.id,
  model_capital_cents: securitiesValueCents,
  securities_value_cents: securitiesValueCents,
  strategy_ca_cents: 0,
  affected_owner_count: eventOwners.length,
  reconciled_owner_count: eventOwners.length,
  capital_source: "HISTORICAL_FULL_RESIDUAL_DISTRIBUTION+EXACT_STORED_EOD_CLOSE",
  reconciled_by: reconciliationActor,
  checks: { ...checks, evidence_sha256: evidenceHash },
};

console.log(JSON.stringify({
  generated_at: new Date().toISOString(),
  mode: "READ_ONLY_NO_WRITES",
  existing_reconciliation: existingReconciliations[0] ?? null,
  repair_supported: true,
  candidate,
}, null, 2));
