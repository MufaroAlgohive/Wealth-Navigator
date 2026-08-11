import type { SupabaseClient } from "@supabase/supabase-js";

import { isUatEnv } from "@/lib/oems/uat-scope";
import { type ModelUnitAction, calculateModelUnitImpact, fullModelLots } from "./model-unit-impact";
import { calculateProceedsBridge } from "./proceeds";

/**
 * When an IC-approved rebalance changes a strategy's model composition, any
 * client whose BUY into that strategy hasn't been sent to the broker yet is
 * sitting on a stale order — it would eventually fill against the OLD
 * composition. This rewrites the ORDER (oems_order_audit) to the new target
 * immediately — nothing stops us from recomposing an order that was never
 * sent anywhere — but deliberately does NOT touch the client's visible
 * `stock_holdings_c.quantity` yet. Holdings must reflect the same thing for
 * every client regardless of parked-vs-settled status: nothing changes until
 * an order actually fills. Repositioning a parked client instantly while a
 * settled client waits for their delta order to fill would show one client's
 * numbers flipping ahead of everyone else who held the identical position —
 * confusing on its own book. The fill path (settleUatFill,
 * admin/orderbook/fills/route.ts) is what finally writes the order's
 * quantity onto the referenced holding, for parked and settled clients alike.
 * The one exception is a full sell-to-zero: there's no future order left to
 * fill (the pending BUY is simply cancelled), so that has to apply now or
 * never.
 *
 * Fee treatment (confirmed with the desk): the client already paid one ISIN
 * custody fee per asset in their ORIGINAL basket at purchase time — nothing
 * has been sent to a broker yet, so repositioning weights among assets they
 * were already going to buy (including selling one down to zero) costs
 * nothing more; it's still the same single not-yet-dispatched order, just
 * recomposed. A genuinely NEW asset added to the strategy (one they weren't
 * already going to hold) DOES cost one fresh ISIN custody fee — same as it
 * costs every already-settled client buying that new asset for real. No
 * brokerage ever applies here (nothing hits the market for a parked order).
 *
 * Also note for whoever eventually wires real broker dispatch: a parked
 * client's "sell" is bookkeeping only. The broker has never heard of this
 * client holding that ISIN — their original order never went out — so a
 * decrease/removal must never be translated into an actual SELL instruction
 * for them; it's simply fewer lines in the one still-pending BUY order.
 *
 * "Parked" detection: a BUY holding with no `Fill_date` yet. This is a
 * pragmatic signal, not a perfect one — a real dispatched-but-still-filling
 * order would also have no Fill_date and would incorrectly qualify. There is
 * currently no per-client attribution on dispatched `oems_order_audit` rows
 * to distinguish "never sent" from "sent, not yet filled" (see the disable
 * comment on requests/[id]/push/route.ts). Safe for the controlled test this
 * was built for; revisit once per-client dispatch attribution exists.
 */

interface ProposedLine {
  ticker: string;
  action?: string;
  shares?: number | null;
}

/** "MTN.JO" / " mtn " -> "MTN". */
function bare(sym: string): string {
  return String(sym ?? "")
    .trim()
    .toUpperCase()
    .replace(/\.(JO|JSE)$/i, "");
}

export interface ReconcileParkedResult {
  reconciledUserIds: string[];
  errors: string[];
}

export async function reconcileParkedHoldings(
  db: SupabaseClient,
  institutionalDb: SupabaseClient,
  strategyId: string,
  strategyName: string | null,
  currentComposition: ProposedLine[],
  proposedComposition: ProposedLine[],
  rebalanceRequestId?: string,
  isUatStrategy?: boolean,
  /**
   * Single-client rebalance: confine every read and write below to this one
   * account. Without it a `single_user` request would fan its target
   * quantities out across the whole strategy — the composition it carries is
   * one client's personal holdings, not a model template.
   */
  restrictToUserId?: string,
): Promise<ReconcileParkedResult> {
  const result: ReconcileParkedResult = { reconciledUserIds: [], errors: [] };
  const ACCOUNT_CODE = process.env.IRESS_ACCOUNT_CODE?.trim() || "";
  // Whether THIS strategy is UAT/test drives the broker destination and the
  // uat_test tag — not a blanket server-wide flag. A UAT strategy's orders
  // must show under "UAT orders" on Active Orderbook regardless of what
  // IRESS_UAT_MODE happens to be set to on this deployment. Falls back to
  // the server-wide flag only if the caller couldn't resolve the strategy's
  // own environment.
  const IS_UAT = isUatStrategy ?? isUatEnv();
  const BROKER = IS_UAT
    ? process.env.IRESS_UAT_DESTINATION?.trim() || "LONGMARK CARE"
    : process.env.IRESS_DESTINATION?.trim() || "LONGMARK CARE";

  const currentModelUnits = new Map<string, number>();
  for (const line of currentComposition) {
    const sym = bare(line.ticker);
    const shares = Math.max(0, Number(line.shares) || 0);
    if (sym && shares > 0) currentModelUnits.set(sym, shares);
  }
  const targets = new Map<string, { action: ModelUnitAction; units: number }>();
  for (const line of proposedComposition) {
    const sym = bare(line.ticker);
    if (!sym) continue;
    targets.set(sym, {
      action: (line.action as ModelUnitAction) ?? "hold",
      units: Math.max(0, Math.round(Number(line.shares) || 0)),
    });
  }
  if (targets.size === 0) return result;

  // Same fee config every rebalance preview uses — only the custody/ISIN
  // fee applies here (see file docstring); brokerage never does. Best
  // effort: an unavailable fee config degrades to fee-free rather than
  // blocking the whole IC approval over a holdings-only correction.
  const feeRes = await db.from("app_settings").select("value").eq("key", "fees").limit(1).maybeSingle();
  const custodyFeeRands = Number((feeRes.data?.value as Record<string, unknown> | null)?.rebCustodyFee);
  const custodyFeeCentsPerIsin =
    Number.isFinite(custodyFeeRands) && custodyFeeRands >= 0 ? Math.round(custodyFeeRands * 100) : 0;
  if (!feeRes.data)
    result.errors.push("Fee config unavailable — new-asset ISIN fee skipped for parked clients.");

  // Parked = active BUY holdings for this strategy with no confirmed fill yet.
  let parkedRes = await db
    .from("stock_holdings_c")
    .select("id, user_id, security_id, quantity, transaction_id, avg_fill, Expected_fill")
    .eq("is_active", true)
    .eq("trade_side", "BUY")
    .is("Fill_date", null)
    .eq("strategy_id", strategyId);
  if ((!parkedRes.data || parkedRes.data.length === 0) && strategyName) {
    parkedRes = await db
      .from("stock_holdings_c")
      .select("id, user_id, security_id, quantity, transaction_id, avg_fill, Expected_fill")
      .eq("is_active", true)
      .eq("trade_side", "BUY")
      .is("Fill_date", null)
      .eq("strategy_name_snapshot", strategyName);
  }
  if (parkedRes.error) {
    result.errors.push(parkedRes.error.message);
    return result;
  }
  const allParkedRows = (parkedRes.data ?? []) as Array<{
    id: string;
    user_id: string;
    security_id: string;
    quantity: number | null;
    transaction_id: string | null;
    avg_fill: number | null;
    Expected_fill: number | null;
  }>;
  // Narrowing here rather than in the query keeps the fallback lookup above
  // (strategy_id, then strategy_name_snapshot) in one place, and the row set
  // is a single strategy's holdings either way.
  const parkedRows = restrictToUserId
    ? allParkedRows.filter((r) => r.user_id === restrictToUserId)
    : allParkedRows;
  if (parkedRows.length === 0) return result;

  const byUser = new Map<string, typeof parkedRows>();
  for (const row of parkedRows) {
    const list = byUser.get(row.user_id) ?? [];
    list.push(row);
    byUser.set(row.user_id, list);
  }

  // Resolve symbol + last price for every held security id (needed for both
  // the current-symbol lookup and pricing any newly-added target symbol).
  const heldSecIds = [...new Set(parkedRows.map((r) => r.security_id).filter(Boolean))];
  const targetSymbols = [...targets.keys()];
  const symbolCandidates = targetSymbols.flatMap((s) => [s, `${s}.JO`]);
  const [secByIdRes, secBySymRes] = await Promise.all([
    heldSecIds.length
      ? db.from("securities_c").select("id, symbol, last_price").in("id", heldSecIds)
      : Promise.resolve({ data: [] as Array<Record<string, unknown>>, error: null }),
    symbolCandidates.length
      ? db.from("securities_c").select("id, symbol, last_price").in("symbol", symbolCandidates)
      : Promise.resolve({ data: [] as Array<Record<string, unknown>>, error: null }),
  ]);
  const secRows = [...(secByIdRes.data ?? []), ...(secBySymRes.data ?? [])] as Array<{
    id: string;
    symbol: string;
    last_price: number | null;
  }>;
  const secById = new Map<string, { symbol: string; priceCents: number }>();
  const secBySymbol = new Map<string, { id: string; priceCents: number }>();
  for (const s of secRows) {
    const sym = bare(s.symbol);
    const cents = Number(s.last_price) || 0;
    secById.set(s.id, { symbol: sym, priceCents: cents });
    if (!secBySymbol.has(sym)) secBySymbol.set(sym, { id: s.id, priceCents: cents });
  }

  const userIds = [...byUser.keys()];
  const profilesRes = userIds.length
    ? await db.from("profiles").select("id, email").in("id", userIds)
    : { data: [] as Array<{ id: string; email: string | null }> };
  const emailByUser = new Map<string, string>();
  for (const p of profilesRes.data ?? []) {
    if (p.email) emailByUser.set(p.id, p.email);
  }

  for (const [userId, rows] of byUser) {
    try {
      const clientEmail = emailByUser.get(userId) ?? "unknown@mymint.co.za";
      const positions = new Map<string, { quantity: number; rowId: string }>();
      for (const row of rows) {
        const meta = secById.get(row.security_id);
        if (!meta) continue;
        positions.set(meta.symbol, { quantity: Number(row.quantity) || 0, rowId: row.id });
      }

      // This client's own lot count vs. the OLD model — same formula used
      // everywhere else in rebalance (impact/route.ts) for consistency.
      const lotsCandidates = [...currentModelUnits.entries()]
        .map(([symbol, units]) => fullModelLots(positions.get(symbol)?.quantity ?? 0, units))
        .filter((lots) => lots > 0);
      const lots = lotsCandidates.length ? Math.min(...lotsCandidates) : 0;
      if (lots === 0) continue; // can't safely size a target without a lot count

      let grossSellCents = 0;
      let grossBuyCents = 0;
      let newAssetCount = 0; // only these incur a custody/ISIN fee — see docstring
      const names = new Set<string>([...positions.keys(), ...targets.keys()]);
      for (const sym of names) {
        const target = targets.get(sym);
        if (!target || target.action === "hold") continue;
        const position = positions.get(sym);
        const currentQty = position?.quantity ?? 0;
        const currentUnits = currentModelUnits.get(sym) ?? 0;
        const { targetQty, deltaQty } = calculateModelUnitImpact({
          action: target.action,
          currentQty,
          currentModelUnits: currentUnits,
          targetModelUnits: target.units,
          fallbackLots: lots,
        });
        if (deltaQty === 0) continue;
        const priceCents = secBySymbol.get(sym)?.priceCents ?? 0;
        const valueCents = Math.abs(deltaQty) * priceCents;
        if (deltaQty > 0) grossBuyCents += valueCents;
        else grossSellCents += valueCents;
        if (!position && target.action === "add") newAssetCount += 1;

        const security = secBySymbol.get(sym);
        if (position) {
          // Existing parked row for this symbol. A full sell-to-zero has no
          // future fill to wait for (the pending BUY is simply cancelled),
          // so that applies now. A reposition only rewrites the ORDER —
          // `stock_holdings_c.quantity` stays untouched until the order
          // actually fills (see file docstring).
          if (targetQty <= 0) {
            await db
              .from("stock_holdings_c")
              .update({ quantity: 0, is_active: false })
              .eq("id", position.rowId);
            await institutionalDb
              .from("oems_order_audit")
              .update({ status: "cancelled", updated_at: new Date().toISOString() })
              .eq("payload->>holding_id", position.rowId)
              .eq("status", "parked");
          } else {
            const auditRes = await institutionalDb
              .from("oems_order_audit")
              .select("id, payload")
              .eq("payload->>holding_id", position.rowId)
              .eq("status", "parked")
              .maybeSingle();
            if (auditRes.data) {
              await institutionalDb
                .from("oems_order_audit")
                .update({
                  quantity: targetQty,
                  price_cents: priceCents,
                  payload: {
                    ...(auditRes.data.payload as Record<string, unknown>),
                    limitPrice: priceCents / 100,
                    rebalance_request_id: rebalanceRequestId ?? null,
                    client_treatment: "parked",
                  },
                  updated_at: new Date().toISOString(),
                })
                .eq("id", auditRes.data.id);
            }
          }
        } else if (targetQty > 0 && security) {
          // New symbol this client didn't already hold — insert a placeholder
          // row (quantity 0, unfilled) so the order below has a holding_id to
          // reference, plus a matching parked order-book row (same shape as a
          // real client buy — see client-order/route.ts). The row's quantity
          // only becomes real at fill time, same as every other case here.
          const sourceRow = rows[0];
          const insertedRes = await db
            .from("stock_holdings_c")
            .insert({
              user_id: userId,
              security_id: security.id,
              quantity: 0,
              strategy_id: strategyId,
              strategy_name_snapshot: strategyName,
              transaction_id: sourceRow?.transaction_id ?? null,
              trade_side: "BUY",
              is_active: true,
              avg_fill: 0,
              Expected_fill: priceCents / 100,
            })
            .select("id")
            .maybeSingle();
          const newHoldingId = insertedRes.data?.id;
          if (newHoldingId && ACCOUNT_CODE) {
            const now = new Date().toISOString();
            await institutionalDb.from("oems_order_audit").insert({
              order_id: `REBALANCE-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
              client_account: clientEmail,
              broker_account_code: ACCOUNT_CODE,
              symbol: sym,
              side: "buy",
              quantity: targetQty,
              price_cents: priceCents,
              status: "parked",
              source: "PAPER_MODEL_REBALANCE",
              payload: {
                book_id: strategyName,
                broker: BROKER,
                order_type: "market",
                strategy: strategyName,
                security_id: security.id,
                isin: null,
                holding_id: newHoldingId,
                family_member_id: null,
                user_id: userId,
                limitPrice: priceCents / 100,
                sent_by: clientEmail,
                sent_at: now,
                trader: clientEmail,
                uat_test: IS_UAT,
                broker_account_code: ACCOUNT_CODE,
                rebalance_request_id: rebalanceRequestId ?? null,
                client_treatment: "parked",
              },
              result_payload: {
                tif: "DAY",
                venue: "JSE",
                broker: BROKER,
                uat_test: IS_UAT,
                preflight: {
                  ok: true,
                  code: "pass",
                  message: "Not yet preflighted — parked, awaiting Send to Market release.",
                  verdict: "pass",
                },
                arrivalMid: priceCents / 100,
              },
              created_at: now,
              updated_at: now,
            });
          }
        }
      }

      if (grossSellCents !== 0 || grossBuyCents !== 0) {
        const residualRes = await db
          .from("strategy_rebalance_residuals")
          .select("id, balance_cents")
          .eq("user_id", userId)
          .eq("strategy_id", strategyId)
          .limit(1)
          .maybeSingle();
        const residualCents = Number(residualRes.data?.balance_cents ?? 0);

        const txnIds = [...new Set(rows.map((r) => r.transaction_id).filter(Boolean))] as string[];
        const transactionsForReserve: Array<{
          id: string;
          buffer_cents: number;
          buffer_consumed_cents: number;
        }> = [];
        let reserveCents = 0;
        if (txnIds.length) {
          const txnRes = await db
            .from("transactions")
            .select("id,buffer_cents,buffer_consumed_cents,status,reversed")
            .in("id", txnIds);
          for (const t of (txnRes.data ?? []) as Array<{
            id: string;
            buffer_cents: number | null;
            buffer_consumed_cents: number | null;
            status: string | null;
            reversed: boolean | null;
          }>) {
            if (t.status !== "posted" || t.reversed === true) continue;
            const bufferCents = Number(t.buffer_cents ?? 0);
            const bufferConsumedCents = Number(t.buffer_consumed_cents ?? 0);
            reserveCents += Math.max(0, bufferCents - bufferConsumedCents);
            transactionsForReserve.push({
              id: t.id,
              buffer_cents: bufferCents,
              buffer_consumed_cents: bufferConsumedCents,
            });
          }
        }

        // Only a genuinely new asset costs a fee (sellAssetCount is always 0
        // — a parked sell never touched a market, so it's never charged;
        // brokerageRate is always 0 for the same reason).
        const bridge = calculateProceedsBridge({
          grossSellCents,
          grossBuyCents,
          sellAssetCount: 0,
          buyAssetCount: newAssetCount,
          brokerageRate: 0,
          custodyFeeCents: custodyFeeCentsPerIsin,
          reserveCents,
          residualCents,
        });

        let remainingReserveUse = bridge.reserveUsedCents;
        for (const t of transactionsForReserve) {
          if (remainingReserveUse <= 0) break;
          const available = Math.max(0, t.buffer_cents - t.buffer_consumed_cents);
          const use = Math.min(available, remainingReserveUse);
          if (use > 0) {
            await db
              .from("transactions")
              .update({ buffer_consumed_cents: t.buffer_consumed_cents + use })
              .eq("id", t.id);
            remainingReserveUse -= use;
          }
        }

        if (residualRes.data) {
          await db
            .from("strategy_rebalance_residuals")
            .update({ balance_cents: bridge.strategyCashAfterCents })
            .eq("id", residualRes.data.id);
        } else {
          await db.from("strategy_rebalance_residuals").insert({
            user_id: userId,
            strategy_id: strategyId,
            balance_cents: bridge.strategyCashAfterCents,
          });
        }
      }

      result.reconciledUserIds.push(userId);
    } catch (err) {
      result.errors.push(err instanceof Error ? err.message : String(err));
    }
  }

  return result;
}
