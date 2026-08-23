/**
 * UAT order poller — Mint OEM Finalisation Phase UAT.
 *
 * Polls IRESS `OrderPadGetByAccount` for the worker-configured
 * `IRESS_UAT_ACCOUNT_CODE` (a *separate* broker account from the production
 * `IRESS_ACCOUNT_CODE`) and writes observed fills back into
 * `oems_order_audit` so the OEMS Order Book UI can render live execution
 * state during UAT.
 *
 * Differs from the production order poll in `orders.ts`:
 *  - only ever touches the UAT account (never real client books)
 *  - reads broker state then UPDATES existing audit rows by `iress_order_number`
 *    (the production poll delete-and-inserts by order_id; the UAT path leaves
 *    the original audit row intact and only stamps the live fill deltas)
 *  - emits change events on the in-process `UatExecutionHub` so the
 *    `/uat/execution-stream` SSE endpoint can push deltas to subscribed UIs
 *
 * Safety:
 *  - the loop is a no-op unless `IRESS_UAT_MODE=1`
 *  - the loop refuses to start if `IRESS_UAT_ACCOUNT_CODE` is empty when UAT
 *    mode is on (caller pre-validates)
 *  - the loop honours `IRESS_WORKER_DRY_RUN` and `SUPABASE_ALLOW_WRITES` like
 *    every other write path
 */

import { IressError, isIressSessionDeadError } from "../../../src/lib/iress/errors";
import { getIressClient } from "../../../src/lib/iress/index";
import type { Order, OrderState } from "../../../src/types/iress";
import { productionOrdersEnabled, type WorkerEnv } from "./env";
import { observedFillFromAudit, settleFill, voidUnfilledRemainder } from "./settlement";
import { maybeCompleteRebalance } from "../../../src/lib/rebalance/complete-rebalance";
import { settleRebalanceCashForClients } from "../../../src/lib/rebalance/settle-rebalance-cash";
import {
  findGiftAuthorization,
  applyGiftFill,
  applyGiftTerminalNoFill,
  GIFT_AUTH_STATUS,
  GiftAuthTransition,
} from "./giftAuthorizationSettlement";
import type { WorkerMintSession, WorkerSessionManager } from "./session";
import type { WorkerSupabase } from "./supabase";

const STATE_MAP: Record<OrderState, string> = {
  PENDING_ACK: "pending_ack",
  ACKNOWLEDGED: "acknowledged",
  WORKING: "working",
  PARTIAL: "partial",
  FILLED: "filled",
  CANCELLED: "cancelled",
  CANCEL_PENDING: "cancel_pending",
  EXPIRED: "expired",
  REJECTED: "rejected",
  AMEND_PENDING: "amend_pending",
  FAILED: "failed",
};

function mapStateToDb(state: OrderState): string {
  return STATE_MAP[state] ?? "created";
}

function mapSide(side: "BUY" | "SELL"): string {
  return side === "BUY" ? "buy" : "sell";
}

function newRequestID(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export interface UatExecutionDelta {
  /** The broker-assigned `OrderNumber` returned by `OrderCreate3`. */
  iressOrderNumber: string;
  /** Audit row this delta applies to (null when we haven't written one yet). */
  orderAuditId: string | null;
  state: string;
  filled: number;
  avgFillPrice: number | null;
  lastFillTimestamp: string | null;
  // 2026-07-13 (Andre + Juan, 26:21): one-liner describing the most
  // recent transition ("Cancelled", "Partial +200", etc.) so the
  // ExecutionView can render a first-class Action column without
  // reconstructing the verb from raw Hermes fields.
  lastAction?: string | null;
  lastActionAt?: string | null;
  // 2026-07-13 (Andre + Juan, 23:40): IRESS ErrorNumber + error text
  // so a rejection delta surfaces the actual reason in the UI.
  iressErrorNumber?: number | null;
  iressErrorDescription?: string | null;
  /** Full poll row (for new UAT orders the SSE consumer has never seen). */
  raw: Order;
  /** Book id (payload.book_id) — null for fresh-from-IRESS rows. */
  bookId: string | null;
  observedAt: string;
}

type Subscriber = (delta: UatExecutionDelta) => void;

class UatExecutionHub {
  private subs = new Set<Subscriber>();
  /** Most recent snapshot per (iressOrderNumber) — keyed so we only push diffs. */
  private lastState = new Map<string, { state: string; filled: number; ts: string }>();

  subscribe(fn: Subscriber): () => void {
    this.subs.add(fn);
    return () => this.subs.delete(fn);
  }

  publish(delta: UatExecutionDelta): void {
    const prev = this.lastState.get(delta.iressOrderNumber);
    const next = { state: delta.state, filled: delta.filled, ts: delta.observedAt };
    const changed = !prev || prev.state !== next.state || prev.filled !== next.filled;
    this.lastState.set(delta.iressOrderNumber, next);
    if (!changed) return;
    for (const fn of this.subs) {
      try {
        fn(delta);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[iress-ingest] uat execution subscriber threw: ${msg}`);
      }
    }
  }

  /** Force the next poll to publish even if state hasn't changed (used by the initial snapshot). */
  reset(): void {
    this.lastState.clear();
  }
}

export const uatExecutionHub = new UatExecutionHub();

async function fetchUatOrders(
  session: WorkerMintSession,
  account: string,
  orderFilter: 1 | 2 | 3 | 4 | 5 | 6 | 7,
): Promise<Order[]> {
  const iosKey = session.serviceKeys.IOSPlus;
  if (!iosKey) {
    throw new Error("IOSPlus service session not available for UAT order poll");
  }
  const client = getIressClient("live");
  const res = await client.orderPadGetByAccount({
    ServiceSessionKey: iosKey,
    AccountCode: account,
    // We MUST see INACTIVE rows, or a fully-filled order disappears from the
    // poll the moment Hermes flips OrderState to INACTIVE on the final print.
    // That was the 2026-07-13 bug: the UI showed "partial 75%, remaining 100"
    // and stuck on "working" because filter=1 excluded the filled row, so the
    // audit status was never stamped `filled`. CARE / desk-routed orders fill
    // later, so "fills arrive on the creation ack" is not true for us.
    //
    // This was hardcoded to 3 on the belief that 3 = ALL. That belief is not
    // sourced — see the OrderFilter note in env.ts — and IRESS themselves used
    // 7 against our production account on 2026-07-27. Now that a missed fill
    // means a client is never debited, this defaults to 7 and is overridable
    // via IRESS_ORDER_FILTER without a redeploy.
    OrderFilter: orderFilter,
    RequestID: newRequestID(`uat-pad-${account}`),
  });
  return res.DataRows;
}

interface AuditRow {
  id: string;
  order_id: string;
  client_account: string;
  symbol: string;
  side: string;
  quantity: number;
  price_cents: number | null;
  status: string;
  source: string | null;
  payload: Record<string, unknown>;
  result_payload: Record<string, unknown>;
}

interface AuditUpdate {
  id: string;
  payload: Record<string, unknown>;
  result_payload: Record<string, unknown>;
  status: string;
  settleRow: {
    order_id: string;
    symbol: string | null;
    side: string | null;
    status: string;
    payload: Record<string, unknown>;
    quantity: number | null;
  };
}

export interface UatOrderPollResult {
  polled: number;
  /** Audit rows that received a state/fill update this cycle. */
  updated: number;
  /** Deltas that were published to the SSE hub this cycle. */
  published: number;
  /** Total time taken. */
  elapsedMs: number;
  /** Empty when the loop is gated off. */
  skipReason: string | null;
}

export interface UatOrderPollOptions {
  env: WorkerEnv;
  sessions: WorkerSessionManager;
  /** INSTITUTIONAL — oems_order_audit + the settlement ledger. */
  supabase: WorkerSupabase | null;
  /** RETAIL — wallets + stock_holdings_c. Null disables settlement entirely. */
  retailSupabase?: WorkerSupabase | null;
}

export async function pollUatForFills(opts: UatOrderPollOptions): Promise<UatOrderPollResult> {
  const started = Date.now();
  const skip = (reason: string): UatOrderPollResult => ({
    polled: 0,
    updated: 0,
    published: 0,
    elapsedMs: Date.now() - started,
    skipReason: reason,
  });

  /* LANE. This loop originally only ran on UAT. It must also run on the
     production lane, or a real order is sent and its fills never come back —
     the audit row sits on `working` forever and the desk is blind to an
     execution that actually happened. An order you cannot track is worse than
     an order you did not send.

     The account differs by lane: UAT polls the test book, production polls the
     real MINT account. */
  const productionLane = !opts.env.uatMode && productionOrdersEnabled();
  if (!opts.env.uatMode && !productionLane) return skip("no_order_lane_enabled");

  const pollAccountCode = opts.env.uatMode ? opts.env.uatAccountCode : opts.env.iressAccountCode;
  if (!pollAccountCode) {
    return skip(opts.env.uatMode ? "uat_account_not_configured" : "iress_account_not_configured");
  }

  const isLive = opts.env.iressMode === "live" || opts.env.iressMode === "wsdl-stub";
  if (!isLive) {
    // In mock mode the UAT flow is fully simulated by the audit-write side
    // (the BFF already wrote a working audit row). Polling is a no-op.
    return skip("iress_mode_not_live");
  }

  let orders: Order[] = [];
  try {
    await opts.sessions.withSession(async (session) => {
      orders = await fetchUatOrders(session, pollAccountCode, opts.env.iressOrderFilter);
    });
  } catch (err) {
    if (isIressSessionDeadError(err) || (err instanceof IressError && err.code === 25001)) {
      // Session is dead — withSession already invalidates + rebuilds; surface
      // the recovery hint to the operator.
      console.warn(`[iress-ingest] uat poll session died: ${(err as Error).message}`);
    } else {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[iress-ingest] uat poll failed: ${msg}`);
    }
    return skip("poll_failed");
  }

  if (orders.length === 0) {
    return { polled: 1, updated: 0, published: 0, elapsedMs: Date.now() - started, skipReason: null };
  }

  // Match observed orders back to their audit rows by `iress_order_number`
  // (stored in payload). The audit row was created by the BFF at send-to-market
  // time; the worker stamped the OrderNumber when OrderCreate3 returned it.
  const iressOrderNumbers = orders
    .map((o) => o.id)
    .filter((id): id is string => Boolean(id && id.length > 0));

  /* WRITE GATE. The worker-wide dryRun / allowWrites flags exist to stop the
     INSTITUTIONAL FEED (quotes, IPS, bonds, alerts) writing. They must not
     suppress order bookkeeping: on the production lane the prod worker runs
     with IRESS_WORKER_DRY_RUN=1 and SUPABASE_ALLOW_WRITES=0, and under the old
     condition a real, filled order would have been logged and then dropped —
     the audit row left on `working` while the client's shares had actually
     traded.

     Enabling IRESS_PRODUCTION_ORDERS is an explicit decision to send real
     orders; recording what happened to them is part of that same decision, not
     a separate opt-in. */
  const mustRecordFills = productionLane || opts.env.uatMode;
  if (!opts.supabase) {
    // No database at all — nothing can be stamped. Loud on a live lane: this
    // means real fills are being observed and thrown away.
    if (mustRecordFills) {
      console.error(
        "[iress-ingest] CRITICAL: order fills observed but the worker has no Supabase client — executions are NOT being recorded.",
      );
    }
    return skip("no_supabase_client");
  }
  if ((opts.env.dryRun || !opts.env.allowWrites) && !mustRecordFills) {
    console.info(
      JSON.stringify({
        level: "info",
        event: "uat_poll_dry_run",
        account: pollAccountCode,
        count: orders.length,
        sample: orders.slice(0, 3).map((o) => ({
          orderNumber: o.id,
          state: o.state,
          filled: o.filled,
          avgPx: o.avgPx,
        })),
      }),
    );
    return { polled: 1, updated: 0, published: 0, elapsedMs: Date.now() - started, skipReason: null };
  }

  // Read existing audit rows tagged with one of the observed OrderNumbers.
  // PostgREST can't `.in()` inside jsonb arrays, so we filter on `order_id`
  // (the broker number) which is the column we store it under.
  const { data: matches, error: matchErr } = await opts.supabase
    .from("oems_order_audit")
    .select(
      "id, order_id, client_account, symbol, side, quantity, price_cents, status, source, payload, result_payload",
    )
    .in("order_id", iressOrderNumbers);

  if (matchErr) {
    console.warn(`[iress-ingest] uat audit match read failed: ${matchErr.message}`);
    return skip("audit_read_failed");
  }

  const auditByNumber = new Map<string, AuditRow>();
  for (const r of (matches ?? []) as AuditRow[]) {
    auditByNumber.set(r.order_id, r);
  }

  const updates: AuditUpdate[] = [];
  const observedAt = new Date().toISOString();
  let published = 0;

  for (const order of orders) {
    if (!order.id) continue;
    const audit = auditByNumber.get(order.id);
    const fillQty = Number(order.filled) || 0;
    // `Order.avgPx` off the IRESS OrderPad is in CENTS — same unit as quotes,
    // see derivePositions() in orders.ts which sums it straight into
    // `buyCostCents`. Two units live in this loop and conflating them was a
    // 100x bug: `payload.avgPx` is stored in CENTS (project-wide DB
    // convention, and what orders.ts already writes), while
    // `UatExecutionDelta.avgFillPrice` is RANDS (see the `priceRands` publish
    // in http-api.ts and the `* 100` that turns it back into
    // `avg_fill_price_cents` on the SSE wire). Keep them as two named
    // variables so neither can be passed where the other belongs.
    const avgFillCents = order.avgPx != null && Number.isFinite(order.avgPx) ? order.avgPx : null;
    const avgFillRands = avgFillCents != null ? avgFillCents / 100 : null;
    const state = mapStateToDb(order.state);

    // 2026-07-13 (Andre + Juan call, 26:21): Andre flagged "action status"
    // + "last action" as the key fields for diagnosing stuck orders in
    // real time. We pin a compact `lastAction` summary on every poll so
    // the ExecutionView can render a one-line "Latest: <event>" without
    // the operator needing to open Supabase or tail worker logs.
    //
    // Format: "<verb> <state>" — e.g. "Acknowledged", "Filled +200",
    // "Partial @ R177.00", "Cancelled", "Expired".
    let lastAction: string | null = null;
    if (state === "filled") lastAction = `Filled (${fillQty} @ R${avgFillRands?.toFixed(2) ?? "?"})`;
    else if (state === "partial")
      lastAction = `Partial +${fillQty}${avgFillRands != null ? ` @ R${avgFillRands.toFixed(2)}` : ""}`;
    else if (state === "cancelled") lastAction = "Cancelled by broker/trader";
    else if (state === "expired") lastAction = "Expired (DAY TIF rollover)";
    else if (state === "rejected")
      lastAction = `Rejected (${order.stateDescription ?? "no reason"})`;
    else if (state === "acknowledged")
      lastAction = "Acknowledged by broker";
    else if (state === "working") lastAction = "Working on exchange";
    else if (state === "pending_ack")
      lastAction = "Awaiting broker acknowledgement";

    // Publish first so subscribers see the latest regardless of write success.
    uatExecutionHub.publish({
      iressOrderNumber: order.id,
      orderAuditId: audit?.id ?? null,
      state,
      filled: fillQty,
      avgFillPrice: avgFillRands, // hub contract is RANDS
      lastFillTimestamp: observedAt,
      // 2026-07-13 — Transcript gap #2 (26:21): carry the same
      // one-liner we stamp on the audit row so the SSE consumer can
      // render it in the Action column without an extra DB read.
      lastAction,
      lastActionAt: observedAt,
      raw: order,
      bookId: audit && typeof audit.payload?.book_id === "string" ? (audit.payload.book_id as string) : null,
      observedAt,
    });
    published += 1;

    if (!audit) continue; // Not our row — don't write.

    const prevPayload = audit.payload ?? {};
    const prevResult = audit.result_payload ?? {};
    const newPayload: Record<string, unknown> = {
      ...prevPayload,
      filled: fillQty,
      avgPx: avgFillCents,
      lastFillAt: observedAt,
      brokerState: order.brokerState ?? order.state,
      actionStatus: order.actionStatus ?? prevPayload.actionStatus ?? null,
      internalOrderStatus: order.internalOrderStatus ?? prevPayload.internalOrderStatus ?? null,
      stateDescription: order.stateDescription ?? prevPayload.stateDescription ?? null,
      remainingVolume: order.remainingVolume ?? null,
      remainingValueCents: order.remainingValueCents ?? null,
      orderValueCents: order.orderValueCents ?? null,
      // 2026-07-13: transcript 26:21 — Andre flagged "last action" as
      // a key field. Stamp both the action text and its timestamp on
      // every poll so the UI can render the most recent transition in
      // the table + tooltip.
      lastAction,
      lastActionAt: observedAt,
    };
    const newResult: Record<string, unknown> = {
      ...prevResult,
      avgFillPrice: avgFillCents, // result_payload is CENTS, like payload.avgPx
      brokerState: order.brokerState ?? order.state,
      state: order.state,
      lastObservedAt: observedAt,
      lastAction,
      lastActionAt: observedAt,
    };
    // Slippage / day-1 P&L refresh so the UI updates without waiting for
    // a manual /fills POST.
    if (avgFillRands != null) {
      const limitRands =
        typeof prevPayload.limitPrice === "number"
          ? (prevPayload.limitPrice as number)
          : audit.price_cents != null
            ? Number(audit.price_cents) / 100
            : null;
      if (limitRands != null) {
        newResult.slippageBps = Math.round(
          ((limitRands - avgFillRands) * 10000) / Math.max(0.0001, limitRands),
        );
        newResult.dayOnePnlCents = Math.round((limitRands - avgFillRands) * 100) * fillQty;
      }
    }
    updates.push({
      id: audit.id,
      payload: newPayload,
      result_payload: newResult,
      status: state,
      // Carried so settlement can read the fill without a second round trip.
      settleRow: {
        order_id: audit.order_id,
        symbol: audit.symbol,
        side: audit.side,
        status: state,
        payload: newPayload,
        /* What was ORDERED. The poller never rewrites this column, so it is the
           only trustworthy denominator for "did this fully fill?" — `filled`
           alone cannot distinguish a completed order from one that traded 60 of
           100 and then expired. */
        quantity: audit.quantity,
      },
    });
  }

  if (updates.length === 0) {
    return { polled: 1, updated: 0, published, elapsedMs: Date.now() - started, skipReason: null };
  }

  // Apply updates. Per-row update keeps the audit trail honest — we never
  // delete or rewrite the row, only stamp fresh state.
  const writeResults = await Promise.all(
    updates.map((u) => {
      const supabase = opts.supabase;
      if (!supabase) return Promise.resolve({ ok: false, reason: "no_supabase_client" as const });
      return supabase
        .from("oems_order_audit")
        .update({
          payload: u.payload,
          result_payload: u.result_payload,
          status: u.status,
          updated_at: observedAt,
        })
        .eq("id", u.id);
    }),
  );
  const failed = writeResults.find((r) => "error" in r && r.error);
  if (failed && "error" in failed && failed.error) {
    console.warn(`[iress-ingest] uat audit write failed: ${failed.error.message}`);
    return {
      polled: 1,
      updated: 0,
      published,
      elapsedMs: Date.now() - started,
      skipReason: "audit_write_failed",
    };
  }

  /* SETTLEMENT. Only after the audit row is safely stamped — the audit trail is
     the record of what the broker did, and it must never lag the money. Failures
     here are logged and retried next cycle; they never fail the poll, because a
     settlement problem must not stop fills being recorded. */
  if (opts.retailSupabase && opts.supabase && opts.env.retailSettlementEnabled) {
    const rebalanceIdsToCheck = new Map<string, string>();
    const failedRebalanceIds = new Set<string>();
    for (const u of updates) {
      const updatePayload = (u.settleRow.payload ?? {}) as Record<string, unknown>;
      const updateRebalanceId =
        typeof updatePayload.rebalance_request_id === "string" ? updatePayload.rebalance_request_id : null;
      if (updateRebalanceId) {
        const actor =
          typeof updatePayload.sent_by === "string"
            ? updatePayload.sent_by
            : typeof updatePayload.trader === "string"
              ? updatePayload.trader
              : "iress-worker";
        rebalanceIdsToCheck.set(updateRebalanceId, actor);
      }
      /* A terminal order with unfilled quantity must be REVERSED, not settled.
         settleFill only ever adds what happened; nothing undid what did not.
         An app-raised order that is rejected — or a DAY order that expires
         part-filled — leaves the client holding pre-booked shares nobody bought
         and out of pocket for them. Runs before the fill path so a part-filled
         expiry both settles what traded and refunds what did not. */
      try {
        await voidUnfilledRemainder(
          {
            institutional: opts.supabase,
            retail: opts.retailSupabase,
            enabled: true,
            dryRun: opts.env.retailSettlementDryRun,
          },
          u.settleRow,
        );
      } catch (err) {
        if (updateRebalanceId) failedRebalanceIds.add(updateRebalanceId);
        const msg = err instanceof Error ? err.message : String(err);
        console.error(
          JSON.stringify({ level: "error", event: "settlement_void_threw", order: u.settleRow.order_id, error: msg }),
        );
      }

      const fill = observedFillFromAudit(u.settleRow);
      if (!fill) {
        /* The commonest and most dangerous outcome, and it used to be silent.
           A row with a real filled quantity that we decline to settle looks
           identical to "there were no fills": the desk sees FILLED in the order
           book and reasonably concludes the client was settled. Only shout when
           something actually executed — an unfilled order skipping settlement is
           just normal. */
        const p = (u.settleRow.payload ?? {}) as Record<string, unknown>;
        const q = Number(p.filled);
        if (Number.isFinite(q) && q > 0) {
          console.error(
            JSON.stringify({
              level: "error",
              event: "settlement_skipped",
              order: u.settleRow.order_id,
              symbol: u.settleRow.symbol,
              filled: q,
              hasUserId: typeof p.user_id === "string" && p.user_id.length > 0,
              hasAvgPx: Number(p.avgPx) > 0,
              reason: "fill observed but not attributable — NOT settled to any client",
            }),
          );
        }
        continue;
      }

      // ── 2026-07-28 GIFT LIFECYCLE ─────────────────────────────────────────
      // If this audit row came from the gift-registry/contribute handler
      // (payload.gift_authorization_id is set), it takes the gift path
      // instead of the regular buy/sell path. The gift settlement owns the
      // wallet side; we do NOT call settleFill() afterwards. A successful
      // within-ceiling fill returns "open_holding" which we use to mint the
      // recipient's stock_holdings_c row directly below.
      const p = (u.settleRow.payload ?? {}) as Record<string, unknown>;
      const giftAuthId = typeof p.gift_authorization_id === "string" ? p.gift_authorization_id : null;
      if (giftAuthId) {
        const auth = await findGiftAuthorization(opts.retailSupabase, p);
        if (auth) {
          let giftTransition: GiftAuthTransition | null = null;
          try {
            if (u.settleRow.status === "filled" || u.settleRow.status === "partial") {
              giftTransition = await applyGiftFill(
                {
                  institutional: opts.supabase,
                  retail: opts.retailSupabase,
                  dryRun: opts.env.retailSettlementDryRun,
                },
                auth,
                fill,
              );
            } else if (u.settleRow.status === "cancelled" || u.settleRow.status === "rejected" ||
                       u.settleRow.status === "expired" || u.settleRow.status === "failed") {
              giftTransition = await applyGiftTerminalNoFill(
                {
                  retail: opts.retailSupabase,
                  dryRun: opts.env.retailSettlementDryRun,
                },
                auth,
                u.settleRow.status,
                typeof p.rejectReason === "string" ? p.rejectReason : null,
              );
            }
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error(
              JSON.stringify({ level: "error", event: "gift_settlement_threw", order: fill.orderId, gift_authorization_id: giftAuthId, error: msg }),
            );
            continue;
          }
          if (giftTransition && giftTransition.action === "open_holding") {
            // Mint the recipient's stock_holdings_c row at the fill price.
            // The wallet was already debited by applyGiftFill; the lot must
            // exist for the recipient's app to render the gift.
            //
            // 2026-07-29 FIX: child-recipient resolution. When the gift is for
            // a child (family_member_id set, recipient_user_id null) the lot
            // must be owned by the parent's primary_user_id (look up via
            // family_members.parent_user_id). The previous behaviour fell
            // back to auth.gifter_user_id, which misrouted child gifts onto
            // the gifter's account and left the actual child without a
            // holding. Self / OTHER-adult recipient paths still work — when
            // recipient_user_id is set, that is the lot owner.
            let lotOwnerUserId = auth.recipient_user_id;
            if (!lotOwnerUserId && auth.recipient_family_member_id) {
              const { data: fam, error: famErr } = await opts.retailSupabase
                .from("family_members")
                .select("parent_user_id")
                .eq("id", auth.recipient_family_member_id)
                .maybeSingle();
              if (famErr) {
                console.error(
                  JSON.stringify({
                    level: "error",
                    event: "gift_holding_family_lookup_failed",
                    gift_authorization_id: auth.id,
                    family_member_id: auth.recipient_family_member_id,
                    error: famErr.message,
                  }),
                );
              }
              lotOwnerUserId = fam?.parent_user_id ?? null;
            }
            if (!lotOwnerUserId) {
              // Last-resort safety: only if neither recipient_user_id nor
              // parent_user_id can be resolved, fall back to the gifter. This
              // should never trigger in normal operation; we log prominently
              // so an operator can fix the underlying data.
              console.error(
                JSON.stringify({
                  level: "error",
                  event: "gift_holding_no_lot_owner",
                  gift_authorization_id: auth.id,
                }),
              );
              lotOwnerUserId = auth.gifter_user_id;
            }
            try {
              const { error: lotErr } = await opts.retailSupabase
                .from("stock_holdings_c")
                .insert({
                  user_id: lotOwnerUserId,
                  security_id: fill.securityId,
                  quantity: giftTransition.fillQuantity,
                  avg_fill: giftTransition.fillPriceCents, // CENTS
                  Expected_fill: giftTransition.fillPriceCents / 100, // RANDS
                  market_value: giftTransition.fillPriceCents * giftTransition.fillQuantity,
                  side: "buy",
                  trade_side: "BUY",
                  is_active: true,
                  Status: "active",
                  Fill_date: new Date().toISOString().slice(0, 10),
                  strategy_name_snapshot: `GIFT-${auth.id}`,
                  fill_set_by: `iress-settlement:${fill.orderId}`,
                  fill_set_at: new Date().toISOString(),
                  family_member_id: auth.recipient_family_member_id ?? null,
                  // Attribution: the recipient is the lot owner. If the
                  // recipient is a child registry (family_member_id) the lot
                  // belongs to the parent_user_id (resolved above) with the
                  // child's family_member_id attached so the UI shows the
                  // child as the beneficiary.
                })
                .select("id");
              if (lotErr) {
                console.error(
                  JSON.stringify({ level: "error", event: "gift_holding_insert_failed", gift_authorization_id: auth.id, error: lotErr.message }),
                );
              } else {
                console.info(
                  JSON.stringify({
                    level: "info",
                    event: "gift_holding_minted",
                    gift_authorization_id: auth.id,
                    qty: giftTransition.fillQuantity,
                    fill_price_cents: giftTransition.fillPriceCents,
                    order_id: fill.orderId,
                  }),
                );
              }
            } catch (e) {
              console.error(
                JSON.stringify({ level: "error", event: "gift_holding_insert_threw", gift_authorization_id: auth.id, error: (e as Error).message }),
              );
            }
          }
          // Whether open_holding, hold_for_approval, or stop — we do NOT
          // call settleFill() afterwards. The gift lifecycle owns the
          // wallet/holding side end-to-end.
          continue;
        }
      }
      // ── END GIFT LIFECYCLE ───────────────────────────────────────────────

      try {
        const settlement = await settleFill(
          {
            institutional: opts.supabase,
            retail: opts.retailSupabase,
            enabled: true,
            dryRun: opts.env.retailSettlementDryRun,
          },
          fill,
        );
        if (settlement.error && updateRebalanceId) failedRebalanceIds.add(updateRebalanceId);
      } catch (err) {
        if (updateRebalanceId) failedRebalanceIds.add(updateRebalanceId);
        const msg = err instanceof Error ? err.message : String(err);
        console.error(
          JSON.stringify({ level: "error", event: "settlement_threw", order: fill.orderId, error: msg }),
        );
      }
    }

    // The audit rows are already stamped and every observed client fill above
    // has settled successfully. Only now may a resolved rebalance flip the
    // strategy model and seal its return/cash boundary. Dry-run must never
    // perform these completion writes.
    if (!opts.env.retailSettlementDryRun) {
      for (const [rebalanceRequestId, actor] of rebalanceIdsToCheck) {
        if (failedRebalanceIds.has(rebalanceRequestId)) continue;
        try {
          const completion = await maybeCompleteRebalance(
            opts.retailSupabase as never,
            opts.supabase as never,
            rebalanceRequestId,
            actor,
          );
          if (completion.error) {
            console.error(
              JSON.stringify({
                level: "error",
                event: "rebalance_completion_blocked",
                rebalance_request_id: rebalanceRequestId,
                error: completion.error,
              }),
            );
            continue;
          }
          if (completion.completed) {
            const cash = await settleRebalanceCashForClients(
              opts.retailSupabase as never,
              opts.supabase as never,
              rebalanceRequestId,
              completion.settlementBatchId,
            );
            if (cash.errors.length > 0) {
              console.error(
                JSON.stringify({
                  level: "error",
                  event: "rebalance_cash_settlement_blocked",
                  rebalance_request_id: rebalanceRequestId,
                  errors: cash.errors,
                }),
              );
            }
          }
        } catch (err) {
          console.error(
            JSON.stringify({
              level: "error",
              event: "rebalance_completion_threw",
              rebalance_request_id: rebalanceRequestId,
              error: err instanceof Error ? err.message : String(err),
            }),
          );
        }
      }
    }
  }

  console.info(
    JSON.stringify({
      level: "info",
      event: "uat_audit_updated",
      uatAccount: opts.env.uatAccountCode,
      matched: updates.length,
      published,
      states: updates.map((u) => u.status),
    }),
  );

  return { polled: 1, updated: updates.length, published, elapsedMs: Date.now() - started, skipReason: null };
}

/** Track the last UAT poll timestamp so `/uat/execution-stream` can show staleness. */
let lastUatPollAt: string | undefined;

export function getLastUatPollAt(): string | undefined {
  return lastUatPollAt;
}

export function stampLastUatPollAt(): void {
  lastUatPollAt = new Date().toISOString();
}
