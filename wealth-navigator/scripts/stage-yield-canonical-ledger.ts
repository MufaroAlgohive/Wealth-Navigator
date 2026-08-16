import { createHash } from "node:crypto";

import { createRetailServiceRoleClient } from "../src/lib/supabase/server";

const STRATEGY_NAME = "Yield Basket";
const LEDGER_VERSION = "excel-yield-execution-leg-pnl-v1";
const apply = process.env.APPLY_CANONICAL_LEDGER_DRAFT === "1";
const replaceConflictingDraft = process.env.REPLACE_CONFLICTING_CANONICAL_DRAFT === "1";
const db = createRetailServiceRoleClient();

type Holding = { ticker: string; units: number };
type Composition = {
  effective_from: string;
  effective_to: string | null;
  holdings: unknown;
  created_at: string;
};
type Batch = {
  id: string;
  effective_date: string;
  status: string;
  settlement_state: string;
  created_at: string;
};
type Fill = {
  batch_id: string;
  security_id: string;
  trade_side: "BUY" | "SELL";
  quantity: number;
  avg_fill: number;
  fill_date: string;
};
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

const bare = (symbol: string) =>
  symbol
    .trim()
    .toUpperCase()
    .replace(/\.(JO|JSE)$/i, "");
const iso = (date: Date) => date.toISOString().slice(0, 10);
function addDays(date: string, days: number) {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return iso(value);
}
function addMonths(date: string, months: number) {
  const value = new Date(`${date}T00:00:00.000Z`);
  const day = value.getUTCDate();
  value.setUTCDate(1);
  value.setUTCMonth(value.getUTCMonth() + months);
  value.setUTCDate(
    Math.min(day, new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth() + 1, 0)).getUTCDate()),
  );
  return iso(value);
}
function previousWeekEnd(date: string) {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() - ((value.getUTCDay() + 6) % 7) - 1);
  return iso(value);
}

function previousMonthEnd(date: string) {
  const value = new Date(`${date}T00:00:00Z`);
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), 0)).toISOString().slice(0, 10);
}
function parseHoldings(value: unknown): Holding[] {
  return (Array.isArray(value) ? value : [])
    .map((row) => ({
      ticker: bare(String(row.ticker ?? row.symbol ?? "")),
      units: Number(row.quantity ?? row.shares ?? 0),
    }))
    .filter((row) => row.ticker && row.units > 0);
}
const holdingMap = (rows: Holding[]) => new Map(rows.map((row) => [row.ticker, row.units] as const));

async function one<T>(
  label: string,
  query: PromiseLike<{ data: T | null; error: { message: string } | null }>,
) {
  const { data, error } = await query;
  if (error) throw new Error(`${label}: ${error.message}`);
  if (!data) throw new Error(`${label}: no row`);
  return data;
}
async function many<T>(
  label: string,
  query: PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
) {
  const { data, error } = await query;
  if (error) throw new Error(`${label}: ${error.message}`);
  return data ?? [];
}
async function fetchStoredCloses(symbols: string[], startDate: string, endDate: string) {
  const rows: StoredClose[] = [];
  for (let offset = 0; ; offset += 1000) {
    const page = await many<StoredClose>(
      `stored closes page ${offset / 1000 + 1}`,
      db
        .from("stock_returns_c")
        .select("symbol,as_of_date,current_price,fetched_at")
        .in("symbol", symbols)
        .gte("as_of_date", startDate)
        .lte("as_of_date", endDate)
        .order("as_of_date")
        .order("fetched_at")
        .range(offset, offset + 999),
    );
    rows.push(...page);
    if (page.length < 1000) break;
  }
  return rows;
}

const strategy = await one<{ id: string; status: string; created_at: string }>(
  "Yield strategy",
  db.from("strategies_c").select("id,status,created_at").eq("name", STRATEGY_NAME).maybeSingle(),
);
if (strategy.status !== "active") throw new Error("Yield Basket is not active");

const [compositions, allBatches, rules, publications, existingRows] = await Promise.all([
  many<Composition>(
    "composition history",
    db
      .from("strategy_composition_log_c")
      .select("effective_from,effective_to,holdings,created_at")
      .eq("strategy_id", strategy.id)
      .order("effective_from"),
  ),
  many<Batch>(
    "rebalance batches",
    db
      .from("rebalance_batch")
      .select("id,effective_date,status,settlement_state,created_at")
      .eq("strategy_id", strategy.id)
      .order("created_at"),
  ),
  many<{
    effective_from: string;
    status: string;
    continuity_cash_per_lot_cents: number;
    complete_value_per_lot_cents: number;
    methodology_version: string;
    source_evidence: unknown;
  }>(
    "valuation rules",
    db
      .from("strategy_valuation_rules_c")
      .select(
        "effective_from,status,continuity_cash_per_lot_cents,complete_value_per_lot_cents,methodology_version,source_evidence",
      )
      .eq("strategy_id", strategy.id)
      .order("effective_from"),
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
      .order("as_of_date"),
  ),
  many<{
    as_of_date: string;
    ledger_version: string;
    certification_status: string;
    securities_value_cents: number;
    continuity_cash_cents: number;
    complete_value_cents: number;
    source_evidence_sha256: string | null;
    period_metrics: Record<string, { return_pct?: number | null }>;
  }>(
    "existing canonical rows",
    db
      .from("strategy_canonical_daily_ledger_c")
      .select(
        "as_of_date,ledger_version,certification_status,securities_value_cents,continuity_cash_cents,complete_value_cents,source_evidence_sha256,period_metrics",
      )
      .eq("strategy_id", strategy.id),
  ),
]);
if (compositions.length !== 4)
  throw new Error(`expected four Yield compositions, found ${compositions.length}`);
const batches = allBatches.filter(
  (batch) => batch.status === "SETTLED" && batch.settlement_state === "COMPLETE",
);
const reversed = allBatches.filter(
  (batch) => batch.status === "REVERSED" || batch.settlement_state === "REVERSED",
);
if (batches.length !== 3 || reversed.length !== 1) {
  throw new Error(
    `expected three completed and one reversed Yield batch, found ${batches.length}/${reversed.length}`,
  );
}
const activeRule = rules.filter((rule) => rule.status === "ACTIVE").at(-1);
if (!activeRule || Number(activeRule.continuity_cash_per_lot_cents) !== 49_194) {
  throw new Error("Yield active valuation rule must independently anchor model CA at 49,194 cents");
}
const endDate = publications.at(-1)?.as_of_date;
if (!endDate) throw new Error("Yield has no guarded publication end date");

const batchIds = batches.map((batch) => batch.id);
const fills = await many<Fill>(
  "settled fills",
  db
    .from("rebalance_event")
    .select("batch_id,security_id,trade_side,quantity,avg_fill,fill_date")
    .in("batch_id", batchIds),
);
if (fills.some((fill) => !fill.avg_fill || !fill.fill_date))
  throw new Error("every settled Yield event must have a fill price and date");
const securityIds = [...new Set(fills.map((fill) => fill.security_id))];
const securities = await many<{ id: string; symbol: string }>(
  "fill securities",
  db.from("securities_c").select("id,symbol").in("id", securityIds),
);
const tickerBySecurity = new Map(securities.map((security) => [security.id, bare(security.symbol)] as const));

const boundaries: Array<{
  batch: Batch;
  before: Holding[];
  after: Holding[];
  deltas: Map<string, number>;
  ownerScale: number;
  prices: Map<string, number>;
  grossCashDeltaCents: number;
}> = [];
for (let index = 1; index < compositions.length; index += 1) {
  const before = parseHoldings(compositions[index - 1].holdings);
  const after = parseHoldings(compositions[index].holdings);
  const beforeMap = holdingMap(before);
  const afterMap = holdingMap(after);
  const deltas = new Map(
    [...new Set([...beforeMap.keys(), ...afterMap.keys()])].map(
      (ticker) => [ticker, (afterMap.get(ticker) ?? 0) - (beforeMap.get(ticker) ?? 0)] as const,
    ),
  );
  const batch = batches.find((candidate) => candidate.effective_date === compositions[index].effective_from);
  if (!batch) throw new Error(`no completed batch for ${compositions[index].effective_from}`);
  const batchFills = fills.filter((fill) => fill.batch_id === batch.id);
  const scales: number[] = [];
  const prices = new Map<string, number>();
  let grossCashDeltaCents = 0;
  for (const [ticker, delta] of deltas) {
    if (!delta) continue;
    const side = delta > 0 ? "BUY" : "SELL";
    const matching = batchFills.filter(
      (fill) => tickerBySecurity.get(fill.security_id) === ticker && fill.trade_side === side,
    );
    if (!matching.length) throw new Error(`batch ${batch.id} lacks ${side} evidence for ${ticker}`);
    const uniquePrices = [...new Set(matching.map((fill) => Number(fill.avg_fill)))];
    if (uniquePrices.length !== 1) throw new Error(`batch ${batch.id} has ambiguous ${ticker} fill prices`);
    const aggregateUnits = matching.reduce((sum, fill) => sum + Number(fill.quantity), 0);
    const scale = aggregateUnits / Math.abs(delta);
    if (!Number.isInteger(scale) || scale <= 0)
      throw new Error(`batch ${batch.id} has invalid owner scale for ${ticker}`);
    scales.push(scale);
    prices.set(`${ticker}:${side}`, uniquePrices[0]);
    grossCashDeltaCents += (side === "SELL" ? 1 : -1) * Math.abs(delta) * uniquePrices[0];
  }
  if (!scales.length || new Set(scales).size !== 1)
    throw new Error(`batch ${batch.id} does not share one aggregate owner scale`);
  boundaries.push({ batch, before, after, deltas, ownerScale: scales[0], prices, grossCashDeltaCents });
}

const sessions = await many<{ trading_date: string }>(
  "JSE sessions",
  db
    .from("jse_trading_calendar")
    .select("trading_date")
    .eq("market", "JSE_EQUITIES")
    .eq("is_trading_day", true)
    .gte("trading_date", strategy.created_at.slice(0, 10))
    .lte("trading_date", endDate)
    .order("trading_date"),
);
const dates = sessions.map((session) => session.trading_date);
const inceptionDate = dates[0];
if (!inceptionDate) throw new Error("no JSE sessions in Yield range");
const allTickers = [
  ...new Set(
    compositions.flatMap((composition) =>
      parseHoldings(composition.holdings).map((holding) => holding.ticker),
    ),
  ),
];
const prices = await fetchStoredCloses(
  allTickers.flatMap((ticker) => [ticker, `${ticker}.JO`]),
  addDays(inceptionDate, -31),
  endDate,
);
function storedPriceOnOrBefore(ticker: string, date: string) {
  const row = prices
    .filter(
      (price) => bare(price.symbol) === ticker && price.as_of_date <= date && Number(price.current_price) > 0,
    )
    .sort((a, b) => b.as_of_date.localeCompare(a.as_of_date) || b.fetched_at.localeCompare(a.fetched_at))[0];
  if (!row) throw new Error(`no stored close for ${ticker} on or before ${date}`);
  return { cents: Number(row.current_price), asOfDate: row.as_of_date, fetchedAt: row.fetched_at };
}
function compositionForDate(date: string) {
  const eligible = compositions.filter(
    (composition) =>
      composition.effective_from <= date && (!composition.effective_to || composition.effective_to >= date),
  );
  if (eligible.length !== 1)
    throw new Error(`expected one Yield composition for ${date}, found ${eligible.length}`);
  return parseHoldings(eligible[0].holdings);
}

const grossCashByDate = new Map<string, number>();
let grossCash = 0;
for (const boundary of boundaries) {
  grossCash += boundary.grossCashDeltaCents;
  grossCashByDate.set(boundary.batch.effective_date, grossCash);
}
const anchoredCash = Number(activeRule.continuity_cash_per_lot_cents);
const cumulativeExecutionCost = grossCash - anchoredCash;
if (cumulativeExecutionCost < 0 || cumulativeExecutionCost > 5_000) {
  throw new Error(`active CA differs implausibly from fill residuals by ${cumulativeExecutionCost} cents`);
}
function cashForDate(date: string) {
  if (date >= activeRule.effective_from) return anchoredCash;
  return boundaries
    .filter((boundary) => boundary.batch.effective_date <= date)
    .reduce((sum, boundary) => sum + boundary.grossCashDeltaCents, 0);
}

const ledgerLegs: LedgerLeg[] = parseHoldings(compositions[0].holdings).map((holding) => ({
  ticker: holding.ticker,
  leg: "Inception leg",
  units: holding.units,
  entryDate: inceptionDate,
  entryPriceCents: storedPriceOnOrBefore(holding.ticker, inceptionDate).cents,
  exitDate: null,
  exitPriceCents: null,
  sourceRef: "strategy_composition_log_c:opening",
}));
let cashLegTotal = 0;
for (const boundary of boundaries) {
  for (const [ticker, delta] of boundary.deltas) {
    if (delta >= 0) continue;
    const fillPrice = boundary.prices.get(`${ticker}:SELL`);
    if (!fillPrice) throw new Error(`validated sell fill missing for ${ticker}`);
    let remaining = -delta;
    for (const leg of ledgerLegs.filter((candidate) => candidate.ticker === ticker && !candidate.exitDate)) {
      if (!remaining) break;
      const closing = Math.min(leg.units, remaining);
      if (closing < leg.units) ledgerLegs.push({ ...leg, units: leg.units - closing });
      leg.units = closing;
      leg.exitDate = boundary.batch.effective_date;
      leg.exitPriceCents = fillPrice;
      leg.sourceRef = `rebalance_event:${boundary.batch.id}:owner_scale_${boundary.ownerScale}`;
      remaining -= closing;
    }
    if (remaining) throw new Error(`could not close ${ticker} model units`);
  }
  for (const [ticker, delta] of boundary.deltas) {
    if (delta <= 0) continue;
    const fillPrice = boundary.prices.get(`${ticker}:BUY`);
    if (!fillPrice) throw new Error(`validated buy fill missing for ${ticker}`);
    ledgerLegs.push({
      ticker,
      leg: "Rebalance buy",
      units: delta,
      entryDate: boundary.batch.effective_date,
      entryPriceCents: fillPrice,
      exitDate: null,
      exitPriceCents: null,
      sourceRef: `rebalance_event:${boundary.batch.id}:owner_scale_${boundary.ownerScale}`,
    });
  }
  if (boundary.grossCashDeltaCents > 0) {
    ledgerLegs.push({
      ticker: "CASH",
      leg: "Gross rebalance residual",
      units: 1,
      entryDate: boundary.batch.effective_date,
      entryPriceCents: boundary.grossCashDeltaCents,
      exitDate: null,
      exitPriceCents: null,
      sourceRef: `rebalance_event:${boundary.batch.id}:fills`,
      isCash: true,
    });
    cashLegTotal += boundary.grossCashDeltaCents;
  }
}
if (cumulativeExecutionCost > 0) {
  ledgerLegs.push({
    ticker: "EXECUTION_COST",
    leg: "Cumulative execution-cost bridge",
    units: 1,
    entryDate: activeRule.effective_from,
    entryPriceCents: cumulativeExecutionCost,
    exitDate: activeRule.effective_from,
    exitPriceCents: 0,
    sourceRef: `strategy_valuation_rules_c:${activeRule.methodology_version}`,
    isCash: true,
  });
}
if (cashLegTotal - cumulativeExecutionCost !== anchoredCash) throw new Error("cash bridge identity failed");

let carryForwardCount = 0;
const navRows = dates.map((date) => {
  const legs = compositionForDate(date).map((holding) => {
    const close = storedPriceOnOrBefore(holding.ticker, date);
    if (close.asOfDate !== date) carryForwardCount += 1;
    return {
      ticker: holding.ticker,
      units: holding.units,
      close_cents: close.cents,
      market_value_cents: holding.units * close.cents,
      price_as_of_date: close.asOfDate,
      price_fetched_at: close.fetchedAt,
      source: close.asOfDate === date ? "STORED_EOD_CLOSE" : "STORED_PRIOR_CLOSE_CARRY_FORWARD",
    };
  });
  const securitiesValueCents = legs.reduce((sum, leg) => sum + leg.market_value_cents, 0);
  const continuityCashCents = cashForDate(date);
  return {
    date,
    legs,
    securitiesValueCents,
    continuityCashCents,
    completeValueCents: securitiesValueCents + continuityCashCents,
  };
});

function rowOnOrBefore(target: string, currentIndex: number) {
  for (let index = currentIndex; index >= 0; index -= 1)
    if (navRows[index].date <= target) return navRows[index];
  return navRows[0];
}
function valueForLeg(leg: LedgerLeg, date: string) {
  if (leg.ticker === "EXECUTION_COST") return date < leg.entryDate ? 0 : 0;
  if (leg.isCash) return leg.entryPriceCents;
  if (date === leg.entryDate) return leg.units * leg.entryPriceCents;
  return leg.units * storedPriceOnOrBefore(leg.ticker, date).cents;
}
function metric(currentIndex: number, requestedReferenceDate: string) {
  const current = navRows[currentIndex];
  const mappedReference = rowOnOrBefore(requestedReferenceDate, currentIndex).date;
  const legTrace = ledgerLegs.flatMap((leg) => {
    if (leg.entryDate > current.date) return [];
    if (leg.ticker === "EXECUTION_COST") {
      if (mappedReference >= leg.entryDate) return [];
      return [
        {
          ticker: leg.ticker,
          leg: leg.leg,
          reference_date: leg.entryDate,
          benchmark_cents: leg.entryPriceCents,
          numerator_cents: 0,
          pnl_cents: -leg.entryPriceCents,
        },
      ];
    }
    const referenceDate = leg.entryDate > mappedReference ? leg.entryDate : mappedReference;
    if (leg.exitDate && leg.exitDate <= referenceDate) return [];
    const benchmarkCents = valueForLeg(leg, referenceDate);
    const currentOrExitCents =
      leg.exitDate && leg.exitDate <= current.date
        ? leg.units * Number(leg.exitPriceCents)
        : valueForLeg(leg, current.date);
    return [
      {
        ticker: leg.ticker,
        leg: leg.leg,
        reference_date: referenceDate,
        benchmark_cents: benchmarkCents,
        numerator_cents: currentOrExitCents,
        pnl_cents: currentOrExitCents - benchmarkCents,
      },
    ];
  });
  const denominator = legTrace.reduce((sum, leg) => sum + leg.benchmark_cents, 0);
  const numeratorValue = legTrace.reduce((sum, leg) => sum + leg.numerator_cents, 0);
  const pnl = legTrace.reduce((sum, leg) => sum + leg.pnl_cents, 0);
  return {
    requested_reference_date: requestedReferenceDate,
    reference_date: mappedReference,
    numerator_value_cents: numeratorValue,
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
  settled_boundaries: boundaries.map((boundary) => ({
    id: boundary.batch.id,
    effective_date: boundary.batch.effective_date,
    owner_scale: boundary.ownerScale,
    gross_cash_delta_cents: boundary.grossCashDeltaCents,
    deltas: Object.fromEntries(boundary.deltas),
  })),
  excluded_reversed_batches: reversed.map((batch) => batch.id),
  cash_bridge: {
    gross_fill_residual_cents: grossCash,
    active_rule_cash_cents: anchoredCash,
    cumulative_execution_cost_cents: cumulativeExecutionCost,
    rule_effective_from: activeRule.effective_from,
    methodology_version: activeRule.methodology_version,
    status: "DRAFT_EXPLICIT_BRIDGE_PENDING_INDEPENDENT_FEE_TIMING_SIGNOFF",
  },
  price_source: "stock_returns_c exact JSE-session close with labelled prior-close carry-forward",
  carry_forward_leg_count: carryForwardCount,
  workbook_reference: {
    file: "MINT_returns_engine_rebalance_clarity_v7_1 (1).xlsx",
    sha256: "bde94581727f9a08232ec5e80f2672bde3a1ef73c733309ec8723fe78bcaa301",
    ledger_sheet: "06_Strategy_Ledger",
    public_view_sheet: "07_Public_Strategy_View",
    formula_match: "LEG_BENCHMARK_NUMERATOR_PNL_AND_RETURN_CELL_PATTERN_MATCHED",
  },
  independent_provider_check: {
    yahoo: "PREVIOUS_WORKBOOK_EVIDENCE_HASH_RETAINED_IN_ACTIVE_RULE",
    certification_effect: "BLOCKED_PENDING_REPEATABLE_PROVIDER_SIGNOFF",
  },
  public_visibility: "DRAFT_NOT_EXPOSED",
};
const evidenceHash = createHash("sha256").update(JSON.stringify(sourceEvidence)).digest("hex");
const ledgerRows = navRows.map((current, index) => ({
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
      current_or_exit_value_cents:
        leg.ticker === "EXECUTION_COST"
          ? 0
          : leg.exitDate && leg.exitDate <= current.date
            ? leg.units * Number(leg.exitPriceCents)
            : valueForLeg(leg, current.date),
    })),
  period_metrics: {
    "1D": metric(index, addDays(current.date, -1)),
    "1W": metric(index, addDays(current.date, -7)),
    WTD: metric(index, previousWeekEnd(current.date)),
    MTD: metric(index, previousMonthEnd(current.date)),
    "1M": metric(index, addMonths(current.date, -1)),
    "3M": metric(index, addMonths(current.date, -3)),
    "6M": metric(index, addMonths(current.date, -6)),
    YTD: metric(index, `${Number(current.date.slice(0, 4)) - 1}-12-31`),
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
      "independent provider price signoff",
      "execution-cost timing signoff",
      "workbook tolerance review",
    ],
  },
}));

const computedByDate = new Map(ledgerRows.map((row) => [row.as_of_date, row] as const));
const conflicts = existingRows.flatMap((existing) => {
  const computed = computedByDate.get(existing.as_of_date);
  if (!computed)
    return [
      {
        as_of_date: existing.as_of_date,
        certification_status: existing.certification_status,
        reason: "outside_computed_range",
      },
    ];
  const matches =
    existing.ledger_version === LEDGER_VERSION &&
    existing.source_evidence_sha256 === evidenceHash &&
    Number(existing.securities_value_cents) === computed.securities_value_cents &&
    Number(existing.continuity_cash_cents) === computed.continuity_cash_cents &&
    Number(existing.complete_value_cents) === computed.complete_value_cents &&
    Number(existing.period_metrics?.MTD?.return_pct) === Number(computed.period_metrics.MTD.return_pct) &&
    Number(existing.period_metrics?.["6M"]?.return_pct) === Number(computed.period_metrics["6M"].return_pct);
  return matches
    ? []
    : [
        {
          as_of_date: existing.as_of_date,
          certification_status: existing.certification_status,
          stored_version: existing.ledger_version,
          stored_complete_value_cents: Number(existing.complete_value_cents),
          computed_complete_value_cents: computed.complete_value_cents,
        },
      ];
});
if (conflicts.some((conflict) => conflict.certification_status !== "DRAFT"))
  throw new Error(`refusing non-DRAFT conflicts: ${JSON.stringify(conflicts)}`);
if (apply && conflicts.length && !replaceConflictingDraft)
  throw new Error(`set REPLACE_CONFLICTING_CANONICAL_DRAFT=1: ${JSON.stringify(conflicts)}`);
const existingDates = new Set(existingRows.map((row) => row.as_of_date));
const rowsToInsert = ledgerRows.filter((row) => !existingDates.has(row.as_of_date));
const conflictDates = new Set(conflicts.map((conflict) => conflict.as_of_date));
const rowsToReplace = ledgerRows.filter((row) => conflictDates.has(row.as_of_date));
const rowsToWrite = replaceConflictingDraft ? [...rowsToInsert, ...rowsToReplace] : rowsToInsert;
if (apply && rowsToWrite.length) {
  const { error } = await db
    .from("strategy_canonical_daily_ledger_c")
    .upsert(rowsToWrite, { onConflict: "strategy_id,as_of_date" });
  if (error) throw new Error(`atomic Yield DRAFT upsert failed: ${error.message}`);
}
const latest = ledgerRows.at(-1);
if (!latest) throw new Error("Yield ledger produced no rows");
const latestGuarded = publications.at(-1);
const august13 = ledgerRows.find((row) => row.as_of_date === "2026-08-13") ?? null;
console.log(
  JSON.stringify(
    {
      strategy: STRATEGY_NAME,
      apply,
      ledger_version: LEDGER_VERSION,
      inception_date: inceptionDate,
      end_date: endDate,
      completed_boundary_count: boundaries.length,
      reversed_batch_count: reversed.length,
      gross_fill_residual_cents: grossCash,
      active_rule_cash_cents: anchoredCash,
      cumulative_execution_cost_cents: cumulativeExecutionCost,
      carry_forward_leg_count: carryForwardCount,
      session_rows: ledgerRows.length,
      existing_rows: existingRows.length,
      rows_to_insert: rowsToInsert.length,
      draft_conflicts: conflicts,
      rows_to_replace: rowsToReplace.length,
      rows_written: apply ? rowsToWrite.length : 0,
      latest: {
        as_of_date: latest.as_of_date,
        securities_value_cents: latest.securities_value_cents,
        continuity_cash_cents: latest.continuity_cash_cents,
        complete_value_cents: latest.complete_value_cents,
        period_returns: Object.fromEntries(
          Object.entries(latest.period_metrics).map(([period, metric]) => [period, metric.return_pct]),
        ),
        current_legs: navRows.at(-1)?.legs ?? [],
      },
      august_13_checkpoint: august13
        ? {
            securities_value_cents: august13.securities_value_cents,
            continuity_cash_cents: august13.continuity_cash_cents,
            complete_value_cents: august13.complete_value_cents,
            period_returns: Object.fromEntries(
              Object.entries(august13.period_metrics).map(([period, metric]) => [period, metric.return_pct]),
            ),
            current_legs: navRows.find((row) => row.date === "2026-08-13")?.legs ?? [],
          }
        : null,
      latest_guarded: latestGuarded ?? null,
      latest_variance_cents: latest.complete_value_cents - Number(latestGuarded?.complete_value_cents ?? 0),
      public_return_changed: false,
    },
    null,
    2,
  ),
);
