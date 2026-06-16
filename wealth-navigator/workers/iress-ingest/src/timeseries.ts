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
  /** Nominal ZAR govt curve constituents (GOVI basket) → curve_id `ZAR_NSS`. */
  curveCodes: string[];
  /** Inflation-linked (ILB) curve constituents → curve_id `ZAR_REAL`. */
  realCodes: string[];
  /** Exchange for the curve/bond codes — CONFIRMED `YFX` for ZAR govt bonds. */
  curveExchange: string;
  /** DataSource for the curve/bond codes — CONFIRMED `YFXD` (NOT JSED). */
  curveDataSource: string;
  intervalSec: number;
}

export function loadTimeSeriesConfig(env: WorkerEnv): TimeSeriesConfig {
  return {
    indexCodes: parseList(process.env.IRESS_TIMESERIES_INDEX_CODES, ["J203"]),
    sectorCodes: parseList(process.env.IRESS_TIMESERIES_SECTOR_CODES, []),
    // CONFIRMED live (2026-06-16): the ZAR govt yield curve is the GOVI-basket
    // bonds on Exchange=YFX, DataSource=YFXD. The earlier "Invalid code/exchange"
    // / "Invalid access" failures were the WRONG exchange+feed (JSE/JSED), not a
    // missing entitlement — TimeSeriesGet2(R2030, YFX, YFXD) returns full yield
    // history. SecuritySearchGet was used to discover the codes/exchange. These
    // constituents are written as tenor points of one curve (`ZAR_NSS`), which
    // is what /api/curves/ZAR_NSS reads.
    curveCodes: parseList(process.env.IRESS_TIMESERIES_CURVE_CODES, [
      "R186",
      "R2030",
      "R213",
      "R2032",
      "R2035",
      "R2037",
      "R2040",
      "R2044",
      "R2048",
    ]),
    // Inflation-linked bonds → the real yield curve (`ZAR_REAL`). I-series codes
    // self-describe the maturity year (I2033 → 2033). Codes that don't resolve
    // are skipped gracefully, so the curve uses whatever the feed returns.
    // I2025 omitted — it returns "Invalid code/exchange" on YFX (doesn't exist
    // on this feed). The remaining I-series resolve (confirmed: curve ok=14).
    realCodes: parseList(process.env.IRESS_TIMESERIES_REAL_CODES, [
      "I2029",
      "I2033",
      "I2038",
      "I2046",
      "I2050",
    ]),
    curveExchange: (process.env.IRESS_TIMESERIES_CURVE_EXCHANGE ?? "YFX").trim() || "YFX",
    curveDataSource: (process.env.IRESS_TIMESERIES_CURVE_DATASOURCE ?? "YFXD").trim() || "YFXD",
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
  dataSource?: string,
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
        // Exchange-specific feed (CONFIRMED live): JSE→JSED, YFX→YFXD. Sending
        // the wrong one returns error 5 ("Invalid access"). When omitted the
        // live client falls back to IRESS_TS_DATASOURCE (JSED).
        DataSource: dataSource,
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

/**
 * Maturity year overrides for legacy-numbered ZAR bonds whose code does NOT
 * encode the maturity year (modern benchmarks like R2030 / I2033 do). Used
 * only to position the tenor on the curve x-axis — the yields come straight
 * off IRESS.
 */
const BOND_MATURITY_YEAR: Record<string, number> = {
  R186: 2026,
  R213: 2031,
  R209: 2036,
  R197: 2023,
  R202: 2033,
  R210: 2028,
};

/** Tenor in years from a bond code (embedded year, with a legacy override). */
function bondTenorYears(code: string): number {
  const c = code.toUpperCase();
  const explicit = BOND_MATURITY_YEAR[c];
  let year = explicit ?? 0;
  if (!year) {
    const m = c.match(/(\d{4})/); // R2030 → 2030, I2033 → 2033
    year = m ? Number(m[1]) : 0;
  }
  if (!year) return 0;
  const now = new Date();
  const nowFractional = now.getUTCFullYear() + now.getUTCMonth() / 12;
  return Math.max(0.05, Number((year - nowFractional).toFixed(2)));
}

/**
 * Build + persist a multi-tenor curve snapshot (e.g. `ZAR_NSS` / `ZAR_REAL`)
 * from its constituent bond codes. Each constituent contributes one tenor
 * point (latest yield); all tenors share one `as_of` (the latest data date)
 * so `/api/curves/<id>` returns a single clean fitted curve ordered by tenor.
 *
 * The table has no unique constraint, so we INSERT one snapshot per data date
 * and SKIP if a snapshot for that date already exists — avoids duplicate tenor
 * rows while retaining daily history (bond data is EOD, so one curve/day).
 */
async function syncCurveSnapshot(
  opts: { sessions: WorkerSessionManager; supabase: WorkerSupabase | null; env: WorkerEnv; isLive: boolean },
  curveId: string,
  codes: string[],
  exchange: string,
  dataSource: string,
): Promise<{ tenors: number; entitlementRequired: boolean }> {
  const { sessions, supabase, env, isLive } = opts;
  let entitlementRequired = false;
  const tenors: Array<{ code: string; tenorYears: number; yieldPct: number; dateMs: number }> = [];

  for (const code of codes) {
    try {
      const res = isLive
        ? await fetchSeries(sessions, code, exchange, undefined, dataSource)
        : { points: await fetchMockSeries(code, exchange), entitlementRequired: false };
      if (res.entitlementRequired) entitlementRequired = true;
      const last = res.points[res.points.length - 1];
      if (!last || !(last.v > 0)) continue; // skip codes the feed doesn't carry
      // YFX bond yields arrive as a decimal fraction (0.0809 = 8.09%); the
      // yield_pct column is a percentage. A value already ≥ 1 is left as-is.
      const yieldPct = last.v < 1 ? Number((last.v * 100).toFixed(4)) : last.v;
      tenors.push({ code, tenorYears: bondTenorYears(code), yieldPct, dateMs: last.t });
    } catch (err) {
      if (isIressSessionDeadError(err)) throw err;
      console.warn(`[iress-ingest] curve(${curveId}/${code}) failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (tenors.length === 0) return { tenors: 0, entitlementRequired };

  // Single as_of for the whole curve = the latest constituent data date.
  const asOf = new Date(Math.max(...tenors.map((t) => t.dateMs))).toISOString();
  tenors.sort((a, b) => a.tenorYears - b.tenorYears);

  if (!supabase || env.dryRun || !env.allowWrites) {
    console.info(
      JSON.stringify({ level: "info", event: "would_upsert_yield_curve_history_c", curve_id: curveId, tenors: tenors.length, asOf }),
    );
    return { tenors: tenors.length, entitlementRequired };
  }

  // Idempotent per data date: skip if a snapshot for this date already exists.
  const { data: latestRows } = await supabase
    .from("yield_curve_history_c")
    .select("as_of")
    .eq("curve_id", curveId)
    .order("as_of", { ascending: false })
    .limit(1);
  const latestAsOf = (latestRows ?? [])[0]?.as_of as string | undefined;
  if (latestAsOf && latestAsOf.slice(0, 10) === asOf.slice(0, 10)) {
    return { tenors: tenors.length, entitlementRequired }; // already have today's curve
  }

  const rows: YieldCurveRow[] = tenors.map((t) => ({
    curve_id: curveId,
    tenor_label: t.code,
    tenor_years: t.tenorYears,
    yield_pct: t.yieldPct,
    as_of: asOf,
    source: "iress-worker",
  }));
  const { error } = await supabase.from("yield_curve_history_c").insert(rows);
  if (error) {
    console.warn(`[iress-ingest] yield_curve_history_c insert(${curveId}) failed: ${error.message}`);
    return { tenors: 0, entitlementRequired };
  }
  console.info(JSON.stringify({ level: "info", event: "yield_curve_snapshot", curve_id: curveId, tenors: rows.length, asOf }));
  return { tenors: rows.length, entitlementRequired };
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

  // Curves: build each as a single multi-tenor snapshot from its constituent
  // bonds (ZAR_NSS = GOVI nominal basket, ZAR_REAL = ILB basket), so
  // /api/curves/<id> returns one fitted curve ordered by tenor.
  const curveSpecs: Array<{ curveId: string; codes: string[] }> = [
    { curveId: "ZAR_NSS", codes: config.curveCodes },
    { curveId: "ZAR_REAL", codes: config.realCodes },
  ];
  for (const spec of curveSpecs) {
    if (spec.codes.length === 0) continue;
    try {
      const t0 = Date.now();
      const res = await syncCurveSnapshot(
        { sessions, supabase, env, isLive },
        spec.curveId,
        spec.codes,
        config.curveExchange,
        config.curveDataSource,
      );
      if (res.entitlementRequired) entitlementRequired = true;
      curvePoints += res.tenors;
      recordWorkerEvent({
        level: res.tenors > 0 ? "info" : "warn",
        event: res.tenors > 0 ? "iress_call_complete" : "time_series_no_data",
        msg: `Curve ${spec.curveId} (${config.curveExchange}/${config.curveDataSource}) → ${res.tenors} tenors`,
        data: {
          method: "TimeSeriesGet2",
          series: "curve",
          code: spec.curveId,
          exchange: config.curveExchange,
          dataSource: config.curveDataSource,
          elapsedMs: Date.now() - t0,
          points: res.tenors,
        },
      });
    } catch (err) {
      if (isIressSessionDeadError(err)) throw err;
      errors += 1;
      console.warn(`[iress-ingest] curve sync(${spec.curveId}) failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return {
    indexPoints,
    sectorPoints,
    curvePoints,
    requestedIndex: config.indexCodes.length,
    requestedSector: config.sectorCodes.length,
    requestedCurve: config.curveCodes.length + config.realCodes.length,
    entitlementRequired,
    errors,
  };
}
