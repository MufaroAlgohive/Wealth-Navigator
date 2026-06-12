// Public IRESS adapter entrypoint.
// The active implementation is selected by IRESS_MODE.

import { getIressCredentialsFromEnv } from "@/lib/iress/config";
import { mockIressClient, iressQueries } from "@/lib/iress/mock";
import { liveIressClient, createLiveIressClient } from "@/lib/iress/live";
import type { IressClient } from "@/lib/iress/client";
import type { IressSessionStartResponse } from "@/lib/iress/client";
import type { IressService } from "@/types/iress";

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

/** Bring up a session + the standard service sessions in one call. */
export async function bringUpMintSession(
  user: { userName: string; company: string; password: string },
  options?: { applicationId?: string; applicationLabel?: string; node?: string },
) {
  // Sticky ApplicationID for the long-running Railway worker: same
  // (UserName + CompanyName + ApplicationID) triple lets IRESS reconnect to
  // the same in-flight license seat. Falls back to a fresh random GUID.
  const applicationId = options?.applicationId ?? buildApplicationId("prod", options?.node ?? "web-1");
  const applicationLabel = options?.applicationLabel ?? "Mint-OEMS-Web";
  const iressSession: IressSessionStartResponse = await iress.iressSessionStart({
    UserName: user.userName,
    CompanyName: user.company,
    Password: user.password,
    ApplicationID: applicationId,
    ApplicationLabel: applicationLabel,
    SessionTimeout: 120,
    Locale: "en-ZA",
  });
  const servicesToStart: Array<{ Service: IressService; Server: string }> = [
    { Service: "IOSPlus", Server: "IOSPLUSAPI" },
    { Service: "IPS", Server: "IPSAPI" },
    { Service: "FIXPlus", Server: "FIXPLUSAPI" },
  ];
  const serviceKeys: Partial<Record<IressService, string>> = {};
  for (const { Service, Server } of servicesToStart) {
    const { ServiceSessionKey } = await iress.serviceSessionStart({
      IRESSSessionKey: iressSession.IRESSSessionKey,
      Service,
      Server,
    });
    serviceKeys[Service] = ServiceSessionKey;
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
