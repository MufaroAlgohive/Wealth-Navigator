import type { DataSourceKind } from "@/components/oems/primitives/data-source-badge";

/**
 * Single source of truth for "what data is the UI actually serving right now".
 *
 * The fallback chain is:
 *   1. IRESS (live) when the Railway worker is heartbeating on the production
 *      seat AND the most recent worker event is a successful (info-level) one
 *      emitted inside the freshness window — i.e. the worker just did work,
 *      not just a heartbeat ping.
 *   2. Supabase DB when the worker is silent or running in mock / UAT mode,
 *      i.e. the DB is the only thing carrying real prices.
 *   3. Yahoo live when the DB row is also stale / missing — the
 *      `resolveSecurityPrices` in-memory read kicks in for the affected symbols.
 *   4. None of the above (mock seed, unconfigured, fully offline).
 *
 * Every cockpit / integration / status surface that needs to label "where is
 * this number coming from" should call `resolveActiveDataSource()` instead of
 * running its own ad-hoc check. That way "IRESS goes down → Yahoo takes over"
 * reads consistently across the platform.
 */

export interface IressHealthEvent {
  /** Event timestamp (ISO). */
  ts: string;
  /**
   * Optional service tag — `iress` for the market-data calls, `ios` for
   * order-service calls, etc. (worker emits this in newer event shapes).
   * Older worker builds don't tag the service; the helper treats
   * `level === "info"` (regardless of service) as evidence of recent
   * successful work — that is good enough because the worker only emits
   * `info` events when a real cycle ran (syncs, upserts, orders), all of
   * which depend on the IRESS service being reachable.
   */
  service?: string | null;
  /** Severity. `error` and `warn` count as "not healthy"; `info` is healthy. */
  level?: "info" | "warn" | "error" | string | null;
}

export interface ActiveSourceInputs {
  /** Adapter mode the deployment is running on. */
  iressMode: "live" | "uat" | "mock" | string | null | undefined;
  /** True when the Railway worker has heartbeated within the freshness window. */
  workerAlive: boolean;
  /** Latest quote-sync timestamp reported by the worker (ISO or null). */
  lastQuoteSyncAt: string | null | undefined;
  /** How many symbols the latest BFF call served via the Yahoo fallback. */
  fallbackCount?: number | null | undefined;
  /**
   * Most-recent DB row freshness. Pass `null` when no DB row exists.
   * - fresh (≤ 20s)   → DB is the live source.
   * - stale (20s–3h)  → DB is stale; the next call flips to Yahoo.
   * - missing/old (>3h) → DB is down; only Yahoo or seeded mock remains.
   */
  dbFresh?: "fresh" | "stale" | "missing" | null;
  /**
   * Recent worker events for the IRESS service. The helper looks at the most
   * recent `iress` service event and treats `error`/`warn` as "IRESS is
   * degraded". This is what stops the cockpit from reporting `IRESS·PROD`
   * when the worker is heartbeating but IRESS SOAP calls have been failing for
   * minutes — without this signal the badge could lie for an hour.
   */
  iressEvents?: ReadonlyArray<IressHealthEvent> | null;
  /** Raw cockpit data source derived from the live-quotes hook, if available. */
  cockpitSource?: DataSourceKind | null;
  /** Now in ms — defaults to Date.now(); pass an explicit value in tests. */
  nowMs?: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const HEARTBEAT_MAX_AGE_MS = 60 * 1000;
const DB_FRESH_MS = 20 * 1000;
const DB_STALE_MS = 3 * 60 * 60 * 1000; // IRESS_STALE_FALLBACK_HOURS default = 3h
// Window inside which the IRESS service must have emitted a healthy (`info`)
// event for the helper to consider the feed "up". Five minutes is wider than
// the typical worker poll cycle (15–60s) but tight enough that an IRESS outage
// flips the badge within one operator's attention span.
const IRESS_OK_WINDOW_MS = 5 * 60 * 1000;

/** Coarse DB freshness bucket used to decide the active source. */
export function deriveDbFresh(
  asOf: string | null | undefined,
  nowMs: number = Date.now(),
): "fresh" | "stale" | "missing" {
  if (!asOf) return "missing";
  const ms = new Date(asOf).getTime();
  if (!Number.isFinite(ms)) return "missing";
  const age = nowMs - ms;
  if (age <= DB_FRESH_MS) return "fresh";
  if (age <= DB_STALE_MS) return "stale";
  return "missing";
}

/** Worker heartbeat window. Public so surfaces can render the same window in their UI. */
export function isWorkerAlive(
  lastHeartbeatAt: string | null | undefined,
  nowMs: number = Date.now(),
): boolean {
  if (!lastHeartbeatAt) return false;
  const ms = new Date(lastHeartbeatAt).getTime();
  if (!Number.isFinite(ms)) return false;
  return nowMs - ms <= HEARTBEAT_MAX_AGE_MS;
}

/**
 * IRESS service health proxy.
 *
 * Returns true when the most recent worker event emitted inside the freshness
 * window is `info`-level. The worker only emits `info` after a real sync /
 * upsert / order cycle ran — all of which require IRESS to be reachable.
 * `warn` / `error` events on the other hand always mean IRESS is unhappy
 * (25008 license seat occupied, SOAP fault, network error, …).
 *
 * Note: the worker does not yet tag events with `service: "iress"` — every
 * info event in `recent_events` is effectively an IRESS event because the
 * worker is the only IRESS path on the BFF side. Once the worker tags events
 * (TODOs in workers/iress-ingest/src/events.ts), the helper picks up the
 * `service === "iress"` filter with no code change here.
 *
 * Returning `true` means "the worker just did something successful inside
 * the window" → IRESS is treated as the live source.
 */
export function isIressServiceHealthy(
  events: ReadonlyArray<IressHealthEvent> | null | undefined,
  nowMs: number = Date.now(),
): boolean {
  if (!events || events.length === 0) return false;
  // Find the most recent info-level event inside the freshness window. We
  // iterate all events (cheap; buffer cap is 50) rather than assuming
  // events are pre-sorted, since the BFF re-emits them from the metadata
  // column and Postgres timestamps can land in any order.
  let latestInfoTs = 0;
  for (const e of events) {
    if (e.level !== "info") continue;
    const ts = new Date(e.ts).getTime();
    if (!Number.isFinite(ts)) continue;
    if (ts > latestInfoTs) latestInfoTs = ts;
  }
  if (latestInfoTs === 0) return false;
  return nowMs - latestInfoTs <= IRESS_OK_WINDOW_MS;
}

export interface ActiveSourceResult {
  /** The badge kind the UI should render. */
  kind: DataSourceKind;
  /**
   * One-line, human-readable rationale — surfaced in the cockpit's existing
   * DataSourceBadge title and on hover in the chip, so operators never have to
   * grep code to understand why a number came from where it did.
   */
  reason: string;
  /** True when at least one symbol on the most recent render came from Yahoo. */
  yahooActive: boolean;
  /**
   * What mode the deployment is currently in:
   * - "iress"   → IRESS production seat is live and serving prices.
   * - "hybrid"  → IRESS is alive AND Yahoo is filling stale/missing rows.
   * - "yahoo"   → IRESS is silent / degraded; Yahoo is the only price source.
   * - "db"      → DB is the only live source (mock / uat / worker-silent paths).
   * - "off"     → mock seed / unconfigured.
   * - "down"    → no live price source available.
   */
  mode: "iress" | "hybrid" | "yahoo" | "db" | "off" | "down";
}

/**
 * Decide the active data source. Order of precedence (first match wins):
 *
 *   1. MOCK      → `iressMode === "mock"` — fixed mock seed, no live feed.
 *   2. IRESS·UAT → `iressMode === "uat"` and the worker is alive — sandbox seat.
 *   3. HYBRID    → IRESS production seat is alive (worker heartbeating AND the
 *                   last IRESS service call is healthy) AND Yahoo is filling
 *                   stale DB rows this render.
 *   4. IRESS·PROD → IRESS production seat is alive (worker heartbeating AND the
 *                   last IRESS service call is healthy) AND no Yahoo fill needed.
 *   5. IRESS degraded / silent → IRESS mode is live but the worker is silent OR
 *                   the most recent IRESS service call is error/warn past the
 *                   freshness window. Fall through to DB / Yahoo based on what's
 *                   actually serving.
 *   6. SUPABASE  → DB has a fresh row; that's the source.
 *   7. YAHOO     → DB is stale/missing AND Yahoo is actively filling.
 *   8. UNAVAILABLE → nothing serves a price.
 */
export function resolveActiveDataSource(inputs: ActiveSourceInputs): ActiveSourceResult {
  const {
    iressMode,
    workerAlive,
    lastQuoteSyncAt,
    fallbackCount: rawFallbackCount,
    dbFresh = "missing",
    iressEvents,
    nowMs = Date.now(),
  } = inputs;
  const fallbackCount = rawFallbackCount ?? 0;
  const yahooActive = fallbackCount > 0;

  // MOCK / UAT are explicit deployment modes — never fall through to IRESS
  // labels even if the worker happens to be heartbeating.
  if (iressMode === "mock") {
    return {
      kind: "mock",
      reason: "IRESS mode is mock — no live market data. Seed fixtures only.",
      yahooActive,
      mode: "off",
    };
  }
  if (iressMode === "uat") {
    return {
      kind: "uat",
      reason: workerAlive
        ? "IRESS UAT/test seat active — data flows through the Railway worker; not production market data."
        : "IRESS UAT mode configured but no worker heartbeat — falling through to mock seed.",
      yahooActive,
      mode: "off",
    };
  }

  // IRESS·PROD requires BOTH the worker to be alive AND the most recent
  // IRESS service call to be healthy (no error/warn in the last 5 min).
  // Without the second gate, a worker that keeps heartbeating but whose
  // SOAP calls have been failing for minutes still reports as IRESS·PROD.
  const iressServiceOk = isIressServiceHealthy(iressEvents, nowMs);
  const iressLive = iressMode === "live" && workerAlive && iressServiceOk;

  if (iressLive && yahooActive) {
    return {
      kind: "hybrid",
      reason: `IRESS production seat is live; ${fallbackCount} symbol${fallbackCount === 1 ? "" : "s"} on the Yahoo fallback because the DB row was stale past IRESS_STALE_FALLBACK_HOURS.`,
      yahooActive: true,
      mode: "hybrid",
    };
  }

  if (iressLive) {
    const since = lastQuoteSyncAt
      ? `${Math.max(0, Math.round((nowMs - new Date(lastQuoteSyncAt).getTime()) / 1000))}s ago`
      : "no quote sync yet";
    return {
      kind: "iress",
      reason: `IRESS production seat is live — last quote sync ${since}.`,
      yahooActive: false,
      mode: "iress",
    };
  }

  // IRESS mode is "live" but the worker is silent OR the most recent IRESS
  // service call is error/warn. Build the right reason for the operator.
  const silentReason = !workerAlive
    ? "IRESS worker silent past the heartbeat window"
    : !iressServiceOk
      ? "IRESS service calls returning errors — worker is up but IRESS is not"
      : "IRESS feed is not serving live prices right now";

  if (yahooActive) {
    return {
      kind: "yahoo",
      reason: `${silentReason} — Yahoo live fallback is serving prices for stale DB rows.`,
      yahooActive: true,
      mode: "yahoo",
    };
  }

  if (dbFresh === "fresh") {
    return {
      kind: "supabase",
      reason: `${silentReason}; the most recent Supabase tick is still inside the freshness window.`,
      yahooActive: false,
      mode: "db",
    };
  }

  if (iressMode === "live" || iressMode == null) {
    // Even when the DB row is stale AND no Yahoo fallback fired yet this
    // render, this is a production deployment — Yahoo IS the fallback path
    // (see `IRESS_STALE_FALLBACK_HOURS` + `/api/quotes` + `/api/equities`
    // + `/api/portfolio` + the rest). Telling the operator "UNAVAILABLE" here
    // would mean "the cockpit can't show what you're serving" — not "no
    // price exists". Show YAHOO with the right reason so the chip flips to
    // its real state the moment the next BFF call counts a Yahoo fill.
    if (fallbackCount === 0 && dbFresh === "missing") {
      return {
        kind: "yahoo",
        reason: `${silentReason}; no fresh DB row. Yahoo will resolve any symbol on the next BFF call.`,
        yahooActive: false,
        mode: "yahoo",
      };
    }
    return {
      kind: "unavailable",
      reason: `${silentReason}; DB rows stale past IRESS_STALE_FALLBACK_HOURS, no Yahoo fallback active.`,
      yahooActive: false,
      mode: "down",
    };
  }

  // Mock / UAT fallthrough (shouldn't normally reach here — the early
  // branches handle those modes — but keep the fallback explicit).
  return {
    kind: iressMode === "uat" ? "uat" : "mock",
    reason: `IRESS mode ${iressMode} without a live feed path.`,
    yahooActive,
    mode: "off",
  };
}

/** Convenience: ms since a timestamp, with safe handling of null/invalid. */
export function ageMs(asOf: string | null | undefined, nowMs: number = Date.now()): number | null {
  if (!asOf) return null;
  const ms = new Date(asOf).getTime();
  if (!Number.isFinite(ms)) return null;
  const diff = nowMs - ms;
  if (diff < 0) return 0;
  return diff <= 7 * DAY_MS ? diff : null;
}
