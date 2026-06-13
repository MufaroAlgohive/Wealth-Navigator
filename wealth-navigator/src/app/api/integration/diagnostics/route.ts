/**
 * GET /api/integration/diagnostics
 *
 * One-shot composer for the integration diagnostic page. Each sub-call
 * is independent — a failure on one never aborts the others; the
 * envelope below always returns shape `{ ok, ts, worker, ipsSession,
 * iressSession, provenance, recentEvents }`, and any failed sub-call
 * is reported inline with its `code` + `error` so the UI can render
 * a per-section empty state without a second fetch round trip.
 *
 * Sub-calls (in order):
 *   1. `GET /api/worker-health`        — Supabase `integration_worker_health` rows
 *   2. `GET /api/integration/health`   — Railway worker heartbeat passthrough
 *   3. `callWorker('/debug/ips-session', …)` — IPS / IOSPlus / FIXPlus state
 *   4. `GET /api/iress/provenance`     — adapter + session provenance summary
 *
 * Auth: the Next.js middleware gates every `/api/*` route that is not
 * in `PUBLIC_PREFIXES` (see `src/middleware.ts`). `/api/integration/*`
 * is authed by default — this route does not duplicate the check.
 */

import { NextResponse } from "next/server";

import { callWorker } from "@/lib/iress/worker-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Worker IPS service-session shape (see `http-api.ts /debug/ips-session`). */
interface WorkerIpsSessionShape {
  ok: boolean;
  serviceKeyCached: string | null;
  services: string[];
  serviceKeys: Record<string, string | null>;
  applicationId: string | null;
  iressMode: string;
  lastError: { code: number | null; message: string; ts: string } | null;
}

/** Worker /health shape (subset — only the fields the UI surfaces). */
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

/** /api/worker-health row shape (subset). */
interface SupabaseWorkerHealthRow {
  worker_id: string;
  service_name: string;
  status: string;
  last_heartbeat_at: string;
  last_quote_sync_at: string | null;
  iress_mode: string | null;
  recent_events?: Array<{
    ts: string;
    level: string;
    event: string;
    msg?: string;
    data?: Record<string, unknown>;
  }>;
  metadata: Record<string, unknown>;
}

/** /api/iress/provenance shape (subset). */
interface IressProvenanceShape {
  sources?: Record<string, string>;
  counts?: Record<string, number>;
  session?: { ok: boolean; mode: string; started: boolean; services: string[] };
}

/** Shape of a failed sub-call inline in the response. */
interface SubCallError {
  ok: false;
  code: string;
  status: number;
  error: string;
  workerUrl?: string;
}

/** Discriminated union: each sub-call is either `ok: true, ...body` or `ok: false, error`. */
type SubCall<T> = ({ ok: true } & T) | SubCallError;

export async function GET() {
  const ts = new Date().toISOString();

  // Fan out the four sub-calls in parallel — none of them depend on
  // each other, and the per-call `WorkerApiResult<T>` (or local
  // `fetch`) already handles the network / timeout error shape.
  const [supabaseWorkerHealth, workerIntegrationHealth, ipsSession, iressProvenance] =
    await Promise.all([
      fetchSupabaseWorkerHealth(),
      fetchWorkerIntegrationHealth(),
      fetchWorkerIpsSession(),
      fetchIressProvenance(),
    ]);

  // Aggregate `recentEvents` from the Supabase worker-health row
  // (newest-first ring buffer surfaced by the worker on every
  // heartbeat). Empty array when the sub-call failed or no worker row
  // is in Supabase.
  const recentEvents =
    supabaseWorkerHealth.ok && Array.isArray(supabaseWorkerHealth.recent_events)
      ? supabaseWorkerHealth.recent_events
      : [];

  // Top-level `ok` is true iff every sub-call succeeded. The UI uses
  // this to render a green/yellow/red strip; each section also has its
  // own per-sub-call `ok` so a single failure can be drilled into.
  const allOk =
    supabaseWorkerHealth.ok &&
    workerIntegrationHealth.ok &&
    ipsSession.ok &&
    iressProvenance.ok;

  return NextResponse.json({
    ok: allOk,
    ts,
    worker: supabaseWorkerHealth,
    ipsSession,
    iressSession: iressProvenance.ok ? iressProvenance.session ?? null : null,
    provenance: iressProvenance,
    recentEvents,
    // Flat passthrough so the UI can also render the live
    // worker /health shape in one panel.
    workerHealth: workerIntegrationHealth,
  });
}

async function fetchSupabaseWorkerHealth(): Promise<SubCall<{
  workers: SupabaseWorkerHealthRow[];
  recent_events: SupabaseWorkerHealthRow["recent_events"];
  count: number;
}>> {
  try {
    const res = await fetch(
      `${process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000"}/api/worker-health`,
      { cache: "no-store" },
    );
    if (!res.ok) {
      return {
        ok: false,
        code: "upstream_error",
        status: res.status,
        error: `/api/worker-health returned ${res.status}`,
      };
    }
    const body = (await res.json()) as { workers: SupabaseWorkerHealthRow[]; count: number };
    // Flatten `recent_events` across all worker rows (newest-first)
    // so the integration page can render a single stream of events.
    const recent = body.workers.flatMap((w) => w.recent_events ?? []);
    return { ok: true, workers: body.workers, recent_events: recent, count: body.count };
  } catch (err) {
    return {
      ok: false,
      code: "unreachable",
      status: 503,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function fetchWorkerIntegrationHealth(): Promise<SubCall<WorkerHealthShape>> {
  try {
    const res = await fetch(
      `${process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000"}/api/integration/health`,
      { cache: "no-store" },
    );
    if (!res.ok) {
      return {
        ok: false,
        code: "upstream_error",
        status: res.status,
        error: `/api/integration/health returned ${res.status}`,
      };
    }
    const body = (await res.json()) as { worker: WorkerHealthShape };
    // `body.worker.ok` is `boolean` from the worker's JSON; the
    // success-path here is "we got a 200 response" so the envelope
    // `ok` is always `true`. Strip the inner `ok` and replace with
    // the outer one to satisfy the SubCall discriminated union.
    const { ok: _innerOk, ...rest } = body.worker;
    void _innerOk;
    return { ok: true, ...rest };
  } catch (err) {
    return {
      ok: false,
      code: "unreachable",
      status: 503,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function fetchWorkerIpsSession(): Promise<SubCall<WorkerIpsSessionShape>> {
  // The worker `/debug/ips-session` endpoint is authed with the
  // shared `WORKER_HTTP_TOKEN` (same as `/health`); `callWorker`
  // forwards the Vercel env value via `Authorization: Bearer …` so
  // the worker auth check passes.
  const result = await callWorker<WorkerIpsSessionShape>({ path: "/debug/ips-session" });
  if (!result.ok) {
    return {
      ok: false,
      code: result.code,
      status: result.status,
      error: result.error,
      workerUrl: result.workerUrl,
    };
  }
  // The worker body has its own `ok` boolean (heartbeat-style
  // `ok: true` on the happy path). Strip it and replace with the
  // SubCall discriminator `true` so the union narrows correctly.
  const { ok: _innerOk, ...rest } = result.body;
  void _innerOk;
  return { ok: true, ...rest };
}

async function fetchIressProvenance(): Promise<SubCall<IressProvenanceShape>> {
  try {
    const res = await fetch(
      `${process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000"}/api/iress/provenance`,
      { cache: "no-store" },
    );
    if (!res.ok) {
      return {
        ok: false,
        code: "upstream_error",
        status: res.status,
        error: `/api/iress/provenance returned ${res.status}`,
      };
    }
    const body = (await res.json()) as IressProvenanceShape;
    return { ok: true, ...body };
  } catch (err) {
    return {
      ok: false,
      code: "unreachable",
      status: 503,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
