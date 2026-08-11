import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Reconcile the execution-reserve (8% buffer) ledger after BUY fill prices land.
 *
 * A client is charged the price they SAW when they bought (`Expected_fill`).
 * When the broker fills higher, that slippage is absorbed by the 8% execution
 * reserve set aside on their funding transaction rather than being passed on.
 * This records where that reserve went: one `buffer_drawdowns_c` row per
 * holding that slipped, plus a `shortfall` row when the slippage outran the
 * pool, and syncs `transactions.buffer_consumed_cents`.
 *
 * The recompute is whole-transaction and idempotent: it clears this
 * transaction's prior fill-type ledger rows and rebuilds them from every BUY
 * holding on the transaction, not just the ones in this batch. A re-fill or a
 * price correction therefore converges instead of double-charging.
 *
 * SELL refunds are a separate settlement-time flow and are excluded here.
 *
 * Port of the CRM's `reconcileBufferDrawdowns` in api/orderbook/update-price.js,
 * which the OEM previously reached over HTTP for every UAT buy self-fill.
 *
 * KNOWN INTERACTION — this writes `buffer_consumed_cents` ABSOLUTELY (it is
 * the total slippage drawn, recomputed from scratch), while
 * settleRebalanceCashForClients ADDS the rebalance's own reserve-funded fees
 * to the same column. They are two consumers of one pool with different write
 * models. Today the ordering saves us: every buy fill in a rebalance runs this
 * first, and the rebalance's fee settlement runs once at completion, after.
 * But a later, unrelated buy fill on the same transaction would recompute from
 * slippage alone and wipe the rebalance's recorded fee consumption. Worth
 * unifying (a single ledger-derived total) before this pattern spreads.
 *
 * Never throws: a reconciliation hiccup must not fail a real fill.
 */

export interface BufferReconcileResult {
  transactionsTouched: number;
  errors: string[];
}

interface HoldingRow {
  id: string;
  quantity: number | null;
  avg_fill: number | null;
  user_id: string | null;
  family_member_id: string | null;
  trade_side: string | null;
  Expected_fill: number | null;
}

function isBuy(row: { trade_side: string | null }): boolean {
  return String(row.trade_side ?? "").toUpperCase() !== "SELL";
}

export async function reconcileBufferDrawdowns(
  retailDb: SupabaseClient,
  holdingIds: string[],
): Promise<BufferReconcileResult> {
  const result: BufferReconcileResult = { transactionsTouched: 0, errors: [] };
  const ids = [...new Set(holdingIds.filter(Boolean))];
  if (ids.length === 0) return result;

  try {
    const affectedRes = await retailDb
      .from("stock_holdings_c")
      .select("id, transaction_id, trade_side")
      .in("id", ids);
    if (affectedRes.error) {
      result.errors.push(affectedRes.error.message);
      return result;
    }
    const affected = (affectedRes.data ?? []) as Array<{
      id: string;
      transaction_id: string | null;
      trade_side: string | null;
    }>;
    const txIds = [
      ...new Set(affected.filter((h) => isBuy(h) && h.transaction_id).map((h) => h.transaction_id as string)),
    ];
    if (txIds.length === 0) return result;

    for (const txId of txIds) {
      try {
        const txRes = await retailDb
          .from("transactions")
          .select("id, user_id, family_member_id, buffer_cents, buffer_consumed_cents")
          .eq("id", txId)
          .maybeSingle();
        const tx = txRes.data as {
          id: string;
          user_id: string | null;
          family_member_id: string | null;
          buffer_cents: number | null;
          buffer_consumed_cents: number | null;
        } | null;
        if (!tx) continue;
        const bufferPool = Math.max(0, Math.round(Number(tx.buffer_cents) || 0));

        // Every BUY holding on the transaction, so the recompute reflects the
        // full picture rather than only the batch that just filled.
        const holdingsRes = await retailDb
          .from("stock_holdings_c")
          .select('id, quantity, avg_fill, user_id, family_member_id, trade_side, "Expected_fill"')
          .eq("transaction_id", txId);
        if (holdingsRes.error) {
          result.errors.push(`tx ${txId}: ${holdingsRes.error.message}`);
          continue;
        }
        const buys = ((holdingsRes.data ?? []) as HoldingRow[]).filter(isBuy);

        await retailDb
          .from("buffer_drawdowns_c")
          .delete()
          .eq("transaction_id", txId)
          .in("event_type", ["slippage_drawdown", "shortfall"]);

        let remaining = bufferPool;
        let totalConsumed = 0;
        const rows: Array<Record<string, unknown>> = [];
        for (const h of buys) {
          const qty = Math.abs(Number(h.quantity) || 0);
          // Expected_fill is RANDS on this table; avg_fill is CENTS.
          const expectedRand = Number(h.Expected_fill);
          const actualCents = Number(h.avg_fill);
          if (!qty) continue;
          if (!Number.isFinite(expectedRand) || expectedRand <= 0) continue;
          if (!Number.isFinite(actualCents) || actualCents <= 0) continue;

          const expectedCents = Math.round(expectedRand * 100);
          const slipPerShare = actualCents - expectedCents;
          if (slipPerShare <= 0) continue; // filled at or below quote — reserve untouched

          const need = slipPerShare * qty;
          const drawn = Math.min(need, remaining);
          const base = {
            transaction_id: txId,
            holding_id: h.id,
            user_id: tx.user_id || h.user_id,
            family_member_id: h.family_member_id || tx.family_member_id || null,
            expected_fill_cents: expectedCents,
            actual_fill_cents: actualCents,
            quantity: qty,
          };
          if (drawn > 0) {
            rows.push({
              ...base,
              event_type: "slippage_drawdown",
              delta_cents: drawn,
              notes: "Fill price above quote — absorbed by execution reserve",
            });
            remaining -= drawn;
            totalConsumed += drawn;
          }
          const short = need - drawn;
          if (short > 0) {
            rows.push({
              ...base,
              event_type: "shortfall",
              delta_cents: short,
              notes: "Slippage exceeded execution reserve",
            });
          }
        }

        if (rows.length > 0) {
          const insertRes = await retailDb.from("buffer_drawdowns_c").insert(rows);
          if (insertRes.error) result.errors.push(`tx ${txId}: ${insertRes.error.message}`);
        }
        if (Math.round(Number(tx.buffer_consumed_cents) || 0) !== totalConsumed) {
          const updRes = await retailDb
            .from("transactions")
            .update({ buffer_consumed_cents: totalConsumed })
            .eq("id", txId);
          if (updRes.error) result.errors.push(`tx ${txId}: ${updRes.error.message}`);
        }
        result.transactionsTouched += 1;
      } catch (err) {
        result.errors.push(`tx ${txId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  } catch (err) {
    result.errors.push(err instanceof Error ? err.message : String(err));
  }
  return result;
}
