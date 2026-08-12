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
import { recordWorkerEvent } from "./events";

export { LICENSE_RELEASE_DELAY_MS };
const EXPIRY_BUFFER_MS = 30_000;
/** Back off after 25008 instead of hammering IRESSSessionStart. */
const LICENSE_EXHAUSTED_BACKOFF_MS = 60_000;
/**
 * Emergency ceiling: after the seat has been held for this long across
 * consecutive attempts, escalate to a much longer backoff so the worker
 * stops hammering IRESS and emits a single `license_seat_emergency`
 * structured event for the operator to correlate with IRESS admin's
 * active-session list. Picked at 10 minutes (the IRESS idle window per
 * the docs is 2 hours, so this is well inside the operator's reaction
 * time but well above the 60s round-trip noise).
 */
const LICENSE_EXHAUSTED_CEILING_MS = 10 * 60_000;
/** Long backoff window used once the ceiling is hit. */
const LICENSE_EXHAUSTED_LONG_BACKOFF_MS = 30 * 60_000;
/**
 * `IRESS_FORCE_ORPHAN_CLEAR=1` — operator override. On the next bring-up,
 * wait up to this long for the IRESS server to release a held seat
 * before retrying. Default is 60s (the previous code aborted on the
 * first 25014 instead of retrying, which is why the orphan from the
 * 2026-07-29 dual-session cutover was never cleared). Set the env, deploy
 * once, then unset.
 */
const FORCE_ORPHAN_CLEAR_TIMEOUT_MS = 60_000;
const FORCE_ORPHAN_CLEAR_POLL_MS = 3_000;

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

/**
 * Persist only the sticky ApplicationID — safe before IRESSSessionStart completes.
 *
 * NOT gated on dryRun / allowWrites. Those flags exist to stop the worker writing
 * MARKET or CLIENT data; `worker_session_metadata` is neither. It is the worker's
 * own bookkeeping, and suppressing it actively costs money:
 *
 * IRESS recovers a session by (UserName + CompanyName + ApplicationID). If the ID
 * is not persisted, every restart mints a NEW one and ORPHANS the previous seat —
 * which keeps consuming a licence until IRESS support clears it. Three restarts on
 * 2026-07-27 leaked three seats and took the production market-data login down with
 * "No more licenses available for this login"; the same failure hit on 11 June.
 *
 * A dry-run worker that silently burns licences is not dry.
 */
async function persistStickyApplicationId(
  deps: WorkerSessionDeps,
  applicationId: string,
): Promise<void> {
  if (!deps.supabase) {
    console.warn(
      "[iress-ingest] no Supabase client — cannot persist ApplicationID; this restart will orphan its IRESS seat.",
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
  // Also NOT gated on dryRun / allowWrites — see persistStickyApplicationId.
  // This row is what lets the next boot REUSE the seat instead of orphaning it.
  if (!deps.supabase) {
    console.warn(
      "[iress-ingest] no Supabase client — cannot persist session metadata; this restart will orphan its IRESS seat.",
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
  // Session bookkeeping — not gated on dryRun/allowWrites (see
  // persistStickyApplicationId). A stale key left behind forces the next boot to
  // purge and re-login, which is another orphaned seat.
  if (!deps.supabase) return;
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
  // Not gated on dryRun/allowWrites (see persistStickyApplicationId). The doc
  // comment above says it exactly: skipping this makes the next boot treat the
  // persisted session as stale and force a purge + re-login — i.e. it orphans a
  // seat. Suppressing it under dry-run was self-defeating.
  if (!deps.supabase) return;
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
  // Runs on graceful shutdown. Not gated on dryRun/allowWrites (see
  // persistStickyApplicationId) — stamping the row as expired is how the next
  // boot knows the seat was released cleanly rather than abandoned.
  if (!deps.supabase) return;
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
  /**
   * Most recent entitlement-required or session-dead error the worker
   * surfaced (25008 license exhausted, 25001 invalid session, 25014
   * entitlement required, 25033 service session terminated, or any
   * `isIressSessionDeadError`). Surfaced by `/debug/ips-session` for the
   * BFF diagnostic so the operator can see *why* the IPS / IOSPlus
   * service keys are missing without tailing Railway logs. Cleared on a
   * successful session bring-up so the field is honest about "no
   * recent failure".
   */
  private lastSessionError: { code: number | null; message: string; ts: string } | null = null;
  /**
   * Latched after the first 25008 in this process. The auto-kick on
   * `IRESSSessionStart` is a one-time recovery move, not a per-cycle
   * tool — re-running it on every subsequent kick loop evicts the
   * operator's other IRESS clients (Chrome, Terminal, test sessions) and
   * makes the thrash worse. Set in `startSession` when we see 25008
   * with the first-boot-or-orphan shape; cleared when a session
   * successfully comes up.
   */
  private autoKickAttempted = false;
  /**
   * When the first 25008 was observed in this process. Used to escalate
   * the backoff from the per-attempt 60s to a 30-minute ceiling once
   * the seat has been held for >`LICENSE_EXHAUSTED_CEILING_MS`.
   */
  private firstLicenseExhaustedAt = 0;
  /**
   * Latched once the long-backoff ceiling has fired in this process.
   * Prevents the `license_seat_emergency` event from being emitted every
   * cycle after the ceiling is hit — the operator only needs to see it
   * once so they can correlate with IRESS admin's session list.
   */
  private licenseEmergencyEmitted = false;

  constructor(private readonly deps: WorkerSessionDeps) {}

  private recordSessionError(err: unknown): void {
    const code = err instanceof IressError ? err.code : null;
    const message = err instanceof Error ? err.message : String(err);
    this.lastSessionError = { code, message, ts: new Date().toISOString() };
  }

  private clearSessionError(): void {
    this.lastSessionError = null;
  }

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
    const lower = msg.toLowerCase();
    // The IRESS server already entered the logout handshake on a previous
    // request (`Awaiting Logout Response` / `Current state: Logged off`). At
    // that point tearDown will fail with the same "not logged in" error, and
    // IRESSSessionStart has already been kicked off by the wire itself — we
    // only need to drop the cached key + persisted row. Skipping the
    // tearDown here avoids two wasted license-seat roundtrips per quote
    // cycle (the original symptom of the rebuild loop in this week's logs).
    const alreadyTearingDown =
      lower.includes("awaiting logout response") || lower.includes("current state: logged off");
    console.warn(
      `[iress-ingest] dead IRESS session (${msg}) — ${alreadyTearingDown ? "wire already tearing down, " : "ending wire session and "}rebuilding`,
    );
    this.recordSessionError(err);
    this.invalidate();
    if (
      !alreadyTearingDown &&
      staleKey &&
      (iressConfig.mode === "live" || iressConfig.mode === "wsdl-stub")
    ) {
      try {
        await tearDownIressWireSession({
          iressSessionKey: staleKey,
          releaseDelayMs: LICENSE_RELEASE_DELAY_MS,
        });
      } catch (teardownErr) {
        // tearDown failures on a dead session are expected (the server is
        // already mid-logout). Log and proceed — the rebuild path will mint
        // a fresh key on the next getSession().
        const tmsg = teardownErr instanceof Error ? teardownErr.message : String(teardownErr);
        console.warn(
          `[iress-ingest] tearDown after dead session failed (continuing): ${tmsg}`,
        );
      }
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
    // The auto-kick on `IRESSSessionStart` is a one-time recovery move
    // (per the 2026-08-07 plan: do not re-attempt with `SessionNumberToKick=-1`
    // on every cycle, that just evicts the operator's other live IRESS
    // clients and makes the thrash worse). Latch on process start so
    // `firstBootOrOrphan` flips back to false the moment we attempt a
    // kick for the first time, even if the persisted row was sticky.
    const shouldAutoKick = firstBootOrOrphan && !this.autoKickAttempted;
    try {
      const { iressSession, serviceKeys } = await bringUpMintSessionFromEnv({
        applicationId,
        applicationLabel: this.deps.applicationLabel,
        node: this.deps.node,
        forceKickOn25008: shouldAutoKick,
      });
      if (shouldAutoKick) this.autoKickAttempted = true;
      this.licenseBackoffUntil = 0;
      this.firstLicenseExhaustedAt = 0;
      this.licenseEmergencyEmitted = false;
      this.clearSessionError();
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
      recordWorkerEvent({
        level: "info",
        event: "iress_session_ready",
        msg: `IRESSSessionStart OK — applicationId=${applicationId} services=${svc}`,
        data: {
          applicationId,
          services: Object.keys(serviceKeys),
          sessionTimeoutMin: session.sessionTimeout,
        },
      });
      return session;
    } catch (err) {
      this.recordSessionError(err);
      if (err instanceof IressError && err.code === 25008) {
        // One-time auto-kick latch (per the 2026-08-07 plan).
        if (shouldAutoKick) this.autoKickAttempted = true;
        // `IRESS_FORCE_ORPHAN_CLEAR=1` — wait for the IRESS server to
        // release the held seat before bailing. The previous code aborted
        // on the first 25014 which is why the orphan from the 2026-07-29
        // dual-session cutover was never cleared. Polls every 3s up to a
        // 60s window. Optimised for the 2h idle timeout in the IRESS docs
        // being a soft upper bound — the orphan usually releases within a
        // few seconds once the server notices the previous wire is gone.
        if (
          process.env.IRESS_FORCE_ORPHAN_CLEAR === "1" &&
          !this.licenseEmergencyEmitted
        ) {
          const cleared = await this.waitForOrphanClear();
          if (cleared) {
            // Retry the bring-up exactly once, now that the seat is
            // free. We do not loop — the caller (loops / HTTP routes) is
            // already on a retry path.
            try {
              const retried = await bringUpMintSessionFromEnv({
                applicationId,
                applicationLabel: this.deps.applicationLabel,
                node: this.deps.node,
                forceKickOn25008: false,
              });
              const session = this.buildSession(
                retried.iressSession,
                retried.serviceKeys,
                applicationId,
              );
              this.licenseBackoffUntil = 0;
              this.firstLicenseExhaustedAt = 0;
              this.licenseEmergencyEmitted = false;
              this.clearSessionError();
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
              recordWorkerEvent({
                level: "info",
                event: "iress_session_ready_after_orphan_clear",
                msg: `IRESSSessionStart OK after IRESS_FORCE_ORPHAN_CLEAR — applicationId=${applicationId}`,
                data: { applicationId },
              });
              return session;
            } catch (retryErr) {
              // The retry itself got 25008 — the orphan did not release
              // in time. Fall through to the regular backoff path.
              this.recordSessionError(retryErr);
            }
          }
        }
        // Backoff escalation (per the 2026-08-07 plan): after the seat
        // has been held for >`LICENSE_EXHAUSTED_CEILING_MS` across
        // consecutive attempts, escalate to a 30-minute window and emit
        // a single `license_seat_emergency` event for the operator to
        // correlate with IRESS admin's active-session list.
        if (this.firstLicenseExhaustedAt === 0) {
          this.firstLicenseExhaustedAt = Date.now();
        }
        const heldForMs = Date.now() - this.firstLicenseExhaustedAt;
        const ceilingReached = heldForMs > LICENSE_EXHAUSTED_CEILING_MS;
        const backoffMs = ceilingReached ? LICENSE_EXHAUSTED_LONG_BACKOFF_MS : LICENSE_EXHAUSTED_BACKOFF_MS;
        this.licenseBackoffUntil = Date.now() + backoffMs;
        if (ceilingReached && !this.licenseEmergencyEmitted) {
          this.licenseEmergencyEmitted = true;
          const msg = `IRESS license seat held for >${LICENSE_EXHAUSTED_CEILING_MS / 60_000}min — backoff escalated to ${LICENSE_EXHAUSTED_LONG_BACKOFF_MS / 60_000}min. Check IRESS admin's active-session list for ${this.deps.workerId} (hostname=${this.deps.node}, applicationId=${applicationId}) and stop any session that is not THIS worker. If the seat is held by an orphan, set IRESS_FORCE_ORPHAN_CLEAR=1 and redeploy once.`;
          console.error(`[iress-ingest] LICENSE SEAT EMERGENCY: ${msg}`);
          recordWorkerEvent({
            level: "error",
            event: "license_seat_emergency",
            msg,
            data: {
              code: 25008,
              heldForMs,
              backoffMs,
              workerId: this.deps.workerId,
              node: this.deps.node,
              applicationId,
              hint: "check IRESS admin active-session list; set IRESS_FORCE_ORPHAN_CLEAR=1 to auto-recover",
            },
          });
        } else {
          const hint = this.autoKickAttempted
            ? "Auto-kick already attempted for this process; another live IRESS client is holding the seat. Check IRESS admin's active-session list or wait for the 2h idle timeout."
            : "Run `bun run iress:logout` from wealth-navigator/ or stop the other IRESS client.";
          console.error(
            `[iress-ingest] 25008 license seat occupied — backing off ${backoffMs}ms. ${hint}`,
          );
          recordWorkerEvent({
            level: "error",
            event: "license_seat_occupied",
            msg: `25008 license seat occupied — backing off ${backoffMs}ms. ${hint}`,
            data: {
              code: 25008,
              backoffMs,
              firstBootOrOrphan,
              autoKickAttempted: this.autoKickAttempted,
              heldForMs,
              ceilingReached,
            },
          });
        }
      }
      throw err;
    }
  }

  /**
   * Poll the IRESS server for up to `FORCE_ORPHAN_CLEAR_TIMEOUT_MS`, looking
   * for the seat to be released. We probe by issuing a no-op
   * `IRESSSessionStart` (no `SessionNumberToKick`) — when the server returns
   * 25008 / 25013 the seat is still held; when it returns a new key, the
   * orphan is gone and we hand the key back to the caller.
   *
   * Returns `true` when the seat was cleared in the window, `false` otherwise.
   */
  private async waitForOrphanClear(): Promise<boolean> {
    const deadline = Date.now() + FORCE_ORPHAN_CLEAR_TIMEOUT_MS;
    let attempt = 0;
    console.warn(
      `[iress-ingest] IRESS_FORCE_ORPHAN_CLEAR=1 — waiting up to ${FORCE_ORPHAN_CLEAR_TIMEOUT_MS / 1000}s for IRESS to release the held seat`,
    );
    recordWorkerEvent({
      level: "warn",
      event: "license_seat_orphan_clear_started",
      msg: `IRESS_FORCE_ORPHAN_CLEAR=1 — polling IRESS for seat release every ${FORCE_ORPHAN_CLEAR_POLL_MS / 1000}s`,
      data: {
        timeoutMs: FORCE_ORPHAN_CLEAR_TIMEOUT_MS,
        pollMs: FORCE_ORPHAN_CLEAR_POLL_MS,
      },
    });
    while (Date.now() < deadline) {
      attempt += 1;
      try {
        // No kick — we want a clean probe. If the orphan is still alive,
        // the server returns 25008 / 25013 and we sleep + retry.
        const { iressSession, serviceKeys } = await bringUpMintSessionFromEnv({
          applicationId: this.lastPersistedApplicationId ?? this.deps.workerId,
          applicationLabel: this.deps.applicationLabel,
          node: this.deps.node,
          forceKickOn25008: false,
        });
        const session = this.buildSession(
          iressSession,
          serviceKeys,
          this.lastPersistedApplicationId ?? this.deps.workerId,
        );
        console.info(
          `[iress-ingest] IRESS_FORCE_ORPHAN_CLEAR: seat released after ${attempt} probe(s) (${Date.now() - (deadline - FORCE_ORPHAN_CLEAR_TIMEOUT_MS)}ms)`,
        );
        recordWorkerEvent({
          level: "info",
          event: "license_seat_orphan_cleared",
          msg: `IRESS seat released after ${attempt} probe(s) — IRESSSessionStart OK`,
          data: { attempts: attempt },
        });
        // Stash the session so the caller's retry path picks it up.
        this.cache = session;
        return true;
      } catch (err) {
        if (err instanceof IressError && err.code === 25008) {
          // Still held — keep polling.
          await new Promise<void>((r) => setTimeout(r, FORCE_ORPHAN_CLEAR_POLL_MS));
          continue;
        }
        // Any other error (25013, 25014, network) — keep polling too,
        // the orphan is independent of transient faults.
        await new Promise<void>((r) => setTimeout(r, FORCE_ORPHAN_CLEAR_POLL_MS));
        continue;
      }
    }
    console.warn(
      `[iress-ingest] IRESS_FORCE_ORPHAN_CLEAR: seat NOT released after ${FORCE_ORPHAN_CLEAR_TIMEOUT_MS / 1000}s and ${attempt} probe(s)`,
    );
    recordWorkerEvent({
      level: "warn",
      event: "license_seat_orphan_keep_held",
      msg: `IRESS seat still held after ${FORCE_ORPHAN_CLEAR_TIMEOUT_MS / 1000}s / ${attempt} probe(s)`,
      data: { attempts: attempt, timeoutMs: FORCE_ORPHAN_CLEAR_TIMEOUT_MS },
    });
    return false;
  }

  invalidate(): void {
    this.cache = null;
  }

  /**
   * Force `getSession()` to back off (throw 25008) for `ms`, so the worker's
   * background loops do not re-grab the single IRESS licence seat. Used only by
   * the `/debug/method-ref?freeSeat=1` route to release the seat long enough to
   * generate the authoritative WSDL / Method Reference (which does its own
   * transient login). The worker rebuilds its session once the window expires.
   */
  pauseAcquisition(ms: number): void {
    this.licenseBackoffUntil = Date.now() + Math.max(0, ms);
  }

  /**
   * Non-async accessor for the current session (no SOAP call, no expiry
   * check). Used by the HTTP API health endpoint to surface session
   * metadata without triggering an IRESS login.
   */
  peekSession(): WorkerMintSession | null {
    return this.cache;
  }

  /**
   * Snapshot of the most recent entitlement-required / session-dead
   * error the worker observed, for `/debug/ips-session` to surface.
   * `null` when no such error has been recorded (or the most recent
   * `startSession` succeeded and cleared it).
   */
  peekLastSessionError(): { code: number | null; message: string; ts: string } | null {
    return this.lastSessionError;
  }

  async getSession(): Promise<WorkerMintSession> {
    if (Date.now() < this.licenseBackoffUntil) {
      const waitSec = Math.ceil((this.licenseBackoffUntil - Date.now()) / 1000);
      const backoffErr = new IressError(
        25008,
        "IRESSSessionStart",
        `License seat occupied — retry in ~${waitSec}s or run bun run iress:logout`,
      );
      this.recordSessionError(backoffErr);
      throw backoffErr;
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
        const msg = err instanceof Error ? err.message : String(err);
        const lower = msg.toLowerCase();
        const alreadyTearingDown =
          lower.includes("awaiting logout response") || lower.includes("current state: logged off");
        await this.recoverDeadSession(session.iressSessionKey, err);
        // If the IRESS server was already mid-logout, the wire has its own
        // IRESSSessionStart in flight on the next IRESS_CT allocation. Yield
        // briefly so we don't race it (and immediately re-trigger the dead
        // state). 1.5s matches the LICENSE_RELEASE_DELAY_MS lower bound
        // (sleep(3_000) inside tearDownIressWireSession when a fresh key is
        // being minted) without being so long that the watchlist loop
        // stalls visibly.
        if (alreadyTearingDown) {
          await new Promise<void>((r) => setTimeout(r, 1500));
        }
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
