/**
 * One-off IRESS `TimeSeriesGet2` Interval-string probe.
 *
 * The IRESS V4 docs in this repo use a string `<Interval>Daily</Interval>`
 * but earlier fix attempts shipped the request as a `Frequency` (Long) field:
 *   - `Frequency: 0`  →  server rejects as `Invalid Parameter Value: 0 as Frequency`
 *   - `Frequency: 8`  →  server rejects as `Invalid Parameter Value: 8 as Frequency`
 *
 * The new code path drops the `Frequency` Long entirely and sends the
 * V4 `<Interval>` STRING enum instead. This script verifies which
 * `Interval` strings the live CT server accepts by running a real
 * `TimeSeriesGet2` for each candidate and printing a one-line JSON
 * record. The first response whose `errorNumber === 0` (or whose
 * `rawFault` is anything other than the parameter-value fault) is the
 * accepted string.
 *
 * Run from `wealth-navigator/`:
 *
 *   bun run scripts/probe-frequency.ts
 *   IRESS_BASE_URL=https://webservices-ct.iress.co.za/v4 \
 *     bun run scripts/probe-frequency.ts
 *
 * The list of candidates is the documented V4 string enum (plus a
 * few extras — `null`/empty for control, capitalisation variants).
 * Override via `PROBE_CANDIDATES="Daily,Weekly,..."` (comma-separated).
 *
 * Requires:
 *   - `IRESS_USERNAME` / `IRESS_PASSWORD` / `IRESS_COMPANY_NAME`
 *     in `.env.local` (the same creds the Railway worker uses)
 *   - Network egress to `webservices-ct.iress.co.za`
 *
 * The script starts a session, runs the probe, then `IRESSSessionEnd`s
 * and waits `LICENSE_RELEASE_DELAY_MS` so the seat is released back to
 * the worker before exit.
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createLiveIressClient } from "../src/lib/iress/live";
import { getIressCredentialsFromEnv } from "../src/lib/iress/config";
import { LICENSE_RELEASE_DELAY_MS } from "../src/lib/iress/index";
import { buildApplicationId } from "../src/lib/iress/index";

function loadDotEnvLocal(): void {
  const path = join(import.meta.dirname, "..", ".env.local");
  if (!existsSync(path)) return;
  const text = readFileSync(path, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    if (process.env[key] !== undefined && process.env[key] !== "") continue;
    let val = trimmed.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    process.env[key] = val;
  }
}

function truncate(msg: string, max = 200): string {
  const oneLine = msg.replace(/\s+/g, " ").trim();
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max - 1)}…`;
}

const DEFAULT_CANDIDATES: (string | null)[] = [
  // V4 documented enum (per the WSDL sample and
  // `iress-v4-docs/05-services/market-data/02-time-series-get-2.md`).
  "Daily",
  "Weekly",
  "Monthly",
  "Quarterly",
  "Yearly",
  "IntraDay",
  "Intraday",
  "intraDay",
  // Capitalisation variants — many CT endpoints accept both. The
  // probe covers them so we can pin the canonical spelling.
  "DAILY",
  "daily",
  "DAY",
  "Day",
  // Null / empty — control: should fail with the same parameter-value
  // fault we used to see when `Frequency` was missing.
  null,
  "",
];

const DEFAULT_CODE = process.env.PROBE_CODE ?? "J203";
const DEFAULT_EXCHANGE = process.env.PROBE_EXCHANGE ?? "JSE";
const CANDIDATES: (string | null)[] = process.env.PROBE_CANDIDATES
  ? process.env.PROBE_CANDIDATES.split(",").map((s) => {
      const t = s.trim();
      return t === "" ? "" : t;
    })
  : DEFAULT_CANDIDATES;

interface ProbeResult {
  interval: string | null;
  ok: boolean;
  errorNumber: number | null;
  errorDescription: string | null;
  rawFault: string | null;
  dataRowCount: number;
  elapsedMs: number;
}

async function probeOnce(
  client: ReturnType<typeof createLiveIressClient>,
  sessionKey: string,
  code: string,
  exchange: string,
  interval: string | null,
): Promise<ProbeResult> {
  const from = new Date(Date.now() - 14 * 86400_000).toISOString().slice(0, 10);
  const to = new Date().toISOString().slice(0, 10);
  const started = Date.now();
  const baseReq = {
    Header: {
      SessionKey: sessionKey,
      RequestID: `probe-${Date.now().toString(36)}`,
      Timeout: 15,
    },
    Code: code,
    Exchange: exchange,
    From: from,
    To: to,
  };
  try {
    // The live client enforces `Interval: string` (non-empty) — for
    // null / empty candidates we need to bypass that local check.
    // Easiest path: pass a string but capture any 25018 / fault and
    // call it a "no-go" rather than a hard error.
    if (interval === null || interval === "") {
      const res = await client.timeSeriesGet2({
        ...baseReq,
        Interval: interval ?? "",
      });
      return {
        interval,
        ok: res.Header.ErrorNumber === 0,
        errorNumber: res.Header.ErrorNumber ?? null,
        errorDescription: res.Header.ErrorDescription ?? null,
        rawFault: null,
        dataRowCount: res.DataRows?.length ?? 0,
        elapsedMs: Date.now() - started,
      };
    }
    const res = await client.timeSeriesGet2({
      ...baseReq,
      Interval: interval,
    });
    return {
      interval,
      ok: res.Header.ErrorNumber === 0,
      errorNumber: res.Header.ErrorNumber ?? null,
      errorDescription: res.Header.ErrorDescription ?? null,
      rawFault: null,
      dataRowCount: res.DataRows?.length ?? 0,
      elapsedMs: Date.now() - started,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const code = (err as { code?: number }).code;
    return {
      interval,
      ok: false,
      errorNumber: typeof code === "number" ? code : null,
      errorDescription: null,
      rawFault: truncate(msg, 240),
      dataRowCount: 0,
      elapsedMs: Date.now() - started,
    };
  }
}

function classifyResult(r: ProbeResult): "ok" | "param-fault" | "other-fault" | "no-data" {
  if (r.ok && r.dataRowCount > 0) return "ok";
  if (r.rawFault && /Invalid Parameter Value/i.test(r.rawFault) && /Interval|Frequency/i.test(r.rawFault)) {
    return "param-fault";
  }
  if (r.ok && r.dataRowCount === 0) return "no-data";
  return "other-fault";
}

async function main(): Promise<void> {
  loadDotEnvLocal();
  process.env.IRESS_MODE = "live";

  const baseUrl =
    process.env.IRESS_BASE_URL ?? "https://webservices-ct.iress.co.za/v4";
  const creds = getIressCredentialsFromEnv();
  if (!creds.userName || !creds.password) {
    console.log(
      JSON.stringify({
        endpoint: baseUrl,
        success: false,
        error: "Missing IRESS_USERNAME or IRESS_PASSWORD (check .env.local)",
      }),
    );
    process.exit(1);
  }

  const code = DEFAULT_CODE;
  const exchange = DEFAULT_EXCHANGE;
  const client = createLiveIressClient({ baseUrl });
  const applicationId = buildApplicationId("prod", "freq-probe");

  let sessionKey: string | null = null;
  let firstAccepted: string | null | undefined = undefined;
  let firstAcceptedKind: string | null = null;
  const results: ProbeResult[] = [];

  try {
    const session = await client.iressSessionStart({
      UserName: creds.userName,
      CompanyName: creds.company,
      Password: creds.password,
      ApplicationID: applicationId,
      ApplicationLabel: "Mint-OEMS-FreqProbe",
      SessionTimeout: 30,
      Locale: "en-ZA",
    });
    sessionKey = session.IRESSSessionKey;
    console.log(
      JSON.stringify({
        event: "session_started",
        endpoint: baseUrl,
        userName: creds.userName,
        applicationId,
        sessionKeyPrefix: sessionKey.slice(0, 8),
        candidates: CANDIDATES.length,
      }),
    );

    for (const interval of CANDIDATES) {
      const r = await probeOnce(client, sessionKey, code, exchange, interval);
      results.push(r);
      const kind = classifyResult(r);
      console.log(
        JSON.stringify({
          event: "probe",
          code,
          exchange,
          interval: r.interval,
          kind,
          errorNumber: r.errorNumber,
          errorDescription: r.errorDescription,
          rawFault: r.rawFault,
          dataRowCount: r.dataRowCount,
          elapsedMs: r.elapsedMs,
        }),
      );
      if (firstAccepted === undefined && (kind === "ok" || kind === "no-data" || kind === "other-fault")) {
        firstAccepted = r.interval;
        firstAcceptedKind = kind;
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.log(
      JSON.stringify({
        event: "session_or_probe_fatal",
        endpoint: baseUrl,
        success: false,
        error: truncate(message),
      }),
    );
    process.exit(1);
  } finally {
    if (sessionKey) {
      try {
        await client.iressSessionEnd({ IRESSSessionKey: sessionKey });
      } catch (endErr) {
        console.warn(
          `probe-frequency: IRESSSessionEnd failed (seat may linger): ${
            endErr instanceof Error ? endErr.message : String(endErr)
          }`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, LICENSE_RELEASE_DELAY_MS));
    }
  }

  const okResults = results.filter((r) => classifyResult(r) === "ok");
  const noDataResults = results.filter((r) => classifyResult(r) === "no-data");
  const otherFaultResults = results.filter((r) => classifyResult(r) === "other-fault");
  const paramFaultResults = results.filter((r) => classifyResult(r) === "param-fault");

  console.log(
    JSON.stringify({
      event: "summary",
      endpoint: baseUrl,
      code,
      exchange,
      totalCandidates: CANDIDATES.length,
      paramFaults: paramFaultResults.length,
      noData: noDataResults.length,
      otherFaults: otherFaultResults.length,
      ok: okResults.length,
      firstNonParamFault: firstAccepted,
      firstNonParamFaultKind: firstAcceptedKind,
      interpretation:
        firstAcceptedKind === "ok"
          ? `Interval=${JSON.stringify(firstAccepted)} accepted by CT (data returned). Pin timeSeriesIntervalString("1d") to ${JSON.stringify(firstAccepted)}.`
          : firstAcceptedKind === "no-data"
            ? `Interval=${JSON.stringify(firstAccepted)} accepted by CT (response envelope OK, empty DataRows). Verify by trying a known-good code.`
            : firstAcceptedKind === "other-fault"
              ? `Interval=${JSON.stringify(firstAccepted)} is NOT rejected as a parameter value — server returned a different fault (e.g. entitlement, no data). Verify before pinning.`
              : "All candidates returned the same parameter-value fault. The V4 server may want a Long after all — fall back to the Long-probe hypothesis and pin the right Frequency value.",
    }),
  );
  process.exit(firstAccepted !== undefined && firstAcceptedKind !== null ? 0 : 2);
}

await main();
