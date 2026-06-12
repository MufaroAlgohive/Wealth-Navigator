/**
 * One-off IRESS logout — releases the CT license seat without running the worker.
 *
 * Session key resolution (first match wins):
 *   1. `IRESS_SESSION_KEY` env
 *   2. `worker_session_metadata.iress_session_key` (Supabase service role)
 *   3. Sticky reconnect via persisted `application_id`, then full teardown
 *
 * Loads credentials from `.env.local`. Does not log passwords or full session keys.
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "@supabase/supabase-js";
import { createLiveIressClient } from "../src/lib/iress/live";
import {
  bringUpMintSession,
  getIressCredentialsFromEnv,
  LICENSE_RELEASE_DELAY_MS,
  tearDownIressWireSession,
} from "../src/lib/iress/index";
import type { IressService } from "../src/types/iress";

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

interface ResolvedLogoutTarget {
  iressSessionKey: string;
  serviceKeys?: Partial<Record<IressService, string>>;
  applicationId?: string;
  source: string;
}

async function readSupabaseRow(workerId: string): Promise<{
  iress_session_key: string | null;
  application_id: string | null;
} | null> {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  const sb = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await sb
    .from("worker_session_metadata")
    .select("iress_session_key, application_id")
    .eq("worker_id", workerId)
    .maybeSingle();
  if (error) {
    console.warn(`iress-logout: worker_session_metadata read failed: ${error.message}`);
    return null;
  }
  return data as { iress_session_key: string | null; application_id: string | null } | null;
}

async function expireSupabaseRow(workerId: string): Promise<void> {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return;
  const sb = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { error } = await sb
    .from("worker_session_metadata")
    .update({
      expires_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      metadata: { shutdown: true, source: "iress-logout" },
    })
    .eq("worker_id", workerId);
  if (error) {
    console.warn(`iress-logout: worker_session_metadata expire failed: ${error.message}`);
  }
}

async function resolveLogoutTarget(workerId: string): Promise<ResolvedLogoutTarget | null> {
  const envKey = process.env.IRESS_SESSION_KEY?.trim();
  if (envKey) {
    return { iressSessionKey: envKey, source: "IRESS_SESSION_KEY" };
  }

  const row = await readSupabaseRow(workerId);
  if (row?.iress_session_key) {
    return {
      iressSessionKey: row.iress_session_key,
      applicationId: row.application_id ?? undefined,
      source: "worker_session_metadata.iress_session_key",
    };
  }
  if (row?.application_id) {
    return {
      iressSessionKey: "",
      applicationId: row.application_id,
      source: "worker_session_metadata.application_id (sticky reconnect)",
    };
  }
  return null;
}

async function main(): Promise<void> {
  loadDotEnvLocal();
  process.env.IRESS_MODE = process.env.IRESS_MODE ?? "live";

  const baseUrl =
    process.env.IRESS_BASE_URL ?? "https://webservices-ct.iress.co.za/v4";
  const workerId = process.env.WORKER_ID ?? "iress-ingest-1";
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

  const target = await resolveLogoutTarget(workerId);
  if (!target) {
    console.log(
      JSON.stringify({
        endpoint: baseUrl,
        success: false,
        workerId,
        error:
          "No IRESS_SESSION_KEY, worker_session_metadata row, or application_id to reconnect. " +
          "Set IRESS_SESSION_KEY or ensure Supabase credentials are in .env.local.",
      }),
    );
    process.exit(1);
  }

  const client = createLiveIressClient({ baseUrl });
  let iressSessionKey = target.iressSessionKey;
  let serviceKeys = target.serviceKeys ?? {};

  if (!iressSessionKey && target.applicationId) {
    try {
      const brought = await bringUpMintSession(
        {
          userName: creds.userName,
          company: creds.company,
          password: creds.password,
        },
        {
          applicationId: target.applicationId,
          applicationLabel: process.env.IRESS_APPLICATION_LABEL ?? "Mint-OEMS-Logout",
          node: workerId,
        },
      );
      iressSessionKey = brought.iressSession.IRESSSessionKey;
      serviceKeys = brought.serviceKeys;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.log(
        JSON.stringify({
          endpoint: baseUrl,
          success: false,
          workerId,
          source: target.source,
          applicationId: target.applicationId,
          error: `Sticky reconnect failed: ${message}`,
        }),
      );
      process.exit(1);
    }
  }

  const ended = await tearDownIressWireSession({
    client,
    iressSessionKey,
    serviceKeys,
    releaseDelayMs: LICENSE_RELEASE_DELAY_MS,
  });

  await expireSupabaseRow(workerId);

  console.log(
    JSON.stringify({
      endpoint: baseUrl,
      success: ended,
      workerId,
      source: target.source,
      sessionKeyPrefix: iressSessionKey.slice(0, 8),
      licenseReleaseWaitMs: LICENSE_RELEASE_DELAY_MS,
    }),
  );
  process.exit(ended ? 0 : 1);
}

await main();
