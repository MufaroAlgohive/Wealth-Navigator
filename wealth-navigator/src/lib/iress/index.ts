// Public IRESS adapter entrypoint.
// The active implementation is selected by IRESS_MODE.

import { getIressCredentialsFromEnv } from "@/lib/iress/config";
import { IressError } from "@/lib/iress/errors";
import { mockIressClient, iressQueries } from "@/lib/iress/mock";
import { liveIressClient, createLiveIressClient } from "@/lib/iress/live";
import type { IressClient } from "@/lib/iress/client";
import type { IressSessionStartRequest, IressSessionStartResponse } from "@/lib/iress/client";
import type { IressService } from "@/types/iress";

/** CT may need a moment to free the license seat after SessionEnd. */
export const LICENSE_RELEASE_DELAY_MS = 3_000;

export type IressMode = "mock" | "live" | "wsdl-stub";

function detectMode(): IressMode {
  const env = process.env.IRESS_MODE as IressMode | undefined;
  if (env === "live" || env === "wsdl-stub") return env;
  return "mock";
}

const mode: IressMode = detectMode();

/**
 * Pick the IRESS client for a given mode. Both `live` and `wsdl-stub` use
 * the SOAP client (the `wsdl-stub` mode is intended for CI: point
 * `IRESS_BASE_URL` at a saved WSDL and use the same transport). `mock` uses
 * the deterministic in-process adapter.
 */
export function getIressClient(targetMode: IressMode = mode): IressClient {
  if (targetMode === "live" || targetMode === "wsdl-stub") return liveIressClient;
  return mockIressClient;
}

/**
 * Build a fresh live client — useful for tests that want to inject a custom
 * transport (e.g. a fake `fetch`) without mutating the module-level
 * singleton.
 */
export { createLiveIressClient };

/** The IRESS client — UI code should use this. */
export const iress: IressClient = getIressClient(mode);

/** Convenience query helpers for read-only seed data. */
export const iressData = iressQueries;

export interface IressConfig {
  mode: IressMode;
  baseUrl: string;
  prodUrl: string;
  applicationLabel: string;
  region: string;
  // Per docs/03-endpoints.md — the cut-down WSDL method lists we'd request.
  // Exposed both as a group→methods map and as a flat array of `{ group, methods }`
  // entries so the integration page can iterate it with `.map`.
  methods: Array<{ group: string; methods: string[] }>;
  methodsByGroup: {
    iress: string[];
    ios: string[];
    ips: string[];
    fix: string[];
  };
}

const iressMethods = (process.env.IRESS_IRESS_METHODS ?? "").split(",").filter(Boolean);
const iosMethods = (process.env.IRESS_IOS_METHODS ?? "").split(",").filter(Boolean);
const ipsMethods = (process.env.IRESS_IPS_METHODS ?? "").split(",").filter(Boolean);
const fixMethods = (process.env.IRESS_FIX_METHODS ?? "").split(",").filter(Boolean);

export const iressConfig: IressConfig = {
  mode,
  baseUrl: process.env.IRESS_BASE_URL ?? "https://webservices-ct.iress.co.za/v4",
  prodUrl: process.env.IRESS_PROD_URL ?? "https://webservices.iress.co.za/v4",
  applicationLabel: "Mint-OEMS-Production",
  region: process.env.IRESS_REGION ?? "ZA",
  methods: [
    { group: "iress", methods: iressMethods },
    { group: "ios",   methods: iosMethods },
    { group: "ips",   methods: ipsMethods },
    { group: "fix",   methods: fixMethods },
  ],
  methodsByGroup: {
    iress: iressMethods,
    ios: iosMethods,
    ips: ipsMethods,
    fix: fixMethods,
  },
};

/** Build the ApplicationID per the docs (Mint-OEMS-<env>-<node>-<guid>). */
export function buildApplicationId(envHint: "dev" | "staging" | "load" | "prod", node: string) {
  const cap = envHint.charAt(0).toUpperCase() + envHint.slice(1);
  const guid = crypto.randomUUID();
  return `Mint-OEMS-${cap}-${node}-${guid}`;
}

export { getIressCredentialsFromEnv } from "@/lib/iress/config";
export type { IressCredentials } from "@/lib/iress/config";

/** Redact an IRESS session key for logs — never log the full token. */
export function redactSessionKeyForLog(value: string): string {
  const at = value.indexOf("@");
  const prefix = value.slice(0, Math.min(12, value.length));
  const host = at >= 0 ? value.slice(at) : "";
  return `${prefix}…${host}`;
}

function readKickOptionsFromEnv(): Pick<IressSessionStartRequest, "SessionNumberToKick" | "KickLikeSessions"> {
  if (process.env.IRESS_FORCE_KICK_ALL === "1" || process.env.IRESS_FORCE_KICK_ALL === "true") {
    return { SessionNumberToKick: -1, KickLikeSessions: true };
  }
  const raw = process.env.IRESS_SESSION_NUMBER_TO_KICK;
  if (raw !== undefined && raw !== "") {
    const n = Number(raw);
    if (Number.isFinite(n)) return { SessionNumberToKick: n, KickLikeSessions: true };
  }
  return {};
}

async function iressSessionStartWithLicenseRecovery(
  params: IressSessionStartRequest,
  options?: { forceKickOn25008?: boolean },
): Promise<IressSessionStartResponse> {
  try {
    return await iress.iressSessionStart(params);
  } catch (err) {
    if (!(err instanceof IressError) || err.code !== 25008) throw err;
    const kick = options?.forceKickOn25008
      ? { SessionNumberToKick: -1 as const, KickLikeSessions: true }
      : readKickOptionsFromEnv();
    if (kick.SessionNumberToKick === undefined) {
      console.error(
        "[mint-iress] 25008 license exhausted — another session holds the seat. " +
          "Run `bun run iress:logout` or wait for idle timeout. " +
          "Set IRESS_SESSION_NUMBER_TO_KICK or IRESS_FORCE_KICK_ALL=1 only with explicit approval.",
      );
      throw err;
    }
    console.warn(
      `[mint-iress] 25008 — retrying IRESSSessionStart with SessionNumberToKick=${kick.SessionNumberToKick}`,
    );
    return await iress.iressSessionStart({ ...params, ...kick });
  }
}

/**
 * Proper V4 logout: end each service session, then the parent IRESS session,
 * then optionally wait for the license seat to free on CT.
 */
export async function tearDownIressWireSession(options: {
  iressSessionKey: string;
  serviceKeys?: Partial<Record<IressService, string>>;
  releaseDelayMs?: number;
  client?: IressClient;
}): Promise<boolean> {
  const client = options.client ?? iress;
  for (const [service, key] of Object.entries(options.serviceKeys ?? {})) {
    if (!key) continue;
    try {
      await client.serviceSessionEnd({ ServiceSessionKey: key });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[mint-iress] ServiceSessionEnd(${service}) failed (continuing): ${message}`);
    }
  }
  try {
    await client.iressSessionEnd({ IRESSSessionKey: options.iressSessionKey });
    const delay = options.releaseDelayMs ?? 0;
    if (delay > 0) {
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[mint-iress] tearDownIressWireSession failed: ${message}`);
    return false;
  }
}

/** Bring up a session + the standard service sessions in one call. */
export async function bringUpMintSession(
  user: { userName: string; company: string; password: string },
  options?: {
    applicationId?: string;
    applicationLabel?: string;
    node?: string;
    sessionNumberToKick?: number;
    kickLikeSessions?: boolean;
    /** Retry 25008 with SessionNumberToKick=-1 (first boot / orphan recovery). */
    forceKickOn25008?: boolean;
  },
) {
  // Sticky ApplicationID for the long-running Railway worker: same
  // (UserName + CompanyName + ApplicationID) triple lets IRESS reconnect to
  // the same in-flight license seat. Falls back to a fresh random GUID.
  const applicationId = options?.applicationId ?? buildApplicationId("prod", options?.node ?? "web-1");
  const applicationLabel = options?.applicationLabel ?? "Mint-OEMS-Web";
  const kickOnFirstAttempt =
    options?.sessionNumberToKick !== undefined
      ? {
          SessionNumberToKick: options.sessionNumberToKick,
          KickLikeSessions: options.kickLikeSessions ?? true,
        }
      : {};
  const iressSession: IressSessionStartResponse = await iressSessionStartWithLicenseRecovery(
    {
      UserName: user.userName,
      CompanyName: user.company,
      Password: user.password,
      ApplicationID: applicationId,
      ApplicationLabel: applicationLabel,
      SessionTimeout: 120,
      Locale: "en-ZA",
      ...kickOnFirstAttempt,
    },
    { forceKickOn25008: options?.forceKickOn25008 },
  );
  console.info(
    `[mint-iress] IRESSSessionStart ok applicationId=${applicationId} sessionKey=${redactSessionKeyForLog(iressSession.IRESSSessionKey)} timeoutMin=${iressSession.SessionTimeout ?? 120}`,
  );
  const servicesToStart: Array<{ Service: IressService; Server: string }> = [
    { Service: "IOSPlus", Server: "IOSPLUSAPI" },
    { Service: "IPS", Server: "IPSAPI" },
    { Service: "FIXPlus", Server: "FIXPLUSAPI" },
  ];
  const serviceKeys: Partial<Record<IressService, string>> = {};
  for (const { Service, Server } of servicesToStart) {
    try {
      const { ServiceSessionKey } = await iress.serviceSessionStart({
        IRESSSessionKey: iressSession.IRESSSessionKey,
        Service,
        Server,
      });
      serviceKeys[Service] = ServiceSessionKey;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(
        `[mint-iress] ServiceSessionStart(${Service}/${Server}) failed (continuing): ${message}`,
      );
    }
  }
  return { iressSession, serviceKeys };
}

/**
 * Start an IRESS WS session using credentials from env vars
 * (`IRESS_USERNAME`, `IRESS_PASSWORD`, `IRESS_COMPANY_NAME`).
 */
export async function bringUpMintSessionFromEnv(options?: {
  applicationId?: string;
  applicationLabel?: string;
  node?: string;
  forceKickOn25008?: boolean;
}) {
  const creds = getIressCredentialsFromEnv();
  if (!creds.userName || !creds.password) {
    throw new Error("IRESS credentials not configured (IRESS_USERNAME / IRESS_PASSWORD)");
  }
  return bringUpMintSession(
    {
      userName: creds.userName,
      company: creds.company,
      password: creds.password,
    },
    options,
  );
}

export type { IressClient } from "@/lib/iress/client";

/**
 * Re-export the read-only HTTP client used by Path B BFF passthroughs.
 * Lives in `worker-api.ts` to keep this barrel focused on the SOAP
 * adapter surface; importing it pulls in the data-policy module which
 * inspects `process.env` so it stays server-only.
 */
export {
  callWorker,
  streamWorkerSse,
  debugResolvedWorkerUrl,
  WORKER_API_TIMEOUT_MS,
} from "@/lib/iress/worker-api";
export type {
  WorkerApiOptions,
  WorkerApiResult,
  WorkerApiSuccess,
  WorkerApiError,
} from "@/lib/iress/worker-api";
