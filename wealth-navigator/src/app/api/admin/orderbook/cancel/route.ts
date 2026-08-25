import { NextResponse } from "next/server";

import { can, getAdminContext } from "@/lib/admin/rbac";
import { isIressWorkerConfigured } from "@/lib/data-policy";
import { callWorker } from "@/lib/iress/worker-api";
import { createInstitutionalServiceRoleClient, createRetailServiceRoleClient } from "@/lib/supabase/server";
import { voidUnfilledRemainder } from "@workers/iress-ingest/src/settlement";

/**
 * POST /api/admin/orderbook/cancel
 *
 * Mint OEM Finalisation — cancel a UAT or production order from the OEMS
 * desk UI. Forwards to the Railway worker's `/orders/cancel` route which:
 *   1. Calls IRESS `OrderDelete` on the IOS+ service session.
 *   2. Stamps `oems_order_audit.status = "cancelled"` (best-effort) so the
 *      OEMS audit trail reflects the broker cancel.
 *   3. Publishes an SSE delta on the UAT execution hub so subscribed UIs
 *      flip to "CANCELLED" immediately (not waiting for the next poll).
 *
 * Body: { account: string, order_number: string }
 *   - `account`: the IRESS AccountCode (e.g. "56378" for UAT,
 *     "MINT-LIVE-001" for production)
 *   - `order_number`: the broker-assigned OrderNumber returned by
 *     OrderCreate3 (NOT the OEMS book_id; that's a strategy grouping)
 *
 * Returns: { ok, orderNumber, account, cancelledAt?, workerId?, error? }
 *
 * Auth: same as the rest of /api/admin/orderbook/* — admin RBAC.
 *
 * 2026-07-13 (Andre + Juan walkthrough): prior to this route the only
 * way to cancel a UAT order was to log into Hermes and click cancel —
 * the OEMS desk UI had no cancel button. After this route exists, the
 * desk can cancel directly from the ExecutionView's row actions, and
 * the cancel reaches the audit row + UI within the same round-trip.
 */

export const dynamic = "force-dynamic";

interface WorkerCancelResponse {
  ok: boolean;
  orderId?: string;
  account?: string;
  cancelledAt?: string;
  workerId?: string;
  iressMode?: string;
  error?: { code: string; message: string };
}

export async function POST(req: Request) {
  const auth = await getAdminContext();
  if (auth.status === "no-session") {
    return NextResponse.json({ ok: false, error: "no-session" }, { status: 401 });
  }
  if (auth.status !== "ok") {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }
  if (!can(auth.ctx, "orderbook", "send_to_market")) {
    // Same RBAC as send-to-market — cancelling is the inverse of placing.
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const account = typeof body.account === "string" ? body.account.trim() : "";
  const orderNumber = typeof body.order_number === "string" ? body.order_number.trim() : "";

  if (!account) {
    return NextResponse.json({ ok: false, error: "account is required" }, { status: 400 });
  }
  if (!orderNumber) {
    return NextResponse.json(
      { ok: false, error: "order_number is required (the broker OrderNumber from OrderCreate3)" },
      { status: 400 },
    );
  }

  if (!isIressWorkerConfigured()) {
    return NextResponse.json(
      {
        ok: false,
        error: "worker_not_configured",
        message:
          "IRESS_WORKER_URL is not set on Vercel. Cancels must go through Hermes directly until the worker is wired up.",
      },
      { status: 503 },
    );
  }

  const cancel = await callWorker<WorkerCancelResponse>({
    method: "POST",
    path: "/orders/cancel",
    body: { account, orderId: orderNumber },
    timeoutMs: 15_000,
  });

  if (!cancel.ok) {
    return NextResponse.json(
      {
        ok: false,
        error: "worker_unreachable",
        message: cancel.error,
      },
      { status: 502 },
    );
  }

  const body2 = cancel.body;
  if (!body2.ok) {
    return NextResponse.json(
      {
        ok: false,
        error: body2.error?.code ?? "cancel_failed",
        message: body2.error?.message ?? "Worker returned ok:false for cancel",
        orderNumber,
        account,
      },
      { status: 200 }, // ok:false with 200 so the UI can render the reason
    );
  }

  // The worker only best-effort stamps oems_order_audit.status="cancelled" —
  // nothing in that round-trip ever retires the RETAIL placeholder holding
  // this order was raised against. Unlike a parked cancel (cancel-parked/
  // route.ts, safe to fully zero — a parked order can never be partially
  // filled), an order that reached the broker CAN be partially filled before
  // cancellation, so voidUnfilledRemainder — the same partial-fill-aware
  // function the IRESS poller uses for a broker-observed terminal state — is
  // reused here rather than a cruder full-zero. Best-effort: a real broker
  // cancel must not be reported as failed over a holding-cleanup hiccup.
  let holdingVoided = false;
  let holdingVoidError: string | null = null;
  try {
    const institutionalDb = createInstitutionalServiceRoleClient();
    const retailDb = createRetailServiceRoleClient();
    const { data: auditRow, error: auditErr } = await institutionalDb
      .from("oems_order_audit")
      .select("order_id, status, quantity, payload")
      .eq("order_id", orderNumber)
      .eq("payload->>broker_account_code", account)
      .maybeSingle();
    if (auditErr) {
      holdingVoidError = auditErr.message;
    } else if (auditRow) {
      const result = await voidUnfilledRemainder(
        { institutional: institutionalDb, retail: retailDb, enabled: true, dryRun: false },
        auditRow as { order_id: string; status: string; quantity: number | null; payload: Record<string, unknown> | null },
      );
      holdingVoided = result.lotVoided || result.unfilledQty > 0;
      if (result.error) holdingVoidError = result.error;
    }
  } catch (err) {
    holdingVoidError = err instanceof Error ? err.message : String(err);
  }

  return NextResponse.json({
    ok: true,
    orderNumber,
    account,
    cancelledAt: body2.cancelledAt ?? new Date().toISOString(),
    workerId: body2.workerId ?? null,
    iressMode: body2.iressMode ?? null,
    holdingVoided,
    holdingVoidError,
  });
}