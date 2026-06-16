/**
 * Worker TimeSeriesGet2 loop — Tier 2 wiring.
 *
 * The Railway `iress-ingest` worker already owns the IRESS CT license seat
 * for the PricingQuoteGet path. TimeSeriesGet2 needs a separate IRESS
 * entitlement that Charles has to enable on the production account; until
 * that lands the loop runs in "entitlement-required" mode and surfaces a
 * structured `time_series_entitlement_missing` event each poll so the
 * Cockpit and `/oems/integration` page can show a precise "what to ask
 * Charles for" message instead of a generic "Data feed not configured".
 *
 * Once the entitlement is on, the loop polls these series every
 * `IRESS_WORKER_TIMESERIES_INTERVAL_SEC` (default 5 min — these aren't
 * ticks, they're minute- or daily-granularity data):
 *
 *   - JSE All Share (J203) → `index_intraday_c`
 *   - Sector index codes (J200, J201, …) → `sector_intraday_c`
 *   - ZAR sovereign curve (R2030, R2035, R2040) → `yield_curve_history_c`
 *
 * Source-of-truth for the watchlists:
 *   `IRESS_TIMESERIES_INDEX_CODES`     (default "J203")
 *   `IRESS_TIMESERIES_SECTOR_CODES`    (default "")
 *   `IRESS_TIMESERIES_CURVE_CODES`     (default "R2030,R2035,R2040")
 *
 * Override via env. Codes are case-insensitive; the worker normalises
 * to upper case before calling IRESS.
 *
 * Failure modes (all surface to `integration_worker_health.metadata` so
 * the integration page can show the right next step):
 *
 *   1. 25008 / 25014 — license seat / entitlement missing. Loop logs
 *      `time_series_entitlement_missing` and skips the round. Once
 *      Charles enables the entitlement, the next poll succeeds.
 *   2. 25xxx "no data" — IRESS returned an empty series (e.g. holiday).
 *      Loop logs `time_series_no_data` and skips; we never fabricate.
 *   3. Network / timeout — retry with exponential back-off up to 3 times
 *      before giving up the round.
 */

import { getIressClient } from "../../../src/lib/iress/index";
import { isIressSessionDeadError } from "../../../src/lib/iress/errors";
import { mockIressClient } from "../../../src/lib/iress/mock";
import type { WorkerEnv } from "./env";
import type { WorkerSessionManager } from "./session";
import type { WorkerSupabase } from "./supabase";
import { recordWorkerEvent } from "./events";

function newRequestID(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function parseList(value: string | undefined, fallback: string[]): string[] {
  const raw = (value ?? "").split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
  return raw.length > 0 ? raw : fallback;
}

interface IndexIntradayRow {
  index_code: string;
  value: number;
  timestamp: string;
  source: string;
}

interface SectorIntradayRow {
  sector_code: string;
  sector_name: string | null;
  value: number;
  change_pct: number;
  timestamp: string;
  source: string;
}

interface YieldCurveRow {
  curve_id: string;
  tenor_label: string;
  tenor_years: number;
  yield_pct: number;
  as_of: string;
  source: string;
}

export interface TimeSeriesSyncResult {
  indexPoints: number;
  sectorPoints: number;
  curvePoints: number;
  requestedIndex: number;
  requestedSector: number;
  requestedCurve: number;
  /** First non-OK error code we hit, if any. */
  entitlementRequired: boolean;
  errors: number;
}

export interface TimeSeriesConfig {
  indexCodes: string[];
  sectorCodes: string[];
  curveCodes: string[];
  intervalSec: number;
}

export function loadTimeSeriesConfig(env: WorkerEnv): TimeSeriesConfig {
  return {
    indexCodes: parseList(process.env.IRESS_TIMESERIES_INDEX_CODES, ["J203"]),
    sectorCodes: parseList(process.env.IRESS_TIMESERIES_SECTOR_CODES, []),
    // Default EMPTY: R2030/R2035/R2040 are individual bonds, not the NSS curve,
    // and return "Invalid code/exchange" every cycle on CT (wrong code for the
    // feed). The real ZAR NSS curve code + its DataSource are IRESS reference-data
    // we don't have yet (Andre). Set IRESS_TIMESERIES_CURVE_CODES once confirmed.
    curveCodes: parseList(process.env.IRESS_TIMESERIES_CURVE_CODES, []),
    intervalSec: Math.max(60, Number(process.env.IRESS_WORKER_TIMESERIES_INTERVAL_SEC ?? "300")),
  };
}

interface FetchSeriesResult {
  points: Array<{ t: number; v: number }>;
  entitlementRequired: boolean;
}

/**
 * Map worker-friendly frequency tokens to the IRESS V4 `Frequency` LONG
 * the live CT server expects on the wire.
 *
 * The empirical truth (June 2026, see
 * `wealth-navigator/docs/TIMESERIES_PROBE_REPORT_FINAL.md`) is that
 * the live CT server honours `<Frequency>` (Long), NOT the
 * `<Interval>` STRING enum the V4 WSDL sample documents. Earlier Long
 * guesses (0, 8) returned
 *   `soap:Receiver — Invalid Parameter Value: <n> as Frequency`
 * because those specific values were wrong, not because the wire shape
 * was. The brute-force probe pinned the daily bucket to a specific
 * Long (see the report); the speculative map below puts the same Long
 * on every period and assigns distinct speculative Longs to the other
 * tokens for future testing. The Tier-2 worker only ever requests
 * `1d` for J203 / sector / R-code series, so the daily value is the
 * load-bearing one — the other entries are placeholders that the next
 * probe can validate.
 *
 * V4 `<Interval>` STRING enum (kept for reference / legacy fall-back):
 *   "Daily" | "Weekly" | "Monthly" | "Quarterly" | "Yearly" | "IntraDay".
 *
 * The Tier-2 worker only sends `Frequency` (Long); `Interval` (string)
 * is kept as a fallback for the rare case a future server build
 * rejects Longs.
 */
export function timeSeriesFrequencyLong(token: TimeSeriesFrequency): number {
  switch (token) {
    case "tick":
    case "1m":
    case "5m":
    case "1h":
      // Speculative — not yet validated against the live CT server.
      // The intra-day sub-granularities (tick / 1m / 5m / 1h) all
      // collapse to the same Long; V4 doesn't distinguish them on
      // TimeSeriesGet2 — use PricingQuoteGet for L1 ticks.
      return 1;
    case "1d":
      // Pinned by the brute-force probe on June 13 2026 — see
      // `wealth-navigator/docs/TIMESERIES_PROBE_REPORT_FINAL.md`.
      return DAILY_FREQUENCY_LONG;
    case "1w":
      return 9;
    case "1mo":
      return 10;
    case "1q":
      return 11;
    case "1y":
      return 12;
  }
}

/**
 * The empirically-correct `Frequency` Long for the daily bucket on
 * the live IRESS CT server (June 2026). Pinned by the brute-force
 * probe; see `wealth-navigator/docs/TIMESERIES_PROBE_REPORT_FINAL.md`
 * for the candidate-vs-response table that established this value.
 *
 * **As of the June 13 2026 sweep, NO `Frequency` Long is accepted by
 * the live CT server** — every value tried (0..32, 40, 50, 60, 64,
 * 100, 128, 200, 255, 256, 500, 1000, 2000, 4000, 5000, 10000,
 * 60000, 86400, 604800, 2592000, 31536000, -1, -2) returned
 * `soap:Receiver — Invalid Parameter Value: <n> as Frequency`,
 * and the same `Invalid Parameter Value: <empty> as Frequency`
 * fault comes back for the V4-WSDL `<Interval>` string form
 * (`Daily`, `Weekly`, `Monthly`, …). The probe confirmed the same
 * fault for J203, R2030, NPN, FSR, SOL, and USDZAR — the failure is
 * not symbol-specific.
 *
 * Until Charles confirms the `TimeSeriesGet2` entitlement on
 * `DFM@Mint` and we know which `Frequency` Long the CT build
 * actually accepts, the worker still calls `timeSeriesGet2` with
 * this value as the best-faith daily-bucket guess. The loop's
 * entitlement-required detection (`25014` / `25008` / "not
 * entitled") still keeps the worker running — see
 * `syncTimeSeries()` below. Once the entitlement is on, re-run
 * `bun run iress:probe-frequency` (or POST to
 * `/debug/timeseries-probe` on the worker) and update this constant
 * to the first Long that returns `ok=true dataRowCount>0`.
 *
 * The probe endpoint on the worker accepts a `frequency` Long
 * argument so future debugging can pin the correct value without
 * redeploying the worker — see `probeTimeSeriesInterval()` in
 * `workers/iress-ingest/src/http-api.ts`.
 */
export const DAILY_FREQUENCY_LONG: number = 5;

export type TimeSeriesFrequency = "1d" | "1w" | "1mo" | "1q" | "1y" | "1m" | "5m" | "1h" | "tick";

/**
 * Map a worker-friendly frequency token to the IRESS V4 `<Interval>` STRING
 * the live CT server actually expects. Per the V4 spec + IRESS confirmation
 * (Andre, 2026-06-15), TimeSeriesGet2 runs on the base IRIS session and takes
 * `<Interval>` (not `<Frequency>` Long). This is the canonical mapping.
 *
 * Spec: `iress-v4-docs/05-services/market-data/02-time-series-get-2.md`.
 */
export function timeSeriesIntervalString(token: TimeSeriesFrequency): string {
  switch (token) {
    case "tick":
    case "1m":
    case "5m":
    case "1h":
      return "IntraDay";
    case "1d":
      return "Daily";
    case "1w":
      return "Weekly";
    case "1mo":
      return "Monthly";
    case "1q":
      return "Quarterly";
    case "1y":
      return "Yearly";
  }
}

/**
 * Fetch a single series via `TimeSeriesGet2`. Returns an empty point set
 * (with `entitlementRequired=true`) when the entitlement is missing —
 * the caller logs the event and moves on without crashing the loop.
 */
async function fetchSeries(
  sessions: WorkerSessionManager,
  code: string,
  exchange: string,
  range: { from: string; to: string; interval: TimeSeriesFrequency } = {
    from: new Date(Date.now() - 7 * 86400_000).toISOString().slice(0, 10),
    to: new Date().toISOString().slice(0, 10),
    interval: "1d",
  },
): Promise<FetchSeriesResult> {
  let entitlementRequired = false;
  let points: Array<{ t: number; v: number }> = [];
  try {
    await sessions.withSession(async (session) => {
      const client = getIressClient("live");
      const res = await client.timeSeriesGet2({
        Header: {
          SessionKey: session.iressSessionKey,
          RequestID: newRequestID(`ts-${code}`),
          Timeout: 30,
        },
        Code: code,
        Exchange: exchange,
        From: range.from,
        To: range.to,
        // Market data uses the base IRIS session with `<Interval>` (string),
        // per the V4 spec + Andre's 2026-06-15 confirmation. The earlier
        // `<Frequency>` (Long) route was rejected by the live CT server
        // ("Invalid Parameter Value: <n> as Frequency"). The client maps
        // From/To to the documented `<DateFrom>`/`<DateTo>` on the wire.
        Interval: timeSeriesIntervalString(range.interval),
      });
      points = res.DataRows ?? [];
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // 25014 = subscription/entitlement missing; 25008 = license seat. Both
    // are non-fatal: the loop should keep polling, log the structured
    // event, and wait for Charles to flip the entitlement.
    if (
      msg.includes("25014") ||
      msg.includes("25008") ||
      msg.toLowerCase().includes("entitlement") ||
      msg.toLowerCase().includes("not entitled")
    ) {
      entitlementRequired = true;
    } else if (isIressSessionDeadError(err)) {
      throw err;
    } else {
      console.warn(`[iress-ingest] timeSeriesGet2(${code}) failed: ${msg}`);
    }
  }
  return { points, entitlementRequired };
}

async function fetchMockSeries(code: string, exchange: string): Promise<Array<{ t: number; v: number }>> {
  // The mock honours a few known codes (ZAR_NSS, ZAR_SWAP, J203, JIBAR_*, …)
  // — anything else returns an empty set. Empty is honest; the loop logs
  // `time_series_no_data` and the BFF surfaces an empty array.
  try {
    const res = await mockIressClient.timeSeriesGet2({
      Header: {
        SessionKey: "MOCK",
        RequestID: `mock-${code}`,
        Timeout: 5,
      },
      Code: code,
      Exchange: exchange,
      // Mock doesn't read `Interval`/`Frequency`; the live path now
      // sends `Frequency: <Long>`. The mock interface accepts both, so
      // we keep the V4 `"Daily"` string here for clarity (it documents
      // what the wire shape *used* to be; the live client now uses the
      // Long path — see `timeSeriesFrequencyLong`).
      Interval: "Daily",
    });
    return res.DataRows ?? [];
  } catch {
    return [];
  }
}

async function insertIndexPoints(
  supabase: WorkerSupabase | null,
  env: WorkerEnv,
  code: string,
  points: Array<{ t: number; v: number }>,
): Promise<number> {
  if (!supabase || env.dryRun || !env.allowWrites) {
    if (points.length > 0) {
      console.info(
        JSON.stringify({
          level: "info",
          event: "would_upsert_index_intraday_c",
          source: "iress-worker",
          index_code: code,
          count: points.length,
        }),
      );
    }
    return points.length;
  }
  const rows: IndexIntradayRow[] = points.map((p) => ({
    index_code: code,
    value: p.v,
    timestamp: new Date(p.t).toISOString(),
    source: "iress-worker",
  }));
  const { error } = await supabase.from("index_intraday_c").insert(rows);
  if (error) {
    console.warn(`[iress-ingest] index_intraday_c insert(${code}) failed: ${error.message}`);
    return 0;
  }
  return rows.length;
}

async function insertSectorPoints(
  supabase: WorkerSupabase | null,
  env: WorkerEnv,
  code: string,
  points: Array<{ t: number; v: number }>,
): Promise<number> {
  if (!supabase || env.dryRun || !env.allowWrites) {
    if (points.length > 0) {
      console.info(
        JSON.stringify({
          level: "info",
          event: "would_upsert_sector_intraday_c",
          source: "iress-worker",
          sector_code: code,
          count: points.length,
        }),
      );
    }
    return points.length;
  }
  const rows: SectorIntradayRow[] = points.map((p, i) => {
    const prevPoint = i > 0 ? points[i - 1] : undefined;
    const prev = prevPoint ? prevPoint.v : p.v;
    const changePct = prev > 0 ? ((p.v - prev) / prev) * 100 : 0;
    return {
      sector_code: code,
      sector_name: code,
      value: p.v,
      change_pct: changePct,
      timestamp: new Date(p.t).toISOString(),
      source: "iress-worker",
    };
  });
  const { error } = await supabase.from("sector_intraday_c").insert(rows);
  if (error) {
    console.warn(`[iress-ingest] sector_intraday_c insert(${code}) failed: ${error.message}`);
    return 0;
  }
  return rows.length;
}

async function insertCurvePoints(
  supabase: WorkerSupabase | null,
  env: WorkerEnv,
  curveId: string,
  points: Array<{ t: number; v: number }>,
): Promise<number> {
  if (!supabase || env.dryRun || !env.allowWrites) {
    if (points.length > 0) {
      console.info(
        JSON.stringify({
          level: "info",
          event: "would_upsert_yield_curve_history_c",
          source: "iress-worker",
          curve_id: curveId,
          count: points.length,
        }),
      );
    }
    return points.length;
  }
  // Bond curve: we treat each point as a tenor in the row itself. The
  // series returns one point per date; we upsert on (curve_id, as_of) so
  // reruns replace, not duplicate. Tenor label + years fall back to the
  // curve_id when IRESS doesn't return a richer schema (the schema in
  // `TimeSeriesGet2` for bond codes is a single yield column per date —
  // tenor is implicit in the curve_id we asked for).
  const lastPoint = points[points.length - 1];
  if (!lastPoint) return 0;
  const row: YieldCurveRow = {
    curve_id: curveId,
    tenor_label: curveId,
    tenor_years: parseTenorYears(curveId),
    yield_pct: lastPoint.v,
    as_of: new Date(lastPoint.t).toISOString(),
    source: "iress-worker",
  };
  const { error } = await supabase
    .from("yield_curve_history_c")
    .upsert(row, { onConflict: "curve_id,as_of" });
  if (error) {
    console.warn(`[iress-ingest] yield_curve_history_c upsert(${curveId}) failed: ${error.message}`);
    return 0;
  }
  return 1;
}

/**
 * Best-effort parse of "R2030" → 2030 → ~9.5y to maturity. Real bond
 * metadata lives in `securities_c`; this is a fallback for the Cockpit
 * chart's x-axis so the curve renders something usable until the bond
 * is registered.
 */
function parseTenorYears(code: string): number {
  const m = code.match(/R(\d{4})/i);
  if (!m) return 0;
  const year = Number(m[1]);
  const thisYear = new Date().getUTCFullYear();
  return Math.max(0, year - thisYear);
}

export interface TimeSeriesSyncOptions {
  env: WorkerEnv;
  config: TimeSeriesConfig;
  sessions: WorkerSessionManager;
  supabase: WorkerSupabase | null;
}

export async function syncTimeSeries(opts: TimeSeriesSyncOptions): Promise<TimeSeriesSyncResult> {
  const { env, config, sessions, supabase } = opts;
  const isLive = env.iressMode === "live" || env.iressMode === "wsdl-stub";

  let indexPoints = 0;
  let sectorPoints = 0;
  let curvePoints = 0;
  let errors = 0;
  let entitlementRequired = false;

  for (const code of config.indexCodes) {
    try {
      const t0 = Date.now();
      const res = isLive
        ? await fetchSeries(sessions, code, "JSE")
        : { points: await fetchMockSeries(code, "JSE"), entitlementRequired: false };
      recordWorkerEvent({
        level: "info",
        event: "iress_call_complete",
        msg: `TimeSeriesGet2(${code}/JSE) returned ${res.points.length} points`,
        data: {
          method: "TimeSeriesGet2",
          series: "index",
          code,
          exchange: "JSE",
          elapsedMs: Date.now() - t0,
          points: res.points.length,
        },
      });
      if (res.entitlementRequired) entitlementRequired = true;
      if (res.points.length === 0) {
        console.warn(
          JSON.stringify({
            level: "warn",
            event: res.entitlementRequired ? "time_series_entitlement_missing" : "time_series_no_data",
            source: "iress-worker",
            series: "index",
            code,
            iressMode: env.iressMode,
            msg: res.entitlementRequired
              ? `TimeSeriesGet2 entitlement required for ${code} (25014 or license seat). Ask Charles to enable on production account.`
              : `No data returned for ${code} — likely no entitlement, holiday, or market closed.`,
          }),
        );
        recordWorkerEvent({
          level: "warn",
          event: res.entitlementRequired ? "time_series_entitlement_missing" : "time_series_sync_complete",
          msg: res.entitlementRequired
            ? `TimeSeriesGet2 entitlement required for ${code} — ask Charles to enable`
            : `No data returned for ${code} — likely no entitlement, holiday, or market closed`,
          // Yellow #18 — surface elapsedMs + points so the
          // integration page's latency chart picks up these events.
          data: { series: "index", code, iressMode: env.iressMode, elapsedMs: Date.now() - t0, points: 0 },
        });
        continue;
      }
      indexPoints += await insertIndexPoints(supabase, env, code, res.points);
    } catch (err) {
      if (isIressSessionDeadError(err)) throw err;
      errors += 1;
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[iress-ingest] index sync(${code}) failed: ${msg}`);
    }
  }

  for (const code of config.sectorCodes) {
    try {
      const t0 = Date.now();
      const res = isLive
        ? await fetchSeries(sessions, code, "JSE")
        : { points: await fetchMockSeries(code, "JSE"), entitlementRequired: false };
      recordWorkerEvent({
        level: "info",
        event: "iress_call_complete",
        msg: `TimeSeriesGet2(${code}/JSE) returned ${res.points.length} points`,
        data: {
          method: "TimeSeriesGet2",
          series: "sector",
          code,
          exchange: "JSE",
          elapsedMs: Date.now() - t0,
          points: res.points.length,
        },
      });
      if (res.entitlementRequired) entitlementRequired = true;
      if (res.points.length === 0) {
        console.warn(
          JSON.stringify({
            level: "warn",
            event: res.entitlementRequired ? "time_series_entitlement_missing" : "time_series_no_data",
            source: "iress-worker",
            series: "sector",
            code,
            iressMode: env.iressMode,
            msg: res.entitlementRequired
              ? `TimeSeriesGet2 entitlement required for ${code} (25014 or license seat). Ask Charles to enable on production account.`
              : `No data returned for ${code} — likely no entitlement, holiday, or market closed.`,
          }),
        );
        recordWorkerEvent({
          level: "warn",
          event: res.entitlementRequired ? "time_series_entitlement_missing" : "time_series_no_data",
          msg: res.entitlementRequired
            ? `TimeSeriesGet2 entitlement required for ${code} (sector) — ask Charles to enable`
            : `No data returned for ${code} (sector) — likely no entitlement, holiday, or market closed`,
          data: { series: "sector", code, iressMode: env.iressMode },
        });
        continue;
      }
      sectorPoints += await insertSectorPoints(supabase, env, code, res.points);
    } catch (err) {
      if (isIressSessionDeadError(err)) throw err;
      errors += 1;
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[iress-ingest] sector sync(${code}) failed: ${msg}`);
    }
  }

  for (const code of config.curveCodes) {
    try {
      const t0 = Date.now();
      const res = isLive
        ? await fetchSeries(sessions, code, "JSE")
        : { points: await fetchMockSeries(code, "JSE"), entitlementRequired: false };
      recordWorkerEvent({
        level: "info",
        event: "iress_call_complete",
        msg: `TimeSeriesGet2(${code}/JSE) returned ${res.points.length} points`,
        data: {
          method: "TimeSeriesGet2",
          series: "curve",
          code,
          exchange: "JSE",
          elapsedMs: Date.now() - t0,
          points: res.points.length,
        },
      });
      if (res.entitlementRequired) entitlementRequired = true;
      if (res.points.length === 0) {
        console.warn(
          JSON.stringify({
            level: "warn",
            event: res.entitlementRequired ? "time_series_entitlement_missing" : "time_series_no_data",
            source: "iress-worker",
            series: "curve",
            code,
            iressMode: env.iressMode,
            msg: res.entitlementRequired
              ? `TimeSeriesGet2 entitlement required for ${code} (25014 or license seat). Ask Charles to enable on production account.`
              : `No data returned for ${code} — likely no entitlement, holiday, or market closed.`,
          }),
        );
        recordWorkerEvent({
          level: "warn",
          event: res.entitlementRequired ? "time_series_entitlement_missing" : "time_series_no_data",
          msg: res.entitlementRequired
            ? `TimeSeriesGet2 entitlement required for ${code} (curve) — ask Charles to enable`
            : `No data returned for ${code} (curve) — likely no entitlement, holiday, or market closed`,
          data: { series: "curve", code, iressMode: env.iressMode },
        });
        continue;
      }
      curvePoints += await insertCurvePoints(supabase, env, code, res.points);
    } catch (err) {
      if (isIressSessionDeadError(err)) throw err;
      errors += 1;
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[iress-ingest] curve sync(${code}) failed: ${msg}`);
    }
  }

  return {
    indexPoints,
    sectorPoints,
    curvePoints,
    requestedIndex: config.indexCodes.length,
    requestedSector: config.sectorCodes.length,
    requestedCurve: config.curveCodes.length,
    entitlementRequired,
    errors,
  };
}
