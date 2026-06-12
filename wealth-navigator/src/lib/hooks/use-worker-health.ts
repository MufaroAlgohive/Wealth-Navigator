"use client";

import { useQuery } from "@tanstack/react-query";
import type { WorkerHealthRow } from "@/app/api/worker-health/route";
import { queryOpts } from "@/lib/store/query-provider";

interface WorkerHealthResponse {
  workers: WorkerHealthRow[];
  count: number;
  error?: string;
}

async function fetchWorkerHealth(): Promise<WorkerHealthResponse> {
  const res = await fetch("/api/worker-health");
  const data = (await res.json()) as WorkerHealthResponse;
  if (!res.ok) throw new Error(data.error ?? `worker-health ${res.status}`);
  return data;
}

/** Railway IRESS ingest heartbeat from `integration_worker_health`. */
export function useWorkerHealth(enabled = true) {
  return useQuery({
    queryKey: ["worker-health"],
    queryFn: fetchWorkerHealth,
    enabled,
    refetchInterval: 30_000,
    ...queryOpts("reference"),
  });
}
