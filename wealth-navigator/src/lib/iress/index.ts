// Public IRESS adapter entrypoint.
// The active implementation is selected by IRESS_MODE.

import { mockIressClient, iressQueries } from "@/lib/iress/mock";
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

/** The IRESS client — UI code should use this. */
export const iress: IressClient = mockIressClient;

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

/** Bring up a session + the standard service sessions in one call. */
export async function bringUpMintSession(user: { userName: string; company: string; password: string }) {
  const applicationId = buildApplicationId("prod", "web-1");
  const iressSession: IressSessionStartResponse = await iress.iressSessionStart({
    UserName: user.userName,
    CompanyName: user.company,
    Password: user.password,
    ApplicationID: applicationId,
    ApplicationLabel: "Mint-OEMS-Web",
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

export type { IressClient } from "@/lib/iress/client";
