import type { SupabaseClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";

import { getAdminContext } from "@/lib/admin/rbac";
import { isSupabaseSchemaMissing } from "@/lib/bff-reasons";
import { createInstitutionalServiceRoleClient } from "@/lib/supabase/server";

/**
 * GET /api/admin/orderbook/execution?book_id=...  OR  ?source=A,B
 *
 * Mint OEM Phase B3 — per-ISIN execution view. Reads `oems_order_audit` rows
 * tied to a book (the `payload.book_id` or `payload.strategy` column) and
 * normalises them into the columns the execution view expects:
 *
 * `source` (2026-07-23) is the preferred filter for the unified OEM panel:
 * `book_id`/`strategy` is open-ended (a basket buy stamps the real strategy
 * display name, an unbounded set), while `source` is a small, stable
 * dimension (UAT_ADHOC_ORDER, MINT_CLIENT_ORDER, ...) — filtering by it
 * returns every current AND future strategy name with zero code change.
 * `book_id` is still supported for a caller that genuinely wants one
 * specific book/strategy.
 *
 *   order_id, ts, strategy, side, symbol, qty, filled, qty_pct,
 *   limit_price, avg_fill_price, slippage_cents, venue, tif, sent_by, state.
 *
 * Returns: { ok, rows, notice? }
 *
 * Schema-missing guard: returns `{ ok: true, rows: [], notice: ... }` so the
 * UI can render an honest empty state without an alert banner when the table
 * hasn't been migrated yet.
 *
 * Lifecycle states (2026-07-13): the audit `status` column now carries the
 * full 8-state IRESS Hermes lifecycle (`pending_ack`, `acknowledged`,
 * `working`, `partial`, `filled`, `cancelled`, `expired`, `rejected`).
 * Earlier this route collapsed anything that wasn't `filled` / `partial` /
 * `cancelled` / `rejected` to `WORKING` — which masked the new
 * `pending_ack` / `acknowledged` states from the UI. See
 * `stateUppercaseFromAudit()` below for the up-to-date mapping.
 *
 * The route also surfaces the Hermes lifecycle detail (ActionStatus,
 * InternalOrderStatus, StateDescription, RemainingVolume, brokerState) on
 * the typed `ExecutionRow` so the desk can see exactly where a stuck
 * order is on the broker side, not just the downmapped lifecycle state.
 */

export const dynamic = "force-dynamic";

interface AuditRow {
  id: string;
  order_id: string;
  client_account: string;
  symbol: string;
  side: string;
  quantity: number;
  price_cents: number | null;
  status: string;
  source: string;
  payload: Record<string, unknown>;
  result_payload: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

interface ExecutionRow {
  id: string;
  // 2026-07-21: the `stock_holdings_c.id` this order came from (stamped by
  // send-to-market/route.ts as `payload.holding_id`) — lets the UI join an
  // execution row back to a specific investor's specific security position,
  // not just to "the whole book". null for rows predating this stamp.
  holding_id: string | null;
  // 2026-07-23: CRM-style order-book number (see release-to-market/route.ts,
  // which stamps this onto every row released together in one "Send to
  // Market" click) — null until the row has been released at least once.
  order_book_seq: number | null;
  order_id: string;
  // 2026-07-13: surface the IRESS AccountCode (from oems_order_audit.client_account)
  // so the UI's Cancel button can forward the correct account to the worker's
  // /orders/cancel endpoint. For UAT dispatches the BFF seeds this with the
  // client email; the broker account comes from payload.uatAccountCode (also
  // surfaced as `broker_account` for clarity).
  client_account: string;
  broker_account: string | null;
  ts: string;
  /** Broker-observation time (audit updated_at) for optimistic-override reconciliation. */
  updated_at?: string;
  strategy: string | null;
  side: string;
  symbol: string;
  isin: string | null;
  qty: number;
  filled: number;
  filled_pct: number;
  limit_price: number | null;
  avg_fill_price: number | null;
  vwap: number | null;
  slippage_cents: number | null;
  day1_pnl_cents: number | null;
  venue: string;
  tif: string;
  sent_by: string | null;
  state: string;
  broker: string | null;
  // 2026-07-14: pre-trade limit-guard stamp from the BFF
  // /api/admin/orderbook/send-to-market. The UI renders a "Guarded"
  // badge when enforced=true so the operator never wonders whether a
  // naked short / cash-bust order went out (the IRESS IOS+ OrderPad
  // does not block these — Andre, 2026-07-14 UAT walkthrough
  // 28:22-34:32).
  limits_enforced?: boolean | null;
  limits_checked_at?: string | null;
  limits_account_code?: string | null;
  limits_skip_reason?: string | null;
  // IRESS Hermes lifecycle detail (2026-07-13). Surface these so the
  // operator can see exactly where the order sits on Hermes without
  // tailing worker logs. 2026-07-14: tightened broker_state to the
  // typed union (ACTIVE | INACTIVE | UNKNOWN) matching OrderBrokerState
  // in src/types/iress.ts so the UI can render the active/inactive chip
  // with confidence.
  broker_state?: "ACTIVE" | "INACTIVE" | "UNKNOWN" | null;
  action_status?: string | null;
  internal_order_status?: string | null;
  state_description?: string | null;
  remaining_volume?: number | null;
  remaining_value_cents?: number | null;
  order_value_cents?: number | null;
  // IRESS ErrorNumber + ErrorDescription (2026-07-13). The worker stamps
  // `result_payload.uatErrorNumber` + `uatErrorDescription` when IRESS
  // returns a non-zero ErrorNumber from OrderCreate3 (or any set method).
  // Per the call w/ Andre, these were a documented gap — they were in
  // `result_payload` but never surfaced to the desk UI. The operator
  // needs them to triage rejections (25014 "Not entitled", 25008 "No
  // license seat", 25010 invalid access, etc.) without tailing worker
  // logs. 2026-07-14: the FAILED branch also writes
  // `payload.iressErrorNumber` + `payload.iressErrorDescription` for
  // transport-level failures (network down, kicked session). Read both.
  iress_error_number?: number | null;
  iress_error_description?: string | null;
  last_action?: string | null;
  last_action_at?: string | null;
  // 2026-07-15: producer of the row — `OB_SEND_TO_MARKET_UAT` for
  // BFF-seed pre-send rows, `iress-worker` for worker-poll writes. UI
  // uses this in the lifecycle timeline to colour-code which producer
  // touched the order.
  source?: string | null;
  // 2026-07-15: PricingInstructions the order was sent under — "limit"
  // or "market". Drives the UI's LMT/MKT chip and prevents the desk from
  // trying to amend a price on a MARKET order (IRESS OrderAmend2 cannot
  // change PricingInstructions, so such amends silently no-op).
  order_type?: "limit" | "market" | null;
}

function openInstitutional(): SupabaseClient | null {
  try {
    return createInstitutionalServiceRoleClient();
  } catch {
    return null;
  }
}

function num(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v !== "" ? v : null;
}

/**
 * Map the audit `status` token (lowercase) to the upper-case enum the
 * ExecutionView badge expects. Mirrors the OrderState union in
 * src/types/iress.ts — the audit row carries the downmapped token.
 */
function stateUppercaseFromAudit(status: string): string {
  switch (status) {
    case "parked":
      return "PARKED";
    case "pending_ack":
      return "PENDING_ACK";
    case "acknowledged":
      return "ACKNOWLEDGED";
    case "partial":
      return "PARTIAL";
    case "filled":
      return "FILLED";
    case "cancelled":
      return "CANCELLED";
    case "cancel_pending":
      return "CANCEL_PENDING";
    case "amend_pending":
      return "AMEND_PENDING";
    case "expired":
      return "EXPIRED";
    case "rejected":
      return "REJECTED";
    case "failed":
      return "FAILED";
    case "working":
    case "amended":
    case "created":
      return "WORKING";
    default:
      // Unknown status — surface as the raw value so the operator can see
      // "what is this?" in the UI instead of silently downmapping to
      // WORKING (which would hide a stuck row).
      return status.toUpperCase();
  }
}

function mapRow(r: AuditRow): ExecutionRow {
  const payload = r.payload ?? {};
  const result = r.result_payload ?? {};
  const limitPrice = num(payload.limitPrice) ?? (r.price_cents != null ? Number(r.price_cents) / 100 : null);

  // Filled quantity: prefer payload.filled (the canonical execution field);
  // fall back to payload.avgPx presence or compute from result.
  const filled = num(payload.filled) ?? (typeof payload.avgPx === "number" ? Number(r.quantity) : 0);
  const qty = Number(r.quantity) || 0;
  const filledPct = qty > 0 ? Math.min(100, (filled / qty) * 100) : 0;

  const avgFill = num(payload.avgPx) ?? num(result.avgFillPrice) ?? num(result.avg_fill_price);

  // Slip = limit − actual fill (in cents). GREEN when fill < client limit.
  let slippageCents: number | null = null;
  if (limitPrice != null && avgFill != null) {
    slippageCents = Math.round((limitPrice - avgFill) * 100);
  }

  // Day-1 P&L proxy = slippage * qty (in cents)
  let day1PnlCents: number | null = null;
  if (slippageCents != null) day1PnlCents = slippageCents * filled;

  return {
    id: r.id,
    holding_id: str(payload.holding_id),
    order_book_seq:
      typeof payload.order_book_seq === "number"
        ? payload.order_book_seq
        : payload.order_book_seq != null && Number.isFinite(Number(payload.order_book_seq))
          ? Number(payload.order_book_seq)
          : null,
    order_id: r.order_id,
    client_account: r.client_account,
    broker_account: str(payload.uatAccountCode),
    ts: typeof payload.ts === "string" ? (payload.ts as string) : r.updated_at,
    updated_at: r.updated_at,
    strategy: typeof payload.strategy === "string" ? (payload.strategy as string) : null,
    side: (r.side ?? "buy").toUpperCase(),
    symbol: r.symbol,
    isin: typeof payload.isin === "string" ? (payload.isin as string) : null,
    qty,
    filled,
    filled_pct: Number(filledPct.toFixed(1)),
    order_type:
      payload.order_type === "limit" || payload.order_type === "market"
        ? payload.order_type
        : limitPrice != null
          ? "limit"
          : "market",
    limit_price: limitPrice,
    avg_fill_price: avgFill,
    vwap: num(payload.vwap),
    slippage_cents: slippageCents,
    day1_pnl_cents: day1PnlCents,
    venue: typeof payload.destination === "string" ? (payload.destination as string) : "JSE",
    tif: typeof payload.tif === "string" ? (payload.tif as string) : "DAY",
    sent_by:
      typeof payload.sent_by === "string"
        ? (payload.sent_by as string)
        : typeof payload.trader === "string"
          ? (payload.trader as string)
          : null,
    state: stateUppercaseFromAudit(r.status),
    broker: typeof payload.broker === "string" ? (payload.broker as string) : null,
    // 2026-07-14: surface the pre-trade limit-guard stamp from the BFF
    // /api/admin/orderbook/send-to-market so the desk can tell at a
    // glance which orders went through the no-naked-short + cash-bust
    // guard vs which ones slipped through the gap. The IRESS broker
    // does NOT block naked shorts — Andre, 2026-07-14.
    limits_enforced:
      typeof payload.limits_enforced === "boolean" ? (payload.limits_enforced as boolean) : null,
    limits_checked_at:
      typeof payload.limits_checked_at === "string" ? (payload.limits_checked_at as string) : null,
    limits_account_code:
      typeof payload.limits_account_code === "string" ? (payload.limits_account_code as string) : null,
    limits_skip_reason:
      typeof payload.limits_skip_reason === "string" ? (payload.limits_skip_reason as string) : null,
    // IRESS Hermes lifecycle detail (2026-07-13). The worker stamps these
    // on every poll cycle; older rows + BFF-written `working` rows may not
    // carry them — render as null in that case. 2026-07-14: broker_state
    // is tightened to the OrderBrokerState union so the UI's
    // active/inactive chip reflects what IRESS actually has on the book
    // (a fully-filled order is INACTIVE but FILLED).
    broker_state:
      str(payload.brokerState) === "ACTIVE" || str(payload.brokerState) === "INACTIVE"
        ? (str(payload.brokerState) as "ACTIVE" | "INACTIVE")
        : "UNKNOWN",
    action_status: str(payload.actionStatus),
    internal_order_status: str(payload.internalOrderStatus),
    state_description: str(payload.stateDescription),
    remaining_volume: num(payload.remainingVolume),
    remaining_value_cents: num(payload.remainingValueCents),
    order_value_cents: num(payload.orderValueCents),
    // 2026-07-13 — Transcript gap #1 (23:40): surface IRESS ErrorNumber
    // + ErrorDescription from result_payload so a rejection from IRESS
    // shows up with its actual reason ("Not entitled" / "No license seat" /
    // etc.). Read both legacy locations — the older route stamps it under
    // `result.uatErrorNumber` / `result.uatErrorDescription`, and a
    // re-polled row could carry it under `result.errorNumber` too.
    // 2026-07-14: the FAILED stamp also writes `payload.iressErrorNumber`
    // + `payload.iressErrorDescription` — read those too so the FAILED
    // chip carries the IRESS error inline.
    iress_error_number:
      num(result.uatErrorNumber) ??
      num(result.errorNumber) ??
      num(payload.iressErrorNumber) ??
      null,
    iress_error_description:
      str(result.uatErrorDescription) ??
      str(result.errorDescription) ??
      str(payload.iressErrorDescription) ??
      null,
    // 2026-07-13 — Transcript gap #2 (26:21): "action status" + "last
    // action" were specifically called out by Andre as the key fields
    // for real-time order-state understanding. We already surface the
    // ActionStatus text via `action_status` above; promote the
    // UAT-specific last-action audit log out of the payload blob so
    // the UI can pin it as a row-level field.
    last_action: str(result.lastAction) ?? str(payload.lastAction) ?? null,
    last_action_at: str(result.lastActionAt) ?? str(payload.lastActionAt) ?? null,
    source: str(r.source) ?? "iress_order_audit",
  };
}

export async function GET(req: Request) {
  const auth = await getAdminContext();
  if (auth.status === "no-session") {
    return NextResponse.json({ ok: false, error: "no-session" }, { status: 401 });
  }
  if (auth.status !== "ok") {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }

  const url = new URL(req.url);
  const bookId = (url.searchParams.get("book_id") ?? "").trim();
  // 2026-07-23: `book_id`/`strategy` is an open-ended value now (a basket
  // buy stamps the real strategy display name, not one of a small known
  // set), so a caller that wants "everything this panel cares about" can't
  // enumerate every book_id up front. `source` is the stable, small
  // dimension instead (UAT_ADHOC_ORDER, MINT_CLIENT_ORDER, ...) — filter by
  // that when given, so a new strategy name shows up with zero code change.
  const sourceParam = (url.searchParams.get("source") ?? "").trim();
  const sources = sourceParam
    ? sourceParam.split(",").map((s) => s.trim()).filter(Boolean)
    : [];
  // order_book_seq: fetch the member orders of one archived/released order book
  // (release-to-market stamps `payload.order_book_seq` on every released row).
  // Lets "Active Order Books" expand a book to show the actual orders in it,
  // reusing this route's full order-detail mapping.
  const seqParam = (url.searchParams.get("order_book_seq") ?? "").trim();
  const orderBookSeq = seqParam && Number.isFinite(Number(seqParam)) ? Number(seqParam) : null;

  // status view: default "active" hides user-cancelled orders from the live
  // blotter (they move to the Cancelled tab); "cancelled" returns ONLY them.
  // Only `cancelled` is split off — broker-terminal states (rejected/expired/
  // failed) stay on the blotter because the desk needs to see them there.
  const statusView = (url.searchParams.get("status") ?? "active").trim().toLowerCase() === "cancelled"
    ? "cancelled"
    : "active";

  const db = openInstitutional();
  if (!db) {
    return NextResponse.json({
      ok: true,
      rows: [],
      notice: "INSTITUTIONAL database not configured.",
    });
  }

  // Audit has no dedicated book_id column; a row belongs to a book by
  // payload.book_id OR payload.strategy (the grouping key from send-to-market).
  // Scope to the book AT THE DB LEVEL so the 500-row window covers THIS book's
  // rows, not the newest 500 across ALL books — on a busy shared audit table the
  // book's rows fell out of that window and orders "vanished" from the view.
  // PostgREST CAN filter jsonb via the `->>` text accessor (an earlier note here
  // claimed otherwise); the JS filter below stays as defense-in-depth.
  let sel = db
    .from("oems_order_audit")
    .select(
      "id, order_id, client_account, symbol, side, quantity, price_cents, status, source, payload, result_payload, created_at, updated_at",
    );
  if (orderBookSeq != null) {
    // A book's members are the audit rows carrying this order_book_seq. This
    // takes precedence over source/book_id so a book expands to exactly its own
    // orders regardless of which sources they came from.
    sel = sel.eq("payload->>order_book_seq", String(orderBookSeq));
  } else if (sources.length > 0) {
    sel = sel.in("source", sources);
  } else if (bookId) {
    const v = bookId.replace(/[\\"]/g, ""); // neutralise PostgREST filter metachars
    sel = sel.or(`payload->>book_id.eq."${v}",payload->>strategy.eq."${v}"`);
  }
  // Split cancelled off from the blotter at the DB level so neither view spends
  // its 500-row window on the other's rows.
  sel = statusView === "cancelled" ? sel.eq("status", "cancelled") : sel.neq("status", "cancelled");
  const { data, error } = await sel.order("updated_at", { ascending: false }).limit(500);
  if (error) {
    if (isSupabaseSchemaMissing(error)) {
      return NextResponse.json({
        ok: true,
        rows: [],
        notice: "oems_order_audit table not migrated yet — apply 20260612000002_oems_order_audit.sql.",
      });
    }
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  const all = (data ?? []) as AuditRow[];
  const filtered =
    orderBookSeq != null
      ? all.filter((r) => Number((r.payload ?? {}).order_book_seq) === orderBookSeq)
      : sources.length > 0
        ? all // already precise via .in("source", sources) above
        : bookId
          ? all.filter((r) => {
              const p = r.payload ?? {};
              return (
                (typeof p.book_id === "string" && p.book_id === bookId) ||
                (typeof p.strategy === "string" && p.strategy === bookId)
              );
            })
          : all;

  const rows = filtered.map(mapRow);
  return NextResponse.json({ ok: true, rows, count: rows.length });
}