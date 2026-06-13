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

  it("captures `iress_call_complete` events with elapsedMs for the integration latency panel", () => {
    recordWorkerEvent({
      level: "info",
      event: "iress_call_complete",
      msg: "TimeSeriesGet2(J203/JSE) returned 30 points",
      data: { method: "TimeSeriesGet2", series: "index", code: "J203", exchange: "JSE", elapsedMs: 184, points: 30 },
    });
    recordWorkerEvent({
      level: "info",
      event: "iress_call_complete",
      msg: "TimeSeriesGet2(R2030/JSE) returned 1 point",
      data: { method: "TimeSeriesGet2", series: "curve", code: "R2030", exchange: "JSE", elapsedMs: 92, points: 1 },
    });
    const evs = recentWorkerEvents();
    // Newest first
    expect(evs[0]?.event).toBe("iress_call_complete");
    expect(evs[0]?.data?.["code"]).toBe("R2030");
    expect(typeof evs[0]?.data?.["elapsedMs"]).toBe("number");
    // /oems/integration's `buildLatencySeries` filters on numeric
    // `elapsedMs` — keep that invariant tight.
    for (const e of evs) {
      if (e.event === "iress_call_complete") {
        expect(typeof e.data?.["elapsedMs"]).toBe("number");
        expect(Number.isFinite(e.data?.["elapsedMs"] as number)).toBe(true);
      }
    }
  });
});
