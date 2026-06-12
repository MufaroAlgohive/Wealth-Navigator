/**
 * Server-only singleton IRESS session manager.
 *
 * Calls `bringUpMintSessionFromEnv()` once, caches session keys, and
 * refreshes on expiry or 25001 (invalid session) errors.
 */

import {
  bringUpMintSessionFromEnv,
  iressConfig,
  LICENSE_RELEASE_DELAY_MS,
  tearDownIressWireSession,
} from "@/lib/iress/index";
import { IressError } from "@/lib/iress/errors";
import type { IressService } from "@/types/iress";

export { LICENSE_RELEASE_DELAY_MS };

export interface MintSession {
  iressSessionKey: string;
  sessionTimeout: number;
  /** Wall-clock ms when the session should be considered stale. */
  expiresAt: number;
  serviceKeys: Partial<Record<IressService, string>>;
  startedAt: number;
}

let cache: MintSession | null = null;
let inflight: Promise<MintSession> | null = null;

/** Buffer before expiry to proactively refresh (30 s). */
const EXPIRY_BUFFER_MS = 30_000;

function buildSession(
  iressSession: Awaited<ReturnType<typeof bringUpMintSessionFromEnv>>["iressSession"],
  serviceKeys: Awaited<ReturnType<typeof bringUpMintSessionFromEnv>>["serviceKeys"],
): MintSession {
  const timeoutMin = iressSession.SessionTimeout ?? 120;
  const now = Date.now();
  return {
    iressSessionKey: iressSession.IRESSSessionKey,
    sessionTimeout: timeoutMin,
    expiresAt: now + timeoutMin * 60_000,
    serviceKeys,
    startedAt: now,
  };
}

async function startSession(): Promise<MintSession> {
  const { iressSession, serviceKeys } = await bringUpMintSessionFromEnv();
  return buildSession(iressSession, serviceKeys);
}

/** Drop cached session — next call will re-authenticate. Does not call IRESS. */
export function invalidateMintSession(): void {
  cache = null;
}

/**
 * End the cached IRESS session on the wire and clear local cache.
 * Use before probes, on dev-server shutdown, or via DELETE /api/iress/session.
 */
export async function tearDownMintSession(options?: {
  releaseDelayMs?: number;
}): Promise<boolean> {
  if (inflight) {
    try {
      await inflight;
    } catch {
      /* start may have failed — still attempt teardown if we have keys */
    }
  }

  const session = cache;
  cache = null;
  if (!session) return false;

  if (iressConfig.mode !== "live" && iressConfig.mode !== "wsdl-stub") {
    return true;
  }

  return tearDownIressWireSession({
    iressSessionKey: session.iressSessionKey,
    serviceKeys: session.serviceKeys,
    releaseDelayMs: options?.releaseDelayMs ?? 0,
  });
}

/** Whether a cached session exists and is not yet expired. */
export function hasValidCachedSession(): boolean {
  return cache !== null && Date.now() < cache.expiresAt - EXPIRY_BUFFER_MS;
}

/** Get (or start) the Mint IRESS session. Refreshes when near expiry. */
export async function getMintSession(): Promise<MintSession> {
  if (cache && Date.now() < cache.expiresAt - EXPIRY_BUFFER_MS) {
    return cache;
  }
  if (inflight) return inflight;

  inflight = startSession();
  try {
    cache = await inflight;
    return cache;
  } finally {
    inflight = null;
  }
}

function isSessionExpired(err: unknown): boolean {
  if (err instanceof IressError && err.code === 25001) return true;
  return typeof err === "object" && err !== null && "code" in err && (err as { code: number }).code === 25001;
}

/** Run `fn` with a valid session; retry once on 25001 (session expired). */
export async function withMintSession<T>(fn: (session: MintSession) => Promise<T>): Promise<T> {
  try {
    return await fn(await getMintSession());
  } catch (err) {
    if (isSessionExpired(err)) {
      invalidateMintSession();
      return await fn(await getMintSession());
    }
    throw err;
  }
}

/** Snapshot for health / session status endpoints (no secrets). */
export function getSessionStatus(): {
  cached: boolean;
  valid: boolean;
  startedAt: number | null;
  expiresAt: number | null;
  services: string[];
} {
  if (!cache) {
    return { cached: false, valid: false, startedAt: null, expiresAt: null, services: [] };
  }
  const valid = Date.now() < cache.expiresAt - EXPIRY_BUFFER_MS;
  return {
    cached: true,
    valid,
    startedAt: cache.startedAt,
    expiresAt: cache.expiresAt,
    services: Object.keys(cache.serviceKeys),
  };
}

let shutdownHooksRegistered = false;
let shuttingDown = false;

function registerShutdownHooks(): void {
  if (shutdownHooksRegistered || typeof process === "undefined") return;
  if (process.env.IRESS_SHUTDOWN_HOOKS === "0") return;
  if (iressConfig.mode !== "live" && iressConfig.mode !== "wsdl-stub") return;

  shutdownHooksRegistered = true;

  const release = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.error(`[mint-iress] ${signal}: releasing IRESS license…`);
    await tearDownMintSession({ releaseDelayMs: LICENSE_RELEASE_DELAY_MS });
  };

  process.once("SIGINT", () => {
    void release("SIGINT").finally(() => process.exit(0));
  });
  process.once("SIGTERM", () => {
    void release("SIGTERM").finally(() => process.exit(0));
  });
}

registerShutdownHooks();
