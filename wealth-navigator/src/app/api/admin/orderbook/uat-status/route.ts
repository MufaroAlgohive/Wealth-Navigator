import { NextResponse } from "next/server";

import { getAdminContext } from "@/lib/admin/rbac";
import { isIressWorkerConfigured } from "@/lib/data-policy";
import { callWorker } from "@/lib/iress/worker-api";
import { uatModeEnabled } from "@/lib/oems/uat-scope";

/**
 * GET /api/admin/orderbook/uat-status
 *
 * Mint OEM Finalisation Phase UAT — surfaces whether the Railway worker is
 * in UAT mode and how fresh the UAT order-pad poll is. The UI uses this to
 * decide whether to render the "UAT MODE" banner and the live execution
 * indicators. Always returns 200 with `ok: true` so the UI can render
 * honest states (worker unreachable, UAT off, last poll stale, …) without
 * an alert banner.
 *
 * Response:
 *   {
 *     ok: true,
 *     uat_mode: boolean,                  // from Vercel IRESS_UAT_MODE
 *     worker_configured: boolean,         // IRESS_WORKER_URL set
 *     worker_uat_mode: boolean | null,    // from worker /uat/status
 *     last_poll_at: string | null,        // worker /uat/status
 *     poll_interval_sec: number | null,   // worker /uat/status
 *     worker_id: string | null,
 *     account_code: string | null,        // UAT account (worker) — null when off
 *     notice: string | null,
 *   }
 */

export const dynamic = "force-dynamic";

interface WorkerUatStatus {
  ok?: boolean;
  uatMode?: boolean;
  uatAccountCode?: string | null;
  productionAccountCode?: string | null;
  iressMode?: string;
  lastPollAt?: string | null;
  pollIntervalSec?: number;
  workerId?: string;
}

export async function GET() {
  const auth = await getAdminContext();
  if (auth.status !== "ok") {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }

  // Accepts "1" as well as "true" — see uatModeEnabled(). This value drives the
  // "UAT MODE" banner, so a strict === "true" made the UI claim UAT was off while
  // the worker had it on.
  const uatMode = uatModeEnabled();
  const workerConfigured = isIressWorkerConfigured();

  let workerStatus: WorkerUatStatus | null = null;
  let workerError: string | null = null;
  if (workerConfigured) {
    const res = await callWorker<WorkerUatStatus>({ method: "GET", path: "/uat/status", timeoutMs: 5_000 });
    if (res.ok) {
      workerStatus = res.body;
    } else {
      workerError = res.error;
    }
  }

  return NextResponse.json({
    ok: true,
    uat_mode: uatMode,
    worker_configured: workerConfigured,
    worker_uat_mode: workerStatus?.uatMode ?? null,
    last_poll_at: workerStatus?.lastPollAt ?? null,
    poll_interval_sec: workerStatus?.pollIntervalSec ?? null,
    worker_id: workerStatus?.workerId ?? null,
    account_code: workerStatus?.uatAccountCode ?? null,
    iress_mode: workerStatus?.iressMode ?? null,
    notice: !uatMode
      ? "UAT mode is off on Vercel (IRESS_UAT_MODE!=true). Send-to-market runs in audit-only mode."
      : !workerConfigured
        ? "UAT mode is on but IRESS_WORKER_URL is not set. Live IRESS order routing is disabled."
        : workerError
          ? `Worker reachable but /uat/status failed: ${workerError}`
          : null,
  });
}
