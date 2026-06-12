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
  tearDownIressWireSession,
} from "@/lib/iress/index";
import { IressError } from "@/lib/iress/errors";
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
}

async function readPersistedApplicationId(
  supabase: WorkerSupabase | null,
  workerId: string,
): Promise<PersistedSessionRow | null> {
  if (!supabase) return null;
  try {
    const { data, error } = await supabase
      .from("worker_session_metadata")
      .select("application_id, expires_at, iress_session_key")
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

async function clearPersistedApplicationId(deps: WorkerSessionDeps): Promise<void> {
  if (!deps.supabase || !deps.allowWrites || deps.dryRun) {
    console.info(`[iress-ingest] would expire worker_session_metadata for ${deps.workerId}`);
    return;
  }
  try {
    const { error } = await deps.supabase
      .from("worker_session_metadata")
      .update({
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
  // Truncated SHA-256 of the session key for log correlation.
  // We never log the full key.
  let h = 0;
  for (let i = 0; i < value.length; i++) {
    h = (h * 31 + value.charCodeAt(i)) | 0;
  }
  return `kh${(h >>> 0).toString(16)}`;
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

  private async startSession(): Promise<WorkerMintSession> {
    const applicationId = await this.resolveApplicationId();
    await persistStickyApplicationId(this.deps, applicationId);
    try {
      const { iressSession, serviceKeys } = await bringUpMintSessionFromEnv({
        applicationId,
        applicationLabel: this.deps.applicationLabel,
        node: this.deps.node,
      });
      this.licenseBackoffUntil = 0;
      const session = this.buildSession(iressSession, serviceKeys, applicationId);
      this.lastPersistedApplicationId = applicationId;
      await persistApplicationId(this.deps, {
        applicationId,
        iressSessionKey: session.iressSessionKey,
        expiresAt: session.expiresAt,
        metadata: { applicationLabel: this.deps.applicationLabel, node: this.deps.node },
      });
      return session;
    } catch (err) {
      if (err instanceof IressError && err.code === 25008) {
        this.licenseBackoffUntil = Date.now() + LICENSE_EXHAUSTED_BACKOFF_MS;
        console.error(
          `[iress-ingest] 25008 license seat occupied — backing off ${LICENSE_EXHAUSTED_BACKOFF_MS}ms. ` +
            "Run `bun run iress:logout` from wealth-navigator/ or stop the other IRESS client.",
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
    try {
      return await fn(await this.getSession());
    } catch (err) {
      if (err instanceof IressError && err.code === 25001) {
        this.invalidate();
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
