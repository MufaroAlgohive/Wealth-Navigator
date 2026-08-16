import { createHash } from "node:crypto";

import { createRetailServiceRoleClient } from "../src/lib/supabase/server";

const STRATEGY_NAME = process.env.STATIC_STRATEGY_NAME?.trim();
const LEDGER_VERSION = "excel-static-lot-v1";
const apply = process.env.APPLY_CANONICAL_LEDGER_DRAFT === "1";
const replaceConflictingDraft = process.env.REPLACE_CONFLICTING_CANONICAL_DRAFT === "1";
const db = createRetailServiceRoleClient();

if (!STRATEGY_NAME) throw new Error("STATIC_STRATEGY_NAME is required");

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

function previousMonthEnd(date: string): string {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(0);
  return iso(value);
}

function bare(symbol: string): string {
  return symbol.trim().toUpperCase().replace(/\.(JO|JSE)$/i, "");
}

async function one<T>(label: string, query: PromiseLike<{ data: T | null; error: { message: string } | null }>) {
  const { data, error } = await query;
  if (error) throw new Error(`${label}: ${error.message}`);
  if (!data) throw new Error(`${label}: no row`);
  return data;
}

async function many<T>(label: string, query: PromiseLike<{ data: T | null; error: { message: string } | null }>) {
  const { data, error } = await query;
  if (error) throw new Error(`${label}: ${error.message}`);
  return data ?? [];
}

async function fetchStoredCloses(strategyId: string, symbols: string[], startDate: string, endDate: string) {
  const pageSize = 1000;
  const result: Array<{ symbol: string; as_of_date: string; current_price: number; fetched_at: string }> = [];
  for (let offset = 0; ; offset += pageSize) {
    const page = await many(
      `stored closes page ${offset / pageSize + 1} for ${strategyId}`,
      db
        .from("stock_returns_c")
        .select("symbol, as_of_date, current_price, fetched_at")
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

const strategy = await one(
  "strategy",
  db.from("strategies_c").select("id, name, status, created_at").eq("name", STRATEGY_NAME).maybeSingle(),
);
if (strategy.status !== "active") throw new Error(`${STRATEGY_NAME} is not active`);
const startDate = String(strategy.created_at).slice(0, 10);

const [compositions, batches, publications, existingRows] = await Promise.all([
  many(
    "compositions",
    db
      .from("strategy_composition_log_c")
      .select("effective_from, effective_to, holdings")
      .eq("strategy_id", strategy.id)
      .order("effective_from"),
  ),
  many("rebalance batches", db.from("rebalance_batch").select("id").eq("strategy_id", strategy.id)),
  many(
    "guarded publications",
    db
      .from("strategy_return_publication_audit_c")
      .select("as_of_date, securities_value_cents, complete_value_cents, ytd_pct")
      .eq("strategy_id", strategy.id)
      .order("as_of_date"),
  ),
  many(
    "existing canonical rows",
    db
      .from("strategy_canonical_daily_ledger_c")
      .select("as_of_date, ledger_version, certification_status, securities_value_cents, continuity_cash_cents, complete_value_cents, period_metrics, source_evidence_sha256")
      .eq("strategy_id", strategy.id),
  ),
]);

if (compositions.length !== 1 || batches.length !== 0) {
  throw new Error(
    `refusing non-static strategy: compositions=${compositions.length}, rebalance_batches=${batches.length}`,
  );
}
const endDate = publications.at(-1)?.as_of_date;
if (!endDate) throw new Error(`${STRATEGY_NAME} has no guarded publication end date`);

const holdings = (Array.isArray(compositions[0].holdings) ? compositions[0].holdings : [])
  .map((holding) => ({
    ticker: bare(String(holding.ticker ?? holding.symbol ?? "")),
    units: Number(holding.shares ?? holding.quantity ?? 0),
  }))
  .filter((holding) => holding.ticker && holding.units > 0);
if (holdings.length === 0) throw new Error(`${STRATEGY_NAME} has no usable holdings`);

const sessions = await many(
  "JSE sessions",
  db
    .from("jse_trading_calendar")
    .select("trading_date")
    .eq("market", "JSE_EQUITIES")
    .eq("is_trading_day", true)
    .gte("trading_date", startDate)
    .lte("trading_date", endDate)
    .order("trading_date"),
);
const dates = sessions.map((session) => session.trading_date);
if (dates.length === 0) throw new Error(`${STRATEGY_NAME} has no JSE sessions in its publication range`);
const inceptionDate = dates[0];

const symbols = holdings.flatMap((holding) => [holding.ticker, `${holding.ticker}.JO`]);
const prices = await fetchStoredCloses(strategy.id, symbols, inceptionDate, endDate);
const priceByKey = new Map<string, { cents: number; fetchedAt: string }>();
for (const price of prices) {
  const cents = Number(price.current_price);
  if (!(cents > 0) || !price.fetched_at) continue;
  priceByKey.set(`${price.as_of_date}:${bare(price.symbol)}`, { cents, fetchedAt: price.fetched_at });
}

const missing: string[] = [];
let carryForwardCount = 0;
const lastPriceByTicker = new Map<string, { cents: number; fetchedAt: string; asOfDate: string }>();
const navRows = dates.map((date) => {
  const legs = holdings.map((holding) => {
    const exactPrice = priceByKey.get(`${date}:${holding.ticker}`);
    if (exactPrice) {
      lastPriceByTicker.set(holding.ticker, { ...exactPrice, asOfDate: date });
    }
    const price = exactPrice
      ? { ...exactPrice, asOfDate: date }
      : lastPriceByTicker.get(holding.ticker);
    if (!price) missing.push(`${date}:${holding.ticker}`);
    if (!exactPrice && price) carryForwardCount += 1;
    const closeCents = price?.cents ?? 0;
    return {
      ticker: holding.ticker,
      units: holding.units,
      close_cents: closeCents,
      market_value_cents: holding.units * closeCents,
      price_fetched_at: price?.fetchedAt ?? null,
      price_as_of_date: price?.asOfDate ?? null,
      source: exactPrice ? "STORED_EOD_CLOSE" : "STORED_PRIOR_CLOSE_CARRY_FORWARD",
    };
  });
  return { date, legs, navCents: legs.reduce((sum, leg) => sum + leg.market_value_cents, 0) };
});
if (missing.length > 0) {
  throw new Error(`missing ${missing.length} exact closes: ${missing.slice(0, 30).join(", ")}`);
}

function rowOnOrBefore(target: string, currentIndex: number) {
  for (let index = currentIndex; index >= 0; index -= 1) {
    if (navRows[index].date <= target) return navRows[index];
  }
  return navRows[0];
}

function metric(currentIndex: number, requestedReferenceDate: string) {
  const current = navRows[currentIndex];
  const basis = rowOnOrBefore(requestedReferenceDate, currentIndex);
  const numerator = current.navCents - basis.navCents;
  return {
    requested_reference_date: requestedReferenceDate,
    reference_date: basis.date,
    numerator_cents: numerator,
    denominator_cents: basis.navCents,
    return_pct: basis.navCents > 0 ? (numerator / basis.navCents) * 100 : null,
  };
}

const sourceEvidence = {
  strategy_created_at: strategy.created_at,
  inception_trading_date: inceptionDate,
  composition_effective_from: compositions[0].effective_from,
  methodology: LEDGER_VERSION,
  price_source: "stock_returns_c exact JSE-session close with prior-close carry-forward where absent",
  exact_close_coverage: carryForwardCount === 0,
  carry_forward_leg_count: carryForwardCount,
  holding_count: holdings.length,
  independent_provider_check: "UNAVAILABLE_2026_SERIES",
  workbook_reference: {
    file: "MINT_returns_engine_rebalance_clarity_v7_1 (1).xlsx",
    sha256: "bde94581727f9a08232ec5e80f2672bde3a1ef73c733309ec8723fe78bcaa301",
    ledger_sheet: "06_Strategy_Ledger",
    formula_match: "STATIC_NAV_DELTA_EQUIVALENT_NO_BOUNDARY",
  },
  public_visibility: "DRAFT_NOT_EXPOSED",
};
const sourceEvidenceHash = createHash("sha256").update(JSON.stringify(sourceEvidence)).digest("hex");
const ledgerRows = navRows.map((current, index) => {
  const previousYearEnd = `${Number(current.date.slice(0, 4)) - 1}-12-31`;
  return {
    strategy_id: strategy.id,
    as_of_date: current.date,
    ledger_version: LEDGER_VERSION,
    certification_status: "DRAFT",
    securities_value_cents: current.navCents,
    continuity_cash_cents: 0,
    complete_value_cents: current.navCents,
    leg_snapshot: current.legs,
    period_metrics: {
      "1D": metric(index, addDays(current.date, -1)),
      "1W": metric(index, addDays(current.date, -7)),
      WTD: metric(index, previousWeekEnd(current.date)),
      MTD: metric(index, previousMonthEnd(current.date)),
      "1M": metric(index, addMonths(current.date, -1)),
      "3M": metric(index, addMonths(current.date, -3)),
      "6M": metric(index, addMonths(current.date, -6)),
      YTD: metric(index, previousYearEnd),
      SI: metric(index, inceptionDate),
    },
    source_evidence: sourceEvidence,
    source_evidence_sha256: sourceEvidenceHash,
    calculation_notes: {
      method: LEDGER_VERSION,
      report_mode: "INSERT_ONLY_DRAFT",
      promotion_blocked: true,
      certification_requirements: [
        "independent workbook comparison",
        "independent provider price signoff",
        "inception date signoff",
        "period return tolerance review",
      ],
    },
  };
});

const computedByDate = new Map(ledgerRows.map((row) => [row.as_of_date, row] as const));
const conflicts = existingRows.flatMap((existing) => {
  const computed = computedByDate.get(existing.as_of_date);
  if (!computed) return [{
    date: existing.as_of_date,
    reason: "outside computed session range",
    certification_status: existing.certification_status,
  }];
  const sameValue =
    existing.source_evidence_sha256 === sourceEvidenceHash &&
    Number(existing.securities_value_cents) === computed.securities_value_cents &&
    Number(existing.continuity_cash_cents) === 0 &&
    Number(existing.complete_value_cents) === computed.complete_value_cents &&
    Number(existing.period_metrics?.MTD?.return_pct) === Number(computed.period_metrics.MTD.return_pct) &&
    Number(existing.period_metrics?.["6M"]?.return_pct) === Number(computed.period_metrics["6M"].return_pct);
  return sameValue ? [] : [{
    date: existing.as_of_date,
    reason: "stored checkpoint disagrees with exact-close static NAV",
    certification_status: existing.certification_status,
    stored_complete_value_cents: Number(existing.complete_value_cents),
    computed_complete_value_cents: computed.complete_value_cents,
  }];
});
const protectedConflicts = conflicts.filter((conflict) => conflict.certification_status !== "DRAFT");
if (protectedConflicts.length > 0) {
  throw new Error(`refusing to replace non-DRAFT conflict(s): ${JSON.stringify(protectedConflicts)}`);
}
if (apply && conflicts.length > 0 && !replaceConflictingDraft) {
  throw new Error(
    `set REPLACE_CONFLICTING_CANONICAL_DRAFT=1 to replace these DRAFT-only conflicts: ${JSON.stringify(conflicts)}`,
  );
}

const existingDates = new Set(existingRows.map((row) => row.as_of_date));
const rowsToInsert = ledgerRows.filter((row) => !existingDates.has(row.as_of_date));
const conflictDates = new Set(conflicts.map((conflict) => conflict.date));
const rowsToReplace = ledgerRows.filter((row) => conflictDates.has(row.as_of_date));
const rowsToWrite = replaceConflictingDraft ? [...rowsToInsert, ...rowsToReplace] : rowsToInsert;
const guardedByDate = new Map(publications.map((row) => [row.as_of_date, row] as const));
const guardedComparisons = ledgerRows.flatMap((row) => {
  const guarded = guardedByDate.get(row.as_of_date);
  if (!guarded) return [];
  return [{
    as_of_date: row.as_of_date,
    ledger_complete_value_cents: row.complete_value_cents,
    guarded_complete_value_cents: Number(guarded.complete_value_cents),
    variance_cents: row.complete_value_cents - Number(guarded.complete_value_cents),
    guarded_ytd_pct: guarded.ytd_pct,
  }];
});

if (apply && rowsToWrite.length > 0) {
  const { error } = await db
    .from("strategy_canonical_daily_ledger_c")
    .upsert(rowsToWrite, { onConflict: "strategy_id,as_of_date" });
  if (error) throw new Error(`DRAFT insert failed: ${error.message}`);
}

console.log(JSON.stringify({
  strategy: STRATEGY_NAME,
  apply,
  inception_date: inceptionDate,
  end_date: endDate,
  holding_count: holdings.length,
  carry_forward_leg_count: carryForwardCount,
  total_session_rows: ledgerRows.length,
  existing_matching_rows: existingRows.length,
  rows_to_insert: rowsToInsert.length,
  replace_conflicting_draft_enabled: replaceConflictingDraft,
  draft_conflicts: conflicts,
  rows_to_replace: rowsToReplace.length,
  rows_written: apply ? rowsToWrite.length : 0,
  guarded_comparisons: guardedComparisons,
  latest: ledgerRows.at(-1),
}, null, 2));
