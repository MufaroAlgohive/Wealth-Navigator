import { callWorker } from "@/lib/iress/worker-api";
import { isIressWorkerConfigured } from "@/lib/data-policy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/integration/health
 *
 * Path B BFF passthrough — surfaces the Railway worker's in-process
 * session + heartbeat state. Worker health is the source of truth in
 * production because the worker owns the IRESS license seat; the BFF
 * mirrors that as `workerHealth` alongside the existing Supabase
 * `worker-health` row read for redundancy.
 *
 * The legacy `/api/worker-health` route still serves the Supabase
 * `integration_worker_health` table (audit trail) — both endpoints are
 * useful and complement each other.
 */

interface WorkerHealthShape {
  ok: boolean;
  workerId: string;
  iressMode: string;
  dryRun: boolean;
  allowWrites: boolean;
  session: {
    cached: boolean;
    expiresAt: number | null;
    services: string[];
    applicationId: string | null;
  };
  accounts: string[];
  watchlistSize: number;
  timestamp: string;
  uptimeSec: number;
  lastQuoteSyncAt: string | null;
}

export async function GET() {
  if (!isIressWorkerConfigured()) {
    return Response.json(
      {
        ok: false,
        status: 503,
        code: "not_configured",
        error:
          "Railway IRESS worker URL not configured (set IRESS_WORKER_URL or RAILWAY_SERVICE_URL on Vercel)",
        worker: null,
      },
      { status: 503 },
    );
  }

  const result = await callWorker<WorkerHealthShape>({ path: "/health" });
  if (!result.ok) {
    return Response.json(
      {
        ok: false,
        status: result.status,
        code: result.code,
        error: result.error,
        workerUrl: result.workerUrl,
        upstreamStatus: result.upstreamStatus,
        upstreamError: result.errorBody,
        worker: null,
      },
      { status: result.status },
    );
  }

  return Response.json(
    {
      ok: true,
      worker: result.body,
      // Convenience aliases so the UI can render `/oems/integration`
      // without a second fetch.
      workerId: result.body.workerId,
      iressMode: result.body.iressMode,
      sessionCached: result.body.session.cached,
      services: result.body.session.services,
      accounts: result.body.accounts,
      lastQuoteSyncAt: result.body.lastQuoteSyncAt,
      uptimeSec: result.body.uptimeSec,
    },
    { status: 200 },
  );
}
