import { createHash } from "node:crypto";

import { createRetailServiceRoleClient } from "../src/lib/supabase/server";

const STRATEGY_NAME = "MyGrowthFund";
const LEDGER_VERSION = "excel-multi-boundary-leg-pnl-v1";
const apply = process.env.APPLY_CANONICAL_LEDGER_DRAFT === "1";
const replaceConflictingDraft = process.env.REPLACE_CONFLICTING_CANONICAL_DRAFT === "1";
const db = createRetailServiceRoleClient();

type Holding = { ticker: string; units: number };
type StoredClose = { symbol: string; as_of_date: string; current_price: number; fetched_at: string };
type Composition = {
  effective_from: string;
  effective_to: string | null;
  holdings: unknown;
  created_at: string;
};
type Batch = {
  id: string;
  status: string;
  settlement_state: string;
  effective_date: string;
  created_at: string;
  holdings_snapshot_before: unknown;
};
type Fill = {
  batch_id: string;
  security_id: string;
  trade_side: string;
  quantity: number;
  avg_fill: number;
  fill_date: string;
};
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
  return symbol
    .trim()
    .toUpperCase()
    .replace(/\.(JO|JSE)$/i, "");
}

function parseHoldings(value: unknown): Holding[] {
  return (Array.isArray(value) ? value : [])
    .map((row) => ({
      ticker: bare(String(row.ticker ?? row.symbol ?? "")),
      units: Number(row.quantity ?? row.shares ?? 0),
    }))
    .filter((row) => row.ticker && row.units > 0);
}

function holdingsMap(holdings: Holding[]): Map<string, number> {
  return new Map(holdings.map((holding) => [holding.ticker, holding.units] as const));
}

function sameHoldings(left: Holding[], right: Holding[]): boolean {
  const a = holdingsMap(left);
  const b = holdingsMap(right);
  const tickers = new Set([...a.keys(), ...b.keys()]);
  return [...tickers].every((ticker) => (a.get(ticker) ?? 0) === (b.get(ticker) ?? 0));
}

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
  const result: StoredClose[] = [];
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
    result.push(...page);
    if (page.length < 1000) break;
  }
  return result;
}

const strategy = await one<{ id: string; name: string; status: string; created_at: string }>(
  "MyGrowth strategy",
  db.from("strategies_c").select("id,name,status,created_at").eq("name", STRATEGY_NAME).maybeSingle(),
);
if (strategy.status !== "active") throw new Error("MyGrowthFund is not active");

const [compositions, batches, reconciliations, publications, existingRows] = await Promise.all([
  many<Composition>(
    "composition history",
    db
      .from("strategy_composition_log_c")
      .select("effective_from,effective_to,holdings,created_at")
      .eq("strategy_id", strategy.id)
      .order("created_at"),
  ),
  many<Batch>(
    "rebalance batches",
    db
      .from("rebalance_batch")
      .select("id,status,settlement_state,effective_date,created_at,holdings_snapshot_before")
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
  }>(
    "existing canonical rows",
    db
      .from("strategy_canonical_daily_ledger_c")
      .select(
        "as_of_date,ledger_version,certification_status,securities_value_cents,continuity_cash_cents,complete_value_cents",
      )
      .eq("strategy_id", strategy.id),
  ),
]);

if (compositions.length !== 4 || batches.length !== 3 || reconciliations.length !== 3) {
  throw new Error(
    `expected 4 compositions, 3 batches and 3 CA reconciliations; got ${compositions.length}/${batches.length}/${reconciliations.length}`,
  );
}
if (batches.some((batch) => batch.status !== "SETTLED" || batch.settlement_state !== "COMPLETE")) {
  throw new Error("all MyGrowth boundaries must be SETTLED and COMPLETE");
}

const batchIds = batches.map((batch) => batch.id);
const [fills, securities] = await Promise.all([
  many<Fill>(
    "rebalance fills",
    db
      .from("rebalance_event")
      .select("batch_id,security_id,trade_side,quantity,avg_fill,fill_date")
      .in("batch_id", batchIds),
  ),
  many<{ id: string; symbol: string }>(
    "rebalance securities",
    db
      .from("securities_c")
      .select("id,symbol")
      .in("id", [
        ...new Set(
          (
            await many<Fill>(
              "rebalance fill security ids",
              db.from("rebalance_event").select("security_id").in("batch_id", batchIds),
            )
          ).map((fill) => fill.security_id),
        ),
      ]),
  ),
]);
const securityTicker = new Map(securities.map((security) => [security.id, bare(security.symbol)] as const));
const reconciliationByBatch = new Map(reconciliations.map((row) => [row.batch_id, row] as const));

const orderedCompositions = compositions.slice().sort((a, b) => a.created_at.localeCompare(b.created_at));
const initialHoldings = parseHoldings(orderedCompositions[0].holdings);
const boundarySequenceByDate = new Map<string, number>();
const boundaries: Array<{
  batch: Batch;
  afterComposition: Composition;
  afterHoldings: Holding[];
  deltas: Map<string, number>;
  representativePrices: Map<string, number>;
  reconciliation: (typeof reconciliations)[number];
}> = [];
for (const batch of batches) {
  const sequence = boundarySequenceByDate.get(batch.effective_date) ?? 0;
  const afterComposition = orderedCompositions
    .filter((composition) => composition.effective_from === batch.effective_date)
    .sort((a, b) => a.created_at.localeCompare(b.created_at))[sequence];
  if (!afterComposition) throw new Error(`no composition recorded after batch ${batch.id}`);
  const beforeHoldings = parseHoldings(batch.holdings_snapshot_before);
  const afterHoldings = parseHoldings(afterComposition.holdings);
  const expectedBefore = boundaries.at(-1)?.afterHoldings ?? initialHoldings;
  if (!sameHoldings(beforeHoldings, expectedBefore))
    throw new Error(`batch ${batch.id} before snapshot breaks composition chain`);
  const before = holdingsMap(beforeHoldings);
  const after = holdingsMap(afterHoldings);
  const tickers = [...new Set([...before.keys(), ...after.keys()])];
  const deltas = new Map(
    tickers.map((ticker) => [ticker, (after.get(ticker) ?? 0) - (before.get(ticker) ?? 0)] as const),
  );
  const batchFills = fills.filter((fill) => fill.batch_id === batch.id);
  const representativePrices = new Map<string, number>();
  for (const [ticker, delta] of deltas) {
    if (delta === 0) continue;
    const side = delta > 0 ? "BUY" : "SELL";
    const matching = batchFills.filter(
      (fill) => securityTicker.get(fill.security_id) === ticker && fill.trade_side === side,
    );
    const prices = [...new Set(matching.map((fill) => Number(fill.avg_fill)))];
    if (
      matching.length === 0 ||
      prices.length !== 1 ||
      !matching.some((fill) => Number(fill.quantity) === Math.abs(delta))
    ) {
      throw new Error(
        `batch ${batch.id} lacks one unambiguous model fill for ${ticker} ${side} ${Math.abs(delta)}`,
      );
    }
    representativePrices.set(`${ticker}:${side}`, prices[0]);
  }
  const reconciliation = reconciliationByBatch.get(batch.id);
  if (!reconciliation) throw new Error(`batch ${batch.id} has no CA reconciliation`);
  boundaries.push({ batch, afterComposition, afterHoldings, deltas, representativePrices, reconciliation });
  boundarySequenceByDate.set(batch.effective_date, sequence + 1);
}

const endDate = publications.at(-1)?.as_of_date;
if (!endDate) throw new Error("MyGrowth has no guarded publication end date");
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
if (dates.length === 0) throw new Error("no JSE sessions in the MyGrowth range");
const inceptionDate = dates[0];
const allTickers = [
  ...new Set(
    orderedCompositions.flatMap((composition) =>
      parseHoldings(composition.holdings).map((holding) => holding.ticker),
    ),
  ),
];
const prices = await fetchStoredCloses(
  allTickers.flatMap((ticker) => [ticker, `${ticker}.JO`]),
  addDays(inceptionDate, -31),
  endDate,
);
const priceByKey = new Map<string, { cents: number; fetchedAt: string }>();
for (const price of prices) {
  const cents = Number(price.current_price);
  if (cents > 0 && price.fetched_at)
    priceByKey.set(`${price.as_of_date}:${bare(price.symbol)}`, { cents, fetchedAt: price.fetched_at });
}

function compositionForDate(date: string): Holding[] {
  const eligible = orderedCompositions
    .filter(
      (composition) =>
        composition.effective_from <= date && (!composition.effective_to || composition.effective_to >= date),
    )
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
  if (eligible.length === 0) throw new Error(`no composition for ${date}`);
  return parseHoldings(eligible[0].holdings);
}

function cashForDate(date: string): number {
  return (
    boundaries
      .filter((boundary) => boundary.batch.effective_date <= date)
      .sort((a, b) => b.batch.created_at.localeCompare(a.batch.created_at))[0]?.reconciliation
      .strategy_ca_cents ?? 0
  );
}

const lastPrice = new Map<string, { cents: number; fetchedAt: string; asOfDate: string }>();
for (const price of prices.slice().sort((a, b) => a.as_of_date.localeCompare(b.as_of_date))) {
  if (price.as_of_date >= inceptionDate) break;
  const cents = Number(price.current_price);
  if (cents > 0)
    lastPrice.set(bare(price.symbol), { cents, fetchedAt: price.fetched_at, asOfDate: price.as_of_date });
}
let carryForwardCount = 0;
const missing: string[] = [];
const navRows = dates.map((date) => {
  const holdings = compositionForDate(date);
  const legs = holdings.map((holding) => {
    const exact = priceByKey.get(`${date}:${holding.ticker}`);
    if (exact) lastPrice.set(holding.ticker, { ...exact, asOfDate: date });
    const price = exact ? { ...exact, asOfDate: date } : lastPrice.get(holding.ticker);
    if (!price) missing.push(`${date}:${holding.ticker}`);
    if (!exact && price) carryForwardCount += 1;
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
  const securitiesValueCents = legs.reduce((sum, leg) => sum + leg.market_value_cents, 0);
  const continuityCashCents = Number(cashForDate(date));
  return {
    date,
    legs,
    securitiesValueCents,
    continuityCashCents,
    completeValueCents: securitiesValueCents + continuityCashCents,
  };
});
if (missing.length > 0)
  throw new Error(
    `missing ${missing.length} prices without a prior close: ${missing.slice(0, 30).join(", ")}`,
  );

function storedPriceOnOrBefore(ticker: string, date: string): number {
  const match = prices
    .filter(
      (price) => bare(price.symbol) === ticker && price.as_of_date <= date && Number(price.current_price) > 0,
    )
    .sort((a, b) => b.as_of_date.localeCompare(a.as_of_date) || b.fetched_at.localeCompare(a.fetched_at))[0];
  if (!match) throw new Error(`no stored price for ${ticker} on or before ${date}`);
  return Number(match.current_price);
}

const ledgerLegs: LedgerLeg[] = initialHoldings.map((holding) => ({
  ticker: holding.ticker,
  leg: "Inception leg",
  units: holding.units,
  entryDate: inceptionDate,
  entryPriceCents: storedPriceOnOrBefore(holding.ticker, inceptionDate),
  exitDate: null,
  exitPriceCents: null,
  sourceRef: "initial_composition",
}));
let activeCashCents = 0;
for (const boundary of boundaries) {
  for (const [ticker, delta] of boundary.deltas) {
    if (delta >= 0) continue;
    const sellPriceCents = boundary.representativePrices.get(`${ticker}:SELL`);
    if (!sellPriceCents) throw new Error(`missing validated sell price for ${ticker}`);
    let unitsToClose = -delta;
    for (const leg of ledgerLegs.filter((candidate) => candidate.ticker === ticker && !candidate.exitDate)) {
      if (unitsToClose <= 0) break;
      const closedUnits = Math.min(unitsToClose, leg.units);
      if (closedUnits < leg.units) {
        ledgerLegs.push({ ...leg, units: leg.units - closedUnits });
        leg.units = closedUnits;
      }
      leg.exitDate = boundary.batch.effective_date;
      leg.exitPriceCents = sellPriceCents;
      leg.sourceRef = `rebalance_batch:${boundary.batch.id}`;
      unitsToClose -= closedUnits;
    }
    if (unitsToClose !== 0) throw new Error(`could not close ${-delta} model units of ${ticker}`);
  }
  for (const [ticker, delta] of boundary.deltas) {
    if (delta <= 0) continue;
    const buyPriceCents = boundary.representativePrices.get(`${ticker}:BUY`);
    if (!buyPriceCents) throw new Error(`missing validated buy price for ${ticker}`);
    ledgerLegs.push({
      ticker,
      leg: "Rebalance buy",
      units: delta,
      entryDate: boundary.batch.effective_date,
      entryPriceCents: buyPriceCents,
      exitDate: null,
      exitPriceCents: null,
      sourceRef: `rebalance_batch:${boundary.batch.id}`,
    });
  }
  const nextCashCents = Number(boundary.reconciliation.strategy_ca_cents);
  if (nextCashCents < activeCashCents)
    throw new Error(`unsupported model CA reduction at batch ${boundary.batch.id}`);
  if (nextCashCents > activeCashCents) {
    ledgerLegs.push({
      ticker: "CASH",
      leg: "Authoritative strategy CA",
      units: 1,
      entryDate: boundary.batch.effective_date,
      entryPriceCents: nextCashCents - activeCashCents,
      exitDate: null,
      exitPriceCents: null,
      sourceRef: `rebalance_batch:${boundary.batch.id}`,
      isCash: true,
    });
  }
  activeCashCents = nextCashCents;
}

function rowOnOrBefore(target: string, currentIndex: number) {
  for (let index = currentIndex; index >= 0; index -= 1)
    if (navRows[index].date <= target) return navRows[index];
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
    if (leg.exitDate && leg.exitDate <= referenceDate) return [];
    const benchmarkCents = valueForLeg(leg, referenceDate);
    const numeratorCents =
      leg.exitDate && leg.exitDate <= current.date
        ? leg.units * Number(leg.exitPriceCents)
        : valueForLeg(leg, current.date);
    return [
      {
        ticker: leg.ticker,
        leg: leg.leg,
        reference_date: referenceDate,
        benchmark_cents: benchmarkCents,
        numerator_cents: numeratorCents,
        pnl_cents: numeratorCents - benchmarkCents,
      },
    ];
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
  boundary_batches: boundaries.map((boundary) => ({
    id: boundary.batch.id,
    effective_date: boundary.batch.effective_date,
    created_at: boundary.batch.created_at,
    model_capital_cents: boundary.reconciliation.model_capital_cents,
    securities_value_cents: boundary.reconciliation.securities_value_cents,
    strategy_ca_cents: boundary.reconciliation.strategy_ca_cents,
    capital_source: boundary.reconciliation.capital_source,
    deltas: Object.fromEntries(boundary.deltas),
  })),
  owner_exception_excluded_from_model: "Ncumolwethu 5 STXACW fill does not alter public model quantity 4",
  price_source: "stock_returns_c exact JSE-session close with labelled prior-close carry-forward",
  carry_forward_leg_count: carryForwardCount,
  public_visibility: "DRAFT_NOT_EXPOSED",
};
const sourceEvidenceHash = createHash("sha256").update(JSON.stringify(sourceEvidence)).digest("hex");
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
        leg.exitDate && leg.exitDate <= current.date
          ? leg.units * Number(leg.exitPriceCents)
          : valueForLeg(leg, current.date),
    })),
  period_metrics: {
    "1D": metric(index, addDays(current.date, -1)),
    "1W": metric(index, addDays(current.date, -7)),
    WTD: metric(index, previousWeekEnd(current.date)),
    "1M": metric(index, addMonths(current.date, -1)),
    "3M": metric(index, addMonths(current.date, -3)),
    YTD: metric(index, `${Number(current.date.slice(0, 4)) - 1}-12-31`),
    SI: metric(index, inceptionDate),
  },
  source_evidence: sourceEvidence,
  source_evidence_sha256: sourceEvidenceHash,
  calculation_notes: {
    method: LEDGER_VERSION,
    return_method: "WORKBOOK_LEG_PNL_OVER_LEG_BENCHMARK",
    report_mode: "UPSERT_DRAFT_ONLY",
    promotion_blocked: true,
    certification_requirements: [
      "independent workbook comparison",
      "independent provider price signoff",
      "period return tolerance review",
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
    Number(existing.securities_value_cents) === computed.securities_value_cents &&
    Number(existing.continuity_cash_cents) === computed.continuity_cash_cents &&
    Number(existing.complete_value_cents) === computed.complete_value_cents;
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
if (conflicts.some((conflict) => conflict.certification_status !== "DRAFT")) {
  throw new Error(`refusing non-DRAFT conflicts: ${JSON.stringify(conflicts)}`);
}
if (apply && conflicts.length > 0 && !replaceConflictingDraft) {
  throw new Error(`set REPLACE_CONFLICTING_CANONICAL_DRAFT=1: ${JSON.stringify(conflicts)}`);
}
const existingDates = new Set(existingRows.map((row) => row.as_of_date));
const rowsToInsert = ledgerRows.filter((row) => !existingDates.has(row.as_of_date));
const conflictDates = new Set(conflicts.map((conflict) => conflict.as_of_date));
const rowsToReplace = ledgerRows.filter((row) => conflictDates.has(row.as_of_date));
const rowsToWrite = replaceConflictingDraft ? [...rowsToInsert, ...rowsToReplace] : rowsToInsert;
if (apply && rowsToWrite.length > 0) {
  const { error } = await db
    .from("strategy_canonical_daily_ledger_c")
    .upsert(rowsToWrite, { onConflict: "strategy_id,as_of_date" });
  if (error) throw new Error(`atomic DRAFT upsert failed: ${error.message}`);
}

const publicationByDate = new Map(publications.map((row) => [row.as_of_date, row] as const));
const latest = ledgerRows.at(-1);
if (!latest) throw new Error("canonical ledger produced no rows");
console.log(
  JSON.stringify(
    {
      strategy: STRATEGY_NAME,
      apply,
      ledger_version: LEDGER_VERSION,
      inception_date: inceptionDate,
      end_date: endDate,
      boundary_count: boundaries.length,
      boundary_evidence: sourceEvidence.boundary_batches,
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
        period_metrics: latest.period_metrics,
      },
      latest_guarded: publicationByDate.get(endDate) ?? null,
      latest_variance_cents:
        latest.complete_value_cents - Number(publicationByDate.get(endDate)?.complete_value_cents ?? 0),
    },
    null,
    2,
  ),
);
