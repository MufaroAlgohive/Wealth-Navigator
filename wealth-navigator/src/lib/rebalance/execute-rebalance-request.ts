import type { SupabaseClient } from "@supabase/supabase-js";

import { bookSettledRebalanceOrders } from "@/lib/rebalance/book-settled-rebalance-orders";
import { reconcileParkedHoldings } from "@/lib/rebalance/reconcile-parked-holdings";

export interface ExecuteRebalanceRequestRow {
  id: string;
  strategy_id: string | null;
  current_composition: unknown;
  proposed_composition: unknown;
  affected_investors: unknown;
}

export type ExecuteRebalanceResult =
  | {
      ok: true;
      parked: { reconciledUserIds: string[]; errors: string[] } | null;
      booked: { bookedUserIds: string[]; errors: string[] } | null;
    }
  | { ok: false; error: string };

/**
 * Runs the side effects of a rebalance request becoming "executed" — the ONE
 * moment a rebalance actually touches anything: any client whose buy into
 * this strategy hasn't been sent to the broker yet gets repositioned for
 * free, and settled clients get their delta orders booked.
 *
 * Extracted out of transition/route.ts (ic_approved -> executed via "Release
 * to Rebalance Tab") so requests/route.ts's Master-only direct-execute path
 * — which skips the pending/ic_approved states entirely — can run the exact
 * same mechanics rather than a second, drifting copy of this logic.
 *
 * `request.strategy_id` actually stores the strategy's display NAME (see
 * rebalance-builder-page.tsx::submitToIc), not its real id —
 * stock_holdings_c.strategy_id is the real id — so this resolves it before
 * either query below, or they'd silently compare a name against a UUID
 * column and no-op the whole feature.
 */
export async function executeRebalanceRequest(
  retailDb: SupabaseClient,
  institutionalDb: SupabaseClient,
  request: ExecuteRebalanceRequestRow,
): Promise<ExecuteRebalanceResult> {
  if (!request.strategy_id) return { ok: true, parked: null, booked: null };

  const strategyName = request.strategy_id;
  const strategyRes = await retailDb
    .from("strategies_c")
    .select("id, investor_environment")
    .eq("name", strategyName)
    .maybeSingle();
  const resolvedStrategyId = (strategyRes.data?.id as string) ?? "";
  // Drives the uat_test tag and broker destination on every order booked
  // below — a UAT/test strategy's orders must show under "UAT orders" on
  // Active Orderbook regardless of this deployment's own env flag.
  const isUatStrategy = String(strategyRes.data?.investor_environment ?? "").toUpperCase() === "UAT";
  const currentComposition = Array.isArray(request.current_composition) ? request.current_composition : [];
  const proposedComposition = Array.isArray(request.proposed_composition) ? request.proposed_composition : [];

  // A "single_user" request carries ONE client's own target quantities, not
  // a model template. Both booking passes below normally fan the proposed
  // composition out across every investor in the strategy, which for this
  // scope would rewrite everyone else's orders to one account's numbers — so
  // they get confined to that account. Completion is likewise scoped: see
  // maybeCompleteRebalance, which skips the model flip and return boundary
  // entirely for this scope, because the strategy itself does not change.
  const affected = request.affected_investors as {
    scope?: unknown;
    user_id?: unknown;
    family_member_id?: unknown;
  } | null;
  const isSingleUser = affected?.scope === "single_user";
  const singleUserId = typeof affected?.user_id === "string" ? affected.user_id : "";
  if (isSingleUser && !singleUserId) {
    return { ok: false, error: "single_user rebalance is missing affected_investors.user_id" };
  }
  const restrictToUserId = isSingleUser ? singleUserId : undefined;
  const restrictToFamilyMemberId =
    isSingleUser && typeof affected?.family_member_id === "string" ? affected.family_member_id : null;

  let parked: { reconciledUserIds: string[]; errors: string[] } | null = null;
  try {
    parked = await reconcileParkedHoldings(
      retailDb,
      institutionalDb,
      resolvedStrategyId,
      strategyName,
      currentComposition,
      proposedComposition,
      request.id,
      isUatStrategy,
      restrictToUserId,
      restrictToFamilyMemberId,
    );
  } catch (err) {
    parked = { reconciledUserIds: [], errors: [err instanceof Error ? err.message : String(err)] };
  }

  // Settled (already-filled) clients don't get their holdings touched at
  // approval time — only a real fill can change what they hold. This books
  // the parked delta orders (+1/-5 etc.) the desk reviews on the order book
  // instead.
  let booked: { bookedUserIds: string[]; errors: string[] } | null = null;
  try {
    booked = await bookSettledRebalanceOrders(
      retailDb,
      institutionalDb,
      resolvedStrategyId,
      strategyName,
      currentComposition,
      proposedComposition,
      request.id,
      isUatStrategy,
      restrictToUserId,
      restrictToFamilyMemberId,
    );
  } catch (err) {
    booked = { bookedUserIds: [], errors: [err instanceof Error ? err.message : String(err)] };
  }

  return { ok: true, parked, booked };
}
