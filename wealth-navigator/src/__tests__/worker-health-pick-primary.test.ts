import { describe, expect, it } from "vitest";
import { pickPrimaryWorker } from "@/lib/hooks/use-worker-health";
import type { WorkerHealthRow } from "@/app/api/worker-health/route";

/**
 * `pickPrimaryWorker` resolves the single most-recently-heartbeating
 * worker. The BFF already drops `status = "stopped"` rows and rows
 * from a different `service_name` (audit #2), so the helper is just
 * `arr[0]`. We pin the contract so future refactors don't accidentally
 * return the last row or merge timestamps across rows.
 */
describe("pickPrimaryWorker", () => {
  it("returns null when the list is empty", () => {
    expect(pickPrimaryWorker([])).toBeNull();
    expect(pickPrimaryWorker(undefined)).toBeNull();
    expect(pickPrimaryWorker(null)).toBeNull();
  });

  it("returns the first row when one worker is heartbeating", () => {
    const rows: WorkerHealthRow[] = [
      { worker_id: "w-1", service_name: "Iress-Worker", status: "healthy", last_heartbeat_at: "2026-06-13T12:00:00Z" } as unknown as WorkerHealthRow,
    ];
    expect(pickPrimaryWorker(rows)?.worker_id).toBe("w-1");
  });

  it("returns the first row when multiple replicas of the same service are heartbeating", () => {
    const rows: WorkerHealthRow[] = [
      { worker_id: "w-1", service_name: "Iress-Worker", status: "healthy", last_heartbeat_at: "2026-06-13T12:00:01Z" } as unknown as WorkerHealthRow,
      { worker_id: "w-2", service_name: "Iress-Worker", status: "healthy", last_heartbeat_at: "2026-06-13T12:00:00Z" } as unknown as WorkerHealthRow,
    ];
    expect(pickPrimaryWorker(rows)?.worker_id).toBe("w-1");
  });
});
