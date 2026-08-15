import { createHash } from "node:crypto";

import { createRetailServiceRoleClient } from "../src/lib/supabase/server";

const ALLOWED_STRATEGIES = new Set(["MINT Diversified Basket", "MINT Multi-sector"]);
const STRATEGY_NAME = process.env.STAGE_STRATEGY_NAME?.trim() ?? "";
const LEDGER_VERSION = "excel-composition-proxy-leg-pnl-v1";
const apply = process.env.APPLY_CANONICAL_LEDGER_DRAFT === "1";
const replaceConflictingDraft = process.env.REPLACE_CONFLICTING_CANONICAL_DRAFT === "1";
const db = createRetailServiceRoleClient();

if (!ALLOWED_STRATEGIES.has(STRATEGY_NAME)) {
  throw new Error(`STAGE_STRATEGY_NAME must be one of: ${[...ALLOWED_STRATEGIES].join(", ")}`);
}

type Holding = { ticker: string; units: number };
type Composition = {
  effective_from: string;
  effective_to: string | null;
  holdings: unknown;
  created_at: string;
};
type StoredClose = {
  symbol: string;
  as_of_date: string;
  current_price: number;
  fetched_at: string;
};
type LedgerLeg = {
  ticker: string;
  leg: "Inception leg" | "Composition increase";
  units: number;
  entryDate: string;
  entryPriceCents: number;
  exitDate: string | null;
  exitPriceCents: number | null;
  sourceRef: string;
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

function holdingMap(holdings: Holding[]): Map<string, number> {
  return new Map(holdings.map((holding) => [holding.ticker, holding.units]));
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
  "strategy",
  db.from("strategies_c").select("id,name,status,created_at").eq("name", STRATEGY_NAME).maybeSingle(),
);
if (strategy.status !== "active") throw new Error(`${STRATEGY_NAME} is not active`);

const [compositions, batches, reconciliations, publications, existingRows] = await Promise.all([
  many<Composition>(
    "composition history",
    db
      .from("strategy_composition_log_c")
      .select("effective_from,effective_to,holdings,created_at")
      .eq("strategy_id", strategy.id)
      .order("effective_from"),
  ),
  many<{ id: string }>(
    "rebalance batches",
    db.from("rebalance_batch").select("id").eq("strategy_id", strategy.id),
  ),
  many<{ id: string }>(
    "CA reconciliations",
    db.from("strategy_rebalance_ca_reconciliation_c").select("id").eq("strategy_id", strategy.id),
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
  }>(
    "existing canonical rows",
    db
      .from("strategy_canonical_daily_ledger_c")
      .select(
        "as_of_date,ledger_version,certification_status,securities_value_cents,continuity_cash_cents,complete_value_cents,source_evidence_sha256",
      )
      .eq("strategy_id", strategy.id),
  ),
]);

if (compositions.length < 2) throw new Error("composition-proxy staging requires at least two compositions");
if (batches.length !== 0 || reconciliations.length !== 0) {
  throw new Error(
    "refusing proxy staging because settlement or model-CA evidence now exists; use the evidence-backed path",
  );
}
const latestPublicationDate = publications.at(-1)?.as_of_date;
if (!latestPublicationDate) throw new Error(`${STRATEGY_NAME} has no guarded publication`);
const endDate = process.env.CANONICAL_LEDGER_END_DATE?.trim() || latestPublicationDate;
if (endDate < latestPublicationDate || endDate > iso(new Date())) {
  throw new Error(`CANONICAL_LEDGER_END_DATE must be between ${latestPublicationDate} and today`);
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
if (!inceptionDate) throw new Error("no JSE sessions in strategy range");

function compositionForDate(date: string): Composition {
  const eligible = compositions.filter(
    (composition) =>
      composition.effective_from <= date && (!composition.effective_to || composition.effective_to >= date),
  );
  if (eligible.length !== 1)
    throw new Error(`expected exactly one composition for ${date}, found ${eligible.length}`);
  return eligible[0];
}

for (const date of dates) compositionForDate(date);
const tickers = [
  ...new Set(compositions.flatMap((composition) => parseHoldings(composition.holdings).map((h) => h.ticker))),
];
const aliases = tickers.flatMap((ticker) => [ticker, `${ticker}.JO`]);
const prices = await fetchStoredCloses(aliases, addDays(inceptionDate, -14), endDate);
const priceByKey = new Map<string, { cents: number; fetchedAt: string }>();
for (const price of prices) {
  if (Number(price.current_price) > 0 && price.fetched_at) {
    priceByKey.set(`${price.as_of_date}:${bare(price.symbol)}`, {
      cents: Number(price.current_price),
      fetchedAt: price.fetched_at,
    });
  }
}

function storedPriceOnOrBefore(
  ticker: string,
  date: string,
): { cents: number; asOfDate: string; fetchedAt: string } {
  const match = prices
    .filter(
      (price) => bare(price.symbol) === ticker && price.as_of_date <= date && Number(price.current_price) > 0,
    )
    .sort((a, b) => b.as_of_date.localeCompare(a.as_of_date) || b.fetched_at.localeCompare(a.fetched_at))[0];
  if (!match) throw new Error(`no stored price for ${ticker} on or before ${date}`);
  return { cents: Number(match.current_price), asOfDate: match.as_of_date, fetchedAt: match.fetched_at };
}

const inceptionComposition = compositionForDate(inceptionDate);
const boundaryCompositions = [
  inceptionComposition,
  ...compositions.filter(
    (composition) =>
      composition !== inceptionComposition &&
      composition.effective_from > inceptionDate &&
      composition.effective_from <= endDate,
  ),
];
const boundaries = boundaryCompositions.slice(1).map((composition, index) => {
  const before = parseHoldings(boundaryCompositions[index].holdings);
  const after = parseHoldings(composition.holdings);
  const beforeMap = holdingMap(before);
  const afterMap = holdingMap(after);
  const changedTickers = [...new Set([...beforeMap.keys(), ...afterMap.keys()])].filter(
    (ticker) => (afterMap.get(ticker) ?? 0) !== (beforeMap.get(ticker) ?? 0),
  );
  const boundaryPriceEvidence = Object.fromEntries(
    changedTickers.map((ticker) => {
      const exact = priceByKey.get(`${composition.effective_from}:${ticker}`);
      const price = exact
        ? { ...exact, asOfDate: composition.effective_from }
        : storedPriceOnOrBefore(ticker, composition.effective_from);
      return [
        ticker,
        {
          price_cents: price.cents,
          price_date: price.asOfDate,
          source: exact ? "EXACT_STORED_EOD_CLOSE" : "STORED_PRIOR_CLOSE_BOUNDARY_PROXY",
        },
      ];
    }),
  );
  return {
    effectiveDate: composition.effective_from,
    sourceCreatedAt: composition.created_at,
    before,
    after,
    deltas: new Map(
      changedTickers.map((ticker) => [ticker, (afterMap.get(ticker) ?? 0) - (beforeMap.get(ticker) ?? 0)]),
    ),
    boundaryPriceEvidence,
  };
});

const lastPrice = new Map<string, { cents: number; fetchedAt: string; asOfDate: string }>();
for (const price of prices.filter((price) => price.as_of_date < inceptionDate)) {
  if (Number(price.current_price) > 0) {
    lastPrice.set(bare(price.symbol), {
      cents: Number(price.current_price),
      fetchedAt: price.fetched_at,
      asOfDate: price.as_of_date,
    });
  }
}
let carryForwardLegCount = 0;
const missingPrices: string[] = [];
const navRows = dates.map((date) => {
  const holdings = parseHoldings(compositionForDate(date).holdings);
  const legs = holdings.map((holding) => {
    const exact = priceByKey.get(`${date}:${holding.ticker}`);
    if (exact) lastPrice.set(holding.ticker, { ...exact, asOfDate: date });
    const price = exact ? { ...exact, asOfDate: date } : lastPrice.get(holding.ticker);
    if (!price) missingPrices.push(`${date}:${holding.ticker}`);
    if (!exact && price) carryForwardLegCount += 1;
    const closeCents = price?.cents ?? 0;
    return {
      ticker: holding.ticker,
      units: holding.units,
      close_cents: closeCents,
      market_value_cents: holding.units * closeCents,
      price_as_of_date: price?.asOfDate ?? null,
      price_fetched_at: price?.fetchedAt ?? null,
      source: exact ? "STORED_EOD_CLOSE" : "STORED_PRIOR_CLOSE_CARRY_FORWARD",
    };
  });
  const securitiesValueCents = legs.reduce((sum, leg) => sum + leg.market_value_cents, 0);
  return { date, legs, securitiesValueCents, completeValueCents: securitiesValueCents };
});
if (missingPrices.length > 0) {
  throw new Error(
    `missing ${missingPrices.length} prices without a prior close: ${missingPrices.slice(0, 30).join(", ")}`,
  );
}

const initialHoldings = parseHoldings(compositionForDate(inceptionDate).holdings);
const ledgerLegs: LedgerLeg[] = initialHoldings.map((holding) => ({
  ticker: holding.ticker,
  leg: "Inception leg",
  units: holding.units,
  entryDate: inceptionDate,
  entryPriceCents: storedPriceOnOrBefore(holding.ticker, inceptionDate).cents,
  exitDate: null,
  exitPriceCents: null,
  sourceRef: "initial_composition",
}));

for (const boundary of boundaries) {
  for (const [ticker, delta] of boundary.deltas) {
    if (delta >= 0) continue;
    let unitsToClose = -delta;
    for (const leg of ledgerLegs.filter((candidate) => candidate.ticker === ticker && !candidate.exitDate)) {
      if (unitsToClose <= 0) break;
      const closedUnits = Math.min(unitsToClose, leg.units);
      if (closedUnits < leg.units) {
        ledgerLegs.push({ ...leg, units: leg.units - closedUnits });
        leg.units = closedUnits;
      }
      leg.exitDate = boundary.effectiveDate;
      leg.exitPriceCents = boundary.boundaryPriceEvidence[ticker].price_cents;
      leg.sourceRef = `composition_proxy:${boundary.effectiveDate}`;
      unitsToClose -= closedUnits;
    }
    if (unitsToClose !== 0) throw new Error(`could not close ${-delta} units of ${ticker}`);
  }
  for (const [ticker, delta] of boundary.deltas) {
    if (delta <= 0) continue;
    ledgerLegs.push({
      ticker,
      leg: "Composition increase",
      units: delta,
      entryDate: boundary.effectiveDate,
      entryPriceCents: boundary.boundaryPriceEvidence[ticker].price_cents,
      exitDate: null,
      exitPriceCents: null,
      sourceRef: `composition_proxy:${boundary.effectiveDate}`,
    });
  }
}

function rowOnOrBefore(target: string, currentIndex: number) {
  for (let index = currentIndex; index >= 0; index -= 1) {
    if (navRows[index].date <= target) return navRows[index];
  }
  return navRows[0];
}

function valueForLeg(leg: LedgerLeg, date: string): number {
  if (date === leg.entryDate) return leg.units * leg.entryPriceCents;
  return leg.units * storedPriceOnOrBefore(leg.ticker, date).cents;
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
  boundary_classification: "COMPOSITION_LOG_ONLY_NO_EXECUTION_EVIDENCE",
  boundary_price_policy: "EXACT_OR_PRIOR_STORED_EOD_CLOSE_MODEL_PROXY",
  boundary_count: boundaries.length,
  boundaries: boundaries.map((boundary) => ({
    effective_date: boundary.effectiveDate,
    composition_created_at: boundary.sourceCreatedAt,
    deltas: Object.fromEntries(boundary.deltas),
    boundary_price_evidence: boundary.boundaryPriceEvidence,
  })),
  continuity_cash_policy: "ZERO_NO_RECONCILIATION_NO_INFERENCE",
  price_source: "stock_returns_c exact JSE-session close with labelled prior-close carry-forward",
  carry_forward_leg_count: carryForwardLegCount,
  workbook_reference: {
    file: "MINT_returns_engine_rebalance_clarity_v7_1 (1).xlsx",
    sha256: "bde94581727f9a08232ec5e80f2672bde3a1ef73c733309ec8723fe78bcaa301",
    ledger_sheet: "06_Strategy_Ledger",
    public_view_sheet: "07_Public_Strategy_View",
    formula_match: "LEG_BENCHMARK_NUMERATOR_PNL_AND_RETURN_CELL_PATTERN_MATCHED",
  },
  independent_provider_check: {
    yahoo: "UNAVAILABLE_2026_SERIES_ZERO_BARS",
    iress: "NO_MATCHING_JUNE_EXECUTION_EVIDENCE",
    certification_effect: "BLOCKED",
  },
  public_visibility: "DRAFT_NOT_EXPOSED",
};
const sourceEvidenceHash = createHash("sha256").update(JSON.stringify(sourceEvidence)).digest("hex");
const ledgerRows = navRows.map((current, index) => ({
  strategy_id: strategy.id,
  as_of_date: current.date,
  ledger_version: LEDGER_VERSION,
  certification_status: "DRAFT",
  securities_value_cents: current.securitiesValueCents,
  continuity_cash_cents: 0,
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
      "reviewed June execution or approved model-boundary signoff",
      "independent provider price signoff",
      "period return tolerance review",
    ],
  },
}));

const computedByDate = new Map(ledgerRows.map((row) => [row.as_of_date, row]));
const conflicts = existingRows.flatMap((existing) => {
  const computed = computedByDate.get(existing.as_of_date);
  if (!computed) {
    return [
      {
        as_of_date: existing.as_of_date,
        certification_status: existing.certification_status,
        reason: "outside_computed_range",
      },
    ];
  }
  const matches =
    existing.ledger_version === LEDGER_VERSION &&
    existing.source_evidence_sha256 === sourceEvidenceHash &&
    Number(existing.securities_value_cents) === computed.securities_value_cents &&
    Number(existing.continuity_cash_cents) === 0 &&
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

const latest = ledgerRows.at(-1);
if (!latest) throw new Error("canonical ledger produced no rows");
const latestGuarded = publications.at(-1);
console.log(
  JSON.stringify(
    {
      strategy: STRATEGY_NAME,
      apply,
      ledger_version: LEDGER_VERSION,
      inception_date: inceptionDate,
      end_date: endDate,
      boundary_evidence: sourceEvidence.boundaries,
      carry_forward_leg_count: carryForwardLegCount,
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
        returns: Object.fromEntries(
          Object.entries(latest.period_metrics).map(([period, value]) => [period, value.return_pct]),
        ),
      },
      latest_guarded: latestGuarded ?? null,
      latest_variance_cents: latest.complete_value_cents - Number(latestGuarded?.complete_value_cents ?? 0),
      certification_ready: false,
    },
    null,
    2,
  ),
);
