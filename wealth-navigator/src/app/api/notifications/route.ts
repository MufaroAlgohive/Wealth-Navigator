import { NextResponse } from "next/server";

import { getAdminContext } from "@/lib/admin/rbac";
import {
  createInstitutionalServiceRoleClient,
  isInstitutionalSupabaseConfigured,
} from "@/lib/supabase/server";

/**
 * GET /api/notifications
 *
 * Aggregated feed of platform notifications for the top-bar bell:
 *
 *   - SYSTEM  — worker heartbeat health + IRESS service-call results
 *               (most recent errors / warnings emitted by the Railway worker).
 *   - DATA    — IRESS overlay + Yahoo fallback activations observed on the
 *               most recent `/api/equities` and `/api/quotes` reads
 *               (informational; surfaces on every render).
 *   - ACTION  — pending admin action items (EFT, manual funds, approvals,
 *               rebalance-ready). Only populated when the caller is an
 *               admin — the same contract the existing
 *               `/api/admin/action-items` route uses.
 *
 * The response shape is intentionally flat so the client can group / sort /
 * filter without a second round-trip. Each notification carries a stable
 * `id`, `category`, `severity`, `title`, `message`, `ts`, optional `href`,
 * and an optional `unread` flag (server returns `true` for everything until
 * the client marks things read in localStorage; the server doesn't persist
 * read state — that keeps the BFF read-only and stateless).
 *
 * Error policy: any failure inside one of the three sub-fetches degrades
 * to `null` for that category rather than 5xx-ing the whole bell. Operators
 * tolerate "no data events yet" but hate an empty bell that broke the page.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface NotificationItem {
  id: string;
  category: "system" | "data" | "action";
  severity: "info" | "warning" | "critical";
  title: string;
  message: string;
  ts: string;
  href?: string;
  unread?: boolean;
}

const MAX_PER_CATEGORY = 8;

function asString(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return null;
}

function workerEventsToNotifications(
  events: ReadonlyArray<{
    ts: string;
    level?: string | null;
    service?: string | null;
    event?: string | null;
    msg?: string | null;
  }>,
  baseHref: string,
): NotificationItem[] {
  return events
    .filter((e) => {
      const lvl = (e.level ?? "").toLowerCase();
      // Show errors and warns always; only show `info` for fresh worker
      // startup events so the bell doesn't get noisy with normal cycles.
      return lvl === "error" || lvl === "warn" || (lvl === "info" && e.event?.startsWith("worker_"));
    })
    .slice(0, MAX_PER_CATEGORY)
    .map((e, idx) => {
      const lvl = (e.level ?? "info").toLowerCase();
      const severity: NotificationItem["severity"] =
        lvl === "error" ? "critical" : lvl === "warn" ? "warning" : "info";
      const service = e.service ? String(e.service).toUpperCase() : "PLATFORM";
      const title = e.event ? `${service} · ${e.event.replace(/_/g, " ")}` : `${service} event`;
      return {
        id: `sys-${e.ts}-${idx}`,
        category: "system",
        severity,
        title,
        message: e.msg ?? title,
        ts: e.ts,
        href: baseHref,
      };
    });
}

interface YahooFallbackRow {
  yahooFallback?: number | null;
  iressOverlay?: number | null;
  count?: number | null;
}

function yahooFallbackToNotifications(equities: YahooFallbackRow | null): NotificationItem[] {
  if (!equities) return [];
  const yf = Number(equities.yahooFallback ?? 0);
  const io = Number(equities.iressOverlay ?? 0);
  const total = Number(equities.count ?? 0);
  const out: NotificationItem[] = [];
  if (yf > 0) {
    out.push({
      id: "data-yahoo-fallback",
      category: "data",
      severity: yf > 25 ? "warning" : "info",
      title: `${yf} symbol${yf === 1 ? "" : "s"} on Yahoo fallback`,
      message: `IRESS service unavailable — ${yf} of ${total} securities are being served by the Yahoo live fallback.`,
      ts: new Date().toISOString(),
      href: "/oems/equities",
      unread: true,
    });
  }
  if (io > 0) {
    out.push({
      id: "data-iress-overlay",
      category: "data",
      severity: "info",
      title: `${io} symbol${io === 1 ? "" : "s"} on IRESS overlay`,
      message: `IRESS-PROD L1 overlay applied to ${io} of ${total} securities.`,
      ts: new Date().toISOString(),
      href: "/oems/equities",
    });
  }
  return out;
}

async function actionItemsToNotifications(): Promise<NotificationItem[]> {
  // Reuse the existing admin action-items shape — admin-only.
  const auth = await getAdminContext();
  if (auth.status !== "ok") return [];
  try {
    const res = await fetch(`${process.env.NEXT_PUBLIC_BASE_URL ?? ""}/api/admin/action-items`, {
      cache: "no-store",
    });
    if (!res.ok) return [];
    const body = (await res.json()) as {
      count?: number;
      items?: Array<{
        id: string;
        type: string;
        label: string;
        href: string;
        severity: string;
        createdAt: string;
      }>;
    };
    if (!body.items || body.items.length === 0) return [];
    return body.items.slice(0, MAX_PER_CATEGORY).map((item) => ({
      id: `act-${item.type}-${item.id}`,
      category: "action",
      severity: (item.severity === "critical"
        ? "critical"
        : item.severity === "warning"
          ? "warning"
          : "info") as NotificationItem["severity"],
      title: item.label,
      message: `Action required · ${item.type.replace(/_/g, " ")}`,
      ts: item.createdAt,
      href: item.href,
      unread: true,
    }));
  } catch {
    return [];
  }
}

export async function GET() {
  // SYSTEM — worker events
  let system: NotificationItem[] = [];
  if (isInstitutionalSupabaseConfigured()) {
    try {
      const db = createInstitutionalServiceRoleClient();
      const { data: workers } = await db
        .from("integration_worker_health")
        .select("worker_id, metadata, status, last_heartbeat_at, iress_mode")
        .order("last_heartbeat_at", { ascending: false })
        .limit(5);
      const allEvents: Array<{
        ts: string;
        level: string | null;
        service: string | null;
        event: string | null;
        msg: string | null;
      }> = [];
      for (const w of workers ?? []) {
        const meta = (
          w as {
            metadata?: {
              recent_events?: Array<{
                ts?: string;
                level?: string;
                service?: string;
                event?: string;
                msg?: string;
              }>;
            } | null;
          }
        ).metadata;
        const evs = meta?.recent_events ?? [];
        for (const e of evs) {
          if (!e.ts) continue;
          allEvents.push({
            ts: e.ts,
            level: e.level ?? null,
            service: e.service ?? null,
            event: e.event ?? null,
            msg: e.msg ?? null,
          });
        }
        // Heartbeat staleness itself is a system notification.
        const lastBeat = (w as { last_heartbeat_at?: string }).last_heartbeat_at;
        if (lastBeat) {
          const ageMs = Date.now() - new Date(lastBeat).getTime();
          if (ageMs > 5 * 60_000 && Number.isFinite(ageMs)) {
            allEvents.push({
              ts: lastBeat,
              level: "warn",
              service: "worker",
              event: "heartbeat_stale",
              msg: `Worker ${(w as { worker_id?: string }).worker_id ?? "—"} heartbeat ${Math.floor(ageMs / 60000)}m old.`,
            });
          }
        }
      }
      allEvents.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));
      system = workerEventsToNotifications(allEvents, "/oems/integration");
    } catch {
      system = [];
    }
  }

  // DATA — Yahoo fallback activations from /api/equities
  let data: NotificationItem[] = [];
  try {
    const base = process.env.NEXT_PUBLIC_BASE_URL ?? "";
    const url = base ? `${base}/api/equities` : "/api/equities";
    const res = await fetch(url, { cache: "no-store" });
    if (res.ok) {
      const body = (await res.json()) as YahooFallbackRow;
      data = yahooFallbackToNotifications(body);
    }
  } catch {
    data = [];
  }

  // ACTION — admin action items (admin-only)
  const action = await actionItemsToNotifications();

  const items: NotificationItem[] = [...system, ...data, ...action].sort((a, b) =>
    a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0,
  );

  return NextResponse.json({
    ok: true,
    count: items.length,
    unreadCount: items.filter((i) => i.unread).length,
    systemCount: system.length,
    dataCount: data.length,
    actionCount: action.length,
    items,
  });
}
