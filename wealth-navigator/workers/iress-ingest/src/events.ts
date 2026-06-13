// In-memory structured event ring buffer for the Railway `iress-ingest`
// worker.
//
// The worker emits many structured events (`time_series_entitlement_missing`,
// `quote_sync_complete`, `25008 license seat occupied — backing off`,
// `PricingQuoteGet(NPN) failed`, …) that today only land in `console.info`
// / `console.warn` lines. The /oems/integration page can't tail Railway
// logs, so the operator can't see *why the worker isn't getting data*
// without an SSH-into-Railway detour.
//
// This module collects the most recent N events in a process-local ring
// buffer. `runHealthLoop` reads the snapshot every heartbeat and stuffs it
// into `metadata.recent_events` on the `integration_worker_health` upsert.
// The BFF surfaces it as `/api/worker-events` (and as part of
// `/api/worker-health.workers[].recent_events`).
//
// Buffer cap: 50 events, newest first, with `ts` (ISO) and `level` (info /
// warn / error) + a free-form `data` payload. Oldest events drop off when
// the cap is hit. The buffer is process-local — a worker restart starts
// empty, which is honest (the heartbeat will surface the new boot as the
// first event).

export type WorkerEventLevel = "info" | "warn" | "error";

export interface WorkerEvent {
  /** ISO-8601 timestamp the event was recorded. */
  ts: string;
  level: WorkerEventLevel;
  /** Short stable identifier — e.g. `quote_sync_complete`, `time_series_entitlement_missing`. */
  event: string;
  /** Optional human-readable message. */
  msg?: string;
  /** Free-form payload (symbol, code, hint, etc.). Keys depend on the event. */
  data?: Record<string, unknown>;
}

const DEFAULT_CAP = 50;

class EventBuffer {
  private items: WorkerEvent[] = [];
  constructor(private readonly cap: number) {}

  record(ev: Omit<WorkerEvent, "ts"> & { ts?: string }): void {
    const item: WorkerEvent = {
      ts: ev.ts ?? new Date().toISOString(),
      level: ev.level,
      event: ev.event,
      ...(ev.msg !== undefined ? { msg: ev.msg } : {}),
      ...(ev.data !== undefined ? { data: ev.data } : {}),
    };
    this.items.unshift(item);
    if (this.items.length > this.cap) {
      this.items.length = this.cap;
    }
  }

  /** Newest-first list of recent events. */
  snapshot(): WorkerEvent[] {
    return [...this.items];
  }

  /** Drop everything (worker restart, test teardown). */
  clear(): void {
    this.items = [];
  }

  size(): number {
    return this.items.length;
  }
}

let singleton: EventBuffer | null = null;

function getBuffer(): EventBuffer {
  if (!singleton) singleton = new EventBuffer(DEFAULT_CAP);
  return singleton;
}

/** Record a structured event for the integration page to surface. */
export function recordWorkerEvent(
  ev: Omit<WorkerEvent, "ts"> & { ts?: string },
): void {
  try {
    getBuffer().record(ev);
  } catch {
    // Never let a diagnostic path break the worker.
  }
}

/** Read the most recent events (newest first). */
export function recentWorkerEvents(): WorkerEvent[] {
  return getBuffer().snapshot();
}

/** Test seam — reset the singleton. */
export function _resetWorkerEventsForTests(): void {
  if (singleton) singleton.clear();
  singleton = null;
}
