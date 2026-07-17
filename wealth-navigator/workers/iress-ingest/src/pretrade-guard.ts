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

// ─── CASH / BUY-SIDE GUARD ───────────────────────────────────────────────────
// The mirror of the sell guard for the buy side.
//
// ASYMMETRY WITH THE SELL GUARD (deliberate): a SELL fails CLOSED — a naked
// short is a hard stop and IRESS won't catch it. A BUY is ADVISORY when the cash
// balance is UNKNOWN (`available === null`): a cash-feed gap must not brick
// legitimate buying, and an overspend is a settlement issue, not a naked short.
// The caller blocks a buy only when cash is KNOWN and insufficient. (This mirrors
// the BFF runLimitGuard's buy-side choice.) DB read errors still throw, so the
// guard fails closed on an infrastructure failure, not on a missing balance.

/** Order states where a BUY still has unfilled quantity working at the broker. */
const OPEN_BUY_STATES = ["working", "pending_ack", "acknowledged", "partial", "amend_pending"];

export interface CashAvailability {
  /** Account cash in RANDS; null when there is no cash source and no configured cap. */
  cash: number | null;
  /** RANDS reserved by OTHER open (working) buys. */
  inflightBuys: number;
  /** max(0, cash − inflightBuys); null when cash is unknown → guard is advisory. */
  available: number | null;
  source: "ips" | "cap" | "none";
  note: string;
}

interface AuditBuyLite {
  id: string;
  side: string | null;
  quantity: number | null;
  status: string | null;
  price_cents: number | null;
  payload: Record<string, unknown> | null;
  result_payload: Record<string, unknown> | null;
}

/**
 * Resolve an open buy's unit price in RANDS, mirroring the BFF notional chain:
 * explicit limit (price_cents/100) → payload.avgPx → payload.limitPrice →
 * result_payload.arrivalMid (Yahoo mid stamped at seed). Null when none resolve.
 */
function openBuyUnitPriceRands(r: AuditBuyLite): number | null {
  const cents = Number(r.price_cents);
  if (Number.isFinite(cents) && cents > 0) return cents / 100;
  const p = (r.payload ?? {}) as { avgPx?: number; limitPrice?: number };
  if (Number(p.avgPx) > 0) return Number(p.avgPx);
  if (Number(p.limitPrice) > 0) return Number(p.limitPrice);
  const rp = (r.result_payload ?? {}) as { arrivalMid?: number };
  if (Number(rp.arrivalMid) > 0) return Number(rp.arrivalMid);
  return null;
}

/**
 * Pre-trade CASH / buying-power availability for a BUY.
 *
 * Cash source is the desk/omnibus account's settled cash in `oems_account_c`
 * (RANDS, IPS-populated), keyed by the same accountCode the sell guard uses. When
 * that row is absent (e.g. UAT, where the IPS feed is parked) it falls back to a
 * configured cap (`fallbackCapRands`) if supplied, else `cash = null` (advisory).
 *
 * `available = max(0, cash − value(other open buys))`. Unlike shares, cash
 * cannot be derived from filled orders (there is no starting balance), so when
 * no source exists the guard is advisory rather than fail-closed.
 */
export async function availableToBuy(
  db: WorkerSupabase,
  accountCode: string,
  excludeAuditId?: string,
  opts?: { fallbackCapRands?: number | null },
): Promise<CashAvailability> {
  // 1. Desk/omnibus account cash (RANDS) from oems_account_c.
  const acct = await db
    .from("oems_account_c")
    .select("cash_balance")
    .eq("account_code", accountCode)
    .maybeSingle();
  if (acct.error) throw new Error(`oems_account_c read failed: ${acct.error.message}`);
  const cashRaw = acct.data != null ? Number((acct.data as { cash_balance: number }).cash_balance) : NaN;
  const hasCash = Number.isFinite(cashRaw);
  const cap = opts?.fallbackCapRands ?? null;
  const cash = hasCash ? cashRaw : cap;
  const source: CashAvailability["source"] = hasCash ? "ips" : cap != null ? "cap" : "none";

  // 2. Reserve the RAND value of OTHER open buys, so several working buys can't
  //    each spend the whole balance.
  const audit = await db
    .from("oems_order_audit")
    .select("id, side, quantity, status, price_cents, payload, result_payload")
    .in("source", UAT_SOURCES);
  if (audit.error) throw new Error(`oems_order_audit read failed: ${audit.error.message}`);

  let inflightBuys = 0;
  let unpriced = 0;
  for (const r of (audit.data ?? []) as AuditBuyLite[]) {
    if (String(r.side ?? "").toLowerCase() !== "buy") continue;
    const status = String(r.status ?? "").toLowerCase();
    if (r.id === excludeAuditId || !OPEN_BUY_STATES.includes(status)) continue;
    const qty = Number(r.quantity) || 0;
    const filled = Number((r.payload as { filled?: number } | null)?.filled) || 0;
    const remaining = Math.max(0, qty - filled);
    if (remaining <= 0) continue;
    const px = openBuyUnitPriceRands(r);
    if (px == null) {
      unpriced += 1;
      continue;
    }
    inflightBuys += remaining * px;
  }

  const available = cash != null ? Math.max(0, cash - inflightBuys) : null;
  let note =
    source === "ips"
      ? `desk cash R${cash}`
      : source === "cap"
        ? `no oems_account_c cash; using cap R${cash}`
        : "no cash source (oems_account_c empty, no cap) — buy guard advisory";
  if (unpriced > 0) note += `; ${unpriced} open buys unpriced (not reserved)`;
  return { cash, inflightBuys, available, source, note };
}
