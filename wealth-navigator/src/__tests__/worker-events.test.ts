import { afterEach, describe, expect, it } from "vitest";
import {
  recordWorkerEvent,
  recentWorkerEvents,
  _resetWorkerEventsForTests,
} from "../../workers/iress-ingest/src/events";

describe("worker events ring buffer", () => {
  afterEach(() => {
    _resetWorkerEventsForTests();
  });

  it("returns an empty list when nothing has been recorded", () => {
    expect(recentWorkerEvents()).toEqual([]);
  });

  it("records an event with level + event name + message + data and returns it newest-first", () => {
    recordWorkerEvent({ level: "warn", event: "license_seat_occupied", msg: "25008 hit", data: { code: 25008 } });
    recordWorkerEvent({ level: "info", event: "iress_session_ready", msg: "session up" });
    const evs = recentWorkerEvents();
    expect(evs).toHaveLength(2);
    // Newest-first ordering.
    expect(evs[0]?.event).toBe("iress_session_ready");
    expect(evs[1]?.event).toBe("license_seat_occupied");
    // Data + msg round-trip.
    expect(evs[1]?.data).toEqual({ code: 25008 });
    expect(evs[1]?.msg).toBe("25008 hit");
    // Every event has an ISO ts and a valid level.
    for (const e of evs) {
      expect(typeof e.ts).toBe("string");
      expect(Number.isNaN(Date.parse(e.ts))).toBe(false);
      expect(["info", "warn", "error"]).toContain(e.level);
    }
  });

  it("caps the buffer at 50 events and drops the oldest", () => {
    for (let i = 0; i < 60; i += 1) {
      recordWorkerEvent({ level: "info", event: `e${i}` });
    }
    const evs = recentWorkerEvents();
    expect(evs).toHaveLength(50);
    // Newest 50 — so e59 first, e10 last (we dropped e0..e9).
    expect(evs[0]?.event).toBe("e59");
    expect(evs[49]?.event).toBe("e10");
  });

  it("treats recordWorkerEvent as best-effort (never throws)", () => {
    // Smoke test: even when called rapidly, the API stays well-behaved.
    for (let i = 0; i < 1000; i += 1) {
      recordWorkerEvent({ level: "info", event: "noop" });
    }
    expect(recentWorkerEvents().length).toBeLessThanOrEqual(50);
  });
});
