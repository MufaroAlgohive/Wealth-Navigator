import type { SupabaseClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";

import { getAdminContext } from "@/lib/admin/rbac";
import { isSupabaseSchemaMissing } from "@/lib/bff-reasons";
import { reconcileBufferDrawdowns } from "@/lib/orderbook/reconcile-buffer-drawdowns";
import { maybeCompleteRebalance } from "@/lib/rebalance/complete-rebalance";
import { settleRebalanceCashForClients } from "@/lib/rebalance/settle-rebalance-cash";
import { createInstitutionalServiceRoleClient, createRetailServiceRoleClient } from "@/lib/supabase/server";
import { observedFillFromAudit, settleFill } from "@workers/iress-ingest/src/settlement";

/**
 * POST /api/admin/orderbook/fills
 *
 * Mint OEM Phase B3 — automated fill ingest (mock endpoint). Accepts a
 * broker-style fill report keyed by order_id (a single book has many
 * order_ids — one per ISIN). For each fill:
 *   - updates `payload.filled` to the cumulative qty
 *   - updates `payload.avgPx` and `result_payload.avgFillPrice`
 *   - flips `status` to 'filled' when filled >= quantity, otherwise 'partial'
 *   - sets `status='rejected'` with a result_payload.rejectReason if qty <= 0
 *   - when all execution rows for the book are 'filled', the response
 *     advertises `book_ready_for_confirmation: true` so the UI can enable
 *     the Send Confirmation button.
 *   - when a row lands on 'filled' AND its payload is tagged uat_test=true
 *     (see client-order/route.ts), best-effort auto-settles it. Never
 *     touches a live order — the uat_test tag gates it, AND both settlement
 *     paths independently check that every targeted holding actually belongs
 *     to a verified test account.
 *   - a BUY fill (settleUatFill) settles entirely in this repo: it stamps
 *     avg_fill/Fill_date (with server-side attribution), writes the order's
 *     own `quantity` onto the referenced `stock_holdings_c` row, and
 *     reconciles the 8% execution-reserve ledger. This used to POST to
 *     MyMintAdmin's update-price endpoint — the OEM's last runtime dependency
 *     on the CRM, removed so buy fills survive the CRM's retirement.
 *   - a SELL fill (settleUatSellFill) goes through the SAME settlement
 *     engine used for real IRESS fills (workers/iress-ingest/src/settlement.ts
 *     `settleFill`). CRM's sell-settlement
 *     always fully closes whatever holding_id the order names — for an
 *     ordinary sell that's correct, but a rebalance-driven PARTIAL sell (sell
 *     5 of 10) references the client's ORIGINAL, still-larger lot, and a full
 *     close there would wipe out shares nobody intended to sell. The real
 *     engine FIFOs the client's actual active lots for that security and
 *     splits a partial correctly (shrinks the original, closes a separate
 *     lot for just the sold quantity, preserves the original cost basis) —
 *     it doesn't trust holding_id's specific row for sizing, only for
 *     scoping which owner's lots to touch.
 *   - for a BUY fill, also writes the order's own `quantity` directly onto
 *     the referenced `stock_holdings_c` row (RETAIL, same repo — no CRM
 *     round-trip needed for this one field). This is a no-op for an ordinary
 *     order (quantity was already correct at park time) but is exactly what
 *     makes a rebalance-driven order's holding become real at the right
 *     moment: reconcile-parked-holdings.ts / book-settled-rebalance-orders.ts
 *     deliberately leave `stock_holdings_c.quantity` untouched (0 or stale)
 *     until this fill lands, so a client's numbers never move ahead of an
 *     order that hasn't actually filled yet.
 *   - if the filled row carries `payload.rebalance_request_id`, checks
 *     whether every order booked for that rebalance has now finished
 *     (filled/cancelled/rejected) and, if so, flips the strategy's own
 *     canonical model composition (`strategies_c.holdings`) to the approved
 *     target — see maybeCompleteRebalance.
 *
 * Body: { order_id: string, fills: Array<{ symbol, qty, avg_fill_price_cents, timestamp }> }
 */

export const dynamic = "force-dynamic";

interface FillEntry {
  symbol: string;
  qty: number;
  avg_fill_price_cents: number;
  timestamp?: string;
}

interface AuditRow {
  id: string;
  order_id: string;
  symbol: string;
  quantity: number;
  status: string;
  side: string | null;
  payload: Record<string, unknown>;
  result_payload: Record<string, unknown>;
}

interface UatSettlementResult {
  audit_id: string;
  attempted: boolean;
  ok: boolean;
  error?: string;
}

/**
 * Settle a UAT BUY self-fill: stamp the fill price on the holding, reconcile
 * the execution-reserve ledger, and make the order's quantity real.
 *
 * This used to POST to MyMintAdmin's `api/orderbook/update-price`, which was
 * the OEM's last runtime dependency on the CRM — with the CRM being retired,
 * a buy fill would simply have stopped working. The three things that
 * endpoint did for this path now happen here: the test-account ownership
 * guard, the fill-price write (with server-side `fill_set_by`/`fill_set_at`
 * attribution), and reconcileBufferDrawdowns.
 *
 * SELL fills do NOT go through here — see settleUatSellFill.
 *
 * Never throws: a settlement failure must not fail the fill itself, but IS
 * surfaced in the response (never silently swallowed).
 */
async function settleUatFill(
  row: AuditRow,
  fillPriceCents: number,
  retailDb: SupabaseClient,
  actorEmail: string,
): Promise<UatSettlementResult> {
  const payload = row.payload ?? {};
  const uatTest = payload.uat_test === true;
  const holdingId = typeof payload.holding_id === "string" ? payload.holding_id : "";
  if (!uatTest || !holdingId) {
    return { audit_id: row.id, attempted: false, ok: false };
  }

  try {
    // The guard that actually protected live data when this ran server-to-server
    // against the CRM: refuse outright unless the holding belongs to a verified
    // test account. Kept here now that there is no remote endpoint to enforce it.
    const ownerRes = await retailDb
      .from("stock_holdings_c")
      .select("user_id")
      .eq("id", holdingId)
      .maybeSingle();
    const userId = (ownerRes.data?.user_id as string | undefined) ?? "";
    if (!userId) {
      return { audit_id: row.id, attempted: true, ok: false, error: "holding not found" };
    }
    const [{ data: profile }, { data: testWallets }] = await Promise.all([
      retailDb.from("profiles").select("is_test").eq("id", userId).maybeSingle(),
      retailDb.from("wallets").select("user_id").eq("user_id", userId).eq("status", "test").limit(1),
    ]);
    const isVerifiedTestAccount = profile?.is_test === true || (testWallets ?? []).length > 0;
    if (!isVerifiedTestAccount) {
      return {
        audit_id: row.id,
        attempted: true,
        ok: false,
        error: "refusing to self-settle: holding does not belong to a verified test account",
      };
    }

    const updRes = await retailDb
      .from("stock_holdings_c")
      .update({
        avg_fill: fillPriceCents,
        Fill_date: new Date().toISOString().slice(0, 10),
        fill_set_by: actorEmail,
        fill_set_at: new Date().toISOString(),
        // The order's own quantity is what actually becomes real at fill
        // time — see the file docstring.
        quantity: row.quantity,
        is_active: true,
      })
      .eq("id", holdingId)
      .select("id");
    if (updRes.error) {
      return { audit_id: row.id, attempted: true, ok: false, error: updRes.error.message };
    }
    if ((updRes.data ?? []).length === 0) {
      return { audit_id: row.id, attempted: true, ok: false, error: "no rows were updated" };
    }

    // Slippage above the quoted price is absorbed by the 8% execution reserve.
    // Reported rather than swallowed, but never fatal: the fill itself landed.
    const buffer = await reconcileBufferDrawdowns(retailDb, [holdingId]);
    if (buffer.errors.length > 0) {
      return {
        audit_id: row.id,
        attempted: true,
        ok: true,
        error: `filled, but buffer reconcile reported: ${buffer.errors.join("; ")}`,
      };
    }
    return { audit_id: row.id, attempted: true, ok: true };
  } catch (e) {
    return {
      audit_id: row.id,
      attempted: true,
      ok: false,
      error: e instanceof Error ? e.message : "settlement failed",
    };
  }
}

/**
 * A UAT SELL self-fill goes through the REAL settlement engine
 * (workers/iress-ingest/src/settlement.ts `settleFill`) instead of CRM's
 * update-price endpoint — see this file's doc comment for exactly why (CRM's
 * sell path fully closes whatever holding_id names, which is wrong for a
 * PARTIAL rebalance sell). That engine correctly FIFOs the client's actual
 * active lots and splits a partial sell, crediting the wallet with the real
 * proceeds — this is a genuine settlement, not a mock.
 *
 * Independently re-verifies the order belongs to a test account before
 * calling it — CRM's endpoint used to be the thing standing between a
 * spoofed/stale uat_test tag and a real client's money; now that we bypass
 * CRM for this path, this check has to stand in for that guarantee itself.
 */
async function settleUatSellFill(
  row: AuditRow,
  retailDb: SupabaseClient,
  institutionalDb: SupabaseClient,
  updatedPayload: Record<string, unknown>,
): Promise<UatSettlementResult> {
  const payload = row.payload ?? {};
  const uatTest = payload.uat_test === true;
  const holdingId = typeof payload.holding_id === "string" ? payload.holding_id : "";
  const userId = typeof payload.user_id === "string" ? payload.user_id : "";
  if (!uatTest || !holdingId || !userId) {
    return { audit_id: row.id, attempted: false, ok: false };
  }

  const [{ data: profile }, { data: testWallets }] = await Promise.all([
    retailDb.from("profiles").select("is_test").eq("id", userId).maybeSingle(),
    retailDb.from("wallets").select("user_id").eq("user_id", userId).eq("status", "test").limit(1),
  ]);
  const isVerifiedTestAccount = profile?.is_test === true || (testWallets ?? []).length > 0;
  if (!isVerifiedTestAccount) {
    return {
      audit_id: row.id,
      attempted: true,
      ok: false,
      error: `refusing: user ${userId} is not a verified test account`,
    };
  }

  const fill = observedFillFromAudit({
    order_id: row.order_id,
    symbol: row.symbol,
    side: "sell",
    status: "filled",
    quantity: row.quantity,
    payload: updatedPayload,
  });
  if (!fill) {
    return {
      audit_id: row.id,
      attempted: true,
      ok: false,
      error: "could not derive a settleable fill from this order",
    };
  }
  // A rebalance sell's proceeds fund the rebalance's own buys — it's an
  // internal swap, not a withdrawal. The wallet must not be credited
  // directly here; settleRebalanceCashForClients (called once the whole
  // rebalance is done) applies the real proceeds bridge instead — fees drawn
  // from the 8% execution reserve, any genuine leftover becoming residual
  // cash. Only the lot mechanics (FIFO close/split, cost basis) run here.
  if (typeof payload.rebalance_request_id === "string" && payload.rebalance_request_id) {
    fill.skipCashMovement = true;
  }

  try {
    const result = await settleFill(
      { institutional: institutionalDb, retail: retailDb, enabled: true, dryRun: false },
      fill,
    );
    if (!result.applied) {
      return {
        audit_id: row.id,
        attempted: true,
        ok: false,
        error: result.error ?? "settlement did not apply",
      };
    }
    return { audit_id: row.id, attempted: true, ok: true };
  } catch (e) {
    return {
      audit_id: row.id,
      attempted: true,
      ok: false,
      error: e instanceof Error ? e.message : "settlement failed",
    };
  }
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

export async function POST(req: Request) {
  const auth = await getAdminContext();
  if (auth.status === "no-session") {
    return NextResponse.json({ ok: false, error: "no-session" }, { status: 401 });
  }
  if (auth.status !== "ok") {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const orderId = typeof body.order_id === "string" ? body.order_id.trim() : "";
  const fills = Array.isArray(body.fills) ? (body.fills as FillEntry[]) : [];

  if (!orderId) return NextResponse.json({ ok: false, error: "order_id is required" }, { status: 400 });
  if (fills.length === 0)
    return NextResponse.json({ ok: false, error: "fills array is required" }, { status: 400 });

  const db = openInstitutional();
  if (!db) {
    return NextResponse.json({ ok: false, error: "INSTITUTIONAL database not configured" }, { status: 503 });
  }

  // Scope to this order/book AT THE DB LEVEL so the 500-row window covers the
  // relevant rows, not the newest 500 across ALL books (which dropped rows on a
  // busy shared audit table — same class as the execution-route vanish fix). The
  // JS filter downstream stays as defense-in-depth. PostgREST filters jsonb via
  // the ->> text accessor.
  const oid = orderId.replace(/[\\"]/g, "");
  const bookLookup = await db
    .from("oems_order_audit")
    .select("id, order_id, symbol, quantity, status, side, payload, result_payload")
    .or(`order_id.eq."${oid}",payload->>book_id.eq."${oid}",payload->>strategy.eq."${oid}"`)
    .order("updated_at", { ascending: false })
    .limit(500);

  if (bookLookup.error) {
    if (isSupabaseSchemaMissing(bookLookup.error)) {
      return NextResponse.json(
        {
          ok: false,
          error: "oems_order_audit table not migrated yet — apply 20260612000002_oems_order_audit.sql.",
        },
        { status: 503 },
      );
    }
    return NextResponse.json({ ok: false, error: bookLookup.error.message }, { status: 500 });
  }

  const allRows = (bookLookup.data ?? []) as AuditRow[];

  // Validate the order_id exists in the audit table. `order_id` in the
  // request is the book aggregate id (matches either order_id or payload.book_id
  // on the sent rows). For Phase B3 the BFF matches against `payload.book_id`
  // to scope the update to all rows of the book.
  const bookRows = allRows.filter((r) => {
    const p = r.payload ?? {};
    return (
      r.order_id === orderId ||
      (typeof p.book_id === "string" && p.book_id === orderId) ||
      (typeof p.strategy === "string" && p.strategy === orderId)
    );
  });

  if (bookRows.length === 0) {
    return NextResponse.json(
      { ok: false, error: `No audit rows found for order_id/book_id "${orderId}".` },
      { status: 404 },
    );
  }

  // Build updates: one upsert per (symbol, audit row) match.
  const now = new Date().toISOString();
  const updates: Array<{
    id: string;
    payload: Record<string, unknown>;
    result_payload: Record<string, unknown>;
    status: string;
  }> = [];
  // Rows that land on "filled" this call, paired with the fill price and the
  // freshly-updated payload (filled/avgPx) — settlement runs after the DB
  // update succeeds, below, and needs the POST-update payload, not the stale
  // pre-fill one still sitting on `row`.
  const toSettle: Array<{ row: AuditRow; fillPriceCents: number; updatedPayload: Record<string, unknown> }> =
    [];

  for (const row of bookRows) {
    const fill = fills.find((f) => f.symbol === row.symbol);
    if (!fill) continue;
    const qty = Number(fill.qty) || 0;
    const avgFillCents = Math.round(Number(fill.avg_fill_price_cents) || 0);
    const avgFillRands = avgFillCents / 100;
    const totalQty = Number(row.quantity) || 0;

    // `payload.avgPx` / `result_payload.avgFillPrice` are read as CENTS
    // everywhere else (execution/route.ts, order-books/route.ts — matching
    // the real IRESS convention of quoting the JSE in cents), so they MUST be
    // written in cents here too, not rands. Storing rands here previously
    // made every UAT self-fill display ~100x too small (a R52.50 fill showed
    // as R0.53, with slip/P&L inheriting the same error downstream).
    const newPayload: Record<string, unknown> = {
      ...row.payload,
      filled: qty,
      avgPx: avgFillCents,
      lastFillAt: fill.timestamp ?? now,
    };

    const newResult: Record<string, unknown> = {
      ...row.result_payload,
      avgFillPrice: avgFillCents,
      slippageBps:
        num(row.payload?.limitPrice) != null
          ? Math.round(((num(row.payload?.limitPrice) ?? 0) - avgFillRands) * 10000) /
            Math.max(0.0001, num(row.payload?.limitPrice) ?? 0.0001)
          : null,
    };

    let newStatus = "partial";
    if (qty <= 0) {
      newStatus = "rejected";
      newResult.rejectReason = "Broker reported zero/negative quantity";
    } else if (qty >= totalQty) {
      newStatus = "filled";
    }

    updates.push({
      id: row.id,
      payload: newPayload,
      result_payload: newResult,
      status: newStatus,
    });

    if (newStatus === "filled") {
      toSettle.push({
        row,
        fillPriceCents: Math.round(Number(fill.avg_fill_price_cents) || 0),
        updatedPayload: newPayload,
      });
    }
  }

  if (updates.length === 0) {
    return NextResponse.json(
      { ok: false, error: "No matching symbols found in the fills payload for this book." },
      { status: 400 },
    );
  }

  // Apply via per-row updates (no upsert — we never insert; only update by id).
  // Use Promise.all so a single failure surfaces in the response.
  const results = await Promise.all(
    updates.map((u) =>
      db
        .from("oems_order_audit")
        .update({
          payload: u.payload,
          result_payload: u.result_payload,
          status: u.status,
          updated_at: now,
        })
        .eq("id", u.id),
    ),
  );

  const failed = results.find((r) => r.error);
  if (failed?.error) {
    return NextResponse.json({ ok: false, error: failed.error.message }, { status: 500 });
  }

  // Check if the entire book is now 100% filled → ready for confirmation.
  const bookId = orderId;
  const bookAfter = allRows
    .filter((r) => {
      const p = r.payload ?? {};
      return (
        r.order_id === bookId ||
        (typeof p.book_id === "string" && p.book_id === bookId) ||
        (typeof p.strategy === "string" && p.strategy === bookId)
      );
    })
    .map((r) => {
      const upd = updates.find((u) => u.id === r.id);
      return upd ? { ...r, status: upd.status } : r;
    });

  const allFilled = bookAfter.length > 0 && bookAfter.every((r) => r.status === "filled");

  // Auto-settle any row that just landed on "filled" and is tagged
  // uat_test=true — best-effort, after the DB update above has succeeded.
  // Never attempted for a live row (settleUatFill checks payload.uat_test
  // itself too — this is belt-and-braces, not the only guard).
  let retailDb: SupabaseClient | null = null;
  try {
    retailDb = createRetailServiceRoleClient();
  } catch {
    retailDb = null;
  }
  const settlements = retailDb
    ? await Promise.all(
        toSettle.map(({ row, fillPriceCents, updatedPayload }) =>
          String(row.side || "buy").toLowerCase() === "sell"
            ? settleUatSellFill(row, retailDb, db, updatedPayload)
            : settleUatFill(row, fillPriceCents, retailDb, auth.ctx.email),
        ),
      )
    : toSettle.map(({ row }) => ({
        audit_id: row.id,
        attempted: true,
        ok: false,
        error: "RETAIL database not configured",
      }));
  const attemptedSettlements = settlements.filter((s) => s.attempted);
  const failedSettlements = attemptedSettlements.filter((s) => !s.ok);

  // A fill that finishes off every order booked for a rebalance is the
  // moment the strategy's own model composition finally flips — see
  // maybeCompleteRebalance's doc comment. Best-effort, one attempt per
  // distinct rebalance touched by this call.
  const rebalanceIds = new Set(
    toSettle
      .map(({ row }) => row.payload?.rebalance_request_id)
      .filter((v): v is string => typeof v === "string" && v.length > 0),
  );
  const completions =
    retailDb && rebalanceIds.size > 0
      ? await Promise.all(
          [...rebalanceIds].map(async (rid) => {
            const outcome = await maybeCompleteRebalance(
              retailDb as SupabaseClient,
              db,
              rid,
              auth.ctx.userId,
            );
            // Settled clients' cash economics (reserve-funded fees, residual
            // leftover) only make sense once the whole rebalance — every
            // leg, every client — has actually finished, same trigger as the
            // model flip above.
            const cash = outcome.completed
              ? await settleRebalanceCashForClients(retailDb as SupabaseClient, db, rid)
              : null;
            return { rebalance_request_id: rid, ...outcome, cashSettlement: cash };
          }),
        )
      : [];

  return NextResponse.json({
    ok: true,
    updated: updates.length,
    book_id: bookId,
    book_ready_for_confirmation: allFilled,
    state: allFilled ? "READY_FOR_CONFIRMATION" : "WORKING",
    ...(completions.length ? { rebalance_completions: completions } : {}),
    ...(attemptedSettlements.length
      ? {
          settlement: {
            attempted: attemptedSettlements.length,
            ok: attemptedSettlements.length - failedSettlements.length,
            failed: failedSettlements,
          },
        }
      : {}),
  });
}
