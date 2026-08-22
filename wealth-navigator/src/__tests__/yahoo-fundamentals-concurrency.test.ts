import { describe, expect, it } from "vitest";

import { runBounded } from "@/app/api/cron/yahoo-fundamentals/route";

/**
 * Regression coverage for the yahoo-fundamentals timeout bug: the cron used
 * to fetch Yahoo one security at a time (concurrency 1), which for 360+
 * active securities routinely blew past `maxDuration = 300`s and left most
 * of the universe permanently uncovered on /oems/equities. The fix batches
 * the same per-security work through `runBounded` (the worker-pool pattern
 * already proven in src/lib/market-prices/fallback.ts) at concurrency 4.
 *
 * This test exercises `runBounded` in isolation — with fake, instant `work`
 * functions — so it proves the batching/counting logic itself is correct
 * without depending on real Yahoo network calls (which would make the test
 * flaky and non-hermetic). It is not a substitute for watching the next real
 * cron run's `covered`/`updated`/`failed` counts.
 */
describe("runBounded", () => {
  it("processes every item exactly once", async () => {
    const items = Array.from({ length: 37 }, (_, i) => i);
    const seen: number[] = [];
    await runBounded(items, 4, async (item) => {
      seen.push(item);
    });
    expect(seen.length).toBe(items.length);
    expect([...seen].sort((a, b) => a - b)).toEqual(items);
  });

  it("never runs more than `concurrency` workers at once", async () => {
    const items = Array.from({ length: 20 }, (_, i) => i);
    let inFlight = 0;
    let maxInFlight = 0;
    await runBounded(items, 4, async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      // Yield to the microtask queue so other workers get a chance to start
      // before this one finishes, the same way a real awaited fetch() would.
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
    });
    expect(maxInFlight).toBeLessThanOrEqual(4);
    expect(maxInFlight).toBeGreaterThan(1); // proves it actually parallelizes, not accidentally serial
  });

  it("caps concurrency at the item count when fewer items than workers", async () => {
    const items = [1, 2];
    let maxInFlight = 0;
    let inFlight = 0;
    await runBounded(items, 4, async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight--;
    });
    expect(maxInFlight).toBeLessThanOrEqual(2);
  });

  it("keeps shared counters accurate under concurrent completion (no lost updates)", async () => {
    // Mirrors the route's plain-number counters (`covered`, `failed`, etc.)
    // and the `sample.length < 8` check-then-push pattern.
    const items = Array.from({ length: 50 }, (_, i) => i);
    let covered = 0;
    const sample: number[] = [];
    await runBounded(items, 4, async (item) => {
      await new Promise((r) => setTimeout(r, Math.random() * 3));
      covered++;
      if (sample.length < 8) sample.push(item);
    });
    expect(covered).toBe(50);
    expect(sample.length).toBe(8); // never over-pushed past the cap despite concurrent workers
  });

  it("does not let one item's rejection stop the pool if the caller catches it", async () => {
    const items = [1, 2, 3, 4, 5];
    let failed = 0;
    let succeeded = 0;
    await runBounded(items, 4, async (item) => {
      try {
        if (item === 3) throw new Error("simulated Yahoo fetch failure");
        succeeded++;
      } catch {
        failed++;
      }
    });
    expect(failed).toBe(1);
    expect(succeeded).toBe(4);
  });
});
