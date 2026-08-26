import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Seal a strategy's return boundary at the moment its composition changes.
 *
 * A rebalance changes WHAT a strategy holds, not how it has performed. Left
 * alone, the EOD return publisher would price the new basket against the old
 * basket's complete value and book the difference as a one-day return — the
 * composition change would masquerade as investment performance, and because
 * the publisher chains (`chain_factor *= 1 + oneDay/100`), that phantom move
 * is permanent: it shifts YTD for the rest of the year and drags every chart
 * and factsheet with it.
 *
 * `finalize_rebalance_return_boundary` (retail RPC, SETTLEMENT_CHAIN_V1) is
 * the existing, guarded mechanism that prevents this. It carries the prior
 * chain factor and YTD across the boundary untouched, and absorbs the value
 * the new securities no longer represent into "continuity cash" so the
 * strategy's COMPLETE value (securities + continuity cash) is preserved
 * across the change. The next EOD run then measures its one-day move from
 * that preserved base — real market movement only.
 *
 * The RPC keys off `rebalance_batch`, so an OEM rebalance records one batch
 * row for its settlement and seals against it. Both the RPC's writes
 * (`strategy_valuation_rules_c`, `strategy_return_publication_audit_c`) are
 * ON CONFLICT DO UPDATE at daily granularity, so re-sealing the same strategy
 * on the same day converges on the latest settlement's numbers rather than
 * double-counting — which is the RPC's own stated intent.
 *
 * Prices come from `stock_intraday_c`, deliberately the SAME source the EOD
 * publisher uses. Sealing against a different price source than the publisher
 * reads would itself create a step change at the boundary — the exact bug
 * this function exists to prevent. `securities_c.last_price` is not used here
 * for that reason.
 */

export interface BoundaryHolding {
  symbol: string;
  shares: number;
}

/** One (client, family member) pair whose own holdings this settlement moved. */
export interface BoundaryOwner {
  userId: string;
  familyMemberId: string | null;
}

export interface RecordSettlementResult {
  batchId?: string;
  /** Retail auth user used for foreign-key-safe settlement attribution. */
  actorId?: string;
  error?: string;
}

/** A broker-confirmed execution row to preserve in the retail audit ledger. */
export interface RebalanceExecutionEvidence {
  userId: string;
  familyMemberId: string | null;
  securityId: string;
  tradeSide: "BUY" | "SELL";
  quantity: number;
  avgFillCents: number;
  fillDate: string;
}

/**
 * OEM sessions are issued by the institutional project, while rebalance_batch
 * belongs to RETAIL and its `created_by`/`settled_by` columns reference retail
 * auth.users. Prefer a supplied actor only when it is a retail profile; an
 * institutional-only operator ID would otherwise fail the batch insert. For a
 * strategy-wide rebalance, an affected retail owner is a valid fallback and
 * keeps the settlement traceable without inventing a user.
 */
async function resolveRetailSettlementActor(
  retailDb: SupabaseClient,
  suppliedActorId: string,
  owners: BoundaryOwner[],
): Promise<string | null> {
  if (suppliedActorId) {
    const actor = await retailDb.from("profiles").select("id").eq("id", suppliedActorId).maybeSingle();
    if (!actor.error && actor.data?.id) return suppliedActorId;
  }
  return owners.find((owner) => owner.userId)?.userId ?? null;
}

export async function recordRebalanceExecutionEvidence(
  retailDb: SupabaseClient,
  batchId: string,
  rows: RebalanceExecutionEvidence[],
): Promise<string | null> {
  for (const row of rows) {
    if (!row.userId || !row.securityId || !(row.quantity > 0) || !(row.avgFillCents > 0) || !/^\d{4}-\d{2}-\d{2}$/.test(row.fillDate)) {
      return "invalid rebalance execution evidence";
    }
    const existing = await retailDb
      .from("rebalance_event")
      .select("id")
      .eq("batch_id", batchId)
      .eq("user_id", row.userId)
      .eq("security_id", row.securityId)
      .eq("trade_side", row.tradeSide)
      .eq("quantity", row.quantity)
      .maybeSingle();
    if (existing.error) return `rebalance_event lookup failed: ${existing.error.message}`;
    if (existing.data) continue;
    const inserted = await retailDb.from("rebalance_event").insert({
      batch_id: batchId,
      user_id: row.userId,
      family_member_id: row.familyMemberId,
      security_id: row.securityId,
      trade_side: row.tradeSide,
      quantity: row.quantity,
      price_at_commit: row.avgFillCents,
      avg_fill: row.avgFillCents,
      fill_date: row.fillDate,
      closed_reason: row.tradeSide === "BUY" ? "REBALANCE_EVENT_BUY" : "REBALANCE_EVENT_SELL",
    });
    if (inserted.error) return `rebalance_event insert failed: ${inserted.error.message}`;
  }
  return null;
}

/**
 * Record the settlement itself: one SETTLED `rebalance_batch` naming the
 * owners it moved.
 *
 * This is the CLIENT-side boundary, and it is required for every rebalance,
 * including a single-client one. The per-owner return publisher refuses to
 * publish an owner whose holdings composition changed unless it can find a
 * settled batch linked to that owner in the gap — without one their return
 * series jams on "composition changed without a settled rebalance boundary".
 * The linkage goes in `pending_swap_snapshot` as `{userId, familyMemberId}`,
 * which is one of the two shapes that publisher already reads.
 *
 * Deliberately separate from sealing the STRATEGY return boundary: a
 * single-client rebalance needs this and must NOT have that, because the
 * strategy's own composition and published value have not changed.
 */
export async function recordRebalanceSettlement(
  retailDb: SupabaseClient,
  params: {
    /** Stable id allocated by the institutional completion claim. */
    batchId?: string;
    strategyId: string;
    strategyName: string;
    holdings: BoundaryHolding[];
    actorId: string;
    owners: BoundaryOwner[];
    /** Filled broker executions; written before the strategy composition can flip. */
    executionEvidence?: RebalanceExecutionEvidence[];
    holdingsBefore?: unknown;
    effectiveAt?: Date;
  },
): Promise<RecordSettlementResult> {
  const effectiveAt = params.effectiveAt ?? new Date();
  const settlementActorId = await resolveRetailSettlementActor(retailDb, params.actorId, params.owners);
  if (!settlementActorId) return { error: "no retail actor or affected owner to attribute the settlement to" };

  const swaps = params.owners
    .filter((o) => o.userId)
    .map((o) => ({ userId: o.userId, familyMemberId: o.familyMemberId ?? null }));

  if (params.batchId) {
    const existing = await retailDb
      .from("rebalance_batch")
      .select("id,strategy_id,status,settlement_state,created_by")
      .eq("id", params.batchId)
      .maybeSingle();
    if (existing.error) return { error: `rebalance_batch lookup failed: ${existing.error.message}` };
    if (existing.data) {
      if (
        existing.data.strategy_id !== params.strategyId ||
        existing.data.status !== "SETTLED" ||
        existing.data.settlement_state !== "COMPLETE"
      ) {
        return { error: "existing rebalance_batch does not match this completion" };
      }
      return {
        batchId: existing.data.id as string,
        actorId: (existing.data.created_by as string | null) ?? settlementActorId,
      };
    }
  }

  const res = await retailDb
    .from("rebalance_batch")
    .insert({
      ...(params.batchId ? { id: params.batchId } : {}),
      strategy_id: params.strategyId,
      strategy_name_snapshot: params.strategyName,
      status: "SETTLED",
      settlement_state: "COMPLETE",
      effective_date: effectiveAt.toISOString().slice(0, 10),
      settlement_effective_at: effectiveAt.toISOString(),
      holdings_snapshot_before: params.holdingsBefore ?? null,
      holdings_snapshot_planned: params.holdings,
      pending_swap_snapshot: swaps,
      created_by: settlementActorId,
      settled_by: settlementActorId,
      settled_at: effectiveAt.toISOString(),
      is_reversed: false,
    })
    .select("id")
    .maybeSingle();
  if (res.error) return { error: `rebalance_batch insert failed: ${res.error.message}` };
  const batchId = res.data?.id as string | undefined;
  if (!batchId) return { error: "rebalance_batch insert returned no id" };
  return { batchId, actorId: settlementActorId };
}

export interface SealBoundaryResult {
  sealed: boolean;
  /** Set when sealing was refused or failed; the caller must not treat the rebalance as settled. */
  error?: string;
  securitiesValueCents?: number;
  continuityCashCents?: number;
  completeValueCents?: number;
  ytdPct?: number;
  batchId?: string;
  idempotent?: boolean;
  /** True once `reconcile_rebalance_ca` has recorded (or already held) this batch's CA row. */
  caReconciled?: boolean;
}

function bare(symbol: string): string {
  return String(symbol ?? "")
    .trim()
    .toUpperCase()
    .replace(/\.(JO|JSE)$/i, "");
}

/**
 * Latest intraday price (cents) per base symbol, mirroring the EOD
 * publisher's own lookup: last four days of ticks, newest first, first
 * positive price per symbol wins.
 */
async function latestPrices(
  retailDb: SupabaseClient,
  symbols: string[],
): Promise<{ priceCents: Map<string, number>; freshestAt: string | null }> {
  const universe = [...new Set(symbols.flatMap((s) => [s, `${s}.JO`]))];
  const since = new Date(Date.now() - 4 * 86_400_000).toISOString();
  const res = await retailDb
    .from("stock_intraday_c")
    .select("symbol, current_price, timestamp")
    .in("symbol", universe)
    .gte("timestamp", since)
    .order("timestamp", { ascending: false });

  const priceCents = new Map<string, number>();
  let freshestAt: string | null = null;
  for (const row of (res.data ?? []) as Array<{
    symbol: string;
    current_price: number | string | null;
    timestamp: string;
  }>) {
    const base = bare(row.symbol);
    const price = Number(row.current_price);
    if (priceCents.has(base) || !(price > 0)) continue;
    priceCents.set(base, price);
    if (!freshestAt || row.timestamp > freshestAt) freshestAt = row.timestamp;
  }
  return { priceCents, freshestAt };
}

/**
 * Finalize an already-recorded strategy rebalance batch: price its target
 * composition, seal the return boundary, and auto-write the corporate-action
 * reconciliation row the boundary makes possible — all as one completion
 * gate. The batch (`rebalance_batch`) and its execution evidence
 * (`rebalance_event`) must already exist (see `recordRebalanceSettlement` /
 * `recordRebalanceExecutionEvidence`), and — critically — cash settlement
 * (`settleRebalanceCashForClients`) must already have run for this batch,
 * because CA reconciliation below requires `strategy_rebalance_cash_events_c`
 * coverage for every affected owner and cannot get it any other way.
 *
 * `reconcile_rebalance_ca` (retail RPC, live since 2026-07-29) is idempotent
 * — an existing row for this batch short-circuits with its stored values, a
 * conflicting one raises — and derives every number from the batch's own
 * evidence, but until this change nothing ever called it, so every
 * production reconciliation row was a hand-authored, after-the-fact
 * migration once someone noticed certification had stalled. It now runs in
 * the SAME transaction as `finalize_rebalance_return_boundary`, via the
 * `finalize_rebalance_boundary_and_ca` wrapper RPC below: a rebalance whose
 * model composition and financial state cannot be reconciled must not seal
 * a return boundary either, or the two would drift out of sync until a
 * later retry — exactly the partial-state failure mode this module exists
 * to prevent. Failure here returns `sealed: false`, so the caller leaves
 * the institutional request `completing` with `completion_error` set and
 * retryable — same as any other failed step.
 */
export async function finalizeRebalanceBoundary(
  retailDb: SupabaseClient,
  params: {
    batchId: string;
    strategyId: string;
    /** The composition the strategy is moving TO. */
    holdings: BoundaryHolding[];
    /** Resolved retail actor from the earlier settlement-recording step. */
    actorId: string;
    /**
     * Set only for a deliberate full liquidation, where an empty target
     * composition is the intended result rather than a malformed input. The
     * securities value is then zero and the whole prior complete value moves
     * into continuity cash. Left false, an empty basket is refused, because
     * silently sealing one would tell the publisher the strategy holds nothing.
     */
    allowEmptyHoldings?: boolean;
    effectiveAt?: Date;
  },
): Promise<SealBoundaryResult> {
  const { batchId, strategyId, actorId } = params;
  const effectiveAt = params.effectiveAt ?? new Date();

  const holdings = params.holdings
    .map((h) => ({ symbol: bare(h.symbol), shares: Math.max(0, Math.round(Number(h.shares) || 0)) }))
    .filter((h) => h.symbol && h.shares > 0);
  if (holdings.length === 0 && !params.allowEmptyHoldings) {
    return { sealed: false, error: "no positive holdings to value", batchId };
  }
  const { priceCents, freshestAt } = await latestPrices(
    retailDb,
    holdings.map((h) => h.symbol),
  );

  // Full coverage or nothing. A boundary sealed on a partially-priced basket
  // understates securities value, which the RPC would then absorb into
  // continuity cash — silently and permanently misstating what the strategy
  // holds. Refusing to seal keeps the rebalance visibly unfinished instead,
  // which is recoverable; a bad seal is not. A liquidation has nothing to
  // price, so there is nothing to be missing.
  const missing = holdings.filter((h) => !priceCents.has(h.symbol)).map((h) => h.symbol);
  if (missing.length > 0) {
    return {
      sealed: false,
      error: `no recent price for ${missing.join(", ")} — refusing to seal a partial boundary`,
      batchId,
    };
  }

  const securitiesValueCents = Math.round(
    holdings.reduce((sum, h) => sum + h.shares * (priceCents.get(h.symbol) ?? 0), 0),
  );

  // One retail RPC, one transaction: finalize_rebalance_boundary_and_ca
  // (supabase/migrations/20260825000003_finalize_rebalance_boundary_and_ca.sql)
  // calls finalize_rebalance_return_boundary then reconcile_rebalance_ca
  // inside a single plpgsql function body. If reconciliation raises, the
  // WHOLE transaction — including the boundary's own writes to
  // strategy_valuation_rules_c / strategy_return_publication_audit_c — rolls
  // back, so there is never a window where the return boundary is sealed
  // against the target composition while strategies_c.holdings still shows
  // the old one. Two separate RPC calls could not guarantee that: a
  // reconciliation failure between them would leave the boundary durably
  // sealed with nothing (yet) to unwind it.
  const rpcRes = await retailDb.rpc("finalize_rebalance_boundary_and_ca", {
    p_batch_id: batchId,
    p_securities_value_cents: securitiesValueCents,
    p_holdings_snapshot: holdings,
    p_effective_at: effectiveAt.toISOString(),
    p_price_observed_at: freshestAt ?? effectiveAt.toISOString(),
    p_actor: actorId,
  });
  if (rpcRes.error) {
    // Whichever callee raised, nothing committed: the rebalance stays
    // `completing`/retryable, strategies_c.holdings is untouched, and a
    // retry (once, for a CA failure, cash settlement covers every owner —
    // see settleRebalanceCashForClients' parked zero-movement rows) succeeds.
    return { sealed: false, error: `boundary finalization failed: ${rpcRes.error.message}`, batchId };
  }

  const combined = (rpcRes.data ?? {}) as { boundary?: Record<string, unknown> };
  const out = (combined.boundary ?? {}) as {
    idempotent?: boolean;
    securities_value_cents?: number;
    continuity_cash_cents?: number;
    complete_value_cents?: number;
    ytd_pct?: number;
  };

  return {
    sealed: true,
    batchId,
    idempotent: out.idempotent === true,
    securitiesValueCents: Number(out.securities_value_cents ?? securitiesValueCents),
    continuityCashCents: Number(out.continuity_cash_cents ?? 0),
    completeValueCents: Number(out.complete_value_cents ?? 0),
    ytdPct: out.ytd_pct == null ? undefined : Number(out.ytd_pct),
    caReconciled: true,
  };
}
