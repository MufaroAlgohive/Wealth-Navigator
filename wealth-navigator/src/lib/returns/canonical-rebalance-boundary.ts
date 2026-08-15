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
  if (executionCostCents < -0.5) throw new Error("BOUNDARY_REQUIRES_UNEXPLAINED_EXTERNAL_CAPITAL");
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
  if (executionCostCents > 0.5) {
    legs.push({
      ticker: "EXECUTION_COST",
      leg: "Rebalance execution-cost bridge",
      units: 1,
      entryDate: batch.effective_date,
      entryPriceCents: executionCostCents,
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
      execution_cost_cents: Math.max(0, executionCostCents),
      capital_source: reconciliation.capital_source ?? null,
      fill_count: input.fills.length,
    },
  };
}
