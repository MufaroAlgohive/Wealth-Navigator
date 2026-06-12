/**
 * Worker-owned IRESS session — NOT the Next.js session-manager singleton.
 * One Railway process holds one license seat.
 *
 * Sticky ApplicationID: the same (UserName + CompanyName + ApplicationID) triple
 * lets IRESS reconnect to the same in-flight license seat across restarts. The
 * ApplicationID is persisted to `worker_session_metadata` on start and reused
 * (or regenerated) on the next boot.
 */

import {
  bringUpMintSessionFromEnv,
  iressConfig,
  LICENSE_RELEASE_DELAY_MS,
  redactSessionKeyForLog,
  tearDownIressWireSession,
} from "@/lib/iress/index";
import { IressError, isIressSessionDeadError } from "@/lib/iress/errors";
import type { IressService } from "../../../src/types/iress";
import type { WorkerSupabase } from "./supabase";

export { LICENSE_RELEASE_DELAY_MS };
const EXPIRY_BUFFER_MS = 30_000;
/** Back off after 25008 instead of hammering IRESSSessionStart. */
const LICENSE_EXHAUSTED_BACKOFF_MS = 60_000;

export interface WorkerMintSession {
  iressSessionKey: string;
  applicationId: string;
  sessionTimeout: number;
  expiresAt: number;
  serviceKeys: Partial<Record<IressService, string>>;
  startedAt: number;
}

export interface WorkerSessionDeps {
  workerId: string;
  /** Stable per-node label (e.g. host / Railway replica id). Used as a fallback when no persisted ApplicationID exists. */
  node: string;
  applicationLabel: string;
  supabase: WorkerSupabase | null;
  allowWrites: boolean;
  dryRun: boolean;
}

function newStickyApplicationId(node: string): string {
  const safe = node.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 32) || "node";
  return `Mint-OEMS-Worker-${safe}`;
}

interface PersistedSessionRow {
  application_id: string;
  expires_at: string | null;
  iress_session_key: string | null;
  metadata?: { shutdown?: boolean; applicationLabel?: string; node?: string };
}

async function readPersistedApplicationId(
  supabase: WorkerSupabase | null,
  workerId: string,
): Promise<PersistedSessionRow | null> {
  if (!supabase) return null;
  try {
    const { data, error } = await supabase
      .from("worker_session_metadata")
      .select("application_id, expires_at, iress_session_key, metadata")
      .eq("worker_id", workerId)
      .maybeSingle();
    if (error) {
      console.warn(`[iress-ingest] read worker_session_metadata failed: ${error.message}`);
      return null;
    }
    return (data as PersistedSessionRow | null) ?? null;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[iress-ingest] readPersistedApplicationId threw: ${msg}`);
    return null;
  }
}

/** Persist only the sticky ApplicationID — safe before IRESSSessionStart completes. */
async function persistStickyApplicationId(
  deps: WorkerSessionDeps,
  applicationId: string,
): Promise<void> {
  if (!deps.supabase || !deps.allowWrites || deps.dryRun) {
    console.info(
      "[iress-ingest] would upsert sticky application_id",
      JSON.stringify({ worker_id: deps.workerId, application_id: applicationId }),
    );
    return;
  }
  try {
    const { error } = await deps.supabase.from("worker_session_metadata").upsert(
      {
        worker_id: deps.workerId,
        application_id: applicationId,
        iress_hostname: deps.node,
        last_started_at: new Date().toISOString(),
        metadata: { applicationLabel: deps.applicationLabel, node: deps.node },
        updated_at: new Date().toISOString(),
      },
      { onConflict: "worker_id" },
    );
    if (error) {
      console.warn(`[iress-ingest] persistStickyApplicationId failed: ${error.message}`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[iress-ingest] persistStickyApplicationId threw: ${msg}`);
  }
}

async function persistApplicationId(
  deps: WorkerSessionDeps,
  row: {
    applicationId: string;
    iressSessionKey: string;
    expiresAt: number;
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  if (!deps.supabase || !deps.allowWrites || deps.dryRun) {
    console.info(
      "[iress-ingest] would upsert worker_session_metadata",
      JSON.stringify({
        worker_id: deps.workerId,
        application_id: row.applicationId,
        iress_session_key_hash: hashForLog(row.iressSessionKey),
        expires_at: new Date(row.expiresAt).toISOString(),
        metadata: row.metadata ?? {},
      }),
    );
    return;
  }
  try {
    const { error } = await deps.supabase.from("worker_session_metadata").upsert(
      {
        worker_id: deps.workerId,
        application_id: row.applicationId,
        iress_session_key: row.iressSessionKey,
        iress_hostname: deps.node,
        last_started_at: new Date().toISOString(),
        expires_at: new Date(row.expiresAt).toISOString(),
        metadata: row.metadata ?? {},
        updated_at: new Date().toISOString(),
      },
      { onConflict: "worker_id" },
    );
    if (error) {
      console.warn(`[iress-ingest] persistApplicationId failed: ${error.message}`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[iress-ingest] persistApplicationId threw: ${msg}`);
  }
}

async function clearPersistedSessionKey(deps: WorkerSessionDeps): Promise<void> {
  if (!deps.supabase || !deps.allowWrites || deps.dryRun) {
    console.info(`[iress-ingest] would clear iress_session_key for ${deps.workerId}`);
    return;
  }
  try {
    const { error } = await deps.supabase
      .from("worker_session_metadata")
      .update({
        iress_session_key: null,
        updated_at: new Date().toISOString(),
      })
      .eq("worker_id", deps.workerId);
    if (error) {
      console.warn(`[iress-ingest] clearPersistedSessionKey failed: ${error.message}`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[iress-ingest] clearPersistedSessionKey threw: ${msg}`);
  }
}

/**
 * Reset the `metadata.shutdown` flag to `false` after the worker has
 * successfully started a new IRESS session. Without this the previous
 * run's `shutdown: true` survives across the sticky ApplicationID
 * reconnect, which `persistedSessionIsStale` then treats as stale and
 * forces a needless purge + re-login.
 */
async function clearShutdownFlag(deps: WorkerSessionDeps): Promise<void> {
  if (!deps.supabase || !deps.allowWrites || deps.dryRun) {
    console.info(
      `[iress-ingest] would reset metadata.shutdown for ${deps.workerId}`,
    );
    return;
  }
  try {
    const { error } = await deps.supabase
      .from("worker_session_metadata")
      .update({
        metadata: {
          applicationLabel: deps.applicationLabel,
          node: deps.node,
          shutdown: false,
        },
        updated_at: new Date().toISOString(),
      })
      .eq("worker_id", deps.workerId);
    if (error) {
      console.warn(`[iress-ingest] clearShutdownFlag failed: ${error.message}`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[iress-ingest] clearShutdownFlag threw: ${msg}`);
  }
}

async function clearPersistedApplicationId(deps: WorkerSessionDeps): Promise<void> {
  if (!deps.supabase || !deps.allowWrites || deps.dryRun) {
    console.info(`[iress-ingest] would expire worker_session_metadata for ${deps.workerId}`);
    return;
  }
  try {
    const { error } = await deps.supabase
      .from("worker_session_metadata")
      .update({
        iress_session_key: null,
        expires_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        metadata: { shutdown: true },
      })
      .eq("worker_id", deps.workerId);
    if (error) {
      console.warn(`[iress-ingest] clearPersistedApplicationId failed: ${error.message}`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[iress-ingest] clearPersistedApplicationId threw: ${msg}`);
  }
}

function hashForLog(value: string): string {
  return redactSessionKeyForLog(value);
}

function persistedSessionIsStale(row: PersistedSessionRow | null): boolean {
  if (!row?.iress_session_key) return true;
  if (row.metadata?.shutdown === true) return true;
  if (row.expires_at && Date.parse(row.expires_at) < Date.now()) return true;
  return false;
}

export class WorkerSessionManager {
  private cache: WorkerMintSession | null = null;
  private inflight: Promise<WorkerMintSession> | null = null;
  private lastPersistedApplicationId: string | null = null;
  private licenseBackoffUntil = 0;

  constructor(private readonly deps: WorkerSessionDeps) {}

  private async resolveApplicationId(): Promise<string> {
    const persisted = await readPersistedApplicationId(this.deps.supabase, this.deps.workerId);
    if (persisted?.application_id) {
      console.info(
        `[iress-ingest] reusing sticky ApplicationID for ${this.deps.workerId}: ${persisted.application_id}`,
      );
      return persisted.application_id;
    }
    const fresh = newStickyApplicationId(this.deps.node);
    console.info(`[iress-ingest] minting new ApplicationID for ${this.deps.workerId}: ${fresh}`);
    await persistStickyApplicationId(this.deps, fresh);
    return fresh;
  }

  private buildSession(
    iressSession: Awaited<ReturnType<typeof bringUpMintSessionFromEnv>>["iressSession"],
    serviceKeys: Awaited<ReturnType<typeof bringUpMintSessionFromEnv>>["serviceKeys"],
    applicationId: string,
  ): WorkerMintSession {
    const timeoutMin = iressSession.SessionTimeout ?? 120;
    const now = Date.now();
    return {
      iressSessionKey: iressSession.IRESSSessionKey,
      applicationId,
      sessionTimeout: timeoutMin,
      expiresAt: now + timeoutMin * 60_000,
      serviceKeys,
      startedAt: now,
    };
  }

  /** End a logged-off / shutdown-persisted key so sticky ApplicationID can mint a live session. */
  private async purgeStaleWireSession(persisted: PersistedSessionRow): Promise<void> {
    const staleKey = persisted.iress_session_key;
    if (!staleKey) return;
    const reason = persisted.metadata?.shutdown
      ? "shutdown metadata"
      : persisted.expires_at && Date.parse(persisted.expires_at) < Date.now()
        ? "expired metadata"
        : "stale persisted key";
    console.info(
      `[iress-ingest] purging ${reason} before IRESSSessionStart key=${hashForLog(staleKey)}`,
    );
    if (iressConfig.mode === "live" || iressConfig.mode === "wsdl-stub") {
      await tearDownIressWireSession({
        iressSessionKey: staleKey,
        releaseDelayMs: LICENSE_RELEASE_DELAY_MS,
      });
    }
    await clearPersistedSessionKey(this.deps);
    // Drop the stale shutdown flag so the freshly persisted row reflects
    // "we are mid-login" rather than the previous run's shutdown state.
    await clearShutdownFlag(this.deps);
  }

  private async recoverDeadSession(staleKey: string | undefined, err: unknown): Promise<void> {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(
      `[iress-ingest] dead IRESS session (${msg}) — ending wire session and rebuilding`,
    );
    this.invalidate();
    if (
      staleKey &&
      (iressConfig.mode === "live" || iressConfig.mode === "wsdl-stub")
    ) {
      await tearDownIressWireSession({
        iressSessionKey: staleKey,
        releaseDelayMs: LICENSE_RELEASE_DELAY_MS,
      });
    }
    await clearPersistedSessionKey(this.deps);
  }

  private async startSession(): Promise<WorkerMintSession> {
    const persisted = await readPersistedApplicationId(this.deps.supabase, this.deps.workerId);
    if (persisted?.iress_session_key && persistedSessionIsStale(persisted)) {
      await this.purgeStaleWireSession(persisted);
    }
    const firstBootOrOrphan = persistedSessionIsStale(persisted);
    const applicationId = await this.resolveApplicationId();
    await persistStickyApplicationId(this.deps, applicationId);
    try {
      const { iressSession, serviceKeys } = await bringUpMintSessionFromEnv({
        applicationId,
        applicationLabel: this.deps.applicationLabel,
        node: this.deps.node,
        forceKickOn25008: firstBootOrOrphan,
      });
      this.licenseBackoffUntil = 0;
      const session = this.buildSession(iressSession, serviceKeys, applicationId);
      const svc = Object.keys(serviceKeys).join(",") || "none";
      console.info(
        `[iress-ingest] session ready applicationId=${applicationId} iressKey=${hashForLog(session.iressSessionKey)} services=${svc}`,
      );
      this.lastPersistedApplicationId = applicationId;
      await persistApplicationId(this.deps, {
        applicationId,
        iressSessionKey: session.iressSessionKey,
        expiresAt: session.expiresAt,
        metadata: {
          applicationLabel: this.deps.applicationLabel,
          node: this.deps.node,
          shutdown: false,
        },
      });
      return session;
    } catch (err) {
      if (err instanceof IressError && err.code === 25008) {
        this.licenseBackoffUntil = Date.now() + LICENSE_EXHAUSTED_BACKOFF_MS;
        const hint = firstBootOrOrphan
          ? "First-boot auto-kick already attempted; seat may be held by another live client."
          : "Run `bun run iress:logout` from wealth-navigator/ or stop the other IRESS client.";
        console.error(
          `[iress-ingest] 25008 license seat occupied — backing off ${LICENSE_EXHAUSTED_BACKOFF_MS}ms. ${hint}`,
        );
      }
      throw err;
    }
  }

  invalidate(): void {
    this.cache = null;
  }

  async getSession(): Promise<WorkerMintSession> {
    if (Date.now() < this.licenseBackoffUntil) {
      const waitSec = Math.ceil((this.licenseBackoffUntil - Date.now()) / 1000);
      throw new IressError(
        25008,
        "IRESSSessionStart",
        `License seat occupied — retry in ~${waitSec}s or run bun run iress:logout`,
      );
    }
    if (this.cache && Date.now() < this.cache.expiresAt - EXPIRY_BUFFER_MS) {
      return this.cache;
    }
    if (this.inflight) return this.inflight;

    this.inflight = this.startSession();
    try {
      this.cache = await this.inflight;
      return this.cache;
    } finally {
      this.inflight = null;
    }
  }

  async withSession<T>(fn: (session: WorkerMintSession) => Promise<T>): Promise<T> {
    const session = await this.getSession();
    try {
      return await fn(session);
    } catch (err) {
      if (isIressSessionDeadError(err) || (err instanceof IressError && err.code === 25001)) {
        await this.recoverDeadSession(session.iressSessionKey, err);
        return await fn(await this.getSession());
      }
      throw err;
    }
  }

  async tearDown(releaseDelayMs = LICENSE_RELEASE_DELAY_MS): Promise<boolean> {
    if (this.inflight) {
      try {
        await this.inflight;
      } catch {
        /* start may have failed */
      }
    }

    const session = this.cache;
    this.cache = null;
    if (!session) {
      // No active session — still expire the metadata row so a restart re-mints.
      await clearPersistedApplicationId(this.deps);
      this.lastPersistedApplicationId = null;
      return false;
    }

    if (iressConfig.mode !== "live" && iressConfig.mode !== "wsdl-stub") {
      await clearPersistedApplicationId(this.deps);
      this.lastPersistedApplicationId = null;
      return true;
    }

    const ended = await tearDownIressWireSession({
      iressSessionKey: session.iressSessionKey,
      serviceKeys: session.serviceKeys,
      releaseDelayMs,
    });
    await clearPersistedApplicationId(this.deps);
    this.lastPersistedApplicationId = null;
    return ended;
  }
}
