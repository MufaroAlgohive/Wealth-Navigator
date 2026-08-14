import type { SupabaseClient } from "@supabase/supabase-js";

import { calculateProceedsBridge } from "./proceeds";

/**
 * A settled client's rebalance is an internal swap, not a withdrawal: the
 * sell's proceeds fund the paired buys, fees are drawn from the strategy's
 * own 8% execution reserve first, and only genuine leftover cash becomes
 * strategy residual — never a raw wallet credit. settleUatSellFill
 * (admin/orderbook/fills/route.ts) already skips the wallet movement a
 * normal sell settlement would do (skipCashMovement); this is the other
 * half — called once every order in a rebalance has finished, applying the
 * real net effect per settled client in one pass.
 *
 * Deliberately keyed off `payload.client_treatment === "settled"` — parked
 * clients never reach this function; their (fee-free) reserve/residual
 * accounting already happened at booking time in reconcile-parked-holdings.ts.
 */

interface FilledOrder {
  side: string;
  quantity: number;
  symbol: string;
  payload: Record<string, unknown>;
}

export interface SettleRebalanceCashResult {
  settledUserIds: string[];
  errors: string[];
}

export async function settleRebalanceCashForClients(
  retailDb: SupabaseClient,
  institutionalDb: SupabaseClient,
  rebalanceRequestId: string,
  settlementBatchId: string | undefined,
): Promise<SettleRebalanceCashResult> {
  const result: SettleRebalanceCashResult = { settledUserIds: [], errors: [] };
  if (!settlementBatchId) {
    result.errors.push("cash evidence requires the completed retail settlement batch");
    return result;
  }

  const feeRes = await retailDb.from("app_settings").select("value").eq("key", "fees").limit(1).maybeSingle();
  const feeValue = feeRes.data?.value as Record<string, unknown> | null;
  const brokerageRate = Number(feeValue?.brokerFeeRate);
  const custodyFeeRands = Number(feeValue?.isinFeePerAsset);
  const safeBrokerageRate = Number.isFinite(brokerageRate) && brokerageRate >= 0 ? brokerageRate : 0;
  const custodyFeeCentsPerIsin =
    Number.isFinite(custodyFeeRands) && custodyFeeRands >= 0 ? Math.round(custodyFeeRands * 100) : 0;

  const ordersRes = await institutionalDb
    .from("oems_order_audit")
    .select("side, quantity, symbol, payload")
    .eq("payload->>rebalance_request_id", rebalanceRequestId)
    .eq("payload->>client_treatment", "settled")
    .eq("status", "filled");
  if (ordersRes.error) {
    result.errors.push(ordersRes.error.message);
    return result;
  }
  const orders = (ordersRes.data ?? []) as FilledOrder[];
  if (orders.length === 0) return result;

  const byUser = new Map<string, FilledOrder[]>();
  for (const o of orders) {
    const uid = typeof o.payload?.user_id === "string" ? o.payload.user_id : "";
    if (!uid) continue;
    const list = byUser.get(uid) ?? [];
    list.push(o);
    byUser.set(uid, list);
  }

  const settlements: Record<string, unknown>[] = [];
  for (const [userId, userOrders] of byUser) {
    try {
      let grossSellCents = 0;
      let grossBuyCents = 0;
      const sellSymbols = new Set<string>();
      const buySymbols = new Set<string>();
      let sellHoldingId: string | null = null;

      for (const o of userOrders) {
        const avgPx = Number(o.payload?.avgPx) || 0;
        const valueCents = Number(o.quantity) * avgPx;
        if (o.side === "sell") {
          grossSellCents += valueCents;
          sellSymbols.add(o.symbol);
          if (!sellHoldingId && typeof o.payload?.holding_id === "string") {
            sellHoldingId = o.payload.holding_id;
          }
        } else {
          grossBuyCents += valueCents;
          buySymbols.add(o.symbol);
        }
      }
      if (grossSellCents === 0 && grossBuyCents === 0) continue;

      const realStrategyRowId = await resolveStrategyRowId(userOrders);

      // Reserve scope: the ORIGINAL transaction that funded the position(s)
      // this rebalance touched — prefer the sell's own referenced holding
      // (it's the pre-existing lot, guaranteed to predate this rebalance);
      // fall back to any of the user's other active holdings in this
      // strategy otherwise (a rebalance with only increases, no decreases).
      let transactionId: string | null = null;
      if (sellHoldingId) {
        const { data } = await retailDb
          .from("stock_holdings_c")
          .select("transaction_id")
          .eq("id", sellHoldingId)
          .maybeSingle();
        transactionId = (data?.transaction_id as string | null) ?? null;
      }
      if (!transactionId && realStrategyRowId) {
        // Exclude this rebalance's own newly-created placeholder rows — a
        // real UUID that can never match a row keeps this a single
        // unconditional filter instead of a type-widening branch.
        const excludeIds = userOrders
          .filter((o) => o.side === "buy" && typeof o.payload?.holding_id === "string")
          .map((o) => o.payload.holding_id as string);
        if (excludeIds.length === 0) excludeIds.push("00000000-0000-0000-0000-000000000000");
        const { data } = await retailDb
          .from("stock_holdings_c")
          .select("transaction_id")
          .eq("user_id", userId)
          .eq("strategy_id", realStrategyRowId)
          .not("transaction_id", "is", null)
          .not("id", "in", `(${excludeIds.join(",")})`)
          .order("created_at", { ascending: true })
          .limit(1);
        transactionId = (data?.[0]?.transaction_id as string | null) ?? null;
      }

      let reserveCents = 0;
      let bufferConsumedCents = 0;
      if (transactionId) {
        const { data: txn } = await retailDb
          .from("transactions")
          .select("buffer_cents, buffer_consumed_cents")
          .eq("id", transactionId)
          .maybeSingle();
        if (txn) {
          bufferConsumedCents = Number(txn.buffer_consumed_cents ?? 0);
          reserveCents = Math.max(0, Number(txn.buffer_cents ?? 0) - Number(txn.buffer_consumed_cents ?? 0));
        }
      }

      // Own residual only — a family member's residual (if any) is a
      // separate cash pool and must never be pulled into this client's own
      // swap math.
      let residualCents = 0;
      if (realStrategyRowId) {
        const { data: residualRows } = await retailDb
          .from("strategy_rebalance_residuals")
          .select("balance_cents")
          .eq("user_id", userId)
          .eq("strategy_id", realStrategyRowId)
          .is("family_member_id", null)
          .maybeSingle();
        residualCents = Number(residualRows?.balance_cents ?? 0);
      }

      const bridge = calculateProceedsBridge({
        grossSellCents,
        grossBuyCents,
        sellAssetCount: sellSymbols.size,
        buyAssetCount: buySymbols.size,
        brokerageRate: safeBrokerageRate,
        custodyFeeCents: custodyFeeCentsPerIsin,
        reserveCents,
        residualCents,
      });

      // Draw the rebalance's fees from the execution reserve. This adds to the
      // transaction's consumed total rather than assigning one, because the
      // reserve has a second consumer: buy-fill slippage reconciliation
      // (reconcileBufferDrawdowns). That function recomputes its own slippage
      // figure on every fill, and used to assign it outright — which erased
      // this draw whenever a buy fill landed afterwards. It now replaces only
      // its own contribution and carries the rest through, so adding here is
      // safe in either order.
      //
      // The atomic database function below writes both the reserve evidence
      // and the residual-cash evidence, then changes these balances in the
      // same transaction. It refuses a stale opening balance rather than
      // risking an unreconcilable cash trail.
      if (!realStrategyRowId) throw new Error("settled rebalance client has no retail strategy identity");
      settlements.push({
        user_id: userId,
        strategy_id: realStrategyRowId,
        transaction_id: transactionId,
        opening_residual_cents: residualCents,
        closing_residual_cents: bridge.strategyCashAfterCents,
        reserve_before_cents: reserveCents,
        reserve_used_cents: bridge.reserveUsedCents,
        reserve_after_cents: bridge.reserveAfterCents,
        requested_fee_cents: bridge.totalFeesCents,
        fee_shortfall_cents: bridge.feeShortfallCents,
        expected_buffer_consumed_cents: bufferConsumedCents,
        gross_sell_cents: bridge.grossSellCents,
        gross_buy_cents: bridge.grossBuyCents,
      });
    } catch (err) {
      result.errors.push(err instanceof Error ? err.message : String(err));
    }
  }

  // Do not write a subset of owners: the reconciliation contract requires
  // one immutable cash/reserve pair for every affected owner in the batch.
  if (settlements.length === 0 || result.errors.length > 0) return result;
  const recorded = await retailDb.rpc("record_rebalance_cash_settlement", {
    p_batch_id: settlementBatchId,
    p_settlements: settlements,
  });
  if (recorded.error) {
    result.errors.push(`cash evidence write failed: ${recorded.error.message}`);
    return result;
  }
  result.settledUserIds = settlements.map((item) => String(item.user_id));
  return result;

  async function resolveStrategyRowId(userOrders: FilledOrder[]): Promise<string | null> {
    const holdingId = userOrders.find((o) => typeof o.payload?.holding_id === "string")?.payload.holding_id as
      | string
      | undefined;
    if (!holdingId) return null;
    const { data } = await retailDb
      .from("stock_holdings_c")
      .select("strategy_id")
      .eq("id", holdingId)
      .maybeSingle();
    return (data?.strategy_id as string | null) ?? null;
  }
}
