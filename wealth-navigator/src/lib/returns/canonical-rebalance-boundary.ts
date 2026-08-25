export type ModelHolding = { ticker: string; units: number };

export type CanonicalLedgerLeg = {
  ticker: string;
  leg: string;
  units: number;
  entryDate: string;
  entryPriceCents: number;
  exitDate: string | null;
  exitPriceCents: number | null;
  sourceRef: string;
};

export type SettledBoundaryBatch = {
  id: string;
  status: string;
  settlement_state: string;
  effective_date: string;
  is_reversed: boolean;
  holdings_snapshot_before?: unknown;
  holdings_snapshot_after?: unknown;
  holdings_snapshot_planned?: unknown;
};

export type BoundaryFill = {
  security_id: string;
  trade_side: string;
  quantity: number;
  avg_fill: number;
  fill_date: string;
};

export type BoundaryReconciliation = {
  model_capital_cents: number;
  securities_value_cents: number;
  strategy_ca_cents: number;
  affected_owner_count: number;
  reconciled_owner_count: number;
  capital_source?: string;
};

const bare = (symbol: string) =>
  String(symbol ?? "")
    .trim()
    .toUpperCase()
    .replace(/\.(JO|JSE)$/i, "");

function aggregate(rows: ModelHolding[]) {
  const result = new Map<string, number>();
  for (const row of rows)
    result.set(bare(row.ticker), (result.get(bare(row.ticker)) ?? 0) + Number(row.units));
  return [...result]
    .filter(([ticker, units]) => ticker && units > 0)
    .map(([ticker, units]) => ({ ticker, units }))
    .sort((a, b) => a.ticker.localeCompare(b.ticker));
}

export function holdingsFromSnapshot(value: unknown): ModelHolding[] {
  return aggregate(
    (Array.isArray(value) ? value : [])
      .map((row) => ({
        ticker: bare(String(row?.ticker ?? row?.symbol ?? "")),
        units: Number(row?.units ?? row?.shares ?? row?.quantity ?? 0),
      }))
      .filter((row) => row.ticker && Number.isFinite(row.units) && row.units > 0),
  );
}

function sameHoldings(left: ModelHolding[], right: ModelHolding[]) {
  const a = aggregate(left);
  const b = aggregate(right);
  return (
    a.length === b.length &&
    a.every((row, index) => row.ticker === b[index]?.ticker && Math.abs(row.units - b[index].units) < 1e-9)
  );
}

export function rebuildLegsAcrossSettledBoundary(input: {
  previousDate: string;
  previousHoldings: ModelHolding[];
  previousCashCents: number;
  previousLegs: CanonicalLedgerLeg[];
  currentHoldings: ModelHolding[];
  currentCashCents: number;
  batch: SettledBoundaryBatch;
  fills: BoundaryFill[];
  securitySymbols: Map<string, string>;
  reconciliation: BoundaryReconciliation;
  /**
   * Current price (cents) per bare ticker for securities that did NOT trade
   * at this boundary. The settlement RPC (finalize_rebalance_return_boundary)
   * re-prices the WHOLE basket at current market value and absorbs whatever's
   * left into continuity cash — by design, so ordinary price movement never
   * leaks into performance. Without this map, the execution-cost check below
   * implicitly assumes every untraded leg is frozen at its previous price,
   * which only holds when zero time passes between the previous published
   * date and settlement. Any real gap (a weekend, a stale certification
   * pipeline) lets genuine price drift accumulate on the untraded legs, and
   * the check misreads that drift as unexplained cash. Reproduced live
   * 2026-08-25: Yield Basket's 2026-08-24 BVT rebalance failed
   * BOUNDARY_REQUIRES_UNEXPLAINED_EXTERNAL_CAPITAL over a R20.62 gap that was
   * actually NED/SUI/DIB/TBS losing R24.38 between 2026-08-21 (last
   * published date) and 2026-08-24 (settlement) — real market movement, not
   * capital appearing from nowhere. Optional and additive: omitting it
   * preserves the exact prior strict (zero-drift) behavior the existing test
   * suite already covers.
   */
  unchangedLegCurrentPrices?: Map<string, number>;
}) {
  const { batch, reconciliation } = input;
  if (batch.status !== "SETTLED" || batch.settlement_state !== "COMPLETE" || batch.is_reversed) {
    throw new Error("BOUNDARY_NOT_SETTLED_COMPLETE");
  }
  if (!batch.effective_date || batch.effective_date <= input.previousDate) {
    throw new Error("BOUNDARY_EFFECTIVE_DATE_INVALID");
  }
  const before = holdingsFromSnapshot(batch.holdings_snapshot_before);
  const afterSnapshot = holdingsFromSnapshot(batch.holdings_snapshot_after);
  const planned = afterSnapshot.length
    ? afterSnapshot
    : holdingsFromSnapshot(batch.holdings_snapshot_planned);
  if (!sameHoldings(before, input.previousHoldings)) throw new Error("BOUNDARY_BEFORE_SNAPSHOT_MISMATCH");
  if (!sameHoldings(planned, input.currentHoldings)) throw new Error("BOUNDARY_AFTER_SNAPSHOT_MISMATCH");
  if (
    Number(reconciliation.model_capital_cents) !==
      Number(reconciliation.securities_value_cents) + Number(reconciliation.strategy_ca_cents) ||
    Number(reconciliation.affected_owner_count) !== Number(reconciliation.reconciled_owner_count)
  ) {
    throw new Error("BOUNDARY_CA_RECONCILIATION_INVALID");
  }
  if (Number(reconciliation.strategy_ca_cents) !== Number(input.currentCashCents)) {
    throw new Error("BOUNDARY_CA_RULE_MISMATCH");
  }

  const beforeUnits = new Map(aggregate(input.previousHoldings).map((row) => [row.ticker, row.units]));
  const afterUnits = new Map(aggregate(input.currentHoldings).map((row) => [row.ticker, row.units]));
  const tickers = [...new Set([...beforeUnits.keys(), ...afterUnits.keys()])];
  const deltas = new Map(
    tickers.map((ticker) => [ticker, (afterUnits.get(ticker) ?? 0) - (beforeUnits.get(ticker) ?? 0)]),
  );

  // Real price movement on legs that did NOT trade at this boundary — see the
  // unchangedLegCurrentPrices doc comment above. Zero when the caller omits
  // the map (exact prior behavior) or for any ticker it doesn't cover.
  let unchangedLegDriftCents = 0;
  for (const [ticker, delta] of deltas) {
    if (Math.abs(delta) > 1e-9) continue;
    const units = afterUnits.get(ticker) ?? 0;
    if (units <= 0) continue;
    const currentPrice = input.unchangedLegCurrentPrices?.get(ticker);
    if (currentPrice == null) continue;
    const previousLeg = input.previousLegs.find((leg) => leg.ticker === ticker && !leg.exitDate);
    const previousPrice = previousLeg?.entryPriceCents;
    if (previousPrice == null) continue;
    unchangedLegDriftCents += units * (currentPrice - previousPrice);
  }
  const fillsByTicker = new Map<string, BoundaryFill[]>();
  for (const fill of input.fills) {
    const ticker = bare(input.securitySymbols.get(fill.security_id) ?? "");
    if (
      !ticker ||
      !["BUY", "SELL"].includes(fill.trade_side) ||
      !(Number(fill.quantity) > 0) ||
      !(Number(fill.avg_fill) > 0) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(fill.fill_date)
    ) {
      throw new Error("BOUNDARY_FILL_INVALID");
    }
    const key = `${ticker}:${fill.trade_side}`;
    fillsByTicker.set(key, [...(fillsByTicker.get(key) ?? []), fill]);
  }

  const scales: number[] = [];
  const fillPriceByTickerSide = new Map<string, number>();
  let grossCashDeltaCents = 0;
  for (const [ticker, delta] of deltas) {
    if (Math.abs(delta) < 1e-9) continue;
    const side = delta > 0 ? "BUY" : "SELL";
    const matches = fillsByTicker.get(`${ticker}:${side}`) ?? [];
    if (!matches.length) throw new Error(`BOUNDARY_FILL_MISSING:${ticker}:${side}`);
    const aggregateUnits = matches.reduce((sum, fill) => sum + Number(fill.quantity), 0);
    const scale = aggregateUnits / Math.abs(delta);
    if (!Number.isInteger(scale) || scale <= 0) throw new Error(`BOUNDARY_OWNER_SCALE_INVALID:${ticker}`);
    scales.push(scale);
    const aggregateCash = matches.reduce(
      (sum, fill) => sum + Number(fill.quantity) * Number(fill.avg_fill),
      0,
    );
    const weightedFill = aggregateCash / aggregateUnits;
    if (!Number.isFinite(weightedFill) || weightedFill <= 0)
      throw new Error(`BOUNDARY_FILL_PRICE_INVALID:${ticker}`);
    fillPriceByTickerSide.set(`${ticker}:${side}`, weightedFill);
    grossCashDeltaCents += (side === "SELL" ? 1 : -1) * Math.abs(delta) * weightedFill;
  }
  if (!scales.length || new Set(scales).size !== 1) throw new Error("BOUNDARY_OWNER_SCALE_AMBIGUOUS");
  const ownerScale = scales[0];

  for (const [key] of fillsByTicker) {
    const [ticker = "", side = ""] = key.split(":");
    const delta = deltas.get(ticker) ?? 0;
    if ((side === "BUY" && delta <= 0) || (side === "SELL" && delta >= 0)) {
      throw new Error(`BOUNDARY_UNEXPECTED_FILL:${ticker}:${side}`);
    }
  }

  const executionCostCents = input.previousCashCents + grossCashDeltaCents - input.currentCashCents;
  // Securities that lost value between the previous published date and
  // settlement legitimately raise the cash the RPC's re-pricing leaves
  // behind (total value is conserved, so less in securities means more in
  // cash); securities that gained value do the opposite. Subtracting the
  // drift here is that same conservation applied to THIS check, so real
  // price movement can't be mistaken for capital appearing from nowhere.
  const adjustedExecutionCostCents = executionCostCents - unchangedLegDriftCents;
  if (adjustedExecutionCostCents < -0.5) throw new Error("BOUNDARY_REQUIRES_UNEXPLAINED_EXTERNAL_CAPITAL");

  // Value-continuity invariant. The published return calculation (publish-canonical-ledger-draft.ts)
  // chain-links complete_value_cents straight across every boundary, which is only correct if total
  // portfolio value is preserved across the boundary except for the real execution cost - i.e.
  // nothing is silently lost or double-counted when legs are relabeled. Legs for tickers that did NOT
  // trade at this boundary (delta === 0) are carried over untouched: identical units at the identical
  // market price on effective_date, so they contribute identically to the "before" and "after" totals
  // and cancel out of any before/after comparison. The invariant therefore reduces to a pure cash
  // identity over the tickers that actually traded:
  //   previousCashCents + (sold-leg exit proceeds) = currentCashCents + (bought-leg entry cost) + executionCostCents
  // executionCostCents above was derived from the netted grossCashDeltaCents accumulator; here we
  // independently recompute both sides directly from the per-ticker sold/bought fill values as a
  // defensive check that the two computations agree (guards against a future edit desynchronizing
  // them). This is in addition to - not a replacement for - the reconciliation identity already
  // validated above (model_capital_cents === securities_value_cents + strategy_ca_cents, and
  // strategy_ca_cents === currentCashCents), which separately certifies the POST-boundary total
  // against the strategy's independently-sourced authoritative valuation.
  let soldExitValueCents = 0;
  let boughtEntryValueCents = 0;
  for (const [ticker, delta] of deltas) {
    if (delta < 0) {
      soldExitValueCents += Math.abs(delta) * Number(fillPriceByTickerSide.get(`${ticker}:SELL`) ?? 0);
    } else if (delta > 0) {
      boughtEntryValueCents += delta * Number(fillPriceByTickerSide.get(`${ticker}:BUY`) ?? 0);
    }
  }
  const beforeTotalCents = input.previousCashCents + soldExitValueCents;
  const afterTotalCents = input.currentCashCents + boughtEntryValueCents;
  const impliedExecutionCostCents = beforeTotalCents - afterTotalCents;
  if (Math.abs(impliedExecutionCostCents - executionCostCents) > 2) {
    throw new Error("BOUNDARY_VALUE_CONTINUITY_VIOLATED");
  }

  const legs = input.previousLegs.map((leg) => ({ ...leg }));
  for (const [ticker, delta] of deltas) {
    if (delta >= 0) continue;
    let remaining = -delta;
    const fillPrice = fillPriceByTickerSide.get(`${ticker}:SELL`);
    if (!(Number(fillPrice) > 0)) throw new Error(`BOUNDARY_FILL_PRICE_INVALID:${ticker}`);
    for (const leg of legs.filter((candidate) => candidate.ticker === ticker && !candidate.exitDate)) {
      if (remaining <= 1e-9) break;
      const closing = Math.min(leg.units, remaining);
      if (closing < leg.units) legs.push({ ...leg, units: leg.units - closing });
      leg.units = closing;
      leg.exitDate = batch.effective_date;
      leg.exitPriceCents = Number(fillPrice);
      leg.sourceRef = `rebalance_event:${batch.id}:owner_scale_${ownerScale}`;
      remaining -= closing;
    }
    if (remaining > 1e-9) throw new Error(`BOUNDARY_CANNOT_CLOSE_MODEL_UNITS:${ticker}`);
  }
  for (const [ticker, delta] of deltas) {
    if (delta <= 0) continue;
    const fillPrice = fillPriceByTickerSide.get(`${ticker}:BUY`);
    if (!(Number(fillPrice) > 0)) throw new Error(`BOUNDARY_FILL_PRICE_INVALID:${ticker}`);
    legs.push({
      ticker,
      leg: "Rebalance buy",
      units: delta,
      entryDate: batch.effective_date,
      entryPriceCents: Number(fillPrice),
      exitDate: null,
      exitPriceCents: null,
      sourceRef: `rebalance_event:${batch.id}:owner_scale_${ownerScale}`,
    });
  }
  for (const leg of legs.filter((candidate) => candidate.ticker === "CASH" && !candidate.exitDate)) {
    leg.exitDate = batch.effective_date;
    leg.exitPriceCents = leg.entryPriceCents;
  }
  if (input.currentCashCents > 0) {
    legs.push({
      ticker: "CASH",
      leg: "Authoritative strategy CA",
      units: 1,
      entryDate: batch.effective_date,
      entryPriceCents: input.currentCashCents,
      exitDate: null,
      exitPriceCents: null,
      sourceRef: `strategy_rebalance_ca_reconciliation_c:${batch.id}`,
    });
  }
  // Drift-adjusted, same reasoning as the guard above: the genuine execution
  // cost (fees/slippage beyond the share price) must not include price
  // movement on legs that never traded — that's not a cost of THIS
  // rebalance, it's ordinary market movement the strategy would have carried
  // regardless.
  if (adjustedExecutionCostCents > 0.5) {
    legs.push({
      ticker: "EXECUTION_COST",
      leg: "Rebalance execution-cost bridge",
      units: 1,
      entryDate: batch.effective_date,
      entryPriceCents: adjustedExecutionCostCents,
      exitDate: batch.effective_date,
      exitPriceCents: 0,
      sourceRef: `rebalance_event:${batch.id}:cash_bridge`,
    });
  }
  return {
    legs,
    evidence: {
      batch_id: batch.id,
      effective_date: batch.effective_date,
      owner_scale: ownerScale,
      model_deltas: Object.fromEntries(deltas),
      gross_cash_delta_cents: grossCashDeltaCents,
      previous_strategy_ca_cents: input.previousCashCents,
      authoritative_strategy_ca_cents: input.currentCashCents,
      execution_cost_cents: Math.max(0, adjustedExecutionCostCents),
      unchanged_leg_drift_cents: unchangedLegDriftCents,
      capital_source: reconciliation.capital_source ?? null,
      fill_count: input.fills.length,
    },
  };
}
