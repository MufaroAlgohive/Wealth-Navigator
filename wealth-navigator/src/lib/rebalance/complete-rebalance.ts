import type { SupabaseClient } from "@supabase/supabase-js";

import {
  recordRebalanceExecutionEvidence,
  recordRebalanceSettlement,
  finalizeRebalanceBoundary,
  type BoundaryHolding,
  type BoundaryOwner,
  type RebalanceExecutionEvidence,
} from "@/lib/returns/seal-rebalance-boundary";
import {
  settleRebalanceCashForClients,
  type SettleRebalanceCashResult,
} from "@/lib/rebalance/settle-rebalance-cash";

/**
 * Once every order booked for a rebalance (reconcile-parked-holdings.ts /
 * book-settled-rebalance-orders.ts, both tag their orders with
 * `payload.rebalance_request_id`) has finished — filled, cancelled, or
 * rejected, nothing left outstanding — the strategy's own canonical model
 * composition (`strategies_c.holdings`) is what should finally flip to the
 * new target. Not at IC approval, not at Send to Order Book: only once the
 * market has actually confirmed it, matching the same "nothing changes until
 * filled" rule applied to every individual client's holdings. Called from
 * the fill path (admin/orderbook/fills/route.ts) after each fill.
 *
 * For a strategy-wide rebalance, completion runs in three ordered phases,
 * each gated on the previous one succeeding:
 *
 *   1. Groundwork — record the SETTLED `rebalance_batch` and its
 *      `rebalance_event` execution evidence. Both are idempotent, so a retry
 *      converges rather than duplicates.
 *   2. Cash settlement (settleRebalanceCashForClients) — every owner named
 *      in the batch's execution evidence, settled or parked, gets
 *      immutable `strategy_rebalance_cash_events_c` coverage. This must run
 *      BEFORE boundary finalization: reconcile_rebalance_ca (phase 3)
 *      requires that coverage to exist for every owner or it refuses.
 *   3. Boundary finalization (finalizeRebalanceBoundary) — seal the return
 *      boundary AND auto-write the CA reconciliation row as one gate. Only
 *      once this succeeds does `strategies_c.holdings` flip.
 *
 * Flipping the composition and sealing the strategy's return boundary are one
 * atomic decision, not two steps: `strategies_c.holdings` is what the EOD
 * return publisher prices, so a flip without a matching boundary makes the
 * next publication read the composition change as a one-day return and chain
 * it into YTD permanently. The boundary (and its CA reconciliation) is
 * therefore sealed FIRST and the flip only happens if it succeeded — leaving
 * the rebalance visibly unfinished (and retryable) is recoverable; a
 * corrupted return chain, or a completed rebalance nobody can reconcile, is
 * not.
 *
 * There are two boundaries, and they are not the same thing. The STRATEGY
 * boundary (above) belongs only to a strategy-wide rebalance. The CLIENT
 * boundary — a SETTLED `rebalance_batch` naming the owners whose holdings
 * moved — is required by EVERY rebalance including a single-client one,
 * because the per-owner return publisher refuses to publish an owner whose
 * composition changed with nothing to explain it.
 */

function bare(sym: string): string {
  return String(sym ?? "")
    .trim()
    .toUpperCase()
    .replace(/\.(JO|JSE)$/i, "");
}

interface ProposedLine {
  ticker: string;
  name?: string;
  action?: string;
  shares?: number | null;
}

export interface CompleteRebalanceResult {
  completed: boolean;
  error?: string;
  /** "single_user" rebalances finish without touching anything strategy-level. */
  scope?: "strategy" | "single_user";
  /** The SETTLED rebalance_batch recorded so affected owners' return series can chain across. */
  settlementBatchId?: string;
  cashSettlement?: SettleRebalanceCashResult;
  /** Return-boundary outcome, when the rebalance reached the flip step. */
  boundary?: {
    sealed: boolean;
    error?: string;
    ytdPct?: number;
    continuityCashCents?: number;
    completeValueCents?: number;
    caReconciled?: boolean;
  };
}

interface SiblingOrder {
  status: string;
  side?: string | null;
  quantity?: number | null;
  order_id?: string | null;
  payload: Record<string, unknown> | null;
  result_payload?: Record<string, unknown> | null;
}

/** Everything phase 3 (finalizeRebalanceBoundary + the holdings flip) needs, once phase 1+2 have succeeded. */
interface PendingStrategyFinalization {
  strategyId: string;
  targetHoldings: Array<{ name: string; shares: number; symbol: string; ticker: string; quantity: number; weight: number }>;
  isLiquidation: boolean;
  settlementActorId: string;
}

interface GroundworkResult {
  completed: boolean;
  error?: string;
  scope?: "strategy" | "single_user";
  settlementBatchId?: string;
  pendingFinalization?: PendingStrategyFinalization;
}

export async function maybeCompleteRebalance(
  retailDb: SupabaseClient,
  institutionalDb: SupabaseClient,
  rebalanceRequestId: string,
  actorId?: string,
): Promise<CompleteRebalanceResult> {
  const siblingsRes = await institutionalDb
    .from("oems_order_audit")
    .select("status,side,quantity,order_id,payload,result_payload")
    .eq("payload->>rebalance_request_id", rebalanceRequestId);
  if (siblingsRes.error) return { completed: false, error: siblingsRes.error.message };
  const siblings = (siblingsRes.data ?? []) as SiblingOrder[];
  if (siblings.length === 0) return { completed: false };
  // The target model is valid only once every required client order has its
  // full broker fill. Terminal failures remain operationally resolved, but
  // they are not a completed rebalance and must never publish the target.
  const allFullyFilled = siblings.every((r) => {
    const expected = Number(r.quantity);
    const observed = Number(r.payload?.filled);
    return (
      r.status === "filled" &&
      Number.isFinite(expected) &&
      expected > 0 &&
      Number.isFinite(observed) &&
      observed >= expected
    );
  });
  if (!allFullyFilled) return { completed: false };

  // Claim before doing any real work: a repeated poller pass over the same
  // resolved group must be a no-op, not a re-sealed boundary or re-settled
  // cash. Reverted to "ic_approved" on any failure below so the group stays
  // retryable (per this module's doc comment: unfinished-and-retryable is
  // recoverable, a corrupted return chain is not) — only genuine success
  // marks it "executed".
  const stateRes = await institutionalDb
    .from("rebalance_request_c")
    .select("status, completion_batch_id")
    .eq("id", rebalanceRequestId)
    .maybeSingle();
  if (stateRes.error) return { completed: false, error: stateRes.error.message };
  if (!stateRes.data) return { completed: false, error: "rebalance request not found" };

  const currentStatus = String(stateRes.data.status ?? "");
  let settlementBatchId = stateRes.data.completion_batch_id as string | null;
  if (currentStatus === "completed") {
    return { completed: true, settlementBatchId: settlementBatchId ?? undefined };
  }

  if (currentStatus === "executed" || currentStatus === "ic_approved") {
    settlementBatchId = settlementBatchId ?? crypto.randomUUID();
    const claim = await institutionalDb
      .from("rebalance_request_c")
      .update({
        status: "completing",
        completion_batch_id: settlementBatchId,
        completion_error: null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", rebalanceRequestId)
      .eq("status", currentStatus)
      .select("id, completion_batch_id")
      .maybeSingle();
    if (claim.error) return { completed: false, error: `rebalance claim failed: ${claim.error.message}` };
    if (!claim.data) return { completed: false };
    settlementBatchId = claim.data.completion_batch_id as string;
  } else if (currentStatus !== "completing") {
    return { completed: false, error: `rebalance cannot complete from status ${currentStatus}` };
  }

  if (!settlementBatchId) {
    return { completed: false, error: "completing rebalance has no stable completion batch id" };
  }

  // Phase 1: groundwork. Records the batch + execution evidence for both
  // scopes; for a strategy-wide request also prices the target composition
  // and returns everything phase 3 will need, without sealing anything yet.
  const groundwork = await recordGroundwork(
    retailDb,
    institutionalDb,
    rebalanceRequestId,
    actorId,
    siblings,
    settlementBatchId,
  );
  if (!groundwork.completed) {
    await recordCompletionError(institutionalDb, rebalanceRequestId, groundwork.error ?? "completion failed");
    return { completed: false, error: groundwork.error, scope: groundwork.scope };
  }

  // Phase 2: cash settlement. Must run before phase 3 — CA reconciliation
  // requires immutable cash-event coverage for every owner named in the
  // batch, settled or parked, and this is what writes it.
  const cashSettlement = await settleRebalanceCashForClients(
    retailDb,
    institutionalDb,
    rebalanceRequestId,
    settlementBatchId,
  );
  if (cashSettlement.errors.length > 0) {
    const error = `cash settlement failed: ${cashSettlement.errors.join("; ")}`;
    await recordCompletionError(institutionalDb, rebalanceRequestId, error);
    return { completed: false, error, scope: groundwork.scope, settlementBatchId, cashSettlement };
  }

  // Single-client requests have nothing left to finalize: the strategy's own
  // composition and return chain were never touched (see this module's doc
  // comment on the two distinct boundaries).
  if (groundwork.scope === "single_user" || !groundwork.pendingFinalization) {
    return await markCompleted(institutionalDb, rebalanceRequestId, settlementBatchId, {
      completed: true,
      scope: groundwork.scope,
      settlementBatchId,
      cashSettlement,
    });
  }

  // Phase 3: seal the return boundary and auto-reconcile CA as one gate.
  const { strategyId, targetHoldings, isLiquidation, settlementActorId } = groundwork.pendingFinalization;
  const boundary = await finalizeRebalanceBoundary(retailDb, {
    batchId: settlementBatchId,
    strategyId,
    holdings: targetHoldings.map((h) => ({ symbol: h.symbol, shares: h.shares })),
    actorId: settlementActorId,
    // A liquidation values its securities at zero and moves the whole prior
    // complete value into continuity cash, which is exactly right: the
    // strategy still holds what it held, just as cash rather than stock.
    allowEmptyHoldings: isLiquidation,
  });
  if (!boundary.sealed) {
    const error = `return boundary not sealed, composition left unchanged: ${boundary.error ?? "unknown"}`;
    await recordCompletionError(institutionalDb, rebalanceRequestId, error);
    return {
      completed: false,
      error,
      scope: "strategy",
      settlementBatchId,
      cashSettlement,
      boundary: { sealed: false, error: boundary.error },
    };
  }

  const updRes = await retailDb
    .from("strategies_c")
    .update({ holdings: targetHoldings, updated_at: new Date().toISOString() })
    .eq("id", strategyId);
  if (updRes.error) {
    await recordCompletionError(institutionalDb, rebalanceRequestId, updRes.error.message);
    return { completed: false, error: updRes.error.message, scope: "strategy", settlementBatchId, cashSettlement };
  }

  return await markCompleted(institutionalDb, rebalanceRequestId, settlementBatchId, {
    completed: true,
    scope: "strategy",
    settlementBatchId,
    cashSettlement,
    boundary: {
      sealed: true,
      ytdPct: boundary.ytdPct,
      continuityCashCents: boundary.continuityCashCents,
      completeValueCents: boundary.completeValueCents,
      caReconciled: boundary.caReconciled,
    },
  });
}

async function markCompleted(
  institutionalDb: SupabaseClient,
  rebalanceRequestId: string,
  settlementBatchId: string,
  successResult: CompleteRebalanceResult,
): Promise<CompleteRebalanceResult> {
  const finalise = await institutionalDb
    .from("rebalance_request_c")
    .update({
      status: "completed",
      completed_at: new Date().toISOString(),
      completion_error: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", rebalanceRequestId)
    .eq("status", "completing")
    .eq("completion_batch_id", settlementBatchId)
    .select("id")
    .maybeSingle();
  if (finalise.error || !finalise.data) {
    const error = `rebalance finalisation failed: ${finalise.error?.message ?? "claim no longer owned"}`;
    await recordCompletionError(institutionalDb, rebalanceRequestId, error);
    return { ...successResult, completed: false, error };
  }
  return successResult;
}

async function recordCompletionError(
  institutionalDb: SupabaseClient,
  rebalanceRequestId: string,
  error: string,
): Promise<void> {
  const result = await institutionalDb
    .from("rebalance_request_c")
    .update({ completion_error: error, updated_at: new Date().toISOString() })
    .eq("id", rebalanceRequestId)
    .eq("status", "completing");
  if (result.error) console.error("rebalance completion error could not be recorded", result.error.message);
}

async function recordGroundwork(
  retailDb: SupabaseClient,
  institutionalDb: SupabaseClient,
  rebalanceRequestId: string,
  actorId: string | undefined,
  siblings: SiblingOrder[],
  settlementBatchId: string,
): Promise<GroundworkResult> {
  // Owners whose own holdings this rebalance moved. Derived from the holdings
  // the orders reference rather than the order payload, because the payload
  // hardcodes family_member_id to null while the holding carries the real one
  // — and the per-owner return publisher keys on (user, family member,
  // strategy), so a wrong family id would leave that owner's boundary
  // unmatched and jam their return series.
  const touchedHoldingIds = [
    ...new Set(
      siblings
        .map((r) => r.payload?.holding_id)
        .filter((v): v is string => typeof v === "string" && v.length > 0),
    ),
  ];
  const owners = new Map<string, BoundaryOwner>();
  const ownerByHoldingId = new Map<string, BoundaryOwner>();
  if (touchedHoldingIds.length > 0) {
    const ownerRes = await retailDb
      .from("stock_holdings_c")
      .select("id, user_id, family_member_id")
      .in("id", touchedHoldingIds);
    if (ownerRes.error) return { completed: false, error: `rebalance owner lookup failed: ${ownerRes.error.message}` };
    for (const row of (ownerRes.data ?? []) as Array<{ id: string; user_id: string; family_member_id: string | null }>) {
      if (!row.user_id) continue;
      const owner = {
        userId: row.user_id,
        familyMemberId: row.family_member_id ?? null,
      };
      owners.set(`${owner.userId}|${owner.familyMemberId ?? ""}`, owner);
      ownerByHoldingId.set(row.id, owner);
    }
  }
  // Fall back to the payload's user_id for any order whose holding row could
  // not be read, so an owner is never silently dropped from the boundary.
  for (const r of siblings) {
    const uid = r.payload?.user_id;
    if (typeof uid !== "string" || !uid) continue;
    if (![...owners.values()].some((o) => o.userId === uid)) {
      owners.set(`${uid}|`, { userId: uid, familyMemberId: null });
    }
  }
  const affectedOwners = [...owners.values()];
  const executionEvidence: RebalanceExecutionEvidence[] = [];
  for (const sibling of siblings.filter((row) => row.status === "filled")) {
    const payload = sibling.payload ?? {};
    const holdingId = typeof payload.holding_id === "string" ? payload.holding_id : "";
    const holdingOwner = holdingId ? ownerByHoldingId.get(holdingId) : undefined;
    const userId = holdingOwner?.userId ?? (typeof payload.user_id === "string" ? payload.user_id : "");
    const familyMemberId = holdingOwner
      ? holdingOwner.familyMemberId
      : typeof payload.family_member_id === "string"
        ? payload.family_member_id
        : null;
    const securityId = typeof payload.security_id === "string" ? payload.security_id : "";
    const side = String(sibling.side ?? "").toUpperCase();
    const tradeSide = side === "BUY" ? "BUY" : side === "SELL" ? "SELL" : null;
    const quantity = Number(payload.filled ?? sibling.quantity ?? 0);
    const avgFillCents = Number(sibling.result_payload?.avgFillPrice ?? payload.avgPx ?? 0);
    const fillDate = typeof payload.lastFillAt === "string" ? payload.lastFillAt.slice(0, 10) : "";
    if (!userId || !securityId || !tradeSide || !(quantity > 0) || !(avgFillCents > 0) || !fillDate) {
      return { completed: false, error: "filled rebalance order is missing immutable execution evidence" };
    }
    executionEvidence.push({
      userId,
      familyMemberId,
      securityId,
      tradeSide,
      quantity,
      avgFillCents,
      fillDate,
    });
  }
  if (executionEvidence.length === 0) {
    return { completed: false, error: "rebalance has no filled execution evidence" };
  }

  const reqRes = await institutionalDb
    .from("rebalance_request_c")
    .select("strategy_id, proposed_composition, affected_investors")
    .eq("id", rebalanceRequestId)
    .maybeSingle();
  if (reqRes.error) return { completed: false, error: reqRes.error.message };
  if (!reqRes.data) return { completed: false };

  // A single-client rebalance moves ONE account's own holdings. The strategy
  // itself — its composition, its weights, its published return chain — is not
  // being changed and must not be touched. `proposed_composition` on these
  // requests is that one client's personal share quantities, NOT a model
  // template (SingleClientRebalancePanel builds it from their own targets), so
  // writing it to `strategies_c.holdings` would redefine the strategy for every
  // other investor, and sealing a return boundary off it would rebase the
  // strategy's published value on one account's trade.
  //
  // Everything client-level still runs: the fills already moved their holdings
  // with cost basis intact, settleRebalanceCashForClients (run by the caller
  // right after this groundwork step) applies their reserve-funded fees and
  // residual, and the settlement batch recorded below lets their own return
  // series (publish-client-eod-returns.ts) chain across the composition change
  // instead of jamming on it.
  const affected = reqRes.data.affected_investors as { scope?: unknown } | null;
  const strategyName = reqRes.data.strategy_id as string;

  if (typeof affected?.scope === "string" && affected.scope === "single_user") {
    const stratRow = await retailDb.from("strategies_c").select("id").eq("name", strategyName).maybeSingle();
    const singleStrategyId = stratRow.data?.id as string | undefined;
    if (!singleStrategyId) {
      return { completed: false, error: `strategy "${strategyName}" not found` };
    }
    const recorded = await recordRebalanceSettlement(retailDb, {
      batchId: settlementBatchId,
      strategyId: singleStrategyId,
      strategyName,
      holdings: [],
      actorId: actorId ?? "",
      owners: affectedOwners,
    });
    if (recorded.error) {
      return {
        completed: false,
        error: `client rebalance boundary not recorded: ${recorded.error}`,
        scope: "single_user",
      };
    }
    if (!recorded.batchId) {
      return { completed: false, error: "client rebalance recorded no batch id", scope: "single_user" };
    }
    const eventError = await recordRebalanceExecutionEvidence(
      retailDb,
      recorded.batchId,
      executionEvidence,
    );
    if (eventError) {
      return {
        completed: false,
        error: `client rebalance execution evidence not recorded: ${eventError}`,
        scope: "single_user",
      };
    }
    return {
      completed: true,
      scope: "single_user",
      settlementBatchId: recorded.batchId,
    };
  }
  const proposed = (
    Array.isArray(reqRes.data.proposed_composition) ? reqRes.data.proposed_composition : []
  ) as ProposedLine[];
  const lines = proposed.filter(
    (p) => (p.action ?? "hold") !== "sell" && Math.round(Number(p.shares) || 0) > 0,
  );
  // "Nothing proposed at all" and "everything proposed is a sell to zero" are
  // different things. The second is a full liquidation — a legitimate target
  // composition of nothing — and treating it as malformed used to abandon the
  // rebalance after its orders had already filled: the model never flipped, no
  // boundary of either kind was recorded, and every affected owner's return
  // series then jammed on an unexplained composition change.
  const isLiquidation = proposed.length > 0 && lines.length === 0;
  if (proposed.length === 0) {
    return { completed: false, error: "proposed composition is empty" };
  }

  const symbols = lines.map((p) => bare(p.ticker));
  const symbolCandidates = symbols.flatMap((s) => [s, `${s}.JO`]);
  const secRes = await retailDb
    .from("securities_c")
    .select("symbol, last_price")
    .in("symbol", symbolCandidates);
  if (secRes.error) return { completed: false, error: secRes.error.message };
  const priceBySymbol = new Map<string, number>();
  for (const s of secRes.data ?? []) priceBySymbol.set(bare(s.symbol as string), Number(s.last_price) || 0);

  const valued = lines.map((p) => {
    const sym = bare(p.ticker);
    const shares = Math.max(0, Math.round(Number(p.shares) || 0));
    const priceCents = priceBySymbol.get(sym) ?? 0;
    return { ticker: p.ticker, name: p.name ?? sym, shares, valueCents: shares * priceCents };
  });
  const totalCents = valued.reduce((s, v) => s + v.valueCents, 0) || 1;
  const targetHoldings = valued.map((v) => ({
    name: v.name,
    shares: v.shares,
    symbol: v.ticker,
    ticker: v.ticker,
    quantity: v.shares,
    weight: Math.round((v.valueCents / totalCents) * 10000) / 100,
  })) as PendingStrategyFinalization["targetHoldings"];

  const stratRes = await retailDb
    .from("strategies_c")
    .select("id, holdings")
    .eq("name", strategyName)
    .maybeSingle();
  if (stratRes.error) return { completed: false, error: stratRes.error.message };
  if (!stratRes.data?.id) return { completed: false, error: `strategy "${strategyName}" not found` };
  const strategyId = stratRes.data.id as string;

  // Record the batch + execution evidence now (phase 1). Boundary sealing
  // and CA reconciliation happen later, in phase 3, after cash settlement.
  const recorded = await recordRebalanceSettlement(retailDb, {
    batchId: settlementBatchId,
    strategyId,
    strategyName,
    holdings: targetHoldings.map((h) => ({ symbol: h.symbol, shares: h.shares } satisfies BoundaryHolding)),
    actorId: actorId ?? "",
    owners: affectedOwners,
    holdingsBefore: stratRes.data.holdings ?? null,
  });
  if (recorded.error || !recorded.batchId || !recorded.actorId) {
    return { completed: false, error: recorded.error ?? "settlement batch not recorded", scope: "strategy" };
  }
  const eventError = await recordRebalanceExecutionEvidence(retailDb, recorded.batchId, executionEvidence);
  if (eventError) {
    return { completed: false, error: eventError, scope: "strategy", settlementBatchId: recorded.batchId };
  }

  return {
    completed: true,
    scope: "strategy",
    settlementBatchId: recorded.batchId,
    pendingFinalization: {
      strategyId,
      targetHoldings,
      isLiquidation,
      settlementActorId: recorded.actorId,
    },
  };
}
