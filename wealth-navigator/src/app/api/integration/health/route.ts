import { isIressWorkerConfigured } from "@/lib/data-policy";
import { callWorker } from "@/lib/iress/worker-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/integration/health
 *
 * Path B BFF passthrough — surfaces the Railway workers' in-process
 * session + heartbeat state. The IRESS worker is the source of truth
 * for quote/orders polling because it owns the IRESS license seat; the
 * broker worker (Phase C4) mirrors broker-fill pipeline health.
 *
 * The legacy `/api/worker-health` route still serves the Supabase
 * `integration_worker_health` table (audit trail) — both endpoints are
 * useful and complement each other.
 *
 * Response shape:
 *   { ok, worker: <iressWorker>, broker: <brokerWorker>, workerId, iressMode, brokerMode, ... }
 *
 * `broker` is added by Phase C4 — its `status` field is one of:
 *   - 'live'         — broker worker writes enabled (BROKER_MODE=live + BROKER_WORKER_DRY_RUN=0 + SUPABASE_ALLOW_WRITES=1)
 *   - 'mock'         — broker worker writes enabled but BROKER_MODE=mock
 *   - 'unconfigured' — worker URL not set (no broker worker reachable)
 *   - 'degraded'     — worker reachable but reports degraded/error
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

interface BrokerHealthShape {
  ok: boolean;
  workerId: string;
  brokerMode: string;
  dryRun: boolean;
  allowWrites: boolean;
  brokerApiConfigured: boolean;
  pollIntervalMs: number;
  state: {
    cursor: string;
    pollsCompleted: number;
    fillsApplied: number;
    booksCompleted: string[];
    rebalanceRequestIdsExecuted: string[];
    lastError: string | null;
  };
  uptimeSec: number;
  timestamp: string;
}

type BrokerStatus = "live" | "mock" | "unconfigured" | "degraded";

function brokerWorkerUrl(): string {
  const explicit = process.env.BROKER_WORKER_URL;
  if (explicit && explicit.trim()) return explicit.trim().replace(/\/+$/, "");
  return "";
}

function isBrokerWorkerConfigured(): boolean {
  return brokerWorkerUrl().length > 0;
}

function classifyBrokerStatus(health: BrokerHealthShape): BrokerStatus {
  if (health.brokerMode === "live" && !health.dryRun && health.allowWrites) return "live";
  if (health.brokerMode === "mock" && !health.dryRun && health.allowWrites) return "mock";
  if (health.dryRun || !health.allowWrites) {
    return health.brokerMode === "live" ? "live" : "mock";
  }
  return "degraded";
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
        broker: { status: isBrokerWorkerConfigured() ? "unconfigured" : "unconfigured" },
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
        broker: { status: "unconfigured" as BrokerStatus },
      },
      { status: result.status },
    );
  }

  let broker: { status: BrokerStatus; details?: BrokerHealthShape; error?: string };
  if (!isBrokerWorkerConfigured()) {
    broker = { status: "unconfigured" as BrokerStatus };
  } else {
    const url = brokerWorkerUrl();
    try {
      const res = await fetch(`${url}/health`, {
        cache: "no-store",
        signal: AbortSignal.timeout(5_000),
      });
      if (!res.ok) {
        broker = { status: "degraded", error: `HTTP ${res.status}` };
      } else {
        const body = (await res.json()) as BrokerHealthShape;
        broker = { status: classifyBrokerStatus(body), details: body };
      }
    } catch (err) {
      broker = {
        status: "degraded",
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  return Response.json(
    {
      ok: true,
      worker: result.body,
      broker,
      workerId: result.body.workerId,
      iressMode: result.body.iressMode,
      sessionCached: result.body.session.cached,
      services: result.body.session.services,
      accounts: result.body.accounts,
      lastQuoteSyncAt: result.body.lastQuoteSyncAt,
      uptimeSec: result.body.uptimeSec,
      brokerMode: broker.details?.brokerMode ?? null,
      brokerPollIntervalMs: broker.details?.pollIntervalMs ?? null,
      brokerFillsApplied: broker.details?.state.fillsApplied ?? null,
    },
    { status: 200 },
  );
}
