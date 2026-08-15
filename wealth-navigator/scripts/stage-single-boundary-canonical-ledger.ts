import { createHash } from "node:crypto";

import { createRetailServiceRoleClient } from "../src/lib/supabase/server";

const STRATEGY_NAME = process.env.BOUNDARY_STRATEGY_NAME?.trim() || "Blended Focus";
const LEDGER_VERSION = "excel-leg-pnl-boundary-v2";
const apply = process.env.APPLY_CANONICAL_LEDGER_DRAFT === "1";
const replaceConflictingDraft = process.env.REPLACE_CONFLICTING_CANONICAL_DRAFT === "1";
const db = createRetailServiceRoleClient();

type Holding = { ticker: string; units: number };
type StoredClose = { symbol: string; as_of_date: string; current_price: number; fetched_at: string };
type LedgerLeg = {
  ticker: string;
  leg: string;
  units: number;
  entryDate: string;
  entryPriceCents: number;
  exitDate: string | null;
  exitPriceCents: number | null;
  sourceRef: string;
  isCash?: boolean;
};

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
    .map((holding) => ({
      ticker: bare(String(holding.ticker ?? holding.symbol ?? "")),
      units: Number(holding.shares ?? holding.quantity ?? 0),
    }))
    .filter((holding) => holding.ticker && holding.units > 0);
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

async function fetchStoredCloses(symbols: string[], startDate: string, endDate: string) {
  const pageSize = 1000;
  const result: StoredClose[] = [];
  for (let offset = 0; ; offset += pageSize) {
    const page = await many<StoredClose[]>(
      `stored closes page ${offset / pageSize + 1}`,
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

const [compositions, batches, publications, existingRows] = await Promise.all([
  many(
    "compositions",
    db
      .from("strategy_composition_log_c")
      .select("effective_from, effective_to, holdings, created_at")
      .eq("strategy_id", strategy.id)
      .order("effective_from"),
  ),
  many(
    "batches",
    db
      .from("rebalance_batch")
      .select("id, status, settlement_state, effective_date, settled_at, holdings_snapshot_before, holdings_snapshot_after, holdings_snapshot_planned, net_proceeds")
      .eq("strategy_id", strategy.id)
      .order("effective_date"),
  ),
  many(
    "publications",
    db
      .from("strategy_return_publication_audit_c")
      .select("as_of_date, complete_value_cents, ytd_pct")
      .eq("strategy_id", strategy.id)
      .order("as_of_date"),
  ),
  many(
    "existing canonical rows",
    db
      .from("strategy_canonical_daily_ledger_c")
      .select("as_of_date, ledger_version, certification_status, securities_value_cents, continuity_cash_cents, complete_value_cents")
      .eq("strategy_id", strategy.id),
  ),
]);

if (compositions.length !== 1 || batches.length !== 1) {
  throw new Error(`expected exactly one composition and one boundary, found ${compositions.length}/${batches.length}`);
}
const batch = batches[0];
if (batch.status !== "SETTLED" || batch.settlement_state !== "COMPLETE" || !batch.effective_date) {
  throw new Error("boundary is not a settled COMPLETE batch with an effective date");
}
const events = await many(
  "boundary fills",
  db
    .from("rebalance_event")
    .select("security_id, trade_side, quantity, avg_fill, fill_date")
    .eq("batch_id", batch.id),
);
if (events.length === 0 || events.some((event) => !(Number(event.quantity) > 0) || !(Number(event.avg_fill) > 0))) {
  throw new Error("boundary does not have complete positive-quantity fills");
}
const securities = await many(
  "boundary securities",
  db
    .from("securities_c")
    .select("id, symbol")
    .in("id", [...new Set(events.map((event) => event.security_id))]),
);
const securityTicker = new Map(
  securities.map((security) => [security.id, bare(String(security.symbol ?? ""))] as const),
);

const beforeHoldings = parseHoldings(batch.holdings_snapshot_before);
const afterHoldings = parseHoldings(compositions[0].holdings);
if (beforeHoldings.length === 0 || afterHoldings.length === 0) throw new Error("boundary holdings are incomplete");

const beforeUnits = new Map(beforeHoldings.map((holding) => [holding.ticker, holding.units] as const));
const afterUnits = new Map(afterHoldings.map((holding) => [holding.ticker, holding.units] as const));
const allTickers = [...new Set([...beforeUnits.keys(), ...afterUnits.keys()])];
const expectedDeltas = new Map(
  allTickers.map((ticker) => [ticker, (afterUnits.get(ticker) ?? 0) - (beforeUnits.get(ticker) ?? 0)] as const),
);
const fillDeltas = new Map<string, number>();
let fillCashCents = 0;
for (const event of events) {
  const ticker = securityTicker.get(event.security_id);
  if (!ticker) throw new Error(`missing ticker for fill security ${event.security_id}`);
  const quantity = Number(event.quantity);
  const fillCents = Number(event.avg_fill);
  const direction = event.trade_side === "BUY" ? 1 : event.trade_side === "SELL" ? -1 : 0;
  if (direction === 0) throw new Error(`unsupported trade side ${event.trade_side}`);
  fillDeltas.set(ticker, (fillDeltas.get(ticker) ?? 0) + direction * quantity);
  fillCashCents += event.trade_side === "SELL" ? quantity * fillCents : -(quantity * fillCents);
}
const deltaMismatches = [...new Set([...expectedDeltas.keys(), ...fillDeltas.keys()])].flatMap((ticker) => {
  const expected = expectedDeltas.get(ticker) ?? 0;
  const filled = fillDeltas.get(ticker) ?? 0;
  return expected === filled ? [] : [{ ticker, expected, filled }];
});
if (deltaMismatches.length > 0) {
  throw new Error(`fill deltas do not reproduce the post-boundary composition: ${JSON.stringify(deltaMismatches)}`);
}
if (fillCashCents < 0) throw new Error(`boundary requires unsupported external capital: ${fillCashCents} cents`);

const startDate = String(strategy.created_at).slice(0, 10);
const endDate = publications.at(-1)?.as_of_date;
if (!endDate) throw new Error(`${STRATEGY_NAME} has no guarded publication end date`);
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
if (dates.length === 0) throw new Error("no JSE sessions in strategy range");
const inceptionDate = dates[0];

const aliases = allTickers.flatMap((ticker) => [ticker, `${ticker}.JO`]);
const prices = await fetchStoredCloses(aliases, inceptionDate, endDate);
const priceByKey = new Map<string, { cents: number; fetchedAt: string }>();
for (const price of prices) {
  const cents = Number(price.current_price);
  if (cents > 0 && price.fetched_at) {
    priceByKey.set(`${price.as_of_date}:${bare(price.symbol)}`, { cents, fetchedAt: price.fetched_at });
  }
}

let carryForwardCount = 0;
const missing: string[] = [];
const lastPriceByTicker = new Map<string, { cents: number; fetchedAt: string; asOfDate: string }>();
const navRows = dates.map((date) => {
  for (const ticker of allTickers) {
    const exact = priceByKey.get(`${date}:${ticker}`);
    if (exact) lastPriceByTicker.set(ticker, { ...exact, asOfDate: date });
  }
  const holdings = date < batch.effective_date ? beforeHoldings : afterHoldings;
  const continuityCashCents = date < batch.effective_date ? 0 : fillCashCents;
  const legs = holdings.map((holding) => {
    const exact = priceByKey.get(`${date}:${holding.ticker}`);
    const price = exact ? { ...exact, asOfDate: date } : lastPriceByTicker.get(holding.ticker);
    if (!price) missing.push(`${date}:${holding.ticker}`);
    if (!exact && price) carryForwardCount += 1;
    const closeCents = price?.cents ?? 0;
    return {
      ticker: holding.ticker,
      units: holding.units,
      close_cents: closeCents,
      market_value_cents: holding.units * closeCents,
      price_fetched_at: price?.fetchedAt ?? null,
      price_as_of_date: price?.asOfDate ?? null,
      source: exact ? "STORED_EOD_CLOSE" : "STORED_PRIOR_CLOSE_CARRY_FORWARD",
    };
  });
  const securitiesValueCents = legs.reduce((sum, leg) => sum + leg.market_value_cents, 0);
  return {
    date,
    legs,
    securitiesValueCents,
    continuityCashCents,
    completeValueCents: securitiesValueCents + continuityCashCents,
  };
});
if (missing.length > 0) throw new Error(`missing ${missing.length} closes without a prior: ${missing.slice(0, 30)}`);

function storedPriceOnOrBefore(ticker: string, targetDate: string): number {
  for (let index = dates.length - 1; index >= 0; index -= 1) {
    const date = dates[index];
    if (date > targetDate) continue;
    const price = priceByKey.get(`${date}:${ticker}`);
    if (price) return price.cents;
  }
  throw new Error(`no stored price on or before ${targetDate} for ${ticker}`);
}

const fillByTickerSide = new Map<string, { quantity: number; fillCents: number }>();
for (const event of events) {
  const ticker = securityTicker.get(event.security_id)!;
  fillByTickerSide.set(`${ticker}:${event.trade_side}`, {
    quantity: Number(event.quantity),
    fillCents: Number(event.avg_fill),
  });
}
const ledgerLegs: LedgerLeg[] = [];
for (const holding of beforeHoldings) {
  const delta = expectedDeltas.get(holding.ticker) ?? 0;
  const soldUnits = Math.max(0, -delta);
  const retainedUnits = holding.units - soldUnits;
  const entryPriceCents = storedPriceOnOrBefore(holding.ticker, inceptionDate);
  if (retainedUnits > 0) {
    ledgerLegs.push({
      ticker: holding.ticker,
      leg: "Start leg",
      units: retainedUnits,
      entryDate: inceptionDate,
      entryPriceCents,
      exitDate: null,
      exitPriceCents: null,
      sourceRef: "holdings_snapshot_before",
    });
  }
  if (soldUnits > 0) {
    const sellFill = fillByTickerSide.get(`${holding.ticker}:SELL`);
    if (!sellFill || sellFill.quantity !== soldUnits) {
      throw new Error(`missing exact sell fill for ${holding.ticker}:${soldUnits}`);
    }
    ledgerLegs.push({
      ticker: holding.ticker,
      leg: "Start leg sold/trimmed",
      units: soldUnits,
      entryDate: inceptionDate,
      entryPriceCents,
      exitDate: batch.effective_date,
      exitPriceCents: sellFill.fillCents,
      sourceRef: `rebalance_batch:${batch.id}`,
    });
  }
}
for (const [ticker, delta] of expectedDeltas) {
  if (delta <= 0) continue;
  const buyFill = fillByTickerSide.get(`${ticker}:BUY`);
  if (!buyFill || buyFill.quantity !== delta) throw new Error(`missing exact buy fill for ${ticker}:${delta}`);
  ledgerLegs.push({
    ticker,
    leg: "Rebalance buy",
    units: delta,
    entryDate: batch.effective_date,
    entryPriceCents: buyFill.fillCents,
    exitDate: null,
    exitPriceCents: null,
    sourceRef: `rebalance_batch:${batch.id}`,
  });
}
if (fillCashCents > 0) {
  ledgerLegs.push({
    ticker: "CASH",
    leg: "Undeployed rebalance proceeds",
    units: 1,
    entryDate: batch.effective_date,
    entryPriceCents: fillCashCents,
    exitDate: null,
    exitPriceCents: null,
    sourceRef: `rebalance_batch:${batch.id}`,
    isCash: true,
  });
}

function rowOnOrBefore(target: string, currentIndex: number) {
  for (let index = currentIndex; index >= 0; index -= 1) {
    if (navRows[index].date <= target) return navRows[index];
  }
  return navRows[0];
}

function valueForLeg(leg: LedgerLeg, date: string): number {
  if (leg.isCash) return leg.entryPriceCents;
  if (date === leg.entryDate) return leg.units * leg.entryPriceCents;
  return leg.units * storedPriceOnOrBefore(leg.ticker, date);
}

function metric(currentIndex: number, requestedReferenceDate: string) {
  const current = navRows[currentIndex];
  const mappedReference = rowOnOrBefore(requestedReferenceDate, currentIndex).date;
  const legTrace = ledgerLegs.flatMap((leg) => {
    if (leg.entryDate > current.date) return [];
    const referenceDate = leg.entryDate > mappedReference ? leg.entryDate : mappedReference;
    if (leg.exitDate && leg.exitDate <= referenceDate) {
      return [{ ticker: leg.ticker, leg: leg.leg, reference_date: referenceDate, benchmark_cents: 0, numerator_cents: 0, pnl_cents: 0 }];
    }
    const benchmarkCents = valueForLeg(leg, referenceDate);
    const numeratorCents = leg.exitDate && leg.exitDate <= current.date
      ? leg.units * Number(leg.exitPriceCents)
      : valueForLeg(leg, current.date);
    return [{
      ticker: leg.ticker,
      leg: leg.leg,
      reference_date: referenceDate,
      benchmark_cents: benchmarkCents,
      numerator_cents: numeratorCents,
      pnl_cents: numeratorCents - benchmarkCents,
    }];
  });
  const denominator = legTrace.reduce((sum, leg) => sum + leg.benchmark_cents, 0);
  const numerator = legTrace.reduce((sum, leg) => sum + leg.numerator_cents, 0);
  const pnl = legTrace.reduce((sum, leg) => sum + leg.pnl_cents, 0);
  return {
    requested_reference_date: requestedReferenceDate,
    reference_date: mappedReference,
    numerator_value_cents: numerator,
    numerator_cents: pnl,
    denominator_cents: denominator,
    pnl_cents: pnl,
    return_pct: denominator > 0 ? (pnl / denominator) * 100 : null,
    leg_trace: legTrace,
  };
}

const sourceEvidence = {
  methodology: LEDGER_VERSION,
  strategy_created_at: strategy.created_at,
  inception_trading_date: inceptionDate,
  boundary_batch_id: batch.id,
  boundary_effective_date: batch.effective_date,
  fill_count: events.length,
  fill_cash_cents: fillCashCents,
  recorded_batch_net_proceeds: batch.net_proceeds,
  fill_deltas_match_composition: true,
  price_source: "stock_returns_c paginated exact closes with labelled prior-close carry-forward",
  carry_forward_leg_count: carryForwardCount,
  independent_provider_check: "UNAVAILABLE_2026_SERIES",
  public_visibility: "DRAFT_NOT_EXPOSED",
};
const evidenceHash = createHash("sha256").update(JSON.stringify(sourceEvidence)).digest("hex");
const ledgerRows = navRows.map((current, index) => {
  const previousYearEnd = `${Number(current.date.slice(0, 4)) - 1}-12-31`;
  return {
    strategy_id: strategy.id,
    as_of_date: current.date,
    ledger_version: LEDGER_VERSION,
    certification_status: "DRAFT",
    securities_value_cents: current.securitiesValueCents,
    continuity_cash_cents: current.continuityCashCents,
    complete_value_cents: current.completeValueCents,
    leg_snapshot: ledgerLegs
      .filter((leg) => leg.entryDate <= current.date)
      .map((leg) => ({
        ticker: leg.ticker,
        leg: leg.leg,
        units: leg.units,
        entry_date: leg.entryDate,
        entry_price_cents: leg.entryPriceCents,
        exit_date: leg.exitDate,
        exit_price_cents: leg.exitPriceCents,
        source_ref: leg.sourceRef,
        counts_in_current_strategy: !leg.exitDate || leg.exitDate > current.date,
        current_or_exit_value_cents: leg.exitDate && leg.exitDate <= current.date
          ? leg.units * Number(leg.exitPriceCents)
          : valueForLeg(leg, current.date),
      })),
    period_metrics: {
      "1D": metric(index, addDays(current.date, -1)),
      "1W": metric(index, addDays(current.date, -7)),
      WTD: metric(index, previousWeekEnd(current.date)),
      "1M": metric(index, addMonths(current.date, -1)),
      "3M": metric(index, addMonths(current.date, -3)),
      YTD: metric(index, previousYearEnd),
      SI: metric(index, inceptionDate),
    },
    source_evidence: sourceEvidence,
    source_evidence_sha256: evidenceHash,
    calculation_notes: {
      method: LEDGER_VERSION,
      return_method: "WORKBOOK_LEG_PNL_OVER_LEG_BENCHMARK",
      report_mode: "UPSERT_DRAFT_ONLY",
      promotion_blocked: true,
      certification_requirements: [
        "independent workbook comparison",
        "independent provider price signoff",
        "17,666-cent boundary cash signoff",
        "period return tolerance review",
      ],
    },
  };
});

const computedByDate = new Map(ledgerRows.map((row) => [row.as_of_date, row] as const));
const conflicts = existingRows.flatMap((existing) => {
  const computed = computedByDate.get(existing.as_of_date);
  if (!computed) return [{ date: existing.as_of_date, certification_status: existing.certification_status }];
  const matches =
    existing.ledger_version === LEDGER_VERSION &&
    Number(existing.securities_value_cents) === computed.securities_value_cents &&
    Number(existing.continuity_cash_cents) === computed.continuity_cash_cents &&
    Number(existing.complete_value_cents) === computed.complete_value_cents;
  return matches ? [] : [{
    date: existing.as_of_date,
    certification_status: existing.certification_status,
    stored_complete_value_cents: Number(existing.complete_value_cents),
    computed_complete_value_cents: computed.complete_value_cents,
  }];
});
if (conflicts.some((conflict) => conflict.certification_status !== "DRAFT")) {
  throw new Error(`refusing non-DRAFT conflict: ${JSON.stringify(conflicts)}`);
}
if (apply && conflicts.length > 0 && !replaceConflictingDraft) {
  throw new Error(`set REPLACE_CONFLICTING_CANONICAL_DRAFT=1: ${JSON.stringify(conflicts)}`);
}
const existingDates = new Set(existingRows.map((row) => row.as_of_date));
const conflictDates = new Set(conflicts.map((conflict) => conflict.date));
const rowsToInsert = ledgerRows.filter((row) => !existingDates.has(row.as_of_date));
const rowsToReplace = ledgerRows.filter((row) => conflictDates.has(row.as_of_date));
const rowsToWrite = replaceConflictingDraft ? [...rowsToInsert, ...rowsToReplace] : rowsToInsert;

if (apply && rowsToWrite.length > 0) {
  const { error } = await db
    .from("strategy_canonical_daily_ledger_c")
    .upsert(rowsToWrite, { onConflict: "strategy_id,as_of_date" });
  if (error) throw new Error(`DRAFT upsert failed: ${error.message}`);
}

const guardedByDate = new Map(publications.map((publication) => [publication.as_of_date, publication] as const));
const latest = ledgerRows.at(-1)!;
const boundaryIndex = ledgerRows.findIndex((row) => row.as_of_date >= batch.effective_date);
const boundaryBefore = boundaryIndex > 0 ? ledgerRows[boundaryIndex - 1] : null;
const boundaryAfter = boundaryIndex >= 0 ? ledgerRows[boundaryIndex] : null;
console.log(JSON.stringify({
  strategy: STRATEGY_NAME,
  apply,
  inception_date: inceptionDate,
  end_date: endDate,
  boundary: {
    batch_id: batch.id,
    effective_date: batch.effective_date,
    fill_cash_cents: fillCashCents,
    recorded_net_proceeds: batch.net_proceeds,
    deltas: Object.fromEntries(fillDeltas),
    previous_session: boundaryBefore && {
      as_of_date: boundaryBefore.as_of_date,
      complete_value_cents: boundaryBefore.complete_value_cents,
    },
    effective_session: boundaryAfter && {
      as_of_date: boundaryAfter.as_of_date,
      securities_value_cents: boundaryAfter.securities_value_cents,
      continuity_cash_cents: boundaryAfter.continuity_cash_cents,
      complete_value_cents: boundaryAfter.complete_value_cents,
      boundary_return_pct: boundaryBefore
        ? ((boundaryAfter.complete_value_cents - boundaryBefore.complete_value_cents) /
            boundaryBefore.complete_value_cents) * 100
        : null,
    },
  },
  carry_forward_leg_count: carryForwardCount,
  total_session_rows: ledgerRows.length,
  existing_rows: existingRows.length,
  rows_to_insert: rowsToInsert.length,
  conflicts,
  rows_to_replace: rowsToReplace.length,
  rows_written: apply ? rowsToWrite.length : 0,
  latest: {
    as_of_date: latest.as_of_date,
    securities_value_cents: latest.securities_value_cents,
    continuity_cash_cents: latest.continuity_cash_cents,
    complete_value_cents: latest.complete_value_cents,
    period_metrics: latest.period_metrics,
    guarded_publication: guardedByDate.get(latest.as_of_date) ?? null,
  },
}, null, 2));
