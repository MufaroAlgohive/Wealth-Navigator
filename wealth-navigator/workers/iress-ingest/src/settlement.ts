/**
 * Fill settlement — push an executed IRESS order into the RETAIL database.
 *
 * Until this module existed, a filled order stamped `oems_order_audit` in the
 * INSTITUTIONAL database and stopped. The client's wallet was never debited and
 * no holding was ever created: order 700002 filled 1 FSR at R96,00 on
 * 2026-07-27 and the client's wallet still read R1 000,00 with no position.
 *
 * WHAT IT WRITES
 *
 *   BUY  → INSERT one new lot into `stock_holdings_c` + debit `wallets.balance`
 *   SELL → close lots FIFO (splitting the last one if needed) + credit balance
 *
 * A buy APPENDS a lot. It never rewrites an existing row's `avg_fill`, because
 * that column is the client's cost basis and is set in stone. `stock_holdings_c`
 * is already a lot ledger — multiple active rows per (user, security) are
 * normal, and `mint_account_pnl()` values it lot-by-lot — so appending is both
 * safe and the shape the rest of the system expects.
 *
 * IDEMPOTENCY
 *
 * The order poller re-reads every order every cycle (the OrderFilter deliberately
 * includes INACTIVE rows so final fills aren't missed), so "apply the fill"
 * runs repeatedly against the same filled order. `oems_fill_settlement_c` holds
 * `settled_qty` — the quantity already reflected in RETAIL — and this module
 * applies only `observed_filled - settled_qty`. Without it, a filled order
 * would re-debit the wallet every 30 seconds.
 *
 * The ledger is in the INSTITUTIONAL database and the money is in RETAIL, so no
 * transaction spans them. We CLAIM FIRST (advance settled_qty, then write
 * RETAIL, then confirm) and roll the claim back if the write fails. That biases
 * toward under-applying — a visible, correctable discrepancy — rather than
 * double-debiting a client, which is a real and silent loss. See the migration
 * header for the full argument.
 *
 * SAFETY POSTURE
 *
 *   RETAIL_SETTLEMENT_ENABLED   default OFF. Nothing runs unless set.
 *   RETAIL_SETTLEMENT_DRY_RUN   default ON.  Computes and logs the exact
 *                               deltas, writes nothing. This is how you see
 *                               what it would do to live client data first.
 */

import type { WorkerSupabase } from "./supabase";

/** A fill as observed on the audit row, already normalised out of the payload. */
export interface ObservedFill {
  orderId: string;
  userId: string;
  securityId: string | null;
  symbol: string | null;
  side: "buy" | "sell";
  /** Cumulative filled quantity reported by IRESS for this order. */
  filledQty: number;
  /** Volume-weighted average fill price in CENTS (raw IRESS unit). */
  avgFillCents: number;
  /** For the lot's `strategy_name_snapshot`. */
  strategy: string | null;
  /**
   * `stock_holdings_c.id` this order came from, when the lot ALREADY EXISTS.
   *
   * Present on every order raised by the MINT retail app: record-investment.js
   * debits the wallet and inserts the lot at PURCHASE time, before the order is
   * even parked (holding efd2ffae… was created 10:01:43, its order parked
   * 10:01:45). Absent on a desk-raised order, where no lot exists yet.
   *
   * This is the difference between creating a position and reconciling one, and
   * getting it wrong debits a client twice.
   */
  holdingId: string | null;
}

/** What a settlement would do, or did. Amounts in the units named. */
export interface SettlementPlan {
  orderId: string;
  userId: string;
  securityId: string | null;
  symbol: string | null;
  side: "buy" | "sell";
  /** Quantity already reflected in RETAIL before this run. */
  alreadySettledQty: number;
  /** Signed rands already moved for this order before this run (running total). */
  alreadySettledCash: number;
  /** Signed rands total after this run — what the ledger must record. */
  settledCashAfter: number;
  /** Quantity this run applies. Zero means nothing to do. */
  deltaQty: number;
  /** Order-wide volume-weighted average, CENTS. IRESS AvgPrc. */
  avgFillCents: number;
  /** Price of THIS slice's shares alone, CENTS. Equals avgFillCents on a full fill. */
  marginalFillCents: number;
  /** Signed rands: negative debits the wallet (buy), positive credits (sell). */
  cashDeltaRands: number;
  walletBefore: number | null;
  walletAfter: number | null;
  /** Primary key of the wallet the write targets. */
  walletId: string | null;
  /** Lots to create (buy) or close/split (sell). */
  lotsToOpen: Array<{ quantity: number; avgFillCents: number; unitMarkCents: number }>;
  lotsToClose: Array<{ id: string; quantity: number; splitRemainder: number }>;
  /**
   * OPEN      — no lot exists; create one and move the full cash. Desk orders.
   * RECONCILE — the MINT app already created the lot and already debited the
   *             wallet; only the actual fill price is missing. Creating a lot
   *             here would give the client two positions and two debits.
   * CLOSE     — a sell against existing lots.
   */
  mode: "open" | "reconcile" | "close";
  /** RECONCILE only: the lot to stamp the real fill price onto. */
  reconcileHoldingId: string | null;
  /**
   * RECONCILE only. Signed rands: what the app charged minus what it actually
   * cost. Positive means the client was overcharged. NOT moved automatically —
   * see the note in the reconcile branch.
   */
  cashVarianceRands: number | null;
  /** Non-null means the plan cannot be applied. */
  blocked: string | null;
}

export interface SettlementResult {
  plan: SettlementPlan;
  applied: boolean;
  dryRun: boolean;
  error: string | null;
}

export interface SettlementDeps {
  /** INSTITUTIONAL — holds `oems_fill_settlement_c`. */
  institutional: WorkerSupabase;
  /** RETAIL — holds `wallets` and `stock_holdings_c`. */
  retail: WorkerSupabase;
  enabled: boolean;
  dryRun: boolean;
}

interface LedgerRow {
  order_id: string;
  settled_qty: number;
  settled_cash_rands: number;
  holding_ids: unknown;
  last_error: string | null;
}

interface LotRow {
  id: string;
  quantity: number;
  avg_fill: number | null;
  created_at: string;
}

/** Round rands to cents. Money must never carry float dust into a balance. */
function toCents2(rands: number): number {
  return Math.round(rands * 100) / 100;
}

function todayIsoDate(): string {
  // SAST. The JSE trades in SAST and Fill_date is a trade date, not a UTC date;
  // a fill at 23:30 UTC+2 must not be stamped as the previous day.
  return new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/**
 * Work out exactly what settling this fill would do, without writing anything.
 * Exported so the dry-run reporter and the tests exercise the SAME code path
 * that the live worker uses — a plan you can inspect is worth more than a
 * comment promising the write is correct.
 */
export async function planSettlement(
  deps: Pick<SettlementDeps, "institutional" | "retail">,
  fill: ObservedFill,
): Promise<SettlementPlan> {
  const base: SettlementPlan = {
    orderId: fill.orderId,
    userId: fill.userId,
    securityId: fill.securityId,
    symbol: fill.symbol,
    side: fill.side,
    alreadySettledQty: 0,
    alreadySettledCash: 0,
    settledCashAfter: 0,
    deltaQty: 0,
    avgFillCents: fill.avgFillCents,
    marginalFillCents: fill.avgFillCents,
    cashDeltaRands: 0,
    walletBefore: null,
    walletAfter: null,
    walletId: null,
    lotsToOpen: [],
    lotsToClose: [],
    mode: fill.side === "sell" ? "close" : fill.holdingId ? "reconcile" : "open",
    reconcileHoldingId: null,
    cashVarianceRands: null,
    blocked: null,
  };

  if (!fill.userId) return { ...base, blocked: "no user_id on the order — cannot attribute the fill to a client" };
  if (!fill.securityId) return { ...base, blocked: "no security_id on the order — cannot write a holding" };
  if (!(fill.filledQty > 0)) return { ...base, blocked: null }; // nothing filled yet, not an error
  if (!(fill.avgFillCents > 0)) {
    return { ...base, blocked: "filled quantity reported with no average price — refusing to guess a cost basis" };
  }

  const { data: ledger, error: ledgerErr } = await deps.institutional
    .from("oems_fill_settlement_c")
    .select("order_id, settled_qty, settled_cash_rands, holding_ids, last_error")
    .eq("order_id", fill.orderId)
    .maybeSingle();
  if (ledgerErr) return { ...base, blocked: `settlement ledger read failed: ${ledgerErr.message}` };

  const alreadySettledQty = Number((ledger as LedgerRow | null)?.settled_qty ?? 0);
  /* Running SIGNED total of cash already moved for this order, in rands.
     Negative = debited (buy). This is a running total, not the last delta —
     the whole correctness argument below depends on that. */
  const alreadySettledCash = Number((ledger as LedgerRow | null)?.settled_cash_rands ?? 0);
  const deltaQty = fill.filledQty - alreadySettledQty;
  if (deltaQty <= 0) return { ...base, alreadySettledQty, deltaQty: 0 };

  /* AvgPrc is the volume-weighted average over the WHOLE order, and it is the
     authoritative price. Andre Pietersen (IRESS), 2026-07-27: on a full fill it
     equals the trade price; on partials it is what the order traded for on
     average — "the field you're going to want to use". Juan's rule follows from
     it: a client is measured on their average fill, not on individual entries.

     So the invariant is TOTAL, not per-slice:

         total cash moved  ==  filledQty * avgPx

     Settle the difference between where the order SHOULD be and where we have
     already taken it. An earlier version of this priced each slice at the
     running average and claimed that self-corrects. It does not:

         slice 1:  40 filled, avg 100  ->  40 * 100 = 4 000
         slice 2: 100 filled, avg 110  ->  60 * 110 = 6 600
         total 10 600, against a true 100 * 110 = 11 000

     R4 of the client's money adrift on a single two-slice order, and it grows
     with every slice. Deriving the delta from the total makes that error
     structurally impossible rather than merely unlikely. */
  const targetTotalMagnitude = toCents2((fill.filledQty * fill.avgFillCents) / 100);
  const targetSigned = fill.side === "buy" ? -targetTotalMagnitude : targetTotalMagnitude;
  const cashDeltaRands = toCents2(targetSigned - alreadySettledCash);

  /* The average price of just the shares that arrived in THIS slice, backed out
     of the running average. On the example above: (11 000 - 4 000) / 60 =
     116,67 — what those 60 shares actually cost, not the 110 order-wide figure.
     On a first or single fill this is exactly avgPx, so a full fill behaves
     identically to before. Lots are priced at this, so the lot ledger sums back
     to filledQty * avgPx and the client's cost basis is right. */
  const marginalFillCents =
    deltaQty > 0 ? Math.round((Math.abs(cashDeltaRands) * 100) / deltaQty) : fill.avgFillCents;

  /* `wallets` is unique on (user_id, status), not on user_id — a user can hold
     an 'active' AND a 'test' wallet. A bare .maybeSingle() on user_id throws for
     such a user, which would block their settlement permanently, and the UPDATE
     below keyed on (user_id, balance) could match BOTH rows and write the wrong
     one. Take the 'active' wallet explicitly (it sorts before 'test'), one row,
     and carry its id so the write targets a primary key rather than a filter. */
  const { data: wallets, error: walletErr } = await deps.retail
    .from("wallets")
    .select("id, balance, status")
    .eq("user_id", fill.userId)
    .order("status", { ascending: true })
    .limit(2);
  if (walletErr) return { ...base, alreadySettledQty, deltaQty, blocked: `wallet read failed: ${walletErr.message}` };
  const walletRows = (wallets ?? []) as Array<{ id: string; balance: number; status: string }>;
  const wallet = walletRows.find((w) => w.status === "active") ?? walletRows[0];
  if (!wallet) {
    return { ...base, alreadySettledQty, deltaQty, blocked: `no wallet for user ${fill.userId}` };
  }
  const walletId = wallet.id;
  const walletBefore = Number(wallet.balance) || 0;
  const walletAfter = toCents2(walletBefore + cashDeltaRands);

  const plan: SettlementPlan = {
    ...base,
    alreadySettledQty,
    alreadySettledCash,
    settledCashAfter: toCents2(targetSigned),
    deltaQty,
    marginalFillCents,
    cashDeltaRands,
    walletBefore,
    walletAfter,
    walletId,
  };

  if (fill.side === "buy" && fill.holdingId) {
    /* RECONCILE. The MINT app already booked this position and already took the
       client's cash — record-investment.js inserts the lot and debits the wallet
       at purchase time, seconds BEFORE the order is parked. All that is missing
       is what it actually filled at: holding efd2ffae… still reads
       avg_fill = null, Expected_fill = 1024.89.

       So stamp the real fill price. Do NOT insert a lot and do NOT debit — that
       would leave the client holding two positions and paying twice.

       The cash variance (charged minus actual) is COMPUTED and reported but not
       moved. We know what the app charged as an Expected_fill, but not with
       certainty that it equals what was actually taken from the wallet, and a
       wrong automatic adjustment on a live balance is worse than a visible
       variance a human settles. Wire the movement once that is confirmed. */
    const { data: lot, error: lotErr } = await deps.retail
      .from("stock_holdings_c")
      .select('id, quantity, "Expected_fill"')
      .eq("id", fill.holdingId)
      .maybeSingle();
    if (lotErr) return { ...plan, blocked: `reconcile lot read failed: ${lotErr.message}` };
    if (!lot) return { ...plan, blocked: `order names holding ${fill.holdingId}, which does not exist` };
    const row = lot as { id: string; quantity: number; Expected_fill: number | null };
    const chargedRands = Number(row.Expected_fill) > 0 ? Number(row.Expected_fill) * (Number(row.quantity) || 0) : null;
    const actualRands = toCents2((fill.filledQty * fill.avgFillCents) / 100);
    return {
      ...plan,
      mode: "reconcile",
      reconcileHoldingId: row.id,
      // No wallet movement in this mode.
      cashDeltaRands: 0,
      walletAfter: walletBefore,
      cashVarianceRands: chargedRands != null ? toCents2(chargedRands - actualRands) : null,
    };
  }

  if (fill.side === "buy") {
    // Mark the new lot at the live price so it shows a real value the moment it
    // appears, rather than sitting at R0,00 until some later valuation pass.
    // Falls back to the fill price, which at t=0 is the honest mark anyway.
    const { data: sec } = await deps.retail
      .from("securities_c")
      .select("last_price")
      .eq("id", fill.securityId)
      .maybeSingle();
    const markCents = Number((sec as { last_price: number } | null)?.last_price);
    const unitMarkCents = Number.isFinite(markCents) && markCents > 0 ? markCents : fill.avgFillCents;

    // A buy never touches an existing lot. One fill slice, one new lot.
    //
    // The wallet is allowed to go negative here and we do NOT block on it. The
    // money already left the client's account at the broker — the trade is
    // done. Refusing to record it would not undo the trade, it would just hide
    // it, leaving the wallet overstated and the position invisible. Preventing
    // an unaffordable buy is the pre-trade guard's job, upstream of the market.
    // Settlement records reality.
    return {
      ...plan,
      lotsToOpen: [{ quantity: deltaQty, avgFillCents: marginalFillCents, unitMarkCents }],
    };
  }

  // SELL — close active lots FIFO for this (user, security).
  /* Scoped to the ACCOUNT HOLDER'S OWN lots.
     
     A minor's holdings live under the PARENT's user_id, distinguished only by
     family_member_id. Live data: user b215eb9a… holds both own and child lots on
     six securities, with identical created_at values on some pairs. Without the
     family_member_id filter a parent's sell FIFOs straight into a child's shares
     and credits the parent's wallet — liquidating a minor's assets to pay an
     adult. The OEMS order payload cannot express a family member at all, so the
     only honest scope is the holder's own lots; a family-member sale has to come
     through a path that knows whose it is.
     
     created_at alone is not a deterministic sort — the ties above are real — so
     id breaks them, making FIFO reproducible and the realised cost basis stable. */
  const { data: lots, error: lotErr } = await deps.retail
    .from("stock_holdings_c")
    .select("id, quantity, avg_fill, created_at")
    .eq("user_id", fill.userId)
    .eq("security_id", fill.securityId)
    .eq("is_active", true)
    .is("family_member_id", null)
    .order("created_at", { ascending: true })
    .order("id", { ascending: true });
  if (lotErr) return { ...plan, blocked: `holdings read failed: ${lotErr.message}` };

  let remaining = deltaQty;
  const lotsToClose: SettlementPlan["lotsToClose"] = [];
  for (const lot of (lots ?? []) as LotRow[]) {
    if (remaining <= 0) break;
    const lotQty = Number(lot.quantity) || 0;
    if (lotQty <= 0) continue;
    const take = Math.min(lotQty, remaining);
    lotsToClose.push({ id: lot.id, quantity: take, splitRemainder: lotQty - take });
    remaining -= take;
  }
  if (remaining > 0) {
    // Selling more than the client holds. The pre-trade guard exists to stop
    // this reaching the market; if it got here anyway, record what we can and
    // shout, rather than silently inventing a negative position.
    return {
      ...plan,
      lotsToClose,
      blocked: `sold ${deltaQty} but only ${deltaQty - remaining} held in active lots — ${remaining} unaccounted`,
    };
  }
  return { ...plan, lotsToClose };
}

/**
 * Apply a fill to RETAIL. Safe to call repeatedly with the same fill: the
 * second call plans a zero delta and returns without writing.
 */
export async function settleFill(deps: SettlementDeps, fill: ObservedFill): Promise<SettlementResult> {
  const plan = await planSettlement(deps, fill);
  const noop: SettlementResult = { plan, applied: false, dryRun: deps.dryRun, error: plan.blocked };

  if (!deps.enabled) return { ...noop, error: null };
  if (plan.blocked) {
    console.error(
      JSON.stringify({ level: "error", event: "settlement_blocked", order: fill.orderId, reason: plan.blocked }),
    );
    return noop;
  }
  if (plan.deltaQty <= 0) return { ...noop, error: null };

  if (deps.dryRun) {
    console.info(
      JSON.stringify({
        level: "info",
        event: "settlement_dry_run",
        order: plan.orderId,
        side: plan.side,
        symbol: plan.symbol,
        deltaQty: plan.deltaQty,
        avgFillRands: plan.avgFillCents / 100,
        sliceFillRands: plan.marginalFillCents / 100,
        cashDeltaRands: plan.cashDeltaRands,
        walletBefore: plan.walletBefore,
        walletAfter: plan.walletAfter,
        lotsToOpen: plan.lotsToOpen.length,
        lotsToClose: plan.lotsToClose.length,
      }),
    );
    return { plan, applied: false, dryRun: true, error: null };
  }

  // ---- CLAIM. Advance the ledger BEFORE touching money. -------------------
  const claimedQty = plan.alreadySettledQty + plan.deltaQty;
  const { error: claimErr } = await deps.institutional.from("oems_fill_settlement_c").upsert(
    {
      order_id: plan.orderId,
      user_id: plan.userId,
      security_id: plan.securityId,
      symbol: plan.symbol,
      side: plan.side,
      settled_qty: claimedQty,
      // RUNNING TOTAL, not this slice's delta. planSettlement subtracts this
      // from filledQty * avgPx to get the next delta, so recording a delta here
      // would make every partial fill after the first mis-price itself.
      settled_cash_rands: plan.settledCashAfter,
      last_error: "claim in flight",
      last_settled_at: new Date().toISOString(),
    },
    { onConflict: "order_id" },
  );
  if (claimErr) {
    // Could not claim → do not touch money. Nothing has changed anywhere.
    return { plan, applied: false, dryRun: false, error: `settlement claim failed: ${claimErr.message}` };
  }

  // ---- APPLY to RETAIL. ----------------------------------------------------
  const touchedHoldingIds: string[] = [];
  const nowIso = new Date().toISOString();
  const fillDate = todayIsoDate();
  /* Set the instant ANY row in RETAIL is written. Load-bearing — see abort(). */
  let retailMutated = false;
  /* Quantity whose RETAIL side actually landed. On a multi-lot sell that fails
     halfway, this is what the ledger must record so the next cycle settles only
     the remainder instead of re-closing lots that are already closed. */
  let appliedQty = 0;

  /* ABORT — the failure path, and the one I originally got wrong.
     
     The migration header argues that claim-first "biases toward under-applying,
     which is visible and correctable, rather than double-debiting". That is only
     true while RETAIL is still untouched. The first version of this un-claimed
     the ledger unconditionally, INCLUDING after a lot had already been inserted
     — which silently converts claim-first into apply-then-record, the exact mode
     the header argues against:
     
       cycle 1: claim qty 1 -> INSERT lot -> wallet write loses the optimistic
                race -> un-claim to qty 0. The lot stays.
       cycle 2: settled_qty is 0 again, so the full delta re-plans and inserts a
                SECOND lot. And a third. Once per poll, forever.
     
     On a sell it is worse: lots are closed in place, so un-claiming leaves shares
     marked sold with no cash credited, and the next cycle cannot find enough
     active quantity and blocks the order permanently.
     
     So: once RETAIL has been touched, the claim STANDS, recording exactly the
     quantity that landed. That genuinely is under-applying — the discrepancy sits
     in last_error for a human — and it is the only version of this that cannot
     double-apply. Un-claiming is safe only when nothing was written. */
  const abort = async (reason: string): Promise<SettlementResult> => {
    await deps.institutional
      .from("oems_fill_settlement_c")
      .update(
        retailMutated
          ? {
              settled_qty: plan.alreadySettledQty + appliedQty,
              settled_cash_rands: plan.alreadySettledCash,
              last_error: `PARTIALLY APPLIED (${appliedQty} of ${plan.deltaQty} landed in RETAIL, cash NOT moved): ${reason}`,
            }
          : {
              settled_qty: plan.alreadySettledQty,
              settled_cash_rands: plan.alreadySettledCash,
              last_error: reason,
            },
      )
      .eq("order_id", plan.orderId);
    console.error(
      JSON.stringify({
        level: "error",
        event: "settlement_failed",
        order: plan.orderId,
        retailMutated,
        appliedQty,
        reason,
      }),
    );
    return { plan, applied: false, dryRun: false, error: reason };
  };

  if (plan.mode === "reconcile") {
    /* Stamp the real fill onto the lot the MINT app already created. No insert,
       no wallet write — both already happened at purchase time. */
    const markCents = plan.marginalFillCents;
    const { error: recErr } = await deps.retail
      .from("stock_holdings_c")
      .update({
        avg_fill: markCents, // CENTS — was null until the fill came back
        Fill_date: fillDate,
        fill_set_by: `iress-settlement:${plan.orderId}`,
        fill_set_at: nowIso,
        updated_at: nowIso,
      })
      .eq("id", plan.reconcileHoldingId);
    if (recErr) return abort(`reconcile update failed: ${recErr.message}`);
    retailMutated = true;
    appliedQty = plan.deltaQty;
    if (plan.reconcileHoldingId) touchedHoldingIds.push(plan.reconcileHoldingId);
    if (plan.cashVarianceRands != null && Math.abs(plan.cashVarianceRands) >= 0.01) {
      /* Deliberately NOT moved. Loud so it cannot be missed. */
      console.warn(
        JSON.stringify({
          level: "warn",
          event: "settlement_cash_variance_unsettled",
          order: plan.orderId,
          holding: plan.reconcileHoldingId,
          chargedMinusActualRands: plan.cashVarianceRands,
          note: "App charged an estimate; the fill differed. Cash NOT adjusted automatically.",
        }),
      );
    }
  } else if (plan.side === "buy") {
    const newLot = plan.lotsToOpen[0];
    if (!newLot) return abort("buy plan produced no lot to open");
    const { data: inserted, error: insErr } = await deps.retail
      .from("stock_holdings_c")
      .insert({
        user_id: plan.userId,
        security_id: plan.securityId,
        quantity: plan.deltaQty,
        avg_fill: newLot.avgFillCents, // CENTS — this slice's price, not the order-wide average
        /* Expected_fill is RANDS, NOT cents — confirmed against every rendering
           lot in the live table (GLPROP avg_fill 5086 / Expected_fill 50.86,
           ADR 650 / 6.5, AME 5500 / 55). The two columns sit next to each other
           holding the same price in different units, which is exactly how a
           100x gets written. Same basis as avg_fill: a direct broker fill
           carries no desk markup. */
        Expected_fill: newLot.avgFillCents / 100, // RANDS
        /* market_value is CENTS (GLPROP: 3 lots x ~5272c = 15816). Marked at the
           live price so the holding shows a real figure the instant it appears
           instead of R0,00. */
        market_value: newLot.unitMarkCents * plan.deltaQty,
        side: "buy",
        trade_side: "BUY",
        is_active: true,
        Status: "active",
        Fill_date: fillDate,
        strategy_name_snapshot: fill.strategy,
        fill_set_by: `iress-settlement:${plan.orderId}`,
        fill_set_at: nowIso,
      })
      .select("id");
    if (insErr) return abort(`holding insert failed: ${insErr.message}`);
    retailMutated = true;
    appliedQty = plan.deltaQty;
    for (const r of (inserted ?? []) as Array<{ id: string }>) touchedHoldingIds.push(r.id);
  } else {
    for (const lot of plan.lotsToClose) {
      if (lot.splitRemainder > 0) {
        // Partial sell of a lot: shrink the open lot, then book the sold slice
        // as its own closed lot. Splitting rather than part-closing keeps one
        // row = one round trip, which is what mint_account_pnl() assumes when
        // it pairs avg_fill against avg_exit.
        const { data: openLot, error: readErr } = await deps.retail
          .from("stock_holdings_c")
          .select('id, quantity, avg_fill, strategy_name_snapshot, strategy_id, family_member_id, "Fill_date", transaction_id')
          .eq("id", lot.id)
          .maybeSingle();
        if (readErr || !openLot) return abort(`lot ${lot.id} read failed: ${readErr?.message ?? "not found"}`);
        const src = openLot as {
          avg_fill: number | null;
          strategy_name_snapshot: string | null;
          strategy_id: string | null;
          family_member_id: string | null;
          Fill_date: string | null;
          transaction_id: string | null;
        };
        const { error: shrinkErr } = await deps.retail
          .from("stock_holdings_c")
          .update({ quantity: lot.splitRemainder, updated_at: nowIso })
          .eq("id", lot.id);
        if (shrinkErr) return abort(`lot ${lot.id} shrink failed: ${shrinkErr.message}`);
        retailMutated = true;
        const { data: closedLot, error: closeInsErr } = await deps.retail
          .from("stock_holdings_c")
          .insert({
            user_id: plan.userId,
            security_id: plan.securityId,
            quantity: lot.quantity,
            avg_fill: src.avg_fill, // carry the ORIGINAL cost basis, untouched
            avg_exit: plan.marginalFillCents, // CENTS — this slice's exit price
            side: "sell",
            trade_side: "SELL",
            is_active: false,
            Status: "closed",
            Exit_date: fillDate,
            closed_at: nowIso,
            closed_reason: `iress-settlement:${plan.orderId}`,
            strategy_name_snapshot: src.strategy_name_snapshot,
            strategy_id: src.strategy_id,
            /* Attribution must survive the split or mint_account_pnl() moves the
               realised P&L to a different account, and back-dates the entry to
               the exit date. The full-close branch is an UPDATE and keeps these
               for free; only the split re-creates a row. */
            family_member_id: src.family_member_id,
            Fill_date: src.Fill_date,
            transaction_id: src.transaction_id,
          })
          .select("id");
        if (closeInsErr) {
          /* The shrink already landed, so the sold slice currently exists
             NOWHERE — it is neither in the open lot nor in a closed one. Say so
             explicitly; a silent "insert failed" would read as a no-op. */
          return abort(
            `split lot insert failed after the open lot was already shrunk to ${lot.splitRemainder} — ` +
              `${lot.quantity} share(s) are unaccounted on holding ${lot.id}: ${closeInsErr.message}`,
          );
        }
        retailMutated = true;
        appliedQty += lot.quantity;
        for (const r of (closedLot ?? []) as Array<{ id: string }>) touchedHoldingIds.push(r.id);
      } else {
        const { error: closeErr } = await deps.retail
          .from("stock_holdings_c")
          .update({
            is_active: false,
            Status: "closed",
            avg_exit: plan.marginalFillCents, // CENTS — this slice's exit price
            Exit_date: fillDate,
            closed_at: nowIso,
            closed_reason: `iress-settlement:${plan.orderId}`,
            updated_at: nowIso,
          })
          .eq("id", lot.id);
        if (closeErr) return abort(`lot ${lot.id} close failed: ${closeErr.message}`);
        retailMutated = true;
        appliedQty += lot.quantity;
        touchedHoldingIds.push(lot.id);
      }
    }
  }

  // Wallet last: if it fails, the rollback path leaves the position recorded and
  // the cash untouched, which an operator can see and fix. Optimistic
  // concurrency on the balance we planned against — if another writer moved it
  // between the plan and now, we must not clobber their write.
  /* RECONCILE moves no cash — the app already took it. Confirm and return. */
  if (plan.mode === "reconcile") {
    await deps.institutional
      .from("oems_fill_settlement_c")
      .update({
        last_error: null,
        holding_ids: touchedHoldingIds,
        settled_qty: plan.alreadySettledQty + appliedQty,
        settled_cash_rands: 0, // no cash moved by settlement on this path
        last_settled_at: nowIso,
      })
      .eq("order_id", plan.orderId);
    console.info(
      JSON.stringify({
        level: "info",
        event: "settlement_reconciled",
        order: plan.orderId,
        holding: plan.reconcileHoldingId,
        qty: plan.deltaQty,
        avgFillRands: plan.marginalFillCents / 100,
        cashVarianceRands: plan.cashVarianceRands,
      }),
    );
    return { plan, applied: true, dryRun: false, error: null };
  }

  const { data: moved, error: walletErr } = await deps.retail
    .from("wallets")
    .update({ balance: plan.walletAfter, updated_at: nowIso })
    // Primary key, not user_id — a user can have two wallet rows.
    .eq("id", plan.walletId)
    // Optimistic concurrency: refuse if anything moved the balance since we planned.
    .eq("balance", plan.walletBefore)
    .select("id");
  if (walletErr) return abort(`wallet update failed: ${walletErr.message}`);
  if (!moved || moved.length === 0) {
    return abort("wallet balance changed between plan and apply — retrying next cycle");
  }

  // ---- CONFIRM. -----------------------------------------------------------
  await deps.institutional
    .from("oems_fill_settlement_c")
    .update({
      last_error: null,
      holding_ids: touchedHoldingIds,
      settled_qty: plan.alreadySettledQty + appliedQty,
      settled_cash_rands: plan.settledCashAfter,
      last_settled_at: nowIso,
    })
    .eq("order_id", plan.orderId);

  console.info(
    JSON.stringify({
      level: "info",
      event: "settlement_applied",
      order: plan.orderId,
      side: plan.side,
      symbol: plan.symbol,
      qty: plan.deltaQty,
      avgFillRands: plan.avgFillCents / 100,
      cashDeltaRands: plan.cashDeltaRands,
      walletBefore: plan.walletBefore,
      walletAfter: plan.walletAfter,
      holdings: touchedHoldingIds,
    }),
  );
  return { plan, applied: true, dryRun: false, error: null };
}

/**
 * Pull the fields settlement needs off an audit row. Returns null when the row
 * is not a settleable execution — which is most rows, most of the time.
 */
export function observedFillFromAudit(row: {
  order_id: string;
  symbol: string | null;
  side: string | null;
  status: string;
  payload: Record<string, unknown> | null;
}): ObservedFill | null {
  if (row.status !== "filled" && row.status !== "partial") return null;
  const p = row.payload ?? {};
  const userId = typeof p.user_id === "string" ? p.user_id : "";
  const securityId = typeof p.security_id === "string" ? p.security_id : null;
  const filledQty = Number(p.filled);
  const avgFillCents = Number(p.avgPx); // CENTS — see the unit contract in order-poller.ts
  if (!userId) return null; // a desk/omnibus order with no client attribution
  if (!Number.isFinite(filledQty) || filledQty <= 0) return null;
  if (!Number.isFinite(avgFillCents) || avgFillCents <= 0) return null;
  return {
    orderId: row.order_id,
    userId,
    securityId,
    symbol: row.symbol,
    side: (row.side ?? "buy").toLowerCase() === "sell" ? "sell" : "buy",
    filledQty,
    avgFillCents,
    strategy: typeof p.strategy === "string" ? p.strategy : null,
    holdingId: typeof p.holding_id === "string" ? p.holding_id : null,
  };
}
