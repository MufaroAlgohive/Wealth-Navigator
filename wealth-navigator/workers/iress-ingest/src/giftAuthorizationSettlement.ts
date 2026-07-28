/**
 * Gift Authorization Settlement — extends the IRESS fill settlement path
 * to honour the 2026-07-28 authorize-then-fill gift lifecycle.
 *
 * The original `settlement.ts` flow is unchanged: an order tagged with
 * `payload.holding_id` (a real stock_holdings_c row) takes the "reconcile"
 * path, and an order without that payload takes the "open" path. Gifts
 * raised by the new contribute handler carry `payload.gift_authorization_id`
 * INSTEAD of `payload.holding_id` — they have no pre-booked lot, and the
 * wallet is reserved, not debited. This module is the bridge that finds
 * the matching authorization, compares the fill price to the gifter's
 * ceiling, transitions the lifecycle state, and tells the regular
 * settlement to either create the holding (within-ceiling) or hold for
 * gifter approval (above-ceiling).
 *
 * Why a separate module and not a patch inside settlement.ts:
 *   - The existing settlement code is heavily audited and tested.
 *     (release-order-claim.test.ts, settlement.test.ts, defect 13/15
 *     regression net). We don't want to change buy/empty/sell/reconcile
 *     branches.
 *   - The gift lifecycle is its own state machine with its own event
 *     ledger (`gift_authorization_events`). Putting it in a separate
 *     module keeps that ledger isolated and easy to audit.
 *   - Settlement.ts already skips orders without `payload.holding_id`.
 *     When we add `payload.gift_authorization_id`, settlement.ts will
 *     skip too (it has no holding to match). The order-poller will call
 *     this module on every gift fill BEFORE/INSTEAD OF the regular
 *     settlement when the gift_authorization_id is present.
 *
 * Invariants:
 *   - Exactly one of `holdingId` / `gift_authorization_id` is set on a
 *     given order's payload. Both can't be true at once (the contribute
 *     handler sends the gift one, the record-investment handler sends
 *     the lot one).
 *   - The gift authorization's `status` is the source of truth for the
 *     wallet side. The IRESS OrderCreate3 / fill is the source of truth
 *     for the broker side. They are reconciled by this module.
 *   - Idempotent: a fill that lands more than once (worker bounce, polling
 *     overlap) is detected via the existing `oems_fill_settlement_c`
 *     ledger. The fill-then-reconcile flow is keyed on order_id, not on
 *     any per-gift state.
 */

import type { WorkerSupabase } from "./supabase";
import type { ObservedFill } from "./settlement";

/** Lifecycle states — mirror of the RETAIL gift_authorizations.status enum. */
export const GIFT_AUTH_STATUS = Object.freeze({
  AUTHORIZED:              "AUTHORIZED",
  PARKED:                  "PARKED",
  WORKING:                 "WORKING",
  PENDING_GIFTER_APPROVAL: "PENDING_GIFTER_APPROVAL",
  FILLED:                  "FILLED",
  CANCELLED:               "CANCELLED",
  AUTO_CANCELLED:          "AUTO_CANCELLED",
  EXPIRED:                 "EXPIRED",
  REJECTED:                "REJECTED",
  FAILED:                  "FAILED",
});

const TERMINAL = new Set([
  GIFT_AUTH_STATUS.FILLED,
  GIFT_AUTH_STATUS.CANCELLED,
  GIFT_AUTH_STATUS.AUTO_CANCELLED,
  GIFT_AUTH_STATUS.EXPIRED,
  GIFT_AUTH_STATUS.REJECTED,
  GIFT_AUTH_STATUS.FAILED,
]);

const DEFAULT_PENDING_DECISION_GRACE_MS = 30 * 60 * 1000;

export interface GiftAuthRow {
  id: string;
  reservation_id: string;
  registry_item_id: string;
  gifter_user_id: string;
  gifter_email: string;
  recipient_user_id: string | null;
  recipient_family_member_id: string | null;
  recipient_display_name: string | null;
  registry_title: string | null;
  quantity: number;
  live_price_cents: number;
  max_acceptable_fill_cents: number;
  drift_bps: number;
  reserved_amount_cents: number;
  payment_method: string;
  status: string;
  pending_decision_deadline: string | null;
  oems_order_audit_id: string | null;
  oems_order_id: string | null;
  idempotency_key: string;
  expires_at: string;
  authorized_at: string;
  parked_at: string | null;
  working_at: string | null;
  filled_at: string | null;
  cancelled_at: string | null;
}

/** Outcome of a gift-authorization transition. */
export interface GiftAuthTransition {
  authorizationId: string;
  fromStatus: string;
  toStatus: string;
  /**
   * What the caller (order-poller) should do next:
   *   "open_holding"   — within ceiling: create the recipient's holding
   *                     lot via the standard `sell? no, buy` path of
   *                     settleFill() with the chosen family_member_id.
   *   "stop"           — status moved to terminal (CANCELLED, EXPIRED, etc.)
   *                     and we should NOT create a holding.
   *   "hold_for_approval" — fill above ceiling: do NOT create a holding
   *                     yet; wait for the gifter's decide call (or grace
   *                     expiry).
   */
  action: "open_holding" | "stop" | "hold_for_approval";
  /** Cents — the amount the gifter's wallet will be (or was) debited. */
  paidAmountCents: number;
  /** Cents — the IRESS-reported avgFill price. */
  fillPriceCents: number;
  /** Filled quantity — may be less than authorized for a partial fill. */
  fillQuantity: number;
  /** IRESS OrderNumber. */
  fillReference: string;
}

/**
 * Find the gift_authorization row this audit row belongs to, by the
 * `payload.gift_authorization_id` the contribute handler stamped.
 */
export async function findGiftAuthorization(
  retail: WorkerSupabase,
  payload: Record<string, unknown> | null,
): Promise<GiftAuthRow | null> {
  const id = typeof payload?.gift_authorization_id === "string" ? payload.gift_authorization_id : null;
  if (!id) return null;
  // gift_authorizations lives on the RETAIL DB, not the institutional one.
  // Reading it from institutional silently returned null previously (PostgREST
  // would have thrown "relation does not exist" if the table truly didn't
  // exist on institutional — the shape here is that the table exists on
  // institutional in *some* deployments but not all; we ALWAYS read it from
  // retail, where it canonically lives per supabase-gift-registry-schema.sql).
  const { data, error } = await retail
    .from("gift_authorizations")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (error) {
    console.error(
      JSON.stringify({ level: "error", event: "gift_auth_lookup_failed", gift_authorization_id: id, error: error.message }),
    );
    return null;
  }
  return (data ?? null) as GiftAuthRow | null;
}

/**
 * Append a row to the gift_authorization_events audit log. Idempotent at
 * the schema level — the events table is the canonical trail.
 */
async function appendEvent(
  retail: WorkerSupabase,
  authorizationId: string,
  fromStatus: string | null,
  toStatus: string,
  actor: string,
  reason: string | null,
  payload: Record<string, unknown> | null,
): Promise<void> {
  const { error } = await retail.from("gift_authorization_events").insert({
    authorization_id: authorizationId,
    from_status: fromStatus,
    to_status: toStatus,
    actor,
    reason,
    payload,
  });
  if (error) {
    console.error(
      JSON.stringify({ level: "error", event: "gift_auth_event_write_failed", gift_authorization_id: authorizationId, error: error.message }),
    );
  }
}

/**
 * Conditional state transition — only succeeds if the row's status is still
 * `fromStatus`. Returns the new row on success, or null on race-loss (the
 * caller should re-plan).
 */
async function transition(
  retail: WorkerSupabase,
  authorizationId: string,
  fromStatus: string,
  toStatus: string,
  patch: Record<string, unknown>,
  actor: string,
  reason: string | null,
  eventPayload: Record<string, unknown> | null,
): Promise<GiftAuthRow | null> {
  const now = new Date().toISOString();
  const fullPatch = { ...patch, status: toStatus, updated_at: now };
  const { data, error } = await retail
    .from("gift_authorizations")
    .update(fullPatch)
    .eq("id", authorizationId)
    .eq("status", fromStatus)
    .select("*")
    .maybeSingle();
  if (error) {
    console.error(
      JSON.stringify({ level: "error", event: "gift_auth_transition_failed", gift_authorization_id: authorizationId, from: fromStatus, to: toStatus, error: error.message }),
    );
    return null;
  }
  if (!data) return null; // race; another process moved it
  await appendEvent(retail, authorizationId, fromStatus, toStatus, actor, reason, eventPayload);
  // Mirror to the realtime channel.
  await retail.from("gift_fill_observers").upsert({
    authorization_id: authorizationId,
    user_id: (data as GiftAuthRow).gifter_user_id,
    recipient_user_id: (data as GiftAuthRow).recipient_user_id ?? null,
    status: toStatus,
    fill_price_cents: (data as GiftAuthRow).fill_price_cents ?? null,
    paid_amount_cents: (data as GiftAuthRow).paid_amount_cents ?? null,
    needs_decision_by: (data as GiftAuthRow).pending_decision_deadline ?? null,
    updated_at: now,
  }, { onConflict: "authorization_id" });
  return data as GiftAuthRow;
}

/**
 * Compare the IRESS fill price to the gifter's ceiling. Returns:
 *   - "within_ceiling" if fillPriceCents <= max_acceptable_fill_cents
 *   - "above_ceiling"  otherwise
 *
 * The ceiling is rounded UP at authorization time so any 1-cent rounding
 * error never trips the gifter into the approval branch by accident.
 */
export function compareFillToCeiling(
  fillPriceCents: number,
  maxAcceptableFillCents: number,
): "within_ceiling" | "above_ceiling" {
  return fillPriceCents <= maxAcceptableFillCents ? "within_ceiling" : "above_ceiling";
}

/**
 * Release the gifter's wallet reservation — used on REJECTED, EXPIRED,
 * AUTO_CANCELLED, CANCELLED (gifter-rejected). Does NOT debit the
 * posted_balance_cents (the gift was never fulfilled).
 */
async function releaseWalletReservation(
  retail: WorkerSupabase,
  gifterUserId: string,
  amountCents: number,
): Promise<void> {
  // wallets lives on the RETAIL DB.
  const { data: wallet, error: readErr } = await retail
    .from("wallets")
    .select("id, available_balance_cents")
    .eq("user_id", gifterUserId)
    .maybeSingle();
  if (readErr || !wallet) return;
  const newAvailable = Number(wallet.available_balance_cents) + Number(amountCents);
  await retail
    .from("wallets")
    .update({ available_balance_cents: newAvailable })
    .eq("id", wallet.id);
}

/**
 * Settle the gifter's wallet — debit posted_balance_cents at the fill
 * amount. The reservation was already removed from available_balance_cents
 * at AUTHORIZED time; this is the final settlement.
 */
async function settleWalletDebit(
  retail: WorkerSupabase,
  gifterUserId: string,
  amountCents: number,
): Promise<void> {
  // wallets lives on the RETAIL DB.
  const { data: wallet, error: readErr } = await retail
    .from("wallets")
    .select("id, posted_balance_cents")
    .eq("user_id", gifterUserId)
    .maybeSingle();
  if (readErr || !wallet) throw new Error(`wallet not found for ${gifterUserId}`);
  const posted = Number(wallet.posted_balance_cents);
  if (!Number.isFinite(posted) || posted < amountCents) {
    throw new Error(`posted_balance ${posted} < fill amount ${amountCents} for ${gifterUserId}`);
  }
  const newPosted = posted - amountCents;
  const { error: updErr } = await retail
    .from("wallets")
    .update({ posted_balance_cents: newPosted, balance: Math.floor(newPosted / 100) })
    .eq("id", wallet.id);
  if (updErr) throw new Error(`wallet posted_balance update failed: ${updErr.message}`);
}

/**
 * Push a notification to the gifter's mobile/desktop so the sent-gifts
 * page shows the prompt. The "decide" endpoint is the only path that
 * resolves PENDING_GIFTER_APPROVAL.
 */
async function notifyGifterForApproval(
  retail: WorkerSupabase,
  auth: GiftAuthRow,
  fillPriceCents: number,
  deadlineIso: string,
): Promise<void> {
  // notifications lives on the RETAIL DB. `type` must be a valid notification_type
  // enum value: system/transaction/security/promotion. We use 'system' and carry
  // the gift-specific discriminator in `payload.gift_event`.
  const fillRands = (fillPriceCents / 100).toFixed(2);
  const ceilingRands = (auth.max_acceptable_fill_cents / 100).toFixed(2);
  await retail.from("notifications").insert({
    user_id: auth.gifter_user_id,
    title: `Gift fill needs your approval`,
    body: `Your gift for ${auth.recipient_display_name ?? "your recipient"} filled at R${fillRands}, above your ceiling of R${ceilingRands}. Approve to charge your wallet, or reject to cancel — by ${deadlineIso}.`,
    type: "system",
    payload: {
      action: "OPEN_GIFT_AUTHORIZATION",
      authorization_id: auth.id,
      gift_event: "gift_decision_required",
      decision_options: ["approve", "reject"],
      deadline: deadlineIso,
    },
  });
}

/**
 * Apply an IRESS fill to the gift authorization lifecycle.
 *
 * The order-poller calls this on every settleable row that carries
 * `payload.gift_authorization_id`. Returns the transition outcome so the
 * caller can decide whether to invoke the regular `settleFill()` path:
 *   - "open_holding" → caller invokes settleFill() with the gifter's
 *     user_id as the lot owner and the recipient's family_member_id so
 *     the lot is attributed correctly.
 *   - "stop" or "hold_for_approval" → caller does NOT invoke settleFill.
 *     The lifecycle state is the source of truth; the wallet/holding have
 *     been adjusted here.
 *
 * This function is idempotent. A second call with the same fill returns
 * the same outcome (the auth row is already terminal, or the within-
 * ceiling comparison still holds against the same fill price).
 */
export async function applyGiftFill(
  deps: { institutional: WorkerSupabase; retail: WorkerSupabase; dryRun: boolean },
  auth: GiftAuthRow,
  fill: ObservedFill,
): Promise<GiftAuthTransition | null> {
  const now = new Date().toISOString();
  const fillPriceCents = Math.round(Number(fill.avgFillCents));
  const fillQuantity = Math.round(Number(fill.filledQty));
  const fillReference = String(fill.orderId);

  // Reject nonsense — guards against accidental double-calls.
  if (!Number.isFinite(fillPriceCents) || fillPriceCents <= 0) return null;
  if (!Number.isFinite(fillQuantity) || fillQuantity <= 0) return null;

  // Already terminal? Don't double-charge.
  if (TERMINAL.has(auth.status)) {
    console.warn(
      JSON.stringify({
        level: "warn",
        event: "gift_auth_fill_ignored",
        gift_authorization_id: auth.id,
        current_status: auth.status,
        order_id: fillReference,
      }),
    );
    return {
      authorizationId: auth.id,
      fromStatus: auth.status,
      toStatus: auth.status,
      action: "stop",
      paidAmountCents: 0,
      fillPriceCents,
      fillQuantity,
      fillReference,
    };
  }

  // 1. Move WORKING → inside the price comparison. If the auth is still in
  //    AUTHORIZED or PARKED (operator hasn't released yet, but the broker
  //    reports a fill), advance through WORKING as a single transition.
  //    Use PARKED → WORKING first if the order was parked, then handle the
  //    price comparison.
  if (auth.status === GIFT_AUTH_STATUS.PARKED) {
    const moved = await transition(
      deps.retail,
      auth.id,
      GIFT_AUTH_STATUS.PARKED,
      GIFT_AUTH_STATUS.WORKING,
      { working_at: now, oems_order_id: fillReference },
      "iress",
      `IRESS reported fill on order ${fillReference}`,
      { fillPriceCents, fillQuantity, orderId: fillReference },
    );
    if (!moved) return null; // race
    auth = moved;
  }
  if (auth.status === GIFT_AUTH_STATUS.AUTHORIZED) {
    const moved = await transition(
      deps.retail,
      auth.id,
      GIFT_AUTH_STATUS.AUTHORIZED,
      GIFT_AUTH_STATUS.WORKING,
      { working_at: now, oems_order_id: fillReference },
      "iress",
      `IRESS reported fill on order ${fillReference}`,
      { fillPriceCents, fillQuantity, orderId: fillReference },
    );
    if (!moved) return null;
    auth = moved;
  }

  // 2. Compare the fill price to the gifter's ceiling.
  const verdict = compareFillToCeiling(fillPriceCents, auth.max_acceptable_fill_cents);

  // 3. WITHIN CEILING → settle: WORKING → FILLED, debit wallet at FILL price.
  if (verdict === "within_ceiling") {
    const paidAmountCents = fillPriceCents * fillQuantity;
    if (!deps.dryRun) {
      try {
        await settleWalletDebit(deps.retail, auth.gifter_user_id, paidAmountCents);
      } catch (e) {
        console.error(
          JSON.stringify({
            level: "error",
            event: "gift_auth_wallet_debit_failed",
            gift_authorization_id: auth.id,
            amount_cents: paidAmountCents,
            error: (e as Error).message,
          }),
        );
        // Mark FAILED so an operator can investigate. Do NOT lose the
        // reservation — the gifter is still on the hook.
        await transition(
          deps.retail,
          auth.id,
          GIFT_AUTH_STATUS.WORKING,
          GIFT_AUTH_STATUS.FAILED,
          { fill_price_cents: fillPriceCents, fill_quantity: fillQuantity, fill_reference: fillReference },
          "system",
          `Wallet debit failed: ${(e as Error).message}`,
          { fillPriceCents, fillQuantity, paidAmountCents, orderId: fillReference, error: (e as Error).message },
        );
        return {
          authorizationId: auth.id,
          fromStatus: GIFT_AUTH_STATUS.WORKING,
          toStatus: GIFT_AUTH_STATUS.FAILED,
          action: "stop",
          paidAmountCents: 0,
          fillPriceCents,
          fillQuantity,
          fillReference,
        };
      }
    }

    // 2026-07-28 — mirror to legacy `gift_contributions` so the existing
    // UI shows the gift as SETTLED during the migration window. The
    // mirror is keyed on the `auth:<authorization_id>` idempotency key
    // the contribute handler wrote.
    if (!deps.dryRun) {
      await deps.retail
        .from("gift_contributions")
        .update({
          status: "SETTLED",
          executed_amount_cents: paidAmountCents,
          order_ref: fillReference,
        })
        .eq("idempotency_key", `auth:${auth.id}`);
    }
    const next = await transition(
      deps.retail,
      auth.id,
      GIFT_AUTH_STATUS.WORKING,
      GIFT_AUTH_STATUS.FILLED,
      {
        fill_price_cents: fillPriceCents,
        fill_quantity: fillQuantity,
        fill_reference: fillReference,
        paid_amount_cents: paidAmountCents,
      },
      "iress",
      `Fill within ceiling (${fillPriceCents} ≤ ${auth.max_acceptable_fill_cents} cents), wallet debited R${(paidAmountCents / 100).toFixed(2)}`,
      { fillPriceCents, fillQuantity, paidAmountCents, orderId: fillReference },
    );
    if (!next) return null; // race; the next cycle will see the FILLED row and stop

    // Tell the gifter. notifications lives on RETAIL; type must be a valid
    // notification_type enum value (system/transaction/security/promotion).
    // We carry the gift-specific discriminator in `payload.gift_event`.
    if (!deps.dryRun) {
      await deps.retail.from("notifications").insert({
        user_id: auth.gifter_user_id,
        title: `Gift filled`,
        body: `Your gift for ${auth.recipient_display_name ?? "your recipient"} filled at R${(fillPriceCents / 100).toFixed(2)}. R${(paidAmountCents / 100).toFixed(2)} was charged to your wallet.`,
        type: "system",
        payload: {
          action: "OPEN_GIFT_AUTHORIZATION",
          authorization_id: auth.id,
          gift_event: "gift_filled",
        },
      });
    }

    return {
      authorizationId: auth.id,
      fromStatus: GIFT_AUTH_STATUS.WORKING,
      toStatus: GIFT_AUTH_STATUS.FILLED,
      action: "open_holding",
      paidAmountCents,
      fillPriceCents,
      fillQuantity,
      fillReference,
    };
  }

  // 4. ABOVE CEILING → PENDING_GIFTER_APPROVAL with a 30-min grace.
  const deadline = new Date(Date.now() + DEFAULT_PENDING_DECISION_GRACE_MS).toISOString();
  const next = await transition(
    deps.retail,
    auth.id,
    GIFT_AUTH_STATUS.WORKING,
    GIFT_AUTH_STATUS.PENDING_GIFTER_APPROVAL,
    {
      fill_price_cents: fillPriceCents,
      fill_quantity: fillQuantity,
      fill_reference: fillReference,
      pending_decision_deadline: deadline,
    },
    "iress",
    `Fill exceeded ceiling (${fillPriceCents} > ${auth.max_acceptable_fill_cents} cents). Awaiting gifter decision until ${deadline}.`,
    {
      fillPriceCents,
      ceilingCents: auth.max_acceptable_fill_cents,
      fillQuantity,
      deadline,
      orderId: fillReference,
      slippageBps: Math.round((fillPriceCents - auth.max_acceptable_fill_cents) * 10000 / auth.max_acceptable_fill_cents),
    },
  );
  if (!next) return null;

  // Mirror to legacy gift_contributions.
  if (!deps.dryRun) {
    await deps.retail
      .from("gift_contributions")
      .update({
        status: "PAID_FORWARD_PENDING",
        order_ref: fillReference,
      })
      .eq("idempotency_key", `auth:${auth.id}`);
  }
  if (!deps.dryRun) {
    await notifyGifterForApproval(deps.retail, auth, fillPriceCents, deadline);
  }
  return {
    authorizationId: auth.id,
    fromStatus: GIFT_AUTH_STATUS.WORKING,
    toStatus: GIFT_AUTH_STATUS.PENDING_GIFTER_APPROVAL,
    action: "hold_for_approval",
    paidAmountCents: 0,
    fillPriceCents,
    fillQuantity,
    fillReference,
  };
}

/**
 * Handle a terminal-non-fill outcome (IRESS rejected, cancelled, expired,
 * failed) — release the gifter's wallet reservation and transition to
 * REJECTED. Called by the order-poller when a gift order's status flips
 * to a terminal-unfilled state.
 */
export async function applyGiftTerminalNoFill(
  deps: { retail: WorkerSupabase; dryRun: boolean },
  auth: GiftAuthRow,
  brokerStatus: "cancelled" | "rejected" | "expired" | "failed",
  brokerReason: string | null,
): Promise<GiftAuthTransition | null> {
  if (TERMINAL.has(auth.status)) return null;
  if (auth.status === GIFT_AUTH_STATUS.FILLED) return null; // never happens

  const targetStatus = brokerStatus === "failed" ? GIFT_AUTH_STATUS.FAILED : GIFT_AUTH_STATUS.REJECTED;
  const now = new Date().toISOString();

  // Release the reservation back to available_balance_cents.
  if (!deps.dryRun) {
    await releaseWalletReservation(deps.retail, auth.gifter_user_id, auth.reserved_amount_cents);
  }

  const next = await transition(
    deps.retail,
    auth.id,
    auth.status,
    targetStatus,
    { fill_reference: null },
    "iress",
    brokerReason ?? `Broker status: ${brokerStatus}`,
    { brokerStatus, brokerReason },
  );
  if (!next) return null;

  if (!deps.dryRun) {
    await deps.retail.from("notifications").insert({
      user_id: auth.gifter_user_id,
      title: brokerStatus === "rejected" ? "Gift rejected by broker" : `Gift ${brokerStatus}`,
      body: brokerReason ?? `Your gift for ${auth.recipient_display_name ?? "your recipient"} was ${brokerStatus}. No charge was made.`,
      type: "system",
      payload: { action: "OPEN_GIFT_AUTHORIZATION", authorization_id: auth.id },
    });
  }

  return {
    authorizationId: auth.id,
    fromStatus: auth.status,
    toStatus: targetStatus,
    action: "stop",
    paidAmountCents: 0,
    fillPriceCents: 0,
    fillQuantity: 0,
    fillReference: "",
  };
}

/**
 * Sweep PARKED authorizations past their expires_at → EXPIRED. Releases
 * the wallet reservation. Called by a cron worker (e.g. every 5 min).
 */
export async function sweepExpiredParkedAuthorizations(
  deps: { retail: WorkerSupabase; dryRun: boolean },
  now: Date = new Date(),
): Promise<{ expired: number }> {
  const cutoff = now.toISOString();
  const { data: candidates, error } = await deps.retail
    .from("gift_authorizations")
    .select("id, gifter_user_id, reserved_amount_cents, status")
    .in("status", [GIFT_AUTH_STATUS.AUTHORIZED, GIFT_AUTH_STATUS.PARKED])
    .lt("expires_at", cutoff);
  if (error) {
    console.error(JSON.stringify({ level: "error", event: "gift_auth_sweep_query_failed", error: error.message }));
    return { expired: 0 };
  }
  let expired = 0;
  for (const row of (candidates ?? []) as Array<{ id: string; gifter_user_id: string; reserved_amount_cents: number; status: string }>) {
    const fromStatus = row.status as string;
    const next = await transition(
      deps.retail,
      row.id,
      fromStatus,
      GIFT_AUTH_STATUS.EXPIRED,
      {},
      "sweeper",
      `Authorization expired without reaching the broker (was ${fromStatus})`,
      { reservedAmountCents: row.reserved_amount_cents },
    );
    if (next) {
      if (!deps.dryRun) {
        await releaseWalletReservation(deps.retail, row.gifter_user_id, row.reserved_amount_cents);
        await deps.retail.from("notifications").insert({
          user_id: row.gifter_user_id,
          title: "Gift reservation expired",
          body: `Your gift reservation expired before the order was sent to the broker. No charge was made.`,
          type: "system",
          payload: { action: "OPEN_GIFT_AUTHORIZATION", authorization_id: row.id, gift_event: "gift_expired" },
        });
      }
      expired += 1;
    }
  }
  if (expired > 0) {
    console.info(JSON.stringify({ level: "info", event: "gift_auth_sweep_completed", expired }));
  }
  return { expired };
}

/**
 * Sweep PENDING_GIFTER_APPROVAL past their pending_decision_deadline →
 * AUTO_CANCELLED. Releases the wallet reservation. The OEM order remains
 * live at the broker (the operator can cancel it out-of-band). A
 * follow-up `applyGiftTerminalNoFill` will reconcile the broker state.
 */
export async function sweepApprovalGraceExpired(
  deps: { retail: WorkerSupabase; dryRun: boolean },
  now: Date = new Date(),
): Promise<{ auto_cancelled: number }> {
  const cutoff = now.toISOString();
  const { data: candidates, error } = await deps.retail
    .from("gift_authorizations")
    .select("id, gifter_user_id, reserved_amount_cents, fill_price_cents, fill_quantity, fill_reference")
    .eq("status", GIFT_AUTH_STATUS.PENDING_GIFTER_APPROVAL)
    .lt("pending_decision_deadline", cutoff);
  if (error) {
    console.error(JSON.stringify({ level: "error", event: "gift_auth_grace_sweep_query_failed", error: error.message }));
    return { auto_cancelled: 0 };
  }
  let auto_cancelled = 0;
  for (const row of (candidates ?? []) as Array<{ id: string; gifter_user_id: string; reserved_amount_cents: number }>) {
    const next = await transition(
      deps.retail,
      row.id,
      GIFT_AUTH_STATUS.PENDING_GIFTER_APPROVAL,
      GIFT_AUTH_STATUS.AUTO_CANCELLED,
      {},
      "sweeper",
      `Gifter did not respond within the 30-min grace window`,
      { reservedAmountCents: row.reserved_amount_cents },
    );
    if (next) {
      if (!deps.dryRun) {
        await releaseWalletReservation(deps.retail, row.gifter_user_id, row.reserved_amount_cents);
        await deps.retail.from("notifications").insert({
          user_id: row.gifter_user_id,
          title: "Gift auto-cancelled",
          body: `We waited 30 minutes for your decision on an above-ceiling fill and didn't hear back. Your gift was cancelled and no charge was made.`,
          type: "system",
          payload: { action: "OPEN_GIFT_AUTHORIZATION", authorization_id: row.id, gift_event: "gift_auto_cancelled" },
        });
      }
      auto_cancelled += 1;
    }
  }
  if (auto_cancelled > 0) {
    console.info(JSON.stringify({ level: "info", event: "gift_auth_grace_sweep_completed", auto_cancelled }));
  }
  return { auto_cancelled };
}