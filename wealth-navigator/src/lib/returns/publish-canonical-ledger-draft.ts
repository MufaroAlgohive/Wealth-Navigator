import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

import { createRetailServiceRoleClient, isRetailSupabaseConfigured } from "../supabase/server";
import {
  type BoundaryFill,
  type BoundaryReconciliation,
  type SettledBoundaryBatch,
  rebuildLegsAcrossSettledBoundary,
} from "./canonical-rebalance-boundary";
import { resolveJseTradingDay } from "./jse-trading-calendar-fallback";

export type JsonRow = Record<string, unknown>;
type Holding = { ticker: string; units: number };
export type PriceRow = { symbol: string; as_of_date: string; current_price: number; fetched_at: string };
export type CanonicalRow = {
  strategy_id: string;
  as_of_date: string;
  ledger_version: string;
  certification_status: string;
  securities_value_cents: number;
  continuity_cash_cents: number;
  complete_value_cents: number;
  leg_snapshot: JsonRow[];
  period_metrics: Record<string, JsonRow>;
  source_evidence: JsonRow;
  source_evidence_sha256: string;
  calculation_notes: JsonRow;
};

const DAILY_LEDGER_VERSION = "EXCEL_LEG_CANONICAL_DAILY_V1";

export type CanonicalDraftResultRow = {
  strategy: string;
  action: "planned" | "written" | "skipped" | "failed";
  reason?: string;
  asOf?: string;
  completeValueCents?: number;
  ledgerVersion?: string;
  replacedExistingDraft?: boolean;
};

export type CanonicalDraftPublishResult = {
  ok: boolean;
  asOf: string;
  apply: boolean;
  summary: { written: number; planned: number; skipped: number; failed: number; total: number };
  results: CanonicalDraftResultRow[];
  note?: string;
};

export const bare = (symbol: string) =>
  String(symbol ?? "")
    .trim()
    .toUpperCase()
    .replace(/\.(JO|JSE)$/i, "");

export function iso(date: Date) {
  return date.toISOString().slice(0, 10);
}

export function addDays(date: string, days: number) {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return iso(value);
}

export function addMonths(date: string, months: number) {
  const value = new Date(`${date}T00:00:00.000Z`);
  const day = value.getUTCDate();
  value.setUTCDate(1);
  value.setUTCMonth(value.getUTCMonth() + months);
  value.setUTCDate(
    Math.min(day, new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth() + 1, 0)).getUTCDate()),
  );
  return iso(value);
}

export function previousWeekEnd(date: string) {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() - ((value.getUTCDay() + 6) % 7) - 1);
  return iso(value);
}

export function previousMonthEnd(date: string) {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(0);
  return iso(value);
}

export function parseModelHoldings(value: unknown): Holding[] {
  return aggregateHoldings(
    (Array.isArray(value) ? value : [])
      .map((row) => ({
        ticker: bare(String(row.ticker ?? row.symbol ?? "")),
        units: Number(row.quantity ?? row.shares ?? row.units ?? 0),
      }))
      .filter((row) => row.ticker && Number.isFinite(row.units) && row.units > 0),
  );
}

export function activeHoldingsFromLedger(row: Pick<CanonicalRow, "as_of_date" | "leg_snapshot">): Holding[] {
  return aggregateHoldings(
    (Array.isArray(row.leg_snapshot) ? row.leg_snapshot : [])
      .filter((leg) => {
        const ticker = bare(String(leg.ticker ?? leg.symbol ?? ""));
        if (!ticker || ticker === "CASH" || ticker === "EXECUTION_COST") return false;
        if (leg.counts_in_current_strategy === false) return false;
        const exitDate = String(leg.exit_date ?? "");
        return !exitDate || exitDate > row.as_of_date;
      })
      .map((leg) => ({
        ticker: bare(String(leg.ticker ?? leg.symbol ?? "")),
        units: Number(leg.units ?? leg.quantity ?? leg.shares ?? 0),
      }))
      .filter((holding) => holding.units > 0),
  );
}

function aggregateHoldings(rows: Holding[]) {
  const totals = new Map<string, number>();
  for (const row of rows) totals.set(row.ticker, (totals.get(row.ticker) ?? 0) + row.units);
  return [...totals]
    .map(([ticker, units]) => ({ ticker, units }))
    .sort((a, b) => a.ticker.localeCompare(b.ticker));
}

export function sameModelHoldings(left: Holding[], right: Holding[]) {
  if (left.length !== right.length) return false;
  return left.every(
    (holding, index) =>
      holding.ticker === right[index]?.ticker && Math.abs(holding.units - right[index].units) < 1e-9,
  );
}

export function canExtendCanonicalCheckpoint(status: string) {
  return status === "DRAFT" || status === "CERTIFIED";
}

export function appendDailyCertificationEvidence(
  sourceEvidence: JsonRow,
  input: {
    asOf: string;
    currentLegs: Array<{
      ticker: string;
      units: number;
      close_cents: number;
      price_as_of_date: string;
      price_fetched_at: string;
      source: string;
    }>;
    expectedHoldings: number;
    securitiesValueCents: number;
    continuityCashCents: number;
    completeValueCents: number;
  },
) {
  const priorPriceCoverage =
    sourceEvidence.price_coverage &&
    typeof sourceEvidence.price_coverage === "object" &&
    !Array.isArray(sourceEvidence.price_coverage)
      ? sourceEvidence.price_coverage
      : {};
  const priorReconciliation =
    sourceEvidence.reconciliation &&
    typeof sourceEvidence.reconciliation === "object" &&
    !Array.isArray(sourceEvidence.reconciliation)
      ? sourceEvidence.reconciliation
      : {};
  return {
    ...sourceEvidence,
    price_coverage: {
      ...priorPriceCoverage,
      latest_exact_close: {
        as_of_date: input.asOf,
        exact_close_required: true,
        covered_holdings: input.currentLegs.length,
        expected_holdings: input.expectedHoldings,
        legs: input.currentLegs.map((leg) => ({
          ticker: leg.ticker,
          units: leg.units,
          close_cents: leg.close_cents,
          price_as_of_date: leg.price_as_of_date,
          fetched_at: leg.price_fetched_at,
          source: leg.source,
        })),
      },
    },
    reconciliation: {
      ...priorReconciliation,
      latest_daily_value_identity: {
        as_of_date: input.asOf,
        securities_value_cents: input.securitiesValueCents,
        continuity_cash_cents: input.continuityCashCents,
        complete_value_cents: input.completeValueCents,
        equation_passed: input.completeValueCents === input.securitiesValueCents + input.continuityCashCents,
      },
    },
  };
}

function isLegLedger(row: CanonicalRow) {
  return row.leg_snapshot.some(
    (leg) => leg.entry_date != null && leg.entry_price_cents != null && leg.ticker != null,
  );
}

async function many<T>(
  label: string,
  query: PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
) {
  const { data, error } = await query;
  if (error) throw new Error(`${label}: ${error.message}`);
  return data ?? [];
}

export async function fetchPriceHistory(
  db: SupabaseClient,
  symbols: string[],
  startDate: string,
  endDate: string,
) {
  const result: PriceRow[] = [];
  for (let offset = 0; ; offset += 1000) {
    const page = await many<PriceRow>(
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

export function priceLookup(rows: PriceRow[]) {
  const exact = new Map<string, { cents: number; fetchedAt: string }>();
  for (const row of rows) {
    const cents = Number(row.current_price);
    if (cents > 0 && row.fetched_at) {
      exact.set(`${row.as_of_date}:${bare(row.symbol)}`, { cents, fetchedAt: row.fetched_at });
    }
  }
  return {
    exact,
    onOrBefore(ticker: string, date: string) {
      const match = rows
        .filter(
          (row) => bare(row.symbol) === ticker && row.as_of_date <= date && Number(row.current_price) > 0,
        )
        .sort(
          (a, b) => b.as_of_date.localeCompare(a.as_of_date) || b.fetched_at.localeCompare(a.fetched_at),
        )[0];
      return match ? { cents: Number(match.current_price), asOfDate: match.as_of_date } : null;
    },
  };
}

export function rowOnOrBefore(rows: CanonicalRow[], date: string) {
  return rows.filter((row) => row.as_of_date <= date).at(-1) ?? rows[0] ?? null;
}

export function directMetric(rows: CanonicalRow[], current: CanonicalRow, requestedReferenceDate: string) {
  const reference = rowOnOrBefore(rows, requestedReferenceDate) ?? current;
  const denominator = Number(reference.complete_value_cents);
  const pnl = Number(current.complete_value_cents) - denominator;
  return {
    requested_reference_date: requestedReferenceDate,
    reference_date: reference.as_of_date,
    numerator_value_cents: Number(current.complete_value_cents),
    numerator_cents: pnl,
    denominator_cents: denominator,
    pnl_cents: pnl,
    return_pct: denominator > 0 ? (pnl / denominator) * 100 : null,
    method: "UNCHANGED_COMPOSITION_COMPLETE_VALUE",
  };
}

export type NormalizedLeg = {
  ticker: string;
  leg: string;
  units: number;
  entryDate: string;
  entryPriceCents: number;
  exitDate: string | null;
  exitPriceCents: number | null;
  sourceRef: string;
};

export function buildCanonicalInceptionLegs(
  holdings: Array<{ ticker: string; units: number; close_cents: number }>,
  asOf: string,
  continuityCashCents: number,
): NormalizedLeg[] {
  return [
    ...holdings.map((leg) => ({
      ticker: leg.ticker,
      leg: "Inception model leg",
      units: leg.units,
      entryDate: asOf,
      entryPriceCents: leg.close_cents,
      exitDate: null,
      exitPriceCents: null,
      sourceRef: "automatic_inception_exact_close",
    })),
    ...(continuityCashCents > 0
      ? [
          {
            ticker: "CASH",
            leg: "Inception continuity cash",
            units: 1,
            entryDate: asOf,
            entryPriceCents: continuityCashCents,
            exitDate: null,
            exitPriceCents: null,
            sourceRef: "active_valuation_rule",
          },
        ]
      : []),
  ];
}

export function normalizeLedgerLegs(row: CanonicalRow): NormalizedLeg[] {
  return row.leg_snapshot.map((leg) => ({
    ticker: bare(String(leg.ticker ?? "")),
    leg: String(leg.leg ?? "Model leg"),
    units: Number(leg.units ?? 0),
    entryDate: String(leg.entry_date ?? ""),
    entryPriceCents: Number(leg.entry_price_cents ?? 0),
    exitDate: leg.exit_date ? String(leg.exit_date) : null,
    exitPriceCents: leg.exit_price_cents == null ? null : Number(leg.exit_price_cents),
    sourceRef: String(leg.source_ref ?? "canonical_prior_row"),
  }));
}

export function legMetric(
  legs: NormalizedLeg[],
  currentDate: string,
  mappedReferenceDate: string,
  priceOnOrBefore: (ticker: string, date: string) => { cents: number; asOfDate: string } | null,
) {
  const value = (leg: NormalizedLeg, date: string) => {
    if (leg.ticker === "CASH") return leg.entryPriceCents;
    if (date === leg.entryDate) return leg.units * leg.entryPriceCents;
    const price = priceOnOrBefore(leg.ticker, date);
    if (!price) throw new Error(`missing stored close for ${leg.ticker} on or before ${date}`);
    return leg.units * price.cents;
  };
  const legTrace = legs.flatMap((leg) => {
    if (leg.entryDate > currentDate) return [];
    if (leg.ticker === "EXECUTION_COST") {
      if (mappedReferenceDate >= leg.entryDate) return [];
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
    const referenceDate = leg.entryDate > mappedReferenceDate ? leg.entryDate : mappedReferenceDate;
    if (leg.exitDate && leg.exitDate <= referenceDate) return [];
    const benchmark = value(leg, referenceDate);
    const numerator =
      leg.exitDate && leg.exitDate <= currentDate
        ? leg.units * Number(leg.exitPriceCents)
        : value(leg, currentDate);
    return [
      {
        ticker: leg.ticker,
        leg: leg.leg,
        reference_date: referenceDate,
        benchmark_cents: benchmark,
        numerator_cents: numerator,
        pnl_cents: numerator - benchmark,
      },
    ];
  });
  const denominator = legTrace.reduce((sum, leg) => sum + leg.benchmark_cents, 0);
  const numeratorValue = legTrace.reduce((sum, leg) => sum + leg.numerator_cents, 0);
  const pnl = legTrace.reduce((sum, leg) => sum + leg.pnl_cents, 0);
  return {
    requested_reference_date: mappedReferenceDate,
    reference_date: mappedReferenceDate,
    numerator_value_cents: numeratorValue,
    numerator_cents: pnl,
    denominator_cents: denominator,
    pnl_cents: pnl,
    return_pct: denominator > 0 ? (pnl / denominator) * 100 : null,
    leg_trace: legTrace,
  };
}

export async function publishCanonicalLedgerDraft(
  options: {
    asOfDate?: string;
    apply?: boolean;
    replaceExistingDraft?: boolean;
    strategyName?: string;
  } = {},
): Promise<CanonicalDraftPublishResult> {
  const asOf = options.asOfDate ?? new Date().toISOString().slice(0, 10);
  const apply = options.apply === true;
  const replaceExistingDraft = options.replaceExistingDraft === true;
  const empty = { written: 0, planned: 0, skipped: 0, failed: 0, total: 0 };
  if (!isRetailSupabaseConfigured()) {
    return { ok: false, asOf, apply, summary: empty, results: [], note: "retail supabase not configured" };
  }
  const db = createRetailServiceRoleClient();
  const calendar = await db
    .from("jse_trading_calendar")
    .select("is_trading_day")
    .eq("market", "JSE_EQUITIES")
    .eq("trading_date", asOf)
    .maybeSingle();
  if (calendar.error)
    return { ok: false, asOf, apply, summary: empty, results: [], note: calendar.error.message };
  const tradingDay = resolveJseTradingDay(asOf, calendar.data ?? null);
  if (!tradingDay.isTradingDay) {
    return {
      ok: true,
      asOf,
      apply,
      summary: empty,
      results: [],
      note:
        tradingDay.source === "calendar"
          ? "not a JSE trading day (calendar row: is_trading_day=false)"
          : "not a JSE trading day (no calendar row for this date; static weekday/holiday fallback used)",
    };
  }
  const tradingDayNote =
    tradingDay.source === "static_fallback"
      ? "jse_trading_calendar has no row for this date; proceeded using the static weekday/holiday fallback"
      : undefined;

  let strategyQuery = db
    .from("strategies_c")
    .select("id,name,status")
    .eq("status", "active")
    .neq("name", "Test Strategy");
  if (options.strategyName) strategyQuery = strategyQuery.eq("name", options.strategyName);
  const strategyResult = await strategyQuery;
  if (strategyResult.error)
    return { ok: false, asOf, apply, summary: empty, results: [], note: strategyResult.error.message };
  const strategies = strategyResult.data ?? [];
  const results: CanonicalDraftResultRow[] = [];
  let written = 0;
  let planned = 0;
  let skipped = 0;
  let failed = 0;

  for (const strategy of strategies) {
    try {
      const [ledgerRows, compositionRows, ruleRows] = await Promise.all([
        many<CanonicalRow>(
          "canonical rows",
          db
            .from("strategy_canonical_daily_ledger_c")
            .select("*")
            .eq("strategy_id", strategy.id)
            .lte("as_of_date", asOf)
            .order("as_of_date"),
        ),
        many<{ effective_from: string; effective_to: string | null; holdings: unknown }>(
          "composition",
          db
            .from("strategy_composition_log_c")
            .select("effective_from,effective_to,holdings")
            .eq("strategy_id", strategy.id)
            .lte("effective_from", asOf)
            .order("effective_from", { ascending: false }),
        ),
        many<{ effective_from: string; continuity_cash_per_lot_cents: number }>(
          "valuation rule",
          db
            .from("strategy_valuation_rules_c")
            .select("effective_from,continuity_cash_per_lot_cents")
            .eq("strategy_id", strategy.id)
            .eq("status", "ACTIVE")
            .lte("effective_from", asOf)
            .order("effective_from", { ascending: false })
            .limit(1),
        ),
      ]);
      const existingCurrent = ledgerRows.at(-1)?.as_of_date === asOf ? ledgerRows.at(-1) : null;
      if (existingCurrent && !replaceExistingDraft) {
        results.push({ strategy: strategy.name, action: "skipped", reason: "ALREADY_EXISTS", asOf });
        skipped += 1;
        continue;
      }
      if (
        existingCurrent?.certification_status !== undefined &&
        existingCurrent.certification_status !== "DRAFT"
      ) {
        results.push({ strategy: strategy.name, action: "skipped", reason: "EXISTING_ROW_NOT_DRAFT", asOf });
        skipped += 1;
        continue;
      }
      const priorLedgerRows = existingCurrent ? ledgerRows.slice(0, -1) : ledgerRows;
      const previous = priorLedgerRows.at(-1);
      if (previous && !canExtendCanonicalCheckpoint(previous.certification_status)) {
        results.push({ strategy: strategy.name, action: "skipped", reason: "LATEST_ROW_NOT_EXTENDABLE" });
        skipped += 1;
        continue;
      }
      const composition = compositionRows.find((row) => !row.effective_to || row.effective_to >= asOf);
      const rule = ruleRows[0];
      if (!composition || !rule) {
        results.push({
          strategy: strategy.name,
          action: "skipped",
          reason: "MISSING_COMPOSITION_OR_ACTIVE_RULE",
        });
        skipped += 1;
        continue;
      }
      const currentHoldings = parseModelHoldings(composition.holdings);
      if (currentHoldings.length === 0) {
        results.push({ strategy: strategy.name, action: "skipped", reason: "EMPTY_ACTIVE_COMPOSITION" });
        skipped += 1;
        continue;
      }
      const priorHoldings = previous ? activeHoldingsFromLedger(previous) : [];
      const continuityCashCents = Number(rule.continuity_cash_per_lot_cents);
      let boundaryLegs: NormalizedLeg[] | null = null;
      let boundaryEvidence: JsonRow | null = null;
      if (
        (previous && !sameModelHoldings(priorHoldings, currentHoldings)) ||
        (previous && continuityCashCents !== Number(previous.continuity_cash_cents))
      ) {
        const batches = await many<SettledBoundaryBatch>(
          "settled rebalance boundary",
          db
            .from("rebalance_batch")
            .select(
              "id,status,settlement_state,effective_date,is_reversed,holdings_snapshot_before,holdings_snapshot_after,holdings_snapshot_planned",
            )
            .eq("strategy_id", strategy.id)
            .eq("status", "SETTLED")
            .eq("settlement_state", "COMPLETE")
            .eq("is_reversed", false)
            .gt("effective_date", previous.as_of_date)
            .lte("effective_date", asOf)
            .order("effective_date"),
        );
        if (batches.length !== 1) {
          results.push({
            strategy: strategy.name,
            action: "skipped",
            reason:
              batches.length === 0
                ? "REBALANCE_REQUIRES_SETTLED_EVIDENCE_REBUILD"
                : "MULTIPLE_REBALANCE_BOUNDARIES_REQUIRE_ORDERED_REBUILD",
          });
          skipped += 1;
          continue;
        }
        const [batch] = batches;
        if (!batch) throw new Error("REBALANCE_REQUIRES_SETTLED_EVIDENCE_REBUILD");
        const fills = await many<BoundaryFill>(
          "rebalance fills",
          db
            .from("rebalance_event")
            .select("security_id,trade_side,quantity,avg_fill,fill_date")
            .eq("batch_id", batch.id),
        );
        const reconciliations = await many<BoundaryReconciliation>(
          "rebalance CA reconciliation",
          db
            .from("strategy_rebalance_ca_reconciliation_c")
            .select(
              "model_capital_cents,securities_value_cents,strategy_ca_cents,affected_owner_count,reconciled_owner_count,capital_source",
            )
            .eq("batch_id", batch.id),
        );
        if (reconciliations.length !== 1) {
          results.push({
            strategy: strategy.name,
            action: "skipped",
            reason: "REBALANCE_CA_RECONCILIATION_REQUIRED",
          });
          skipped += 1;
          continue;
        }
        const securityIds = [...new Set(fills.map((fill) => fill.security_id).filter(Boolean))];
        const securities = securityIds.length
          ? await many<{ id: string; symbol: string }>(
              "rebalance securities",
              db.from("securities_c").select("id,symbol").in("id", securityIds),
            )
          : [];
        const [reconciliation] = reconciliations;
        if (!reconciliation) throw new Error("REBALANCE_CA_RECONCILIATION_REQUIRED");
        // Actual closes at both the boundary date AND the previous published
        // date, so the boundary check can tell real price movement on
        // untraded legs apart from unexplained cash — see
        // unchangedLegCurrentPrices/unchangedLegPreviousPrices's doc comment
        // on rebuildLegsAcrossSettledBoundary. Deliberately NOT derived from
        // previousLegs' own entryPriceCents (a leg's original cost basis,
        // not a rolling mark) — that was the bug in the first version of
        // this fix. A small, separate fetch spanning both dates rather than
        // reusing the wider `prices`/`lookup` built below: those cover this
        // strategy's full history for the daily-return calc, not yet
        // available at this point in the function.
        const boundaryPrices = await fetchPriceHistory(
          db,
          currentHoldings.flatMap((holding) => [holding.ticker, `${holding.ticker}.JO`]),
          previous.as_of_date < batch.effective_date ? previous.as_of_date : batch.effective_date,
          previous.as_of_date > batch.effective_date ? previous.as_of_date : batch.effective_date,
        );
        const boundaryLookup = priceLookup(boundaryPrices);
        const priceOnOrBefore = (ticker: string, date: string) =>
          boundaryLookup.exact.get(`${date}:${ticker}`) ?? boundaryLookup.onOrBefore(ticker, date) ?? null;
        const unchangedLegCurrentPrices = new Map(
          currentHoldings
            .map((holding) => {
              const price = priceOnOrBefore(holding.ticker, batch.effective_date);
              return price ? ([holding.ticker, price.cents] as const) : null;
            })
            .filter((entry): entry is readonly [string, number] => entry != null),
        );
        const unchangedLegPreviousPrices = new Map(
          currentHoldings
            .map((holding) => {
              const price = priceOnOrBefore(holding.ticker, previous.as_of_date);
              return price ? ([holding.ticker, price.cents] as const) : null;
            })
            .filter((entry): entry is readonly [string, number] => entry != null),
        );
        const rebuilt = rebuildLegsAcrossSettledBoundary({
          previousDate: previous.as_of_date,
          previousHoldings: priorHoldings,
          previousCashCents: Number(previous.continuity_cash_cents),
          previousLegs: normalizeLedgerLegs(previous),
          currentHoldings,
          currentCashCents: continuityCashCents,
          batch,
          fills,
          securitySymbols: new Map(securities.map((security) => [security.id, security.symbol])),
          reconciliation,
          unchangedLegCurrentPrices,
          unchangedLegPreviousPrices,
        });
        boundaryLegs = rebuilt.legs;
        boundaryEvidence = rebuilt.evidence;
      }

      const metricLegs =
        boundaryLegs ?? (previous && isLegLedger(previous) ? normalizeLedgerLegs(previous) : null);
      const tickers = [
        ...new Set([
          ...currentHoldings.map((holding) => holding.ticker),
          ...(metricLegs ?? [])
            .map((leg) => leg.ticker)
            .filter((ticker) => ticker !== "CASH" && ticker !== "EXECUTION_COST"),
        ]),
      ];
      const earliestDate = priorLedgerRows.at(0)?.as_of_date ?? asOf;
      const prices = await fetchPriceHistory(
        db,
        tickers.flatMap((ticker) => [ticker, `${ticker}.JO`]),
        earliestDate,
        asOf,
      );
      const lookup = priceLookup(prices);
      const currentLegs = currentHoldings.map((holding) => {
        const price = lookup.exact.get(`${asOf}:${holding.ticker}`);
        if (!price) throw new Error(`EXACT_CLOSE_MISSING:${holding.ticker}`);
        return {
          ticker: holding.ticker,
          units: holding.units,
          close_cents: price.cents,
          market_value_cents: holding.units * price.cents,
          price_as_of_date: asOf,
          price_fetched_at: price.fetchedAt,
          source: "STORED_EOD_CLOSE",
        };
      });
      const securitiesValueCents = currentLegs.reduce((sum, leg) => sum + leg.market_value_cents, 0);
      const completeValueCents = securitiesValueCents + continuityCashCents;
      const bootstrapLegs = buildCanonicalInceptionLegs(currentLegs, asOf, continuityCashCents);
      const bootstrapEvidence = {
        method: "AUTO_INCEPTION_BOOTSTRAP_V1",
        strategy_name: strategy.name,
        inception_ledger_date: asOf,
        composition_effective_from: composition.effective_from,
        valuation_rule_effective_from: rule.effective_from,
        exact_close_required: true,
        public_visibility: "DRAFT_NOT_EXPOSED",
      };
      const current: CanonicalRow = {
        ...(previous ?? {
          strategy_id: strategy.id,
          ledger_version: DAILY_LEDGER_VERSION,
          certification_status: "DRAFT",
          source_evidence: bootstrapEvidence,
          source_evidence_sha256: createHash("sha256")
            .update(JSON.stringify(bootstrapEvidence))
            .digest("hex"),
          calculation_notes: {},
        }),
        as_of_date: asOf,
        securities_value_cents: securitiesValueCents,
        continuity_cash_cents: continuityCashCents,
        complete_value_cents: completeValueCents,
        leg_snapshot: currentLegs,
        period_metrics: {},
      };
      const references = {
        "1D": addDays(asOf, -1),
        "1W": addDays(asOf, -7),
        WTD: previousWeekEnd(asOf),
        MTD: previousMonthEnd(asOf),
        "1M": addMonths(asOf, -1),
        "3M": addMonths(asOf, -3),
        "6M": addMonths(asOf, -6),
        YTD: `${Number(asOf.slice(0, 4)) - 1}-12-31`,
        SI: earliestDate,
      };
      const allRows = [...priorLedgerRows, current];
      // NOTE (chain-linking fix): return_pct/numerator_cents/denominator_cents/pnl_cents are ALWAYS
      // derived from directMetric()'s complete_value_cents ratio, for every period, regardless of
      // whether the composition changed. complete_value_cents is continuous across rebalances by
      // construction (rebuildLegsAcrossSettledBoundary enforces value continuity at every boundary),
      // so this is equivalent to full segment-by-segment chain-linking without the leg-sum
      // denominator-inflation bug: legMetric() adds each rebalance leg's full purchase price to the
      // denominator as if it were newly-contributed capital, even though it's the same money that
      // came from selling the prior leg. legMetric()'s output (when available) is retained ONLY as
      // leg_trace: supplementary, informational audit detail about which securities contributed what -
      // it must never be read as the authoritative return.
      if (metricLegs || !previous) {
        const normalized = metricLegs ?? bootstrapLegs;
        current.leg_snapshot = normalized.map((leg) => ({
          ticker: leg.ticker,
          leg: leg.leg,
          units: leg.units,
          entry_date: leg.entryDate,
          entry_price_cents: leg.entryPriceCents,
          exit_date: leg.exitDate,
          exit_price_cents: leg.exitPriceCents,
          source_ref: leg.sourceRef,
          counts_in_current_strategy: !leg.exitDate || leg.exitDate > asOf,
          current_or_exit_value_cents:
            leg.ticker === "EXECUTION_COST"
              ? 0
              : leg.exitDate && leg.exitDate <= asOf
                ? leg.units * Number(leg.exitPriceCents)
                : leg.ticker === "CASH"
                  ? leg.entryPriceCents
                  : leg.units *
                    Number(
                      lookup.exact.get(`${asOf}:${leg.ticker}`)?.cents ??
                        lookup.onOrBefore(leg.ticker, asOf)?.cents ??
                        0,
                    ),
        }));
        current.period_metrics = Object.fromEntries(
          Object.entries(references).map(([period, requested]) => {
            const mapped = rowOnOrBefore(allRows, requested)?.as_of_date ?? earliestDate;
            const authoritative = directMetric(allRows, current, requested);
            // leg_trace is supplementary audit detail only; if it can't be built (e.g. a missing
            // stored close for an intermediate leg), that must not block the authoritative
            // value-ratio return from being published.
            let legTrace: unknown;
            try {
              legTrace = legMetric(normalized, asOf, mapped, lookup.onOrBefore).leg_trace;
            } catch {
              legTrace = undefined;
            }
            return [
              period,
              {
                ...authoritative,
                leg_trace: legTrace,
              },
            ];
          }),
        );
      } else {
        current.period_metrics = Object.fromEntries(
          Object.entries(references).map(([period, requested]) => [
            period,
            directMetric(allRows, current, requested),
          ]),
        );
      }
      current.calculation_notes = {
        ...(previous?.calculation_notes ?? {}),
        daily_writer: !previous
          ? "canonical-draft-auto-inception-v1"
          : boundaryEvidence
            ? "canonical-draft-evidence-backed-boundary-v2"
            : "canonical-draft-stable-composition-v1",
        report_mode: "DAILY_DRAFT_APPEND_ONLY",
        promotion_blocked: true,
      };
      if (boundaryEvidence && previous) {
        const priorBoundaries = Array.isArray(previous.source_evidence?.daily_boundaries)
          ? previous.source_evidence.daily_boundaries
          : [];
        current.source_evidence = {
          ...previous.source_evidence,
          daily_boundaries: [...priorBoundaries, boundaryEvidence],
        };
      }
      if (previous) {
        current.source_evidence = appendDailyCertificationEvidence(current.source_evidence, {
          asOf,
          currentLegs,
          expectedHoldings: currentHoldings.length,
          securitiesValueCents,
          continuityCashCents,
          completeValueCents,
        });
        current.source_evidence_sha256 = createHash("sha256")
          .update(JSON.stringify(current.source_evidence))
          .digest("hex");
      }

      if (apply) {
        const write = existingCurrent
          ? db
              .from("strategy_canonical_daily_ledger_c")
              .upsert(current, { onConflict: "strategy_id,as_of_date" })
          : db.from("strategy_canonical_daily_ledger_c").insert(current);
        const { error } = await write;
        if (error) throw new Error(`DRAFT_INSERT_FAILED:${error.message}`);
        written += 1;
      } else {
        planned += 1;
      }
      results.push({
        strategy: strategy.name,
        action: apply ? "written" : "planned",
        asOf,
        replacedExistingDraft: Boolean(existingCurrent),
        completeValueCents,
        ledgerVersion: current.ledger_version,
      });
    } catch (error) {
      failed += 1;
      results.push({
        strategy: strategy.name,
        action: "failed",
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return {
    ok: failed === 0,
    asOf,
    apply,
    summary: { written, planned, skipped, failed, total: strategies.length },
    results,
    ...(tradingDayNote ? { note: tradingDayNote } : {}),
  };
}
