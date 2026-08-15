import { createHash } from "node:crypto";

import { createRetailServiceRoleClient } from "../src/lib/supabase/server";

const STRATEGY_NAME = "MyGrowthFund";
const ANCHOR_DATE = "2026-08-03";
const LEDGER_VERSION = "excel-segmented-post-ca-boundary-v1";
const apply = process.env.APPLY_CANONICAL_LEDGER_DRAFT === "1";
const replaceConflictingDraft = process.env.REPLACE_CONFLICTING_CANONICAL_DRAFT === "1";
const db = createRetailServiceRoleClient();

type Holding = { ticker: string; units: number };
type StoredClose = { symbol: string; as_of_date: string; current_price: number; fetched_at: string };

function iso(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function addDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return iso(value);
}

function addMonths(date: string, months: number): string {
  const value = new Date(`${date}T00:00:00.000Z`);
  const day = value.getUTCDate();
  value.setUTCDate(1);
  value.setUTCMonth(value.getUTCMonth() + months);
  const finalDay = new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth() + 1, 0)).getUTCDate();
  value.setUTCDate(Math.min(day, finalDay));
  return iso(value);
}

function previousWeekEnd(date: string): string {
  const value = new Date(`${date}T00:00:00.000Z`);
  const mondayOffset = (value.getUTCDay() + 6) % 7;
  value.setUTCDate(value.getUTCDate() - mondayOffset - 1);
  return iso(value);
}

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

async function fetchStoredCloses(symbols: string[], startDate: string, endDate: string) {
  const pageSize = 1000;
  const result: StoredClose[] = [];
  for (let offset = 0; ; offset += pageSize) {
    const page = await many<StoredClose>(
      `stored closes page ${offset / pageSize + 1}`,
      db
        .from("stock_returns_c")
        .select("symbol,as_of_date,current_price,fetched_at")
        .in("symbol", symbols)
        .gte("as_of_date", startDate)
        .lte("as_of_date", endDate)
        .order("as_of_date")
        .order("fetched_at")
        .range(offset, offset + pageSize - 1),
    );
    result.push(...page);
    if (page.length < pageSize) break;
  }
  return result;
}

const strategy = await one<{
  id: string;
  name: string;
  status: string;
  created_at: string;
}>(
  "MyGrowth strategy",
  db
    .from("strategies_c")
    .select("id,name,status,created_at")
    .eq("name", STRATEGY_NAME)
    .maybeSingle(),
);
if (strategy.status !== "active") throw new Error("MyGrowthFund is not active");

const [compositions, batches, reconciliations, rule, publications, existingRows] = await Promise.all([
  many<{
    effective_from: string;
    effective_to: string | null;
    holdings: unknown;
    created_at: string;
  }>(
    "composition history",
    db
      .from("strategy_composition_log_c")
      .select("effective_from,effective_to,holdings,created_at")
      .eq("strategy_id", strategy.id)
      .order("created_at"),
  ),
  many<{
    id: string;
    status: string;
    settlement_state: string;
    effective_date: string;
    created_at: string;
  }>(
    "rebalance batches",
    db
      .from("rebalance_batch")
      .select("id,status,settlement_state,effective_date,created_at")
      .eq("strategy_id", strategy.id)
      .order("created_at"),
  ),
  many<{
    batch_id: string;
    model_capital_cents: number;
    securities_value_cents: number;
    strategy_ca_cents: number;
    capital_source: string;
  }>(
    "CA reconciliations",
    db
      .from("strategy_rebalance_ca_reconciliation_c")
      .select("batch_id,model_capital_cents,securities_value_cents,strategy_ca_cents,capital_source")
      .eq("strategy_id", strategy.id),
  ),
  one<{
    effective_from: string;
    continuity_cash_per_lot_cents: number;
    complete_value_per_lot_cents: number;
    methodology_version: string;
  }>(
    "effective ACTIVE valuation rule",
    db
      .from("strategy_valuation_rules_c")
      .select("effective_from,continuity_cash_per_lot_cents,complete_value_per_lot_cents,methodology_version")
      .eq("strategy_id", strategy.id)
      .eq("status", "ACTIVE")
      .lte("effective_from", ANCHOR_DATE)
      .order("effective_from", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ),
  many<{
    as_of_date: string;
    securities_value_cents: number;
    continuity_cash_cents: number;
    complete_value_cents: number;
    ytd_pct: number;
  }>(
    "guarded publications",
    db
      .from("strategy_return_publication_audit_c")
      .select("as_of_date,securities_value_cents,continuity_cash_cents,complete_value_cents,ytd_pct")
      .eq("strategy_id", strategy.id)
      .gte("as_of_date", ANCHOR_DATE)
      .order("as_of_date"),
  ),
  many<{
    as_of_date: string;
    ledger_version: string;
    certification_status: string;
    securities_value_cents: number;
    continuity_cash_cents: number;
    complete_value_cents: number;
  }>(
    "existing canonical rows",
    db
      .from("strategy_canonical_daily_ledger_c")
      .select("as_of_date,ledger_version,certification_status,securities_value_cents,continuity_cash_cents,complete_value_cents")
      .eq("strategy_id", strategy.id)
      .gte("as_of_date", ANCHOR_DATE),
  ),
]);

const anchorBatches = batches.filter((row) => row.effective_date === ANCHOR_DATE);
if (
  anchorBatches.length !== 2 ||
  anchorBatches.some((row) => row.status !== "SETTLED" || row.settlement_state !== "COMPLETE")
) {
  throw new Error("expected exactly two COMPLETE settled MyGrowth boundaries on 2026-08-03");
}
const anchorBatchIds = new Set(anchorBatches.map((row) => row.id));
const anchorReconciliations = reconciliations.filter((row) => anchorBatchIds.has(row.batch_id));
if (anchorReconciliations.length !== 2) {
  throw new Error("both 2026-08-03 boundaries require CA reconciliations");
}
const finalReconciliation = anchorReconciliations
  .slice()
  .sort((a, b) =>
    anchorBatches.find((row) => row.id === a.batch_id)!.created_at.localeCompare(
      anchorBatches.find((row) => row.id === b.batch_id)!.created_at,
    ),
  )
  .at(-1)!;
const authoritativeCashCents = Number(finalReconciliation.strategy_ca_cents);
if (
  authoritativeCashCents !== Number(rule.continuity_cash_per_lot_cents) ||
  rule.effective_from !== ANCHOR_DATE
) {
  throw new Error("final boundary CA does not match the ACTIVE valuation rule");
}

const currentCompositions = compositions.filter(
  (row) => row.effective_from === ANCHOR_DATE && row.effective_to === null,
);
if (currentCompositions.length !== 1) {
  throw new Error("expected one final open MyGrowth composition at the anchor");
}
const holdings = parseHoldings(currentCompositions[0].holdings);
if (holdings.length !== 4) throw new Error(`expected four final holdings, got ${holdings.length}`);

const endDate = publications.at(-1)?.as_of_date;
if (!endDate) throw new Error("no guarded publication end date after the anchor");
const sessions = await many<{ trading_date: string }>(
  "JSE sessions",
  db
    .from("jse_trading_calendar")
    .select("trading_date")
    .eq("market", "JSE_EQUITIES")
    .eq("is_trading_day", true)
    .gte("trading_date", ANCHOR_DATE)
    .lte("trading_date", endDate)
    .order("trading_date"),
);
const dates = sessions.map((row) => row.trading_date);
if (dates[0] !== ANCHOR_DATE) throw new Error("anchor date is not the first expected JSE session");

const symbols = holdings.flatMap((row) => [row.ticker, `${row.ticker}.JO`]);
const prices = await fetchStoredCloses(symbols, addDays(ANCHOR_DATE, -14), endDate);
const priceByKey = new Map<string, { cents: number; fetchedAt: string }>();
for (const price of prices) {
  const cents = Number(price.current_price);
  if (cents > 0 && price.fetched_at) {
    priceByKey.set(`${price.as_of_date}:${bare(price.symbol)}`, {
      cents,
      fetchedAt: price.fetched_at,
    });
  }
}

const lastPrice = new Map<string, { cents: number; fetchedAt: string; asOfDate: string }>();
for (const date of [...new Set(prices.map((row) => row.as_of_date))].sort()) {
  if (date >= ANCHOR_DATE) break;
  for (const holding of holdings) {
    const exact = priceByKey.get(`${date}:${holding.ticker}`);
    if (exact) lastPrice.set(holding.ticker, { ...exact, asOfDate: date });
  }
}

let carryForwardLegCount = 0;
const missing: string[] = [];
const navRows = dates.map((date) => {
  const legs = holdings.map((holding) => {
    const exact = priceByKey.get(`${date}:${holding.ticker}`);
    if (exact) lastPrice.set(holding.ticker, { ...exact, asOfDate: date });
    const price = exact ? { ...exact, asOfDate: date } : lastPrice.get(holding.ticker);
    if (!price) missing.push(`${date}:${holding.ticker}`);
    if (!exact && price) carryForwardLegCount += 1;
    return {
      ticker: holding.ticker,
      units: holding.units,
      close_cents: price?.cents ?? 0,
      market_value_cents: holding.units * (price?.cents ?? 0),
      price_as_of_date: price?.asOfDate ?? null,
      price_fetched_at: price?.fetchedAt ?? null,
      source: exact ? "STORED_EOD_CLOSE" : "STORED_PRIOR_CLOSE_CARRY_FORWARD",
    };
  });
  const securitiesCents = legs.reduce((sum, row) => sum + row.market_value_cents, 0);
  return {
    date,
    legs,
    securitiesCents,
    completeCents: securitiesCents + authoritativeCashCents,
  };
});
if (missing.length > 0) throw new Error(`missing stored closes: ${missing.join(", ")}`);

function rowOnOrBefore(target: string, currentIndex: number) {
  for (let index = currentIndex; index >= 0; index -= 1) {
    if (navRows[index].date <= target) return navRows[index];
  }
  return null;
}

function metric(currentIndex: number, requestedReferenceDate: string) {
  const current = navRows[currentIndex];
  const basis = rowOnOrBefore(requestedReferenceDate, currentIndex);
  if (!basis) {
    return {
      requested_reference_date: requestedReferenceDate,
      reference_date: null,
      numerator_cents: null,
      denominator_cents: null,
      return_pct: null,
      certification_block: "REFERENCE_PRECEDES_PROVEN_2026_08_03_CA_BOUNDARY",
    };
  }
  const numerator = current.completeCents - basis.completeCents;
  return {
    requested_reference_date: requestedReferenceDate,
    reference_date: basis.date,
    numerator_cents: numerator,
    denominator_cents: basis.completeCents,
    return_pct: basis.completeCents > 0 ? (numerator / basis.completeCents) * 100 : null,
    certification_block: null,
  };
}

const sourceEvidence = {
  strategy: STRATEGY_NAME,
  anchor_date: ANCHOR_DATE,
  anchor_batch_ids: [...anchorBatchIds],
  anchor_ca_reconciliations: anchorReconciliations,
  final_model_ca_cents: authoritativeCashCents,
  final_composition_created_at: currentCompositions[0].created_at,
  unresolved_prior_boundary: {
    effective_date: "2026-07-23",
    reason: "NO_MODEL_CA_RECONCILIATION",
    effect: "period metrics crossing this boundary remain null and uncertified",
  },
  owner_exception_excluded_from_model: "Ncumolwethu 5 STXACW vs public model 4",
  price_source: "stock_returns_c exact JSE-session close with prior-close carry-forward",
  carry_forward_leg_count: carryForwardLegCount,
  public_visibility: "DRAFT_NOT_EXPOSED",
};
const sourceEvidenceHash = createHash("sha256").update(JSON.stringify(sourceEvidence)).digest("hex");
const ledgerRows = navRows.map((current, index) => ({
  strategy_id: strategy.id,
  as_of_date: current.date,
  ledger_version: LEDGER_VERSION,
  certification_status: "DRAFT",
  securities_value_cents: current.securitiesCents,
  continuity_cash_cents: authoritativeCashCents,
  complete_value_cents: current.completeCents,
  leg_snapshot: current.legs,
  period_metrics: {
    "1D": metric(index, addDays(current.date, -1)),
    "1W": metric(index, addDays(current.date, -7)),
    WTD: metric(index, previousWeekEnd(current.date)),
    "1M": metric(index, addMonths(current.date, -1)),
    "3M": metric(index, addMonths(current.date, -3)),
    YTD: metric(index, `${Number(current.date.slice(0, 4)) - 1}-12-31`),
    SI: metric(index, strategy.created_at.slice(0, 10)),
  },
  source_evidence: sourceEvidence,
  source_evidence_sha256: sourceEvidenceHash,
  calculation_notes: {
    method: LEDGER_VERSION,
    report_mode: "POST_BOUNDARY_DRAFT",
    promotion_blocked: true,
    promotion_requirements: [
      "review post-boundary workbook comparison",
      "resolve or explicitly leave pre-2026-08-03 ranges uncertified",
    ],
  },
}));

const computedByDate = new Map(ledgerRows.map((row) => [row.as_of_date, row] as const));
const conflicts = existingRows.flatMap((existing) => {
  const computed = computedByDate.get(existing.as_of_date);
  if (!computed) return [];
  const matches =
    Number(existing.securities_value_cents) === computed.securities_value_cents &&
    Number(existing.continuity_cash_cents) === computed.continuity_cash_cents &&
    Number(existing.complete_value_cents) === computed.complete_value_cents &&
    existing.ledger_version === LEDGER_VERSION;
  return matches ? [] : [{
    as_of_date: existing.as_of_date,
    certification_status: existing.certification_status,
    stored_version: existing.ledger_version,
    stored_complete_value_cents: Number(existing.complete_value_cents),
    computed_complete_value_cents: computed.complete_value_cents,
  }];
});
const protectedConflicts = conflicts.filter((row) => row.certification_status !== "DRAFT");
if (protectedConflicts.length > 0) {
  throw new Error(`refusing non-DRAFT conflicts: ${JSON.stringify(protectedConflicts)}`);
}
if (apply && conflicts.length > 0 && !replaceConflictingDraft) {
  throw new Error(`set REPLACE_CONFLICTING_CANONICAL_DRAFT=1: ${JSON.stringify(conflicts)}`);
}

const existingDates = new Set(existingRows.map((row) => row.as_of_date));
const conflictDates = new Set(conflicts.map((row) => row.as_of_date));
const rowsToInsert = ledgerRows.filter((row) => !existingDates.has(row.as_of_date));
const rowsToReplace = ledgerRows.filter((row) => conflictDates.has(row.as_of_date));
const rowsToWrite = replaceConflictingDraft ? [...rowsToInsert, ...rowsToReplace] : rowsToInsert;
if (apply && rowsToReplace.length > 0) {
  const { error } = await db
    .from("strategy_canonical_daily_ledger_c")
    .delete()
    .eq("strategy_id", strategy.id)
    .in("as_of_date", rowsToReplace.map((row) => row.as_of_date))
    .eq("certification_status", "DRAFT");
  if (error) throw new Error(`DRAFT replacement delete failed: ${error.message}`);
}
if (apply && rowsToWrite.length > 0) {
  const { error } = await db.from("strategy_canonical_daily_ledger_c").insert(rowsToWrite);
  if (error) throw new Error(`DRAFT insert failed: ${error.message}`);
}

const publicationByDate = new Map(publications.map((row) => [row.as_of_date, row] as const));
console.log(JSON.stringify({
  strategy: STRATEGY_NAME,
  apply,
  anchor_date: ANCHOR_DATE,
  end_date: endDate,
  ledger_version: LEDGER_VERSION,
  authoritative_cash_cents: authoritativeCashCents,
  anchor_batch_ids: [...anchorBatchIds],
  session_rows: ledgerRows.length,
  rows_to_insert: rowsToInsert.length,
  draft_conflicts: conflicts,
  rows_to_replace: rowsToReplace.length,
  rows_written: apply ? rowsToWrite.length : 0,
  latest: ledgerRows.at(-1),
  latest_guarded: publicationByDate.get(endDate) ?? null,
  latest_variance_cents:
    ledgerRows.at(-1)!.complete_value_cents - Number(publicationByDate.get(endDate)?.complete_value_cents ?? 0),
}, null, 2));
