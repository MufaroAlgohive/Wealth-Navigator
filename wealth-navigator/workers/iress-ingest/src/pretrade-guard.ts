/**
 * Pre-trade naked-short guard.
 *
 * IRESS V4 does NOT validate orders for you — the docs are explicit that
 * pre-trade compliance (no-naked-short, buying power) is the OEMS's
 * responsibility, before OrderCreate3 (iress-v4-docs/11-mint-oems). So this is
 * the mandatory gate that stops a SELL of stock we don't hold from reaching the
 * broker.
 *
 * "Held" comes from the best source available:
 *   1. oems_position_c — the authoritative IRESS/IPS settled position for the
 *      account (populated by the IPS worker). Used when a row exists.
 *   2. Otherwise derived from OUR OWN order record (oems_order_audit): net
 *      FILLED quantity of the desk's UAT orders for the symbol. This always
 *      works even while the IPS entitlement is parked and oems_position_c is
 *      empty — you can only sell what our filled orders show we bought.
 *
 * Available-to-sell = held − open (unfilled) sells already working at the broker,
 * so two sells can't each consume the whole position.
 *
 * FAIL-CLOSED: any data error throws; the caller must block the sell rather than
 * risk a naked short.
 */

import type { WorkerSupabase } from "./supabase";

export interface SellAvailability {
  held: number;
  inflightSells: number;
  available: number;
  source: "ips" | "derived" | "none";
  note: string;
}

/** UAT dispatch sources — all route to the desk UAT account. */
const UAT_SOURCES = ["UAT_ADHOC_ORDER", "OB_SEND_TO_MARKET_UAT"];
/** Order states where a SELL still has unfilled quantity working at the broker. */
const OPEN_SELL_STATES = ["working", "pending_ack", "acknowledged", "partial", "amend_pending"];

export function bareCode(sym: string): string {
  return String(sym ?? "")
    .trim()
    .toUpperCase()
    .replace(/\.(JO|JSE)$/i, "");
}

interface AuditLite {
  id: string;
  side: string | null;
  quantity: number | null;
  status: string | null;
  payload: Record<string, unknown> | null;
}

export async function availableToSell(
  db: WorkerSupabase,
  accountCode: string,
  symbol: string,
  excludeAuditId?: string,
): Promise<SellAvailability> {
  const code = bareCode(symbol);

  // 1. Authoritative settled position from IRESS/IPS (when the account is ingested).
  const pos = await db
    .from("oems_position_c")
    .select("quantity")
    .eq("account_code", accountCode)
    .eq("security_code", code)
    .maybeSingle();
  if (pos.error) throw new Error(`oems_position_c read failed: ${pos.error.message}`);
  const posQty = pos.data != null ? Number((pos.data as { quantity: number }).quantity) || 0 : null;

  // 2. Our own UAT order record — net FILLED position + open-sell reservation.
  const audit = await db
    .from("oems_order_audit")
    .select("id, side, quantity, status, payload")
    .in("source", UAT_SOURCES)
    .in("symbol", [code, `${code}.JO`]);
  if (audit.error) throw new Error(`oems_order_audit read failed: ${audit.error.message}`);

  let filledBuys = 0;
  let filledSells = 0;
  let inflightSells = 0;
  for (const r of (audit.data ?? []) as AuditLite[]) {
    const side = String(r.side ?? "").toLowerCase();
    const status = String(r.status ?? "").toLowerCase();
    const qty = Number(r.quantity) || 0;
    const payloadFilled = Number((r.payload as { filled?: number } | null)?.filled) || 0;
    // Fully-filled rows contribute their whole quantity; partials contribute the
    // filled portion recorded by the poller.
    const filled = status === "filled" ? qty : payloadFilled;
    if (side === "buy") {
      filledBuys += filled;
    } else if (side === "sell") {
      filledSells += filled;
      // Reserve the still-open remainder of OTHER working sells (not this order).
      if (r.id !== excludeAuditId && OPEN_SELL_STATES.includes(status)) {
        inflightSells += Math.max(0, qty - filled);
      }
    }
  }
  const derivedHeld = Math.max(0, filledBuys - filledSells);

  const held = posQty != null ? posQty : derivedHeld;
  const source: SellAvailability["source"] =
    posQty != null ? "ips" : (audit.data ?? []).length > 0 ? "derived" : "none";
  const available = Math.max(0, held - inflightSells);
  return {
    held,
    inflightSells,
    available,
    source,
    note:
      posQty != null
        ? `IPS settled position ${held}`
        : `derived from filled UAT orders (${filledBuys} bought − ${filledSells} sold = ${derivedHeld})`,
  };
}
