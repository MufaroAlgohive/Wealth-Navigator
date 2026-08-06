import type { SupabaseClient } from "@supabase/supabase-js";

import { type ModelUnitAction, calculateModelUnitImpact, fullModelLots } from "./model-unit-impact";

/**
 * When an IC-approved rebalance changes a strategy's model composition, any
 * client whose BUY into that strategy hasn't been sent to the broker yet is
 * sitting on a stale order — it would eventually fill against the OLD
 * composition. This rewrites those "parked" holdings directly to the new
 * target (same treatment a settled client gets from the model-unit math),
 * WITHOUT charging brokerage/custody — the order never touched the market,
 * so there's nothing to charge a fee against. Their strategy CA ends up
 * higher than a fee-paying settled client's by exactly that fee amount.
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
  strategyId: string,
  strategyName: string | null,
  currentComposition: ProposedLine[],
  proposedComposition: ProposedLine[],
): Promise<ReconcileParkedResult> {
  const result: ReconcileParkedResult = { reconciledUserIds: [], errors: [] };

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
  const parkedRows = (parkedRes.data ?? []) as Array<{
    id: string;
    user_id: string;
    security_id: string;
    quantity: number | null;
    transaction_id: string | null;
    avg_fill: number | null;
    Expected_fill: number | null;
  }>;
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

  for (const [userId, rows] of byUser) {
    try {
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

        const security = secBySymbol.get(sym);
        if (position) {
          // Existing parked row for this symbol — rewrite in place.
          if (targetQty <= 0) {
            await db
              .from("stock_holdings_c")
              .update({ quantity: 0, is_active: false })
              .eq("id", position.rowId);
          } else {
            await db
              .from("stock_holdings_c")
              .update({ quantity: targetQty, Expected_fill: priceCents / 100 })
              .eq("id", position.rowId);
          }
        } else if (targetQty > 0 && security) {
          // New symbol this client didn't already hold — insert a parked row
          // for it, matching the shape of the rows we're reading from.
          const sourceRow = rows[0];
          await db.from("stock_holdings_c").insert({
            user_id: userId,
            security_id: security.id,
            quantity: targetQty,
            strategy_id: strategyId,
            strategy_name_snapshot: strategyName,
            transaction_id: sourceRow?.transaction_id ?? null,
            trade_side: "BUY",
            is_active: true,
            avg_fill: 0,
            Expected_fill: priceCents / 100,
          });
        }
      }

      if (grossSellCents !== 0 || grossBuyCents !== 0) {
        const deltaCents = grossSellCents - grossBuyCents; // no fees — never hit the market
        const residualRes = await db
          .from("strategy_rebalance_residuals")
          .select("id, balance_cents")
          .eq("user_id", userId)
          .eq("strategy_id", strategyId)
          .limit(1)
          .maybeSingle();
        if (residualRes.data) {
          await db
            .from("strategy_rebalance_residuals")
            .update({ balance_cents: Number(residualRes.data.balance_cents ?? 0) + deltaCents })
            .eq("id", residualRes.data.id);
        } else {
          await db.from("strategy_rebalance_residuals").insert({
            user_id: userId,
            strategy_id: strategyId,
            balance_cents: deltaCents,
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
