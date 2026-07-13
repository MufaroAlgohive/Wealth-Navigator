import { NextResponse } from "next/server";

import { getAdminContext } from "@/lib/admin/rbac";
import { isIressWorkerConfigured } from "@/lib/data-policy";
import { callWorker } from "@/lib/iress/worker-api";

/**
 * GET /api/admin/orderbook/state-probe?account=56378&orderNumber=12345
 *
 * Operator-only passthrough to the worker's `/debug/order-state-probe`.
 * Surfaces the live IRESS Hermes row + the worker's mapped lifecycle
 * fields so the desk can answer "where exactly is this order stuck?"
 * without tailing Railway logs.
 *
 * Added 2026-07-13 after Andre's walkthrough exposed three gaps:
 *   1. Fully-filled CARE orders were collapsing to "Working" in the UI
 *      because INACTIVE + done>=qty was being downmapped to CANCELLED.
 *   2. The IRESS Hermes `ActionStatus` (Pending / Acknowledged / OK /
 *      Cancelled / Rejected) was being thrown away by the worker.
 *   3. The Hermes `StateDescription` free-text ("Traded 200@177,
 *      then 200@179") was not being captured.
 *
 * The mapper + BFF changes are the structural fix; this endpoint is the
 * operator's microscope for "is the structural fix actually seeing this
 * row?" — if Hermes says `OrderState=INACTIVE, DoneVolumeTotal=400,
 * OrderVolume=400` and the audit row says `working`, this is where you
 * see the mismatch.
 *
 * Response (success, found=true):
 *   {
 *     ok: true,
 *     found: true,
 *     account, orderNumber, iressMode, fetchedAt,
 *     raw: { ... OrderPadGetByAccount row },
 *     lifecycleFields: {
 *       orderState, actionStatus, internalOrderStatus,
 *       stateDescription, lifetime, pricingInstructions,
 *     },
 *     fillMath: {
 *       orderVolume, doneVolumeTotal, remainingVolume,
 *       remainingValue, orderValue, averagePrice, fillPct,
 *     },
 *     timestamps: { createDateTime, updateDateTime },
 *   }
 */

export const dynamic = "force-dynamic";

interface OrderStateProbeBody {
  ok?: boolean;
  found?: boolean;
  account?: string;
  orderNumber?: string;
  iressMode?: string;
  fetchedAt?: string;
  raw?: Record<string, unknown>;
  lifecycleFields?: Record<string, string>;
  fillMath?: Record<string, number>;
  timestamps?: Record<string, string>;
  orderPadRows?: number;
  error?: { code: string; message: string };
  hint?: string;
}

export async function GET(req: Request) {
  const auth = await getAdminContext();
  if (auth.status !== "ok") {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }

  const url = new URL(req.url);
  const account = url.searchParams.get("account")?.trim();
  const orderNumber = url.searchParams.get("orderNumber")?.trim();
  if (!account || !orderNumber) {
    return NextResponse.json(
      {
        ok: false,
        error: "bad_request",
        message: "account and orderNumber query params required",
      },
      { status: 400 },
    );
  }

  if (!isIressWorkerConfigured()) {
    return NextResponse.json(
      {
        ok: false,
        error: "worker_not_configured",
        message: "IRESS_WORKER_URL is not set; live state probe unavailable",
      },
      { status: 503 },
    );
  }

  const probe = await callWorker<OrderStateProbeBody>({
    method: "GET",
    path: `/debug/order-state-probe?account=${encodeURIComponent(account)}&orderNumber=${encodeURIComponent(orderNumber)}`,
    timeoutMs: 15_000,
  });

  if (!probe.ok) {
    return NextResponse.json(
      {
        ok: false,
        error: "worker_unreachable",
        message: probe.error,
      },
      { status: 502 },
    );
  }

  return NextResponse.json(probe.body, { status: 200 });
}