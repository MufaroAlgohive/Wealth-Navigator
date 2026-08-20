import { NextResponse } from "next/server";

import { getAdminContext, isAdminRole } from "@/lib/admin/rbac";
import { IRESS_STALE_FALLBACK_MS } from "@/lib/market-prices/fallback";
import { createInstitutionalServiceRoleClient, createRetailServiceRoleClient } from "@/lib/supabase/server";

/**
 * GET /api/cron/iress-monitor
 *
 * Detects when the IRESS market-data feed goes offline and posts a Discord
 * embed on the transition (and on recovery). It is the alerting half of the
 * IRESS→Yahoo fallback story: the read paths serve Yahoo live the moment a
 * DB price is stale (`/api/admin/factsheets` → lib/market-prices/fallback.ts)
 * and `/api/cron/yahoo-fundamentals` persists Yahoo prices — this route just
 * tells the operator when that handover happens and when IRESS comes back.
 *
 * Signals used:
 *  - Primary: `integration_worker_health` (institutional). The worker stamps
 *    `last_heartbeat_at` every `IRESS_WORKER_HEARTBEAT_SEC`; a heartbeat older
 *    than `IRESS_DOWN_AFTER_SEC` (default 600s) — or `status='stopped'` — is
 *    treated as "IRESS offline".
 *  - Context: how many active retail symbols currently have a stale
 *    `securities_c.updated_at` (i.e. are being served by Yahoo fallback).
 *
 * Dedup / transitions use `monitor_state_c` (institutional, created by
 * supabase/migrations/20260820000001_monitor_state_c.sql). If that table is
 * missing this route is fail-safe: it records detection but does NOT alert
 * (no way to dedup → no spam), and the response explains what to run.
 *
 * Auth: Vercel cron `Authorization: Bearer ${CRON_SECRET}`, OR an admin session.
 * Alerts are sent only when `DISCORD_WEBHOOK_URL` is configured.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MONITOR_ID = "iress-feed";
const DOWN_AFTER_MS = (Number(process.env.IRESS_DOWN_AFTER_SEC) || 600) * 1000;
const RE_ALERT_HOURS = Number(process.env.IRESS_REALERT_HOURS) || 24;
const EMBED_OUTAGE_COLOR = 0xf23f43;
const EMBED_RECOVERED_COLOR = 0x2ecc71;

async function authorized(req: Request): Promise<boolean> {
  const secret = process.env.CRON_SECRET;
  const bearer = req.headers.get("authorization")?.replace("Bearer ", "");
  if (secret && bearer === secret) return true;
  const auth = await getAdminContext();
  return auth.status === "ok" && isAdminRole(auth.ctx);
}

async function sendDiscord(payload: unknown): Promise<{ ok: boolean; status?: number }> {
  const url = process.env.DISCORD_WEBHOOK_URL;
  if (!url) return { ok: false, status: 0 };
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    return { ok: res.ok, status: res.status };
  } catch {
    return { ok: false };
  }
}

function humanAge(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function buildEmbed(opts: {
  offline: boolean;
  workerId: string;
  serviceName: string;
  status: string;
  iressMode: string | null;
  lastHeartbeatAt: string | null;
  heartbeatAgeMs: number;
  lastQuoteSyncAt: string | null;
  symbolsCovered: number | null;
  yahooServing: number | null;
}) {
  const {
    offline,
    workerId,
    serviceName,
    status,
    iressMode,
    lastHeartbeatAt,
    heartbeatAgeMs,
    lastQuoteSyncAt,
    symbolsCovered,
    yahooServing,
  } = opts;
  const fields = [
    { name: "Worker", value: `${serviceName} · \`${workerId}\``, inline: true },
    { name: "IRESS mode", value: iressMode ? `\`${iressMode}\`` : "—", inline: true },
    { name: "Status", value: `\`${status}\``, inline: true },
    {
      name: "Last heartbeat",
      value: lastHeartbeatAt ? `<t:${Math.floor(new Date(lastHeartbeatAt).getTime() / 1000)}:F>` : "—",
      inline: true,
    },
    { name: "Heartbeat age", value: humanAge(heartbeatAgeMs), inline: true },
    {
      name: "Last quote sync",
      value: lastQuoteSyncAt ? `<t:${Math.floor(new Date(lastQuoteSyncAt).getTime() / 1000)}:F>` : "—",
      inline: true,
    },
    {
      name: "Symbols covered",
      value: symbolsCovered != null ? String(symbolsCovered) : "—",
      inline: true,
    },
    {
      name: "Symbols on Yahoo fallback",
      value: yahooServing != null ? String(yahooServing) : "—",
      inline: true,
    },
  ];
  return {
    username: "MINT Feed Monitor",
    embeds: [
      offline
        ? {
            color: EMBED_OUTAGE_COLOR,
            title: "🔴 IRESS market-data feed offline",
            description:
              "The IRESS worker stopped reporting quotes. Prices are now being served from the Yahoo Finance fallback (in-memory on read, persisted by the 5-min `yahoo-fundamentals` cron). A recovery embed is posted when IRESS comes back.",
            fields,
            footer: { text: "MINT Feed Monitor · IRESS → Yahoo fallback active" },
            timestamp: new Date().toISOString(),
          }
        : {
            color: EMBED_RECOVERED_COLOR,
            title: "🟢 IRESS market-data feed recovered",
            description:
              "The IRESS worker resumed reporting. Quotes are flowing again — price ownership hands back to IRESS (Path A → Supabase) automatically as `securities_c.updated_at` refreshes.",
            fields,
            footer: { text: "MINT Feed Monitor · IRESS back online" },
            timestamp: new Date().toISOString(),
          },
    ],
  };
}

export async function GET(req: Request) {
  if (!(await authorized(req))) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const now = Date.now();
  let stateRow: { state: string; last_alert_at: string | null } | null = null;
  let stateError: string | null = null;

  let institutional: ReturnType<typeof createInstitutionalServiceRoleClient>;
  try {
    institutional = createInstitutionalServiceRoleClient();
  } catch {
    return NextResponse.json({ ok: false, error: "institutional db not configured" }, { status: 502 });
  }

  const { data: healthRows } = await institutional
    .from("integration_worker_health")
    .select("*")
    .eq("service_name", "iress-ingest")
    .order("last_heartbeat_at", { ascending: false })
    .limit(1);

  const worker = healthRows?.[0] as
    | {
        worker_id?: string;
        service_name?: string;
        status?: string;
        iress_mode?: string | null;
        last_heartbeat_at?: string | null;
        last_quote_sync_at?: string | null;
        metadata?: Record<string, unknown> | null;
      }
    | undefined;

  const lastHeartbeatAt = worker?.last_heartbeat_at ?? null;
  const lastBeatMs = lastHeartbeatAt ? new Date(lastHeartbeatAt).getTime() : 0;
  const heartbeatAgeMs =
    Number.isFinite(lastBeatMs) && lastBeatMs > 0 ? now - lastBeatMs : Number.POSITIVE_INFINITY;
  const offline = !lastBeatMs || worker?.status === "stopped" || heartbeatAgeMs > DOWN_AFTER_MS;

  // Context: how many active retail symbols are currently older than the
  // IRESS_STALE_FALLBACK_HOURS window (i.e. being served by Yahoo fallback).
  let yahooServing: number | null = null;
  try {
    const retail = createRetailServiceRoleClient();
    const { count } = await retail
      .from("securities_c")
      .select("id", { count: "exact", head: true })
      .eq("is_active", true)
      .lt("updated_at", new Date(now - IRESS_STALE_FALLBACK_MS).toISOString());
    yahooServing = count ?? null;
  } catch {
    // Retail db optional for this cron — embed just shows "—".
  }

  try {
    const { data, error } = await institutional
      .from("monitor_state_c")
      .select("state,last_alert_at")
      .eq("monitor_id", MONITOR_ID)
      .maybeSingle();
    if (error) throw error;
    stateRow = data as { state: string; last_alert_at: string | null } | null;
  } catch (error) {
    stateError = error instanceof Error ? error.message : String(error);
  }

  const desired = offline ? "offline" : "online";
  const transition = Boolean(stateRow && stateRow.state !== desired);
  const reAlertDue = Boolean(
    offline &&
      stateRow?.state === "offline" &&
      stateRow.last_alert_at &&
      now - new Date(stateRow.last_alert_at).getTime() > RE_ALERT_HOURS * 3_600_000,
  );

  let alerted = false;
  let alertError: string | null = null;
  const webhookConfigured = Boolean(process.env.DISCORD_WEBHOOK_URL);

  if (stateError) {
    console.warn(
      `[iress-monitor] monitor_state_c unavailable (${stateError}) — skipping alert to avoid spam. Run supabase/migrations/20260820000001_monitor_state_c.sql on the institutional DB.`,
    );
  } else if (transition || reAlertDue) {
    const embed = buildEmbed({
      offline,
      workerId: worker?.worker_id ?? "unknown",
      serviceName: worker?.service_name ?? "iress-ingest",
      status: worker?.status ?? "unknown",
      iressMode: worker?.iress_mode ?? null,
      lastHeartbeatAt,
      heartbeatAgeMs,
      lastQuoteSyncAt: worker?.last_quote_sync_at ?? null,
      symbolsCovered:
        worker?.metadata && typeof worker.metadata.symbols_covered === "number"
          ? Number(worker.metadata.symbols_covered)
          : null,
      yahooServing,
    });
    const result = await sendDiscord(embed);
    alerted = result.ok;
    if (!result.ok) alertError = result.status ? `discord ${result.status}` : "discord unreachable";
    if (alertError) console.error(`[iress-monitor] alert failed: ${alertError}`);
  }

  // Persist state so the next run can detect the transition. Tolerates a
  // missing table (returns a row error) — alerting above is already skipped.
  const persist = stateRow
    ? institutional
        .from("monitor_state_c")
        .update({
          state: desired,
          first_detected_at: offline && transition ? new Date(now).toISOString() : undefined,
          last_checked_at: new Date(now).toISOString(),
          last_transition_at: transition ? new Date(now).toISOString() : undefined,
          last_alert_at: alerted ? new Date(now).toISOString() : stateRow.last_alert_at,
          updated_at: new Date(now).toISOString(),
          metadata: {
            last_heartbeat_at: lastHeartbeatAt,
            heartbeat_age_ms: Number.isFinite(heartbeatAgeMs) ? heartbeatAgeMs : null,
            yahoo_serving_symbols: yahooServing,
          },
        })
        .eq("monitor_id", MONITOR_ID)
    : institutional.from("monitor_state_c").insert({
        monitor_id: MONITOR_ID,
        state: desired,
        first_detected_at: offline ? new Date(now).toISOString() : null,
        last_transition_at: new Date(now).toISOString(),
        last_alert_at: alerted ? new Date(now).toISOString() : null,
        last_checked_at: new Date(now).toISOString(),
        updated_at: new Date(now).toISOString(),
        metadata: {
          last_heartbeat_at: lastHeartbeatAt,
          heartbeat_age_ms: Number.isFinite(heartbeatAgeMs) ? heartbeatAgeMs : null,
          yahoo_serving_symbols: yahooServing,
        },
      });
  await persist;

  return NextResponse.json({
    ok: true,
    offline,
    state: desired,
    transition,
    alerted,
    webhookConfigured,
    stateReadFailed: Boolean(stateError),
    heartbeatAgeSec: Number.isFinite(heartbeatAgeMs) ? Math.round(heartbeatAgeMs / 1000) : null,
    yahooServing,
    alertError,
  });
}
