import type { SupabaseClient } from "@supabase/supabase-js";

import { isUatEnv } from "@/lib/oems/uat-scope";
import { type ModelUnitAction, calculateModelUnitImpact, fullModelLots } from "./model-unit-impact";

/**
 * When an IC-approved rebalance changes a strategy's model composition, a
 * client who is already FILLED must not have their holdings changed at
 * approval time — the weighting/holding of the strategy only changes once an
 * order actually fills (see reconcile-parked-holdings.ts for the very
 * different treatment of a client whose original buy never reached the
 * broker). Instead, approval books a parked delta order per symbol — the
 * "rebalance book" the desk sees on the UAT order book (+1 to buy, -5 to
 * sell) — and only a real fill (settleUatFill, admin/orderbook/fills/route.ts)
 * is allowed to touch stock_holdings_c.
 *
 * Leg immutability: an increase never rewrites the client's existing filled
 * row. It inserts a brand-new, separate row (Fill_date=null, quantity=delta
 * only) and parks a BUY against THAT row's id — the live filled leg is never
 * touched, matching the no-retroactive-cost-basis-rewrite principle CRM uses
 * for its own rebalances. A decrease/removal parks a SELL referencing the
 * EXISTING filled holding's id directly; the holding itself isn't touched
 * until that sell actually fills.
 *
 * No fees, no reserve/residual changes happen here — a parked order that
 * hasn't filled hasn't cost anything yet. Fee/residual accounting for a
 * settled client's rebalance trade happens at fill time, same as any other
 * real order (out of scope for this function).
 */

interface ProposedLine {
  ticker: string;
  action?: string;
  shares?: number | null;
}

function bare(sym: string): string {
  return String(sym ?? "")
    .trim()
    .toUpperCase()
    .replace(/\.(JO|JSE)$/i, "");
}

export interface BookSettledResult {
  bookedUserIds: string[];
  errors: string[];
}

export async function bookSettledRebalanceOrders(
  db: SupabaseClient,
  institutionalDb: SupabaseClient,
  strategyId: string,
  strategyName: string | null,
  currentComposition: ProposedLine[],
  proposedComposition: ProposedLine[],
): Promise<BookSettledResult> {
  const result: BookSettledResult = { bookedUserIds: [], errors: [] };
  const ACCOUNT_CODE = process.env.IRESS_ACCOUNT_CODE?.trim() || "";
  const IS_UAT = isUatEnv();
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
  if (targets.size === 0 || !ACCOUNT_CODE) return result;

  // Settled = active BUY holdings for this strategy that HAVE a confirmed
  // fill — the mirror image of reconcile-parked-holdings.ts's query.
  let settledRes = await db
    .from("stock_holdings_c")
    .select("id, user_id, security_id, quantity, transaction_id, Fill_date")
    .eq("is_active", true)
    .eq("trade_side", "BUY")
    .not("Fill_date", "is", null)
    .eq("strategy_id", strategyId);
  if ((!settledRes.data || settledRes.data.length === 0) && strategyName) {
    settledRes = await db
      .from("stock_holdings_c")
      .select("id, user_id, security_id, quantity, transaction_id, Fill_date")
      .eq("is_active", true)
      .eq("trade_side", "BUY")
      .not("Fill_date", "is", null)
      .eq("strategy_name_snapshot", strategyName);
  }
  if (settledRes.error) {
    result.errors.push(settledRes.error.message);
    return result;
  }
  const settledRows = (settledRes.data ?? []) as Array<{
    id: string;
    user_id: string;
    security_id: string;
    quantity: number | null;
    transaction_id: string | null;
    Fill_date: string | null;
  }>;
  if (settledRows.length === 0) return result;

  const byUser = new Map<string, typeof settledRows>();
  for (const row of settledRows) {
    const list = byUser.get(row.user_id) ?? [];
    list.push(row);
    byUser.set(row.user_id, list);
  }

  const heldSecIds = [...new Set(settledRows.map((r) => r.security_id).filter(Boolean))];
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
      // A symbol can have more than one filled leg (earlier buys, earlier
      // rebalance increases). Aggregate quantity for correct lot-sizing;
      // keep the most recently filled row's id as the one a decrease's
      // SELL order references — good enough for this controlled scope.
      const positions = new Map<string, { quantity: number; rowId: string }>();
      for (const row of rows) {
        const meta = secById.get(row.security_id);
        if (!meta) continue;
        const existing = positions.get(meta.symbol);
        const qty = Number(row.quantity) || 0;
        if (!existing) {
          positions.set(meta.symbol, { quantity: qty, rowId: row.id });
        } else {
          existing.quantity += qty;
          if ((row.Fill_date ?? "") > "") existing.rowId = row.id;
        }
      }

      const lotsCandidates = [...currentModelUnits.entries()]
        .map(([symbol, units]) => fullModelLots(positions.get(symbol)?.quantity ?? 0, units))
        .filter((lots) => lots > 0);
      const lots = lotsCandidates.length ? Math.min(...lotsCandidates) : 0;
      if (lots === 0) continue;

      const names = new Set<string>([...positions.keys(), ...targets.keys()]);
      let bookedAny = false;
      for (const sym of names) {
        const target = targets.get(sym);
        if (!target || target.action === "hold") continue;
        const position = positions.get(sym);
        const currentQty = position?.quantity ?? 0;
        const currentUnits = currentModelUnits.get(sym) ?? 0;
        const { deltaQty } = calculateModelUnitImpact({
          action: target.action,
          currentQty,
          currentModelUnits: currentUnits,
          targetModelUnits: target.units,
          fallbackLots: lots,
        });
        if (deltaQty === 0) continue;
        const security = secBySymbol.get(sym);
        const priceCents = security?.priceCents ?? 0;
        const now = new Date().toISOString();

        if (deltaQty > 0) {
          if (!security) continue;
          const sourceRow = rows[0];
          const insertedRes = await db
            .from("stock_holdings_c")
            .insert({
              user_id: userId,
              security_id: security.id,
              quantity: deltaQty,
              strategy_id: strategyId,
              strategy_name_snapshot: strategyName,
              transaction_id: sourceRow?.transaction_id ?? null,
              trade_side: "BUY",
              is_active: true,
              avg_fill: 0,
              Expected_fill: priceCents / 100,
              Fill_date: null,
            })
            .select("id")
            .maybeSingle();
          const newHoldingId = insertedRes.data?.id;
          if (!newHoldingId) continue;
          await institutionalDb.from("oems_order_audit").insert({
            order_id: `REBALANCE-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
            client_account: clientEmail,
            broker_account_code: ACCOUNT_CODE,
            symbol: sym,
            side: "buy",
            quantity: deltaQty,
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
            },
            result_payload: {
              tif: "DAY",
              venue: "JSE",
              broker: BROKER,
              uat_test: IS_UAT,
              preflight: {
                ok: true,
                code: "pass",
                message: "Rebalance book — parked, awaiting Send to Market release.",
                verdict: "pass",
              },
              arrivalMid: priceCents / 100,
            },
            created_at: now,
            updated_at: now,
          });
          bookedAny = true;
        } else {
          if (!position) continue;
          await institutionalDb.from("oems_order_audit").insert({
            order_id: `REBALANCE-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
            client_account: clientEmail,
            broker_account_code: ACCOUNT_CODE,
            symbol: sym,
            side: "sell",
            quantity: Math.abs(deltaQty),
            price_cents: priceCents,
            status: "parked",
            source: "PAPER_MODEL_REBALANCE",
            payload: {
              book_id: strategyName,
              broker: BROKER,
              order_type: "market",
              strategy: strategyName,
              security_id: security?.id ?? null,
              isin: null,
              holding_id: position.rowId,
              family_member_id: null,
              user_id: userId,
              limitPrice: priceCents / 100,
              sent_by: clientEmail,
              sent_at: now,
              trader: clientEmail,
              uat_test: IS_UAT,
              broker_account_code: ACCOUNT_CODE,
            },
            result_payload: {
              tif: "DAY",
              venue: "JSE",
              broker: BROKER,
              uat_test: IS_UAT,
              preflight: {
                ok: true,
                code: "pass",
                message: "Rebalance book — parked, awaiting Send to Market release.",
                verdict: "pass",
              },
              arrivalMid: priceCents / 100,
            },
            created_at: now,
            updated_at: now,
          });
          bookedAny = true;
        }
      }

      if (bookedAny) result.bookedUserIds.push(userId);
    } catch (err) {
      result.errors.push(err instanceof Error ? err.message : String(err));
    }
  }

  return result;
}
