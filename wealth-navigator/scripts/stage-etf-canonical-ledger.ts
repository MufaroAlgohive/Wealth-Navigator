import { createHash } from "node:crypto";

import { createRetailServiceRoleClient } from "../src/lib/supabase/server";

const STRATEGY_NAME = "ETF Basket";
const LEDGER_VERSION = "excel-static-lot-v1";
const apply = process.env.APPLY_CANONICAL_LEDGER_DRAFT === "1";
const replaceConflictingDraft = process.env.REPLACE_CONFLICTING_CANONICAL_DRAFT === "1";
const db = createRetailServiceRoleClient();

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

const strategy = await one(
  "ETF strategy",
  db
    .from("strategies_c")
    .select("id, name, status, created_at")
    .eq("name", STRATEGY_NAME)
    .maybeSingle(),
);
if (strategy.status !== "active") throw new Error(`${STRATEGY_NAME} is not active`);
const startDate = String(strategy.created_at).slice(0, 10);

const [compositions, publications, existingRows] = await Promise.all([
  many(
    "ETF compositions",
    db
      .from("strategy_composition_log_c")
      .select("effective_from, effective_to, holdings")
      .eq("strategy_id", strategy.id)
      .order("effective_from"),
  ),
  many(
    "ETF publications",
    db
      .from("strategy_return_publication_audit_c")
      .select("as_of_date, securities_value_cents, complete_value_cents, ytd_pct")
      .eq("strategy_id", strategy.id)
      .order("as_of_date"),
  ),
  many(
    "existing ETF canonical rows",
    db
      .from("strategy_canonical_daily_ledger_c")
      .select("as_of_date, certification_status, ledger_version, securities_value_cents, continuity_cash_cents, complete_value_cents, period_metrics, source_evidence_sha256")
      .eq("strategy_id", strategy.id),
  ),
]);
const endDate = publications.at(-1)?.as_of_date;
if (!endDate) throw new Error("ETF has no guarded publication end date");

const effectiveCompositions = compositions.filter(
  (composition) =>
    composition.effective_from <= endDate && (!composition.effective_to || composition.effective_to >= startDate),
);
if (effectiveCompositions.length !== 1) {
  throw new Error(`expected one unchanged ETF composition, found ${effectiveCompositions.length}`);
}
const holdings = (Array.isArray(effectiveCompositions[0].holdings) ? effectiveCompositions[0].holdings : [])
  .map((holding) => ({
    ticker: bare(String(holding.ticker ?? holding.symbol ?? "")),
    units: Number(holding.shares ?? holding.quantity ?? 0),
  }))
  .filter((holding) => holding.ticker && holding.units > 0);
if (holdings.length !== 5) throw new Error(`expected five ETF holdings, found ${holdings.length}`);

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
if (dates.at(0) !== startDate) {
  throw new Error(`strategy creation date ${startDate} is not a JSE trading session`);
}

const symbols = holdings.flatMap((holding) => [holding.ticker, `${holding.ticker}.JO`]);
const prices = await many(
  "ETF stored closes",
  db
    .from("stock_returns_c")
    .select("symbol, as_of_date, current_price, fetched_at")
    .in("symbol", symbols)
    .gte("as_of_date", startDate)
    .lte("as_of_date", endDate)
    .order("fetched_at"),
);
const priceByKey = new Map<string, { cents: number; fetchedAt: string }>();
for (const price of prices) {
  const cents = Number(price.current_price);
  if (!(cents > 0) || !price.fetched_at) continue;
  priceByKey.set(`${price.as_of_date}:${bare(price.symbol)}`, { cents, fetchedAt: price.fetched_at });
}

const missing: string[] = [];
const navRows = dates.map((date) => {
  const legs = holdings.map((holding) => {
    const price = priceByKey.get(`${date}:${holding.ticker}`);
    if (!price) missing.push(`${date}:${holding.ticker}`);
    const closeCents = price?.cents ?? 0;
    return {
      ticker: holding.ticker,
      units: holding.units,
      close_cents: closeCents,
      market_value_cents: holding.units * closeCents,
      price_fetched_at: price?.fetchedAt ?? null,
      source: "STORED_EOD_CLOSE",
    };
  });
  return { date, legs, navCents: legs.reduce((sum, leg) => sum + leg.market_value_cents, 0) };
});
if (missing.length > 0) {
  throw new Error(`missing ${missing.length} exact closes: ${missing.slice(0, 20).join(", ")}`);
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

const ledgerRows = navRows.map((current, index) => {
  const previousYearEnd = `${Number(current.date.slice(0, 4)) - 1}-12-31`;
  const periodMetrics = {
    "1D": metric(index, addDays(current.date, -1)),
    "1W": metric(index, addDays(current.date, -7)),
    WTD: metric(index, previousWeekEnd(current.date)),
    MTD: metric(index, previousMonthEnd(current.date)),
    "1M": metric(index, addMonths(current.date, -1)),
    "3M": metric(index, addMonths(current.date, -3)),
    "6M": metric(index, addMonths(current.date, -6)),
    YTD: metric(index, previousYearEnd),
    SI: metric(index, startDate),
  };
  const sourceEvidence = {
    strategy_created_at: strategy.created_at,
    inception_trading_date: startDate,
    composition_effective_from: effectiveCompositions[0].effective_from,
    methodology: LEDGER_VERSION,
    price_source: "stock_returns_c exact JSE-session close",
    full_price_coverage: true,
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
  return {
    strategy_id: strategy.id,
    as_of_date: current.date,
    ledger_version: LEDGER_VERSION,
    certification_status: "DRAFT",
    securities_value_cents: current.navCents,
    continuity_cash_cents: 0,
    complete_value_cents: current.navCents,
    leg_snapshot: current.legs,
    period_metrics: periodMetrics,
    source_evidence: sourceEvidence,
    source_evidence_sha256: createHash("sha256").update(JSON.stringify(sourceEvidence)).digest("hex"),
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

const navByDate = new Map(navRows.map((row) => [row.date, row.navCents] as const));
const guardedComparison = publications.map((publication) => {
  const ledgerNavCents = navByDate.get(publication.as_of_date) ?? null;
  const guardedSecuritiesCents = Number(publication.securities_value_cents);
  return {
    as_of_date: publication.as_of_date,
    ledger_nav_cents: ledgerNavCents,
    guarded_securities_cents: guardedSecuritiesCents,
    variance_cents: ledgerNavCents == null ? null : ledgerNavCents - guardedSecuritiesCents,
    guarded_ytd_pct: publication.ytd_pct,
  };
});
const guardedMismatches = guardedComparison.filter((row) => row.variance_cents !== 0);
const computedByDate = new Map(ledgerRows.map((row) => [row.as_of_date, row] as const));
const conflicts = existingRows.flatMap((existing) => {
  const computed = computedByDate.get(existing.as_of_date);
  if (!computed) return [{ date: existing.as_of_date, reason: "outside computed session range", certification_status: existing.certification_status }];
  const matches =
    existing.source_evidence_sha256 === computed.source_evidence_sha256 &&
    Number(existing.securities_value_cents) === computed.securities_value_cents &&
    Number(existing.continuity_cash_cents) === computed.continuity_cash_cents &&
    Number(existing.complete_value_cents) === computed.complete_value_cents &&
    Number(existing.period_metrics?.MTD?.return_pct) === Number(computed.period_metrics.MTD.return_pct) &&
    Number(existing.period_metrics?.["6M"]?.return_pct) === Number(computed.period_metrics["6M"].return_pct);
  return matches ? [] : [{ date: existing.as_of_date, reason: "stored checkpoint disagrees with rebuilt ETF NAV", certification_status: existing.certification_status }];
});
const protectedConflicts = conflicts.filter((conflict) => conflict.certification_status !== "DRAFT");
if (protectedConflicts.length) throw new Error(`refusing to replace non-DRAFT conflict(s): ${JSON.stringify(protectedConflicts)}`);
if (apply && conflicts.length && !replaceConflictingDraft) {
  throw new Error(`set REPLACE_CONFLICTING_CANONICAL_DRAFT=1 to replace DRAFT-only ETF conflicts`);
}
const existingDates = new Set(existingRows.map((row) => row.as_of_date));
const conflictDates = new Set(conflicts.map((conflict) => conflict.date));
const rowsToInsert = ledgerRows.filter((row) => !existingDates.has(row.as_of_date));
const rowsToReplace = ledgerRows.filter((row) => conflictDates.has(row.as_of_date));
const rowsToWrite = replaceConflictingDraft ? [...rowsToInsert, ...rowsToReplace] : rowsToInsert;

const summary = {
  strategy: STRATEGY_NAME,
  apply,
  start_date: startDate,
  end_date: endDate,
  row_count: ledgerRows.length,
  rows_to_insert: rowsToInsert.length,
  rows_to_replace: rowsToReplace.length,
  holdings,
  guarded_comparison: {
    compared_rows: guardedComparison.length,
    exact_value_matches: guardedComparison.length - guardedMismatches.length,
    mismatch_count: guardedMismatches.length,
    mismatches: guardedMismatches,
  },
  first: ledgerRows.at(0),
  last: ledgerRows.at(-1),
};

if (apply && rowsToWrite.length) {
  const { error } = await db.from("strategy_canonical_daily_ledger_c").upsert(rowsToWrite, { onConflict: "strategy_id,as_of_date" });
  if (error) throw new Error(`DRAFT upsert failed: ${error.message}`);
}

console.log(JSON.stringify(summary, null, 2));
