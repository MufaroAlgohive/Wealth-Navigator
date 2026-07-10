/**
 * TimeSeriesGet2 entitlement probe — Andre Pietersen unblock (2026-07-09).
 *
 * **Context.** Andre confirmed the `TimeSeriesGet2` entitlement is live for the
 * `DFM@Mint` production account as of 2026-07-09. His example used
 * `DataSource=zax`, `Exchange=jse`, `Frequency=monthly` and returned data.
 * Prior to this email, every `Frequency` Long + `Interval` string was
 * entitlement-rejected with the same `soap:Receiver — Invalid Parameter
 * Value: <n> as Frequency` fault (documented in
 * `wealth-navigator/docs/TIMESERIES_PROBE_REPORT_FINAL.md`).
 *
 * **What this script does.** Posts a list of candidate TimeSeriesGet2 probe
 * bodies to the Railway worker's `/debug/timeseries-probe` endpoint and
 * prints a one-line JSON record per candidate. The worker holds the IRESS
 * CT license seat; we deliberately do NOT spin the worker up locally with
 * `IRESS_MODE=live` (that would kick the production worker off the seat and
 * break live quote ingest). Run this against the production worker to
 * confirm the entitlement, then save the JSON to
 * `wealth-navigator/docs/TIMESERIES_PROBE_RUN_<date>.json`.
 *
 * **What we want to confirm:**
 *   1. Per-stock daily (`Frequency=Daily` on SOL, NPN, FSR, SBK, MTN) — this
 *      powers `/api/history/[sym]` and the Security page chart ranges.
 *   2. Per-stock monthly (`Frequency=Monthly`) — what Andre proved in his
 *      email; useful for the 5Y/All windows.
 *   3. Per-stock intraday (`Frequency=IntraDay` / `Tick` / `1-Minute`) — the
 *      Security page 1D / 5D chart; **not yet proven by Andre**.
 *   4. Index (J203) daily — the ALSI chart panel.
 *   5. Sector index daily — the sector heatmap.
 *   6. Bond (R2030, R2035) daily — the ZAR sovereign curve; `DataSource=yfxd`
 *      for YFX, not `zax` (different feed per Andre's standing
 *      `SecuritySearchGet` results).
 *
 * **Usage.** Set the worker URL + token, then run from `wealth-navigator/`:
 *
 *   WORKER_URL=https://iress-worker-production.up.railway.app \
 *   WORKER_TOKEN=… \
 *     bun run scripts/probe-timeseries.ts
 *
 * The script posts sequentially with a short delay (the worker enforces a
 * per-process 10s minimum gap on the *news* probe; the time-series probe
 * has no throttle, but we'll still pace calls to avoid bursting the seat).
 * Output is one JSON object per line, machine-parseable.
 *
 * **Failure mode (this dev box).** `IRESS_MODE=mock` locally — the worker is
 * NOT running locally with live IRESS. The probe only works against the live
 * Railway worker. If `WORKER_URL` is unset (the default for `bun run dev`
 * locally), the script prints a single explanatory line and exits 2 — it
 * never calls IRESS.
 */

import { getIressWorkerUrl } from "../src/lib/data-policy";

interface ProbeCandidate {
  /** Label for the candidate (used in the printed JSON `name` field). */
  name: string;
  /** Symbol as it goes into the `<SecurityCode>` element. */
  code: string;
  /** Exchange code; Andre proved `jse` (lowercase — the worker uppercases it). */
  exchange: string;
  /** DataSource; `zax` is what Andre proved. YFX bonds still need `yfxd`. */
  dataSource: string;
  /** V4 Frequency STRING enum (matches Andre's email). */
  interval: string;
  /** Optional ISO YYYY-MM-DD overrides (default: last 14 days). */
  dateFrom?: string;
  dateTo?: string;
  /** What panel uses this — for the unblock plan cross-reference. */
  panel: string;
  /** Already proven by Andre? If `true`, we expect `ok=true dataRowCount>0`. */
  provenByAndre: boolean;
}

const CANDIDATES: ProbeCandidate[] = [
  // --- per-stock daily (drives /api/history/[sym] for 5D/1M/6M/YTD/1Y/5Y/All) ---
  { name: "SOL daily", code: "SOL", exchange: "jse", dataSource: "zax", interval: "Daily", panel: "per-stock history", provenByAndre: false },
  { name: "NPN daily", code: "NPN", exchange: "jse", dataSource: "zax", interval: "Daily", panel: "per-stock history", provenByAndre: false },
  { name: "FSR daily", code: "FSR", exchange: "jse", dataSource: "zax", interval: "Daily", panel: "per-stock history", provenByAndre: false },
  { name: "SBK daily", code: "SBK", exchange: "jse", dataSource: "zax", interval: "Daily", panel: "per-stock history", provenByAndre: false },
  { name: "MTN daily", code: "MTN", exchange: "jse", dataSource: "zax", interval: "Daily", panel: "per-stock history", provenByAndre: false },
  // --- per-stock monthly (Andre's working example) ---
  { name: "SOL monthly (Andre's example)", code: "SOL", exchange: "jse", dataSource: "zax", interval: "Monthly", panel: "per-stock history (5Y/All)", provenByAndre: true },
  { name: "NPN monthly", code: "NPN", exchange: "jse", dataSource: "zax", interval: "Monthly", panel: "per-stock history (5Y/All)", provenByAndre: false },
  // --- per-stock intraday (NEEDS additional probe — Andre did not prove Tick/1-Minute) ---
  { name: "SOL intraday (Tick)", code: "SOL", exchange: "jse", dataSource: "zax", interval: "Tick", panel: "per-stock intraday", provenByAndre: false },
  { name: "SOL intraday (1-Minute)", code: "SOL", exchange: "jse", dataSource: "zax", interval: "1-Minute", panel: "per-stock intraday", provenByAndre: false },
  { name: "SOL intraday (IntraDay)", code: "SOL", exchange: "jse", dataSource: "zax", interval: "IntraDay", panel: "per-stock intraday", provenByAndre: false },
  // --- JSE All Share (J203) daily — ALSI chart panel ---
  { name: "J203 daily", code: "J203", exchange: "jse", dataSource: "zax", interval: "Daily", panel: "ALSI / cockpit tier-2", provenByAndre: false },
  { name: "J203 intraday (Tick)", code: "J203", exchange: "jse", dataSource: "zax", interval: "Tick", panel: "ALSI intraday", provenByAndre: false },
  // --- sector indices — sector heatmap (codes per JSE: J200=Top 40, J201=...) ---
  { name: "J200 daily", code: "J200", exchange: "jse", dataSource: "zax", interval: "Daily", panel: "sector heatmap", provenByAndre: false },
  // --- ZAR sovereign curve — bond codes on YFX, DataSource=yfxd (NOT zax) ---
  { name: "R2030 daily (yfxd)", code: "R2030", exchange: "yfx", dataSource: "yfxd", interval: "Daily", panel: "ZAR sovereign curve", provenByAndre: false },
  { name: "R2035 daily (yfxd)", code: "R2035", exchange: "yfx", dataSource: "yfxd", interval: "Daily", panel: "ZAR sovereign curve", provenByAndre: false },
];

const PROBE_DELAY_MS = 1500;

interface ProbeResult {
  ok: boolean;
  code: string;
  exchange: string;
  interval: string | null;
  frequency: number | null;
  errorNumber: number | null;
  errorDescription: string | null;
  rawFault: string | null;
  dataRowCount: number;
  firstRow: Record<string, unknown> | null;
  iressMode: string;
  elapsedMs: number;
  probedAt: string;
  build: string;
}

interface ProbeEnvelope {
  ok: boolean;
  status: number;
  body?: ProbeResult;
  error?: { code: string; message: string };
}

async function main(): Promise<void> {
  const workerUrl = getIressWorkerUrl();
  const token = process.env.WORKER_TOKEN?.trim() || "";
  if (!workerUrl) {
    console.log(
      JSON.stringify({
        event: "skip",
        reason: "WORKER_URL (or IRESS_WORKER_URL / RAILWAY_SERVICE_URL) is not set; the probe can only run against the live Railway worker. Locally IRESS_MODE=mock — never spin the worker up with IRESS_MODE=live on this dev box (Railway worker holds the single CT seat).",
        candidates: CANDIDATES.length,
        nextStep: "Set WORKER_URL=https://iress-worker-production.up.railway.app and WORKER_TOKEN=… then re-run.",
      }),
    );
    process.exit(2);
  }

  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) headers["authorization"] = `Bearer ${token}`;

  console.log(
    JSON.stringify({
      event: "probe_start",
      workerUrl,
      auth: token ? "on" : "off",
      candidates: CANDIDATES.length,
      delayMs: PROBE_DELAY_MS,
    }),
  );

  for (const c of CANDIDATES) {
    const body = {
      code: c.code,
      exchange: c.exchange,
      interval: c.interval,
      dataSource: c.dataSource,
      ...(c.dateFrom ? { dateFrom: c.dateFrom } : {}),
      ...(c.dateTo ? { dateTo: c.dateTo } : {}),
    };
    let env: ProbeEnvelope;
    try {
      const res = await fetch(`${workerUrl}/debug/timeseries-probe`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        // Per-call: 30s for the round-trip; the worker itself uses 15s SOAP timeout.
        signal: AbortSignal.timeout(30_000),
      });
      const text = await res.text();
      let parsed: unknown = text;
      try {
        parsed = JSON.parse(text);
      } catch {
        /* keep text */
      }
      env = { ok: res.ok, status: res.status, body: (parsed as { ok?: boolean; result?: ProbeResult; resultProbe?: ProbeResult })?.result ?? ((parsed as ProbeResult)?.ok !== undefined ? (parsed as ProbeResult) : undefined) };
    } catch (err) {
      env = {
        ok: false,
        status: 0,
        error: { code: "fetch_failed", message: err instanceof Error ? err.message : String(err) },
      };
    }

    const result = env.body;
    const summary: Record<string, unknown> = {
      event: "probe",
      name: c.name,
      code: c.code,
      exchange: c.exchange,
      dataSource: c.dataSource,
      interval: c.interval,
      panel: c.panel,
      provenByAndre: c.provenByAndre,
      httpStatus: env.status,
      ok: result?.ok ?? null,
      errorNumber: result?.errorNumber ?? null,
      errorDescription: result?.errorDescription ?? null,
      rawFault: result?.rawFault ?? null,
      dataRowCount: result?.dataRowCount ?? 0,
      firstRowClose: (result?.firstRow as Record<string, unknown> | null)?.["ClosePrice"] ?? null,
      firstRowDate: (result?.firstRow as Record<string, unknown> | null)?.["TimeSeriesDate"] ?? null,
      iressMode: result?.iressMode ?? null,
      elapsedMs: result?.elapsedMs ?? null,
      build: result?.build ?? null,
    };
    if (env.error) summary["fetchError"] = env.error;
    console.log(JSON.stringify(summary));
    await new Promise((resolve) => setTimeout(resolve, PROBE_DELAY_MS));
  }

  console.log(
    JSON.stringify({
      event: "probe_done",
      interpretation:
        "Probes with `ok=true dataRowCount>0` are confirmed. Probes with the old `Invalid Parameter Value: <n> as Frequency` fault mean the V4 string form is also rejected on this code (which contradicts Andre's email — escalate back). 25010/25034 fault codes are entitlement-blocked; 25008 is the license seat.",
    }),
  );
}

await main();
