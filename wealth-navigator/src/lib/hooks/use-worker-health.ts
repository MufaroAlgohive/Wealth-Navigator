"use client";

import { useQuery } from "@tanstack/react-query";
import type { WorkerHealthRow } from "@/app/api/worker-health/route";
import { queryOpts } from "@/lib/store/query-provider";

interface WorkerHealthResponse {
  workers: WorkerHealthRow[];
  count: number;
  ghostRowsHidden?: number;
  error?: string;
}

async function fetchWorkerHealth(): Promise<WorkerHealthResponse> {
  const res = await fetch("/api/worker-health");
  const data = (await res.json()) as WorkerHealthResponse;
  if (!res.ok) throw new Error(data.error ?? `worker-health ${res.status}`);
  return data;
}

/**
 * Pick the "primary" worker row from a (post-BFF-filter) list of
 * heartbeats. The BFF already drops `status = "stopped"` rows and rows
 * belonging to a different `service_name` (audit #2), so the first row
 * in the sorted response is always the most-recently-heartbeating
 * replica. The integration page uses this to resolve
 *   - `primaryWorker.iress_mode` → Adapter-mode tile
 *   - `primaryWorker.last_quote_sync_at` → last-sync tile
 *   - `primaryWorker.recent_events` → diagnostic events panel
 *
 * Kept here (rather than in the page) so the integration page, the
 * cockpit `deriveDataSource` call, and the worker-event feed all agree
 * on which row is "primary".
 */
export function pickPrimaryWorker(workers: WorkerHealthRow[] | undefined | null): WorkerHealthRow | null {
  if (!workers || workers.length === 0) return null;
  return workers[0] ?? null;
}

/** Railway IRESS ingest heartbeat from `integration_worker_health`. */
export function useWorkerHealth(enabled = true) {
  return useQuery({
    queryKey: ["worker-health"],
    queryFn: fetchWorkerHealth,
    enabled,
    // 30s is intentional. The worker heartbeats every ~15s and the UI
    // re-renders on every refresh. Polling faster than that just
    // burns through the React Query cache. Audit #35.
    refetchInterval: 30_000,
    ...queryOpts("reference"),
  });
}
