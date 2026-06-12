/**
 * One-off IRESS session login probe. Loads credentials from `.env.local`;
 * endpoint from `IRESS_BASE_URL` (set in shell to override CT default).
 * Does not log passwords.
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createLiveIressClient } from "../src/lib/iress/live";
import { buildApplicationId } from "../src/lib/iress/index";
import { getIressCredentialsFromEnv } from "../src/lib/iress/config";
import { IressError } from "../src/lib/iress/errors";

function loadDotEnvLocal(): void {
  const path = join(import.meta.dir, "..", ".env.local");
  if (!existsSync(path)) return;
  const text = readFileSync(path, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    if (key === "IRESS_BASE_URL" && process.env.IRESS_BASE_URL) continue;
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

/** IRESS CT may need a moment to free the license seat after SessionEnd. */
const LICENSE_RELEASE_DELAY_MS = 3_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  loadDotEnvLocal();
  process.env.IRESS_MODE = process.env.IRESS_MODE ?? "live";

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

  const client = createLiveIressClient({ baseUrl });
  const applicationId = buildApplicationId("prod", "probe-1");

  try {
    const session = await client.iressSessionStart({
      UserName: creds.userName,
      CompanyName: creds.company,
      Password: creds.password,
      ApplicationID: applicationId,
      ApplicationLabel: "Mint-OEMS-Probe",
      SessionTimeout: 30,
      Locale: "en-ZA",
    });
    let sessionEndOk = true;
    try {
      await client.iressSessionEnd({ IRESSSessionKey: session.IRESSSessionKey });
    } catch (endErr) {
      sessionEndOk = false;
      const endMsg =
        endErr instanceof Error ? endErr.message : String(endErr);
      console.error(`probe: IRESSSessionEnd failed (seat may linger): ${endMsg}`);
    }
    if (sessionEndOk) {
      await sleep(LICENSE_RELEASE_DELAY_MS);
    }
    console.log(
      JSON.stringify({
        endpoint: baseUrl,
        success: true,
        userName: creds.userName,
        company: creds.company,
        sessionKeyPrefix: session.IRESSSessionKey.slice(0, 8),
      }),
    );
  } catch (err) {
    const message =
      err instanceof IressError
        ? `code=${err.code} ${err.message}`
        : err instanceof Error
          ? err.message
          : String(err);
    console.log(
      JSON.stringify({
        endpoint: baseUrl,
        success: false,
        userName: creds.userName,
        company: creds.company,
        error: truncate(message),
      }),
    );
    process.exit(1);
  }
}

await main();

