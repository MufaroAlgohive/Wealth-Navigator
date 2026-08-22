import { createHash, randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

import { createRetailServiceRoleClient, isRetailSupabaseConfigured } from "../supabase/server";
import {
  type BoundaryFill,
  type BoundaryReconciliation,
  type SettledBoundaryBatch,
  rebuildLegsAcrossSettledBoundary,
} from "./canonical-rebalance-boundary";
import { type AffectedStrategy, findAffectedStrategies } from "./find-rebalanced-strategies";
import {
  type CanonicalRow,
  type JsonRow,
  type NormalizedLeg,
  type PriceRow,
  activeHoldingsFromLedger,
  addDays,
  addMonths,
  bare,
  buildCanonicalInceptionLegs,
  directMetric,
  fetchPriceHistory,
  legMetric,
  normalizeLedgerLegs,
  parseModelHoldings,
  previousMonthEnd,
  previousWeekEnd,
  priceLookup,
  rowOnOrBefore,
  sameModelHoldings,
} from "./publish-canonical-ledger-draft";

/**
 * Phase 2 bulk historical reprocessor for the canonical-ledger YTD chain-linking fix.
 *
 * publishCanonicalLedgerDraft() (publish-canonical-ledger-draft.ts) is explicitly daily/
 * incremental/append-only - its own calculation_notes tag it "DAILY_DRAFT_APPEND_ONLY" and it only
 * ever computes ONE date (today, by default) against whatever rows already exist. It is not built
 * to rewrite a strategy's full history, and it must not be repurposed to do so: calling it
 * repeatedly for past dates would skip every date whose row is already CERTIFIED (see its
 * `EXISTING_ROW_NOT_DRAFT` / `LATEST_ROW_NOT_EXTENDABLE` guards) - i.e. it would silently do
 * nothing for exactly the historical rows this repair needs to recompute.
 *
 * This module instead walks a strategy's ENTIRE history - from its TRUE inception (strategies_c
 * .created_at, not strategy_composition_log_c.effective_from, which has been confirmed to carry
 * placeholder dates unrelated to when a strategy actually launched) through today - recomputing
 * every daily row with the now-fixed chain-linked logic, entirely in memory (no per-day database
 * round trips), and writes the corrected series into a SEPARATE SHADOW TABLE
 * (strategy_canonical_daily_ledger_repair_c - see the accompanying migration). It never writes to
 * strategy_canonical_daily_ledger_c. Promotion of a shadow row into production is a distinct,
 * explicitly human-invoked step (promote_canonical_ledger_repair_row_c, which itself refuses to
 * touch a CERTIFIED production row) that this module never calls.
 *
 * As much of the actual per-day math as possible is reused, not reinvented, from
 * publish-canonical-ledger-draft.ts: parseModelHoldings, activeHoldingsFromLedger,
 * sameModelHoldings, buildCanonicalInceptionLegs, normalizeLedgerLegs, directMetric,
 * rowOnOrBefore, legMetric, and the period-reference-date helpers are the SAME functions the daily
 * writer uses, now exported for this purpose. rebuildLegsAcrossSettledBoundary (the boundary-leg
 * rebuild used at every rebalance) is reused unchanged from canonical-rebalance-boundary.ts.
 */

const REPAIR_LEDGER_VERSION = "CANONICAL_REPAIR_CHAIN_LINKED_HISTORICAL_V1";
export const CANONICAL_LEDGER_REPAIR_SHADOW_TABLE = "strategy_canonical_daily_ledger_repair_c";

export type RepairedDayRow = CanonicalRow & { repair_run_id: string; carry_forward_price: boolean };

export type RepairInputs = {
  strategyId: string;
  strategyName: string;
  /** JSE trading dates, ascending, from the strategy's true inception through the as-of date. */
  tradingDates: string[];
  compositions: Array<{ effective_from: string; effective_to: string | null; holdings: unknown }>;
  /** ACTIVE valuation-rule rows only, any order. */
  activeRules: Array<{ effective_from: string; continuity_cash_per_lot_cents: number }>;
  /** SETTLED / COMPLETE / not-reversed rebalance_batch rows only, any order. */
  settledBatches: SettledBoundaryBatch[];
  fillsByBatch: Map<string, BoundaryFill[]>;
  reconciliationByBatch: Map<string, BoundaryReconciliation>;
  prices: PriceRow[];
};

export type RepairComputationError = { date: string; reason: string };

export type RepairComputationResult = {
  rows: RepairedDayRow[];
  errors: RepairComputationError[];
  carryForwardCount: number;
  /** true if the walk reached the end of tradingDates with no unrecoverable error. */
  complete: boolean;
};

function activeRuleFor(rules: RepairInputs["activeRules"], date: string) {
  return [...rules]
    .filter((rule) => rule.effective_from <= date)
    .sort((a, b) => a.effective_from.localeCompare(b.effective_from))
    .at(-1);
}

function compositionFor(compositions: RepairInputs["compositions"], date: string) {
  return compositions.find(
    (row) => row.effective_from <= date && (!row.effective_to || row.effective_to >= date),
  );
}

/**
 * The pure, DB-independent core: given a strategy's full prefetched history, recompute every
 * daily canonical row using the fixed chain-linked logic. No network access, so this is directly
 * unit-testable end to end (including the ~10.8-11% Yield Basket regression figure).
 */
export function computeRepairedLedgerSeries(
  input: RepairInputs,
  repairRunId: string,
): RepairComputationResult {
  const lookup = priceLookup(input.prices);
  const rows: RepairedDayRow[] = [];
  const errors: RepairComputationError[] = [];
  let carryForwardCount = 0;
  let previousRow: RepairedDayRow | null = null;
  let previousLegs: NormalizedLeg[] | null = null;

  const batchByEffectiveDate = new Map<string, SettledBoundaryBatch[]>();
  for (const batch of input.settledBatches) {
    const list = batchByEffectiveDate.get(batch.effective_date) ?? [];
    list.push(batch);
    batchByEffectiveDate.set(batch.effective_date, list);
  }

  for (const date of input.tradingDates) {
    const composition = compositionFor(input.compositions, date);
    const rule = activeRuleFor(input.activeRules, date);
    if (!composition || !rule) {
      errors.push({ date, reason: "MISSING_COMPOSITION_OR_ACTIVE_RULE" });
      break;
    }
    const holdings = parseModelHoldings(composition.holdings);
    if (holdings.length === 0) {
      errors.push({ date, reason: "EMPTY_ACTIVE_COMPOSITION" });
      break;
    }
    const continuityCashCents = Number(rule.continuity_cash_per_lot_cents);

    let currentLegs: NormalizedLeg[];
    let boundaryEvidence: JsonRow | null = null;
    try {
      if (!previousRow || !previousLegs) {
        const pricedHoldings = holdings.map((holding) => {
          const priced = priceFor(lookup, holding.ticker, date);
          if (priced.carryForward) carryForwardCount += 1;
          return { ticker: holding.ticker, units: holding.units, close_cents: priced.cents };
        });
        currentLegs = buildCanonicalInceptionLegs(pricedHoldings, date, continuityCashCents).map(
          toNormalizedLeg,
        );
      } else {
        const priorHoldings = activeHoldingsFromLedger(previousRow);
        const compositionChanged = !sameModelHoldings(priorHoldings, holdings);
        const cashChanged = continuityCashCents !== Number(previousRow.continuity_cash_cents);
        if (compositionChanged || cashChanged) {
          const candidates = batchByEffectiveDate.get(date) ?? [];
          if (candidates.length !== 1) {
            errors.push({
              date,
              reason:
                candidates.length === 0
                  ? "REBALANCE_REQUIRES_SETTLED_EVIDENCE_ON_THIS_DATE"
                  : "MULTIPLE_REBALANCE_BOUNDARIES_ON_SAME_DATE",
            });
            break;
          }
          const batch = candidates[0] as SettledBoundaryBatch;
          const fills = input.fillsByBatch.get(batch.id) ?? [];
          const reconciliation = input.reconciliationByBatch.get(batch.id);
          if (!reconciliation) {
            errors.push({ date, reason: "REBALANCE_CA_RECONCILIATION_REQUIRED" });
            break;
          }
          const rebuilt = rebuildLegsAcrossSettledBoundary({
            previousDate: previousRow.as_of_date,
            previousHoldings: priorHoldings,
            previousCashCents: Number(previousRow.continuity_cash_cents),
            previousLegs,
            currentHoldings: holdings,
            currentCashCents: continuityCashCents,
            batch,
            fills,
            securitySymbols: new Map(
              [...new Set(fills.map((fill) => fill.security_id))].map((id) => [id, id]),
            ),
            reconciliation,
          });
          currentLegs = rebuilt.legs.map(toNormalizedLeg);
          boundaryEvidence = rebuilt.evidence;
        } else {
          currentLegs = previousLegs;
        }
      }
    } catch (error) {
      errors.push({ date, reason: error instanceof Error ? error.message : String(error) });
      break;
    }

    const currentLegDetails = holdings.map((holding) => {
      const priced = priceFor(lookup, holding.ticker, date);
      if (priced.carryForward) carryForwardCount += 1;
      return {
        ticker: holding.ticker,
        units: holding.units,
        close_cents: priced.cents,
        market_value_cents: holding.units * priced.cents,
        price_as_of_date: priced.asOfDate,
        source: priced.carryForward ? "STORED_PRIOR_CLOSE_CARRY_FORWARD" : "STORED_EOD_CLOSE",
      };
    });
    const securitiesValueCents = currentLegDetails.reduce((sum, leg) => sum + leg.market_value_cents, 0);
    const completeValueCents = securitiesValueCents + continuityCashCents;

    const current: RepairedDayRow = {
      strategy_id: input.strategyId,
      as_of_date: date,
      ledger_version: REPAIR_LEDGER_VERSION,
      certification_status: "DRAFT",
      securities_value_cents: securitiesValueCents,
      continuity_cash_cents: continuityCashCents,
      complete_value_cents: completeValueCents,
      leg_snapshot: currentLegs.map((leg) => normalizedLegToJson(leg, date, lookup)),
      period_metrics: {},
      source_evidence: {},
      source_evidence_sha256: "",
      calculation_notes: {},
      repair_run_id: repairRunId,
      carry_forward_price: currentLegDetails.some((leg) => leg.source === "STORED_PRIOR_CLOSE_CARRY_FORWARD"),
    };

    const references = {
      "1D": addDays(date, -1),
      "1W": addDays(date, -7),
      WTD: previousWeekEnd(date),
      MTD: previousMonthEnd(date),
      "1M": addMonths(date, -1),
      "3M": addMonths(date, -3),
      "6M": addMonths(date, -6),
      YTD: `${Number(date.slice(0, 4)) - 1}-12-31`,
      SI: input.tradingDates[0] ?? date,
    };
    const allRowsSoFar = [...rows, current];
    current.period_metrics = Object.fromEntries(
      Object.entries(references).map(([period, requested]) => {
        const mapped = rowOnOrBefore(allRowsSoFar, requested)?.as_of_date ?? date;
        const authoritative = directMetric(allRowsSoFar, current, requested);
        let legTrace: unknown;
        try {
          legTrace = legMetric(currentLegs, date, mapped, (ticker, onOrBefore) => {
            const priced = priceFor(lookup, ticker, onOrBefore);
            return { cents: priced.cents, asOfDate: priced.asOfDate };
          }).leg_trace;
        } catch {
          legTrace = undefined;
        }
        return [period, { ...authoritative, leg_trace: legTrace }];
      }),
    );

    current.calculation_notes = {
      repair_run_id: repairRunId,
      daily_writer: !previousRow
        ? "canonical-repair-historical-inception-v1"
        : boundaryEvidence
          ? "canonical-repair-historical-boundary-v1"
          : "canonical-repair-historical-stable-composition-v1",
      report_mode: "HISTORICAL_BULK_REPAIR_SHADOW_ONLY",
      promotion_blocked: true,
      superseded_bug: "leg_sum_denominator_double_counted_recycled_capital",
      superseded_by_pr: "#142",
    };
    const sourceEvidence: JsonRow = {
      methodology: REPAIR_LEDGER_VERSION,
      repair_run_id: repairRunId,
      strategy_inception_date: input.tradingDates[0] ?? date,
      opening_model_snapshot: currentLegDetails,
      ordered_settled_batches: input.settledBatches.map((batch) => batch.id),
      price_coverage: {
        as_of_date: date,
        legs: currentLegDetails,
      },
      reconciliation: {
        as_of_date: date,
        securities_value_cents: securitiesValueCents,
        continuity_cash_cents: continuityCashCents,
        complete_value_cents: completeValueCents,
        equation_passed: completeValueCents === securitiesValueCents + continuityCashCents,
      },
      boundary: boundaryEvidence,
      public_visibility: "SHADOW_NOT_EXPOSED_PENDING_HUMAN_PROMOTION",
    };
    current.source_evidence = sourceEvidence;
    current.source_evidence_sha256 = createHash("sha256")
      .update(JSON.stringify(sourceEvidence))
      .digest("hex");

    rows.push(current);
    previousRow = current;
    previousLegs = currentLegs;
  }

  return { rows, errors, carryForwardCount, complete: errors.length === 0 };
}

function priceFor(lookup: ReturnType<typeof priceLookup>, ticker: string, date: string) {
  const exact = lookup.exact.get(`${date}:${bare(ticker)}`);
  if (exact) return { cents: exact.cents, asOfDate: date, carryForward: false };
  const prior = lookup.onOrBefore(bare(ticker), date);
  if (!prior) throw new Error(`NO_STORED_CLOSE:${ticker}:on-or-before:${date}`);
  return { cents: prior.cents, asOfDate: prior.asOfDate, carryForward: true };
}

function toNormalizedLeg(leg: {
  ticker: string;
  leg: string;
  units: number;
  entryDate: string;
  entryPriceCents: number;
  exitDate: string | null;
  exitPriceCents: number | null;
  sourceRef: string;
}): NormalizedLeg {
  return { ...leg };
}

function normalizedLegToJson(leg: NormalizedLeg, asOf: string, lookup: ReturnType<typeof priceLookup>) {
  const currentOrExitValueCents =
    leg.ticker === "EXECUTION_COST"
      ? 0
      : leg.exitDate && leg.exitDate <= asOf
        ? leg.units * Number(leg.exitPriceCents)
        : leg.ticker === "CASH"
          ? leg.entryPriceCents
          : leg.units * priceFor(lookup, leg.ticker, asOf).cents;
  return {
    ticker: leg.ticker,
    leg: leg.leg,
    units: leg.units,
    entry_date: leg.entryDate,
    entry_price_cents: leg.entryPriceCents,
    exit_date: leg.exitDate,
    exit_price_cents: leg.exitPriceCents,
    source_ref: leg.sourceRef,
    counts_in_current_strategy: !leg.exitDate || leg.exitDate > asOf,
    current_or_exit_value_cents: currentOrExitValueCents,
  };
}

// --- DB orchestration -------------------------------------------------------------------------

async function many<T>(
  label: string,
  query: PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
) {
  const { data, error } = await query;
  if (error) throw new Error(`${label}: ${error.message}`);
  return data ?? [];
}

export type StrategyRepairRunResult = {
  strategyId: string;
  strategyName: string;
  action: "written" | "failed" | "skipped";
  reason?: string;
  inceptionDate?: string;
  endDate?: string;
  rowsComputed?: number;
  carryForwardCount?: number;
  latestCompleteValueCents?: number;
  latestPeriodReturns?: Record<string, number | null>;
};

/** Loads one strategy's full history from the live database and computes its corrected series.
 *  Never writes to strategy_canonical_daily_ledger_c - only ever reads it (to determine what NOT
 *  to conflict with) is not even necessary since the shadow table is entirely separate. */
export async function reprocessStrategyHistory(
  db: SupabaseClient,
  strategy: Pick<AffectedStrategy, "id" | "name" | "createdAt">,
  options: { asOfDate?: string; repairRunId: string },
): Promise<{ result: StrategyRepairRunResult; rows: RepairedDayRow[] }> {
  const asOf = options.asOfDate ?? new Date().toISOString().slice(0, 10);
  const inceptionDate = strategy.createdAt.slice(0, 10);
  try {
    const [sessions, compositions, rules, settledBatches] = await Promise.all([
      many<{ trading_date: string }>(
        "JSE sessions",
        db
          .from("jse_trading_calendar")
          .select("trading_date")
          .eq("market", "JSE_EQUITIES")
          .eq("is_trading_day", true)
          .gte("trading_date", inceptionDate)
          .lte("trading_date", asOf)
          .order("trading_date"),
      ),
      many<{ effective_from: string; effective_to: string | null; holdings: unknown }>(
        "composition history",
        db
          .from("strategy_composition_log_c")
          .select("effective_from,effective_to,holdings")
          .eq("strategy_id", strategy.id)
          .order("effective_from"),
      ),
      many<{ effective_from: string; continuity_cash_per_lot_cents: number; status: string }>(
        "valuation rules",
        db
          .from("strategy_valuation_rules_c")
          .select("effective_from,continuity_cash_per_lot_cents,status")
          .eq("strategy_id", strategy.id)
          .order("effective_from"),
      ),
      many<SettledBoundaryBatch>(
        "settled rebalance batches",
        db
          .from("rebalance_batch")
          .select(
            "id,status,settlement_state,effective_date,is_reversed,holdings_snapshot_before,holdings_snapshot_after,holdings_snapshot_planned",
          )
          .eq("strategy_id", strategy.id)
          .eq("status", "SETTLED")
          .eq("settlement_state", "COMPLETE")
          .eq("is_reversed", false)
          .order("effective_date"),
      ),
    ]);
    const tradingDates = sessions.map((session) => session.trading_date);
    if (!tradingDates.length) {
      return {
        result: {
          strategyId: strategy.id,
          strategyName: strategy.name,
          action: "skipped",
          reason: "NO_JSE_SESSIONS_IN_RANGE",
        },
        rows: [],
      };
    }
    const activeRules = rules.filter((rule) => rule.status === "ACTIVE");
    const batchIds = settledBatches.map((batch) => batch.id);
    const [fills, reconciliations] = await Promise.all([
      batchIds.length
        ? many<BoundaryFill & { batch_id: string }>(
            "rebalance fills",
            db
              .from("rebalance_event")
              .select("batch_id,security_id,trade_side,quantity,avg_fill,fill_date")
              .in("batch_id", batchIds),
          )
        : Promise.resolve([]),
      batchIds.length
        ? many<BoundaryReconciliation & { batch_id: string }>(
            "rebalance CA reconciliation",
            db
              .from("strategy_rebalance_ca_reconciliation_c")
              .select(
                "batch_id,model_capital_cents,securities_value_cents,strategy_ca_cents,affected_owner_count,reconciled_owner_count,capital_source",
              )
              .in("batch_id", batchIds),
          )
        : Promise.resolve([]),
    ]);
    const fillsByBatch = new Map<string, BoundaryFill[]>();
    for (const fill of fills) {
      const list = fillsByBatch.get(fill.batch_id) ?? [];
      list.push(fill);
      fillsByBatch.set(fill.batch_id, list);
    }
    const reconciliationByBatch = new Map(reconciliations.map((row) => [row.batch_id, row] as const));
    const securityIds = [...new Set(fills.map((fill) => fill.security_id).filter(Boolean))];
    const securities = securityIds.length
      ? await many<{ id: string; symbol: string }>(
          "fill securities",
          db.from("securities_c").select("id,symbol").in("id", securityIds),
        )
      : [];
    const symbolBySecurity = new Map(securities.map((row) => [row.id, row.symbol]));
    // rebuildLegsAcrossSettledBoundary keys fills by symbol via securitySymbols; resolve here so
    // the pure computeRepairedLedgerSeries never needs a securities_c lookup of its own.
    for (const fill of fills) {
      fill.security_id = symbolBySecurity.get(fill.security_id) ?? fill.security_id;
    }

    const allTickers = [
      ...new Set(
        compositions.flatMap((composition) => parseModelHoldings(composition.holdings).map((h) => h.ticker)),
      ),
    ];
    const prices = await fetchPriceHistory(
      db,
      allTickers.flatMap((ticker) => [ticker, `${ticker}.JO`]),
      addDays(inceptionDate, -31),
      asOf,
    );

    const computed = computeRepairedLedgerSeries(
      {
        strategyId: strategy.id,
        strategyName: strategy.name,
        tradingDates,
        compositions,
        activeRules,
        settledBatches,
        fillsByBatch,
        reconciliationByBatch,
        prices,
      },
      options.repairRunId,
    );
    if (!computed.rows.length) {
      return {
        result: {
          strategyId: strategy.id,
          strategyName: strategy.name,
          action: "failed",
          reason: computed.errors[0]?.reason ?? "NO_ROWS_COMPUTED",
        },
        rows: [],
      };
    }
    const latest = computed.rows.at(-1) as RepairedDayRow;
    return {
      result: {
        strategyId: strategy.id,
        strategyName: strategy.name,
        action: computed.complete ? "written" : "failed",
        reason: computed.complete
          ? undefined
          : computed.errors.map((e) => `${e.date}:${e.reason}`).join("; "),
        inceptionDate: tradingDates[0],
        endDate: latest.as_of_date,
        rowsComputed: computed.rows.length,
        carryForwardCount: computed.carryForwardCount,
        latestCompleteValueCents: latest.complete_value_cents,
        latestPeriodReturns: Object.fromEntries(
          Object.entries(latest.period_metrics).map(([period, metric]) => [
            period,
            (metric as { return_pct?: number | null }).return_pct ?? null,
          ]),
        ),
      },
      rows: computed.rows,
    };
  } catch (error) {
    return {
      result: {
        strategyId: strategy.id,
        strategyName: strategy.name,
        action: "failed",
        reason: error instanceof Error ? error.message : String(error),
      },
      rows: [],
    };
  }
}

export type PlatformRepairRunResult = {
  ok: boolean;
  repairRunId: string;
  asOf: string;
  discoveredStrategyCount: number;
  summary: { written: number; failed: number; skipped: number };
  results: StrategyRepairRunResult[];
  note?: string;
};

/**
 * Full-platform sweep: finds every strategy that has ever rebalanced (via findAffectedStrategies,
 * not a hardcoded list) and reprocesses each one's complete history into the shadow table. Writes
 * are chunked per strategy; nothing is written to strategy_canonical_daily_ledger_c and nothing is
 * ever promoted - that is exclusively the job of the (separately-invoked, human-gated)
 * promote_canonical_ledger_repair_row_c RPC.
 */
export async function runFullPlatformRepair(
  options: { asOfDate?: string; apply?: boolean; strategyId?: string } = {},
): Promise<PlatformRepairRunResult> {
  const empty = { written: 0, failed: 0, skipped: 0 };
  if (!isRetailSupabaseConfigured()) {
    return {
      ok: false,
      repairRunId: randomUUID(),
      asOf: options.asOfDate ?? new Date().toISOString().slice(0, 10),
      discoveredStrategyCount: 0,
      summary: empty,
      results: [],
      note: "retail supabase not configured",
    };
  }
  return runFullPlatformRepairForTesting(createRetailServiceRoleClient(), options);
}

/**
 * Same as runFullPlatformRepair() but takes an explicit db client, so it can be driven by a mock
 * Supabase client in tests without needing live retail credentials. Not "for testing only" in the
 * sense of being test-specific logic - it IS the real implementation; runFullPlatformRepair() is
 * a thin wrapper that resolves the real service-role client and calls this.
 */
export async function runFullPlatformRepairForTesting(
  db: SupabaseClient,
  options: { asOfDate?: string; apply?: boolean; strategyId?: string } = {},
): Promise<PlatformRepairRunResult> {
  const asOf = options.asOfDate ?? new Date().toISOString().slice(0, 10);
  const apply = options.apply === true;
  const repairRunId = randomUUID();
  const affected = await findAffectedStrategies(db);
  const targets = options.strategyId ? affected.filter((s) => s.id === options.strategyId) : affected;
  const results: StrategyRepairRunResult[] = [];
  for (const strategy of targets) {
    const { result, rows } = await reprocessStrategyHistory(db, strategy, { asOfDate: asOf, repairRunId });
    if (apply && rows.length && result.action === "written") {
      const { error } = await db.from(CANONICAL_LEDGER_REPAIR_SHADOW_TABLE).insert(rows);
      if (error) {
        results.push({ ...result, action: "failed", reason: `SHADOW_WRITE_FAILED:${error.message}` });
        continue;
      }
    }
    results.push(result);
  }
  const written = results.filter((r) => r.action === "written").length;
  const failed = results.filter((r) => r.action === "failed").length;
  const skipped = results.filter((r) => r.action === "skipped").length;
  return {
    ok: failed === 0,
    repairRunId,
    asOf,
    discoveredStrategyCount: affected.length,
    summary: { written, failed, skipped },
    results,
  };
}
