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
  source: "ips" | "derived" | "none" | "retail_holdings";
  note: string;
}

/** UAT dispatch sources — all route to the desk UAT account. */
const UAT_SOURCES = ["UAT_ADHOC_ORDER", "OB_SEND_TO_MARKET_UAT", "MINT_CLIENT_ORDER"];
/**
 * Order states where a SELL still has unfilled quantity working at the broker.
 *
 * 2026-07-20: `cancel_pending` is now reserved too, aligning the worker with
 * the BFF `IN_FLIGHT_STATUSES` set in `src/app/api/admin/orderbook/send-to-market/route.ts`.
 * We reserve until IRESS confirms cancellation — a fill racing a cancel
 * instruction is a real risk on a single-seat broker, and "release on
 * cancel_pending" previously let two sells each pass the guard against
 * shares that were still at risk. `amend_pending` stays reserved for the
 * same reason — an amend can change qty upward.
 */
const OPEN_SELL_STATES = [
  "working",
  "pending_ack",
  "acknowledged",
  "partial",
  "amend_pending",
  "cancel_pending",
];

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
const OPEN_BUY_STATES = [
  "working",
  "pending_ack",
  "acknowledged",
  "partial",
  "amend_pending",
  "cancel_pending",
];

export interface CashAvailability {
  /** Account cash in RANDS; null when there is no cash source and no configured cap. */
  cash: number | null;
  /** RANDS reserved by OTHER open (working) buys. */
  inflightBuys: number;
  /** max(0, cash − inflightBuys); null when cash is unknown → guard is advisory. */
  available: number | null;
  source: "ips" | "cap" | "none" | "wallet";
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
  /* avgPx is CENTS. The other three sources in this chain are RANDS, and this
     line returned avgPx unconverted — a 100x over-reservation on any partially
     filled order.
     Verified on live order 700002 (FSR, 2026-07-27): payload.avgPx = 9600 while
     result_payload.arrivalMid = 96.07 for the same order. The poller stamps it
     straight from the IRESS OrderPad, and IRESS quotes the JSE in cents.
     Effect: one partly-filled R96 order would reserve R9 600 and lock a R1 000
     client out of every subsequent buy. It fails CLOSED, so no money was at
     risk — but it reads to an operator as "the guard is broken". */
  if (Number(p.avgPx) > 0) return Number(p.avgPx) / 100;
  if (Number(p.limitPrice) > 0) return Number(p.limitPrice); // RANDS (submit.ts: price_cents / 100)
  const rp = (r.result_payload ?? {}) as { arrivalMid?: number };
  if (Number(rp.arrivalMid) > 0) return Number(rp.arrivalMid); // RANDS
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

// ─── PER-CLIENT HOLDER GUARDS (production client orders) ─────────────────────
// The desk guards above check the shared desk/omnibus account (56378). For a
// PRODUCTION client order we must instead check THAT client's own holdings + cash,
// which live in the RETAIL db: stock_holdings_c (positions) + wallets (cash). This
// is OUR per-client ledger — Longmark nets everything into ONE omnibus account and
// exposes no per-client broker position, so our side is the source of truth.
//
// DORMANT TODAY: no production client orders flow yet (UAT uses the desk path
// above, byte-for-byte unchanged). These are wired only behind IRESS_PER_CLIENT_GUARD.
// Before enabling in production: (a) VALIDATE the retail column names + the
// trade_side convention against a live client holding; (b) add open-order
// reservation (a client's own working sells/buys) — these do NOT yet reserve.
// FAIL-CLOSED on any read error.

/**
 * Look up the user's own open (non-terminal) orders from `oems_order_audit`
 * to reserve quantity / notional against an incoming per-client order.
 *
 * 2026-07-20: wired up — previously these guards returned `inflightSells: 0`
 * with an explicit `(open-order reservation TODO)` note. The reservation
 * math now mirrors the desk path: subtract `qty - filled` from working
 * sells, subtract notional of working buys.
 *
 * IMPORTANT: until the `mint_number ↔ AccountCode` bridge lands (per
 * AGENTS.md, deferred past OEMS v1), the only reliable way to scope a
 * client's open orders is `payload.user_id` or `payload.trader_email`
 * stamps written by the BFF. Both are written by `submitOrder` today.
 * When the bridge lands, switch to filtering on `broker_account_code`
 * the same way the desk path does.
 */
/**
 * In-flight reservations for ONE client, read from `oems_order_audit`.
 *
 * Takes the INSTITUTIONAL client. The parameter used to be named `retail` and
 * callers passed the retail handle, so every call died with
 * "Could not find the table 'public.oems_order_audit' in the schema cache" —
 * that table lives on the institutional database. The pre-trade guard treats a
 * thrown read as unverifiable and refuses the order, so a fully funded client
 * order was blocked at the last gate on 2026-07-27 with a R1 000 wallet against
 * a R98 buy. Fail-closed behaved correctly; it was reading the wrong database.
 *
 * The 3-DB split (docs/DB_TOPOLOGY_DECISION.md): wallets and holdings on
 * RETAIL, the order book on INSTITUTIONAL. A guard for one client needs both.
 */
async function clientOpenOrderReservations(
  institutional: WorkerSupabase,
  userId: string,
  traderEmail: string | null | undefined,
  /**
   * A bare/`.JO` symbol scopes the read to that security — correct for SHARES,
   * where a holding of AGL says nothing about selling MTN.
   *
   * `null` means EVERY symbol — correct for CASH, which is fungible. The caller
   * used to pass the string `"*"` for this, which became
   * `.in("symbol", ["*", "*.JO"])` and matched no rows at all, so the buy
   * reservation silently returned R0 on every call. A client with R1 000 could
   * release R900 of FSR and then R900 of AGL, both passing. `null` is now an
   * explicit "no symbol filter" rather than a sentinel that reads as one.
   */
  symbol: string | null,
): Promise<{
  inflightSells: number;
  inflightBuysRands: number;
}> {
  // Match by either the explicit user_id stamp OR the trader email — both
  // are written by `src/lib/orders/submit.ts` and cover the row shapes we
  // see in production today.
  const filters: string[] = [`payload->>user_id.eq.${userId}`];
  if (traderEmail) {
    filters.push(`client_account.eq.${traderEmail}`);
  }
  let q = institutional
    .from("oems_order_audit")
    // result_payload carries `arrivalMid`, the only price a MARKET order has
    // before it fills. Omitting it is why market buys reserved nothing.
    .select("side, quantity, status, payload, result_payload, price_cents")
    .or(filters.join(","))
    .in("status", [
      "working",
      "pending_ack",
      "acknowledged",
      "partial",
      "amend_pending",
      "cancel_pending",
    ]);
  if (symbol !== null) {
    const code = bareCode(symbol);
    q = q.in("symbol", [code, `${code}.JO`]);
  }
  const { data, error } = await q;
  if (error) throw new Error(`oems_order_audit read failed: ${error.message}`);

  // A still-open market buy can fill above the arrival mid, so reserve the same
  // headroom the preflight applies to a NEW market order. Under-reserving is how
  // the second order of the day gets approved against money already committed.
  const buffer = Number(process.env.IRESS_MARKET_BUY_BUFFER ?? "1.02") || 1.02;

  let inflightSells = 0;
  let inflightBuysRands = 0;
  for (const row of (data ?? []) as AuditBuyLite[]) {
    const side = String(row.side ?? "").toLowerCase();
    const qty = Number(row.quantity) || 0;
    const filled = Number((row.payload as { filled?: number } | null)?.filled) || 0;
    const remaining = Math.max(0, qty - filled);
    if (remaining <= 0) continue;
    if (side === "sell") {
      inflightSells += remaining;
    } else if (side === "buy") {
      // Same chain the desk path uses: limit → avgPx → limitPrice → arrivalMid.
      // The client path had its own shorter copy that stopped at avgPx, which is
      // only populated AFTER a fill — so an unfilled market buy priced at 0.
      const px = openBuyUnitPriceRands(row);
      if (px != null && px > 0) {
        const isMarket = !(Number(row.price_cents) > 0);
        inflightBuysRands += remaining * px * (isMarket ? buffer : 1);
      }
    }
  }
  return { inflightSells, inflightBuysRands };
}

/** Client SELL availability from the retail per-client ledger (stock_holdings_c). */
/**
 * Needs BOTH databases — holdings live on RETAIL, the order book on
 * INSTITUTIONAL. Passing one handle for both is what broke this on 2026-07-27.
 */
export async function availableToSellForClient(
  retail: WorkerSupabase,
  institutional: WorkerSupabase,
  userId: string,
  symbol: string,
  opts?: { traderEmail?: string | null },
): Promise<SellAvailability> {
  const code = bareCode(symbol);
  const sec = await retail
    .from("securities_c")
    .select("id")
    .in("symbol", [code, `${code}.JO`, `${code}.JSE`])
    .limit(1)
    .maybeSingle();
  if (sec.error) throw new Error(`securities_c read failed: ${sec.error.message}`);
  const securityId = sec.data ? (sec.data as { id: string }).id : null;
  if (!securityId) {
    return {
      held: 0,
      inflightSells: 0,
      available: 0,
      source: "none",
      note: `no securities_c row for ${code} — fail-closed`,
    };
  }
  const rows = await retail
    .from("stock_holdings_c")
    .select("quantity, trade_side")
    .eq("user_id", userId)
    .eq("security_id", securityId)
    .eq("is_active", true);
  if (rows.error) throw new Error(`stock_holdings_c read failed: ${rows.error.message}`);
  let held = 0;
  for (const r of (rows.data ?? []) as { quantity: number | null; trade_side: string | null }[]) {
    const q = Math.abs(Number(r.quantity) || 0);
    held += String(r.trade_side ?? "").toUpperCase() === "SELL" ? -q : q;
  }
  held = Math.max(0, held);

  // Reserve that user's own open (working) sells so two of their sells
  // can't each consume the whole position. (Per-client reservation wired
  // on 2026-07-20; was a TODO before.)
  const { inflightSells } = await clientOpenOrderReservations(
    institutional,
    userId,
    opts?.traderEmail ?? null,
    symbol,
  );

  return {
    held,
    inflightSells,
    available: Math.max(0, held - inflightSells),
    source: "retail_holdings",
    note:
      inflightSells > 0
        ? `retail stock_holdings_c client ${userId.slice(0, 8)} held ${held}, ${inflightSells} in open sells`
        : `retail stock_holdings_c client ${userId.slice(0, 8)} held ${held}`,
  };
}

/** Client BUY cash availability from the retail wallet (RANDS). */
/**
 * Needs BOTH databases — the wallet lives on RETAIL, the order book on
 * INSTITUTIONAL. Passing one handle for both is what broke this on 2026-07-27.
 */
export async function availableToBuyForClient(
  retail: WorkerSupabase,
  institutional: WorkerSupabase,
  userId: string,
  opts?: { traderEmail?: string | null },
): Promise<CashAvailability> {
  const w = await retail
    .from("wallets")
    .select("balance")
    .eq("user_id", userId)
    .limit(1)
    .maybeSingle();
  if (w.error) throw new Error(`wallets read failed: ${w.error.message}`);
  const cash = w.data != null ? Number((w.data as { balance: number }).balance) || 0 : null;

  // Reserve the user's own open (working) buys' notional so two of their
  // buys can't each spend the whole wallet. Mirrors the desk path's
  // `availableToBuy` notional chain. (Per-client reservation wired on
  // 2026-07-20; was a TODO before.)
  // null = every symbol. Cash is fungible: an open FSR buy must reserve against
  // a subsequent AGL buy from the same wallet.
  const { inflightBuysRands } = await clientOpenOrderReservations(
    institutional,
    userId,
    opts?.traderEmail ?? null,
    null,
  );

  return {
    cash,
    inflightBuys: inflightBuysRands,
    available: cash != null ? Math.max(0, cash - inflightBuysRands) : null,
    source: cash != null ? "wallet" : "none",
    note:
      cash != null
        ? inflightBuysRands > 0
          ? `retail wallet client ${userId.slice(0, 8)} R${cash}, R${inflightBuysRands.toFixed(2)} in open buys`
          : `retail wallet client ${userId.slice(0, 8)} R${cash}`
        : "no wallet row — advisory",
  };
}

/**
 * Classify an order's holder for guard routing. UAT / desk orders check the
 * shared desk account (availableToSell / availableToBuy); a PRODUCTION client
 * order checks that client's retail ledger (availableTo*ForClient). Defaults to
 * "desk" for anything without a clear client linkage, so the current desk path
 * is the fallback. The caller only routes to "client" when IRESS_PER_CLIENT_GUARD
 * is enabled, so today everything runs the desk path.
 */
export function resolveHolderKind(order: {
  source?: string | null;
  payload?: Record<string, unknown> | null;
}): "desk" | "client" {
  const source = String(order.source ?? "").toUpperCase();
  if (UAT_SOURCES.some((s) => s.toUpperCase() === source)) return "desk";
  const p = order.payload ?? {};
  if (p.uat_test === true) return "desk";
  if (typeof p.holding_id === "string" || typeof p.user_id === "string") return "client";
  return "desk";
}

