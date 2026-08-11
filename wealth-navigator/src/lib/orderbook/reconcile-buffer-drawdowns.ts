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
 * SHARED POOL — the reserve has a second consumer. Rebalance fees are drawn
 * from the same `buffer_consumed_cents` by settleRebalanceCashForClients,
 * which adds its total rather than recomputing one. This function used to
 * assign the slippage total outright, so whichever ran last won: an ordinary
 * buy fill landing after a rebalance would recompute from slippage alone and
 * silently erase the rebalance's fees.
 *
 * It now only ever replaces its OWN contribution. The portion of the column
 * that this function's previous slippage rows don't account for is treated as
 * somebody else's draw and carried through untouched. That keeps the two
 * consumers independent in either order, and needs no schema change — the
 * `buffer_drawdowns_c.event_type` CHECK is a closed set, so rebalance fees
 * cannot be given a ledger row of their own without a migration. It also means
 * consumption recorded before the ledger existed (six transactions, R689.09,
 * written straight to the column) survives rather than being zeroed on the
 * first recompute.
 *
 * Never throws: a reconciliation hiccup must not fail a real fill.
 */

export interface BufferReconcileResult {
  transactionsTouched: number;
  errors: string[];
}

/** Slippage rows this function owns and rewrites on every recompute. */
const SLIPPAGE_EVENT_TYPES = ["slippage_drawdown", "shortfall"] as const;

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

        // What this function contributed last time. Only `slippage_drawdown`
        // counts — a `shortfall` row records slippage the reserve could NOT
        // cover, so it never consumed anything. Whatever the column holds
        // beyond this belongs to the other consumer (rebalance fees, or a
        // pre-ledger direct write) and must survive the recompute below.
        const priorRes = await retailDb
          .from("buffer_drawdowns_c")
          .select("delta_cents")
          .eq("transaction_id", txId)
          .eq("event_type", "slippage_drawdown");
        if (priorRes.error) {
          result.errors.push(`tx ${txId}: ${priorRes.error.message}`);
          continue;
        }
        const priorSlippage = ((priorRes.data ?? []) as Array<{ delta_cents: number | null }>).reduce(
          (sum, r) => sum + Math.max(0, Math.round(Number(r.delta_cents) || 0)),
          0,
        );
        const otherConsumers = Math.max(0, Math.round(Number(tx.buffer_consumed_cents) || 0) - priorSlippage);

        await retailDb
          .from("buffer_drawdowns_c")
          .delete()
          .eq("transaction_id", txId)
          .in("event_type", SLIPPAGE_EVENT_TYPES as unknown as string[]);

        let remaining = bufferPool;
        let slippageConsumed = 0;
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
            slippageConsumed += drawn;
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
        // Replace only this function's own contribution; anything else the
        // column was carrying stays.
        const consumed = otherConsumers + slippageConsumed;
        if (Math.round(Number(tx.buffer_consumed_cents) || 0) !== consumed) {
          const updRes = await retailDb
            .from("transactions")
            .update({ buffer_consumed_cents: consumed })
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
