import { NextResponse } from "next/server";

import { getAdminContext } from "@/lib/admin/rbac";
import { createRetailServiceRoleClient } from "@/lib/supabase/server";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Cyber Compliance & monitoring. Ports `/api/cyber-compliance?action=…` over
 * cc_incidents / cc_uptime_log / cc_api_health / cc_policy_checks / cc_audit_log
 * (RETAIL DB) + auth users for activity.
 *
 * DB-backed now: badge-count, list-incidents, create/update/confirm/delete
 * incident, list-uptime, list-api-health, list-policy-checks, list-audit-log,
 * purge-kyc-audit, list-user-activity, health-summary, check-migration.
 * DEFERRED (active scanners / SQL runner = backend bucket): run-policy-checks-
 * live, run-health-check, run-migration — return honest notices.
 */

export const dynamic = "force-dynamic";

const VALID_PRIORITIES = ["low", "medium", "high", "critical"];
const VALID_STATUSES = ["open", "in_progress", "resolved", "closed"];
const VALID_CATEGORIES = ["hardware", "software", "network", "security", "access", "uptime", "api", "policy", "other"];
const VALID_ENVS = ["live", "dev", "crm", "supabase", "email", "general"];
const DEFER = "Active scan / migration runner is deferred (backend port pending).";

async function gate() {
  const auth = await getAdminContext();
  if (auth.status === "no-session") return { db: null, ctx: null, err: NextResponse.json({ ok: false, error: "no-session" }, { status: 401 }) };
  if (auth.status === "not-member") return { db: null, ctx: null, err: NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 }) };
  let db: SupabaseClient | null = null;
  try {
    db = createRetailServiceRoleClient();
  } catch {
    db = null;
  }
  return { db, ctx: auth.status === "ok" ? auth.ctx : null, err: null as null };
}

const sinceIso = (ms: number) => new Date(Date.now() - ms).toISOString();

export async function GET(req: Request) {
  const g = await gate();
  if (g.err) return g.err;
  const { db } = g;
  const url = new URL(req.url);
  const action = url.searchParams.get("action") || "list-incidents";
  if (!db) return NextResponse.json({ ok: true, notice: "RETAIL database not configured.", incidents: [], logs: [], checks: [], users: [], counts: {} });

  if (action === "badge-count") {
    const [inc, pol, up] = await Promise.all([
      db.from("cc_incidents").select("id").in("status", ["open", "in_progress"]).limit(1000),
      db.from("cc_policy_checks").select("id").eq("passed", false).gte("checked_at", sinceIso(90 * 60 * 1000)).limit(1000),
      db.from("cc_uptime_log").select("id").eq("is_up", false).gte("checked_at", sinceIso(20 * 60 * 1000)).limit(1000),
    ]);
    const count = (inc.data?.length ?? 0) + (pol.data?.length ?? 0) + (up.data?.length ?? 0);
    return NextResponse.json({ ok: true, count });
  }

  if (action === "list-incidents") {
    const status = url.searchParams.get("status") || "";
    const priority = url.searchParams.get("priority") || "";
    const env = url.searchParams.get("env") || "";
    const search = url.searchParams.get("search") || "";
    const auto = url.searchParams.get("auto") || "";
    const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(url.searchParams.get("limit") || "50", 10) || 50));
    let q = db.from("cc_incidents").select("*");
    if (status && VALID_STATUSES.includes(status)) q = q.eq("status", status);
    if (priority && VALID_PRIORITIES.includes(priority)) q = q.eq("priority", priority);
    if (env && VALID_ENVS.includes(env)) q = q.eq("environment", env);
    if (auto === "true") q = q.eq("auto_generated", true);
    if (auto === "false") q = q.eq("auto_generated", false);
    if (search) q = q.or(`title.ilike.%${search}%,description.ilike.%${search}%`);
    const { data, error } = await q.order("created_at", { ascending: false }).range((page - 1) * limit, (page - 1) * limit + limit - 1);
    if (error) return NextResponse.json({ ok: true, incidents: [], notice: "cc_incidents not available." });
    return NextResponse.json({ ok: true, incidents: data ?? [] });
  }

  if (action === "list-uptime") {
    const serviceKey = url.searchParams.get("service_key") || "";
    const env = url.searchParams.get("env") || "";
    const limit = Math.min(500, Math.max(1, parseInt(url.searchParams.get("limit") || "200", 10) || 200));
    let q = db.from("cc_uptime_log").select("*");
    if (serviceKey) q = q.eq("service_key", serviceKey);
    if (env) q = q.eq("environment", env);
    const { data, error } = await q.order("checked_at", { ascending: false }).limit(limit);
    if (error) return NextResponse.json({ ok: true, logs: [], notice: "cc_uptime_log not available." });
    return NextResponse.json({ ok: true, logs: data ?? [] });
  }

  if (action === "list-api-health") {
    const env = url.searchParams.get("env") || "";
    const limit = Math.min(500, Math.max(1, parseInt(url.searchParams.get("limit") || "200", 10) || 200));
    let q = db.from("cc_api_health").select("*");
    if (env) q = q.eq("environment", env);
    const { data, error } = await q.order("checked_at", { ascending: false }).limit(limit);
    if (error) return NextResponse.json({ ok: true, checks: [], notice: "cc_api_health not available." });
    return NextResponse.json({ ok: true, checks: data ?? [] });
  }

  if (action === "list-policy-checks") {
    const env = (url.searchParams.get("env") || "").replace(/[^a-z]/g, "");
    const limit = Math.min(200, Math.max(1, parseInt(url.searchParams.get("limit") || "100", 10) || 100));
    let q = db.from("cc_policy_checks").select("*");
    if (env) q = q.eq("target_env", env);
    const { data, error } = await q.order("checked_at", { ascending: false }).limit(limit);
    if (error) {
      // target_env may not exist pre-migration — fall back unfiltered.
      const fb = await db.from("cc_policy_checks").select("*").order("checked_at", { ascending: false }).limit(limit);
      const rows = (fb.data ?? []).filter((r: Record<string, unknown>) => !env || (r.target_env || "crm") === env);
      return NextResponse.json({ ok: true, checks: rows });
    }
    return NextResponse.json({ ok: true, checks: data ?? [] });
  }

  if (action === "list-audit-log") {
    const table = url.searchParams.get("table") || "";
    const operation = url.searchParams.get("operation") || "";
    const since = url.searchParams.get("since") || "";
    const limit = Math.min(200, Math.max(1, parseInt(url.searchParams.get("limit") || "100", 10) || 100));
    const safeTable = /^[a-z0-9_]+$/.test(table) ? table : "";
    let q = db.from("cc_audit_log").select("*");
    if (safeTable) q = q.eq("table_name", safeTable);
    if (operation && ["INSERT", "UPDATE", "DELETE"].includes(operation)) q = q.eq("operation", operation);
    if (since) {
      const d = new Date(since);
      if (!Number.isNaN(d.getTime())) q = q.gte("changed_at", d.toISOString());
    }
    const { data, error } = await q.order("changed_at", { ascending: false }).limit(limit);
    if (error || !Array.isArray(data) || data.length === 0) return NextResponse.json({ ok: true, logs: [] });
    // Resolve changed_by UUIDs → profile display names.
    const uuids = [...new Set(data.map((r: Record<string, unknown>) => r.changed_by).filter((v): v is string => typeof v === "string" && /^[0-9a-f-]{36}$/i.test(v)))];
    const nameMap: Record<string, string> = {};
    if (uuids.length) {
      const { data: profiles } = await db.from("profiles").select("id, first_name, last_name, email").in("id", uuids);
      for (const p of profiles ?? []) {
        nameMap[p.id as string] = [p.first_name, p.last_name].filter(Boolean).join(" ").trim() || (p.email as string) || (p.id as string);
      }
    }
    const logs = data.map((r: Record<string, unknown>) => ({ ...r, changed_by: nameMap[r.changed_by as string] || r.changed_by || "system" }));
    return NextResponse.json({ ok: true, logs });
  }

  if (action === "health-summary") {
    const since24h = sinceIso(24 * 60 * 60 * 1000);
    const [up, api, pol] = await Promise.all([
      db.from("cc_uptime_log").select("is_up, checked_at").gte("checked_at", since24h).order("checked_at", { ascending: false }).limit(2000),
      db.from("cc_api_health").select("endpoint, label, passed, checked_at").order("checked_at", { ascending: false }).limit(500),
      db.from("cc_policy_checks").select("policy_name, passed, checked_at").order("checked_at", { ascending: false }).limit(500),
    ]);
    const upArr = up.data ?? [];
    const apiArr = api.data ?? [];
    const polArr = pol.data ?? [];
    const pct = (arr: { passed?: boolean; is_up?: boolean }[], key: "passed" | "is_up") =>
      arr.length ? Math.round((arr.filter((r) => r[key]).length / arr.length) * 100) : null;
    const latestBy = <T extends Record<string, unknown>>(arr: T[], k: string) => {
      const m: Record<string, T> = {};
      for (const r of arr) if (!m[r[k] as string]) m[r[k] as string] = r;
      return Object.values(m);
    };
    const apiLatest = latestBy(apiArr as Record<string, unknown>[], "endpoint");
    const polLatest = latestBy(polArr as Record<string, unknown>[], "policy_name");
    const lastChecked = [upArr[0]?.checked_at, apiArr[0]?.checked_at, polArr[0]?.checked_at].filter(Boolean).sort().reverse()[0] || null;
    return NextResponse.json({
      ok: true,
      lastChecked,
      uptimePct: pct(upArr as { is_up?: boolean }[], "is_up"),
      apiPassRate: pct(apiLatest as { passed?: boolean }[], "passed"),
      policyPassRate: pct(polLatest as { passed?: boolean }[], "passed"),
      uptimeCount: upArr.length,
      apiCount: apiLatest.length,
      policyCount: polLatest.length,
    });
  }

  if (action === "list-user-activity" || action === "list-active-users") {
    const MS_30_MIN = 30 * 60 * 1000, MS_24_H = 24 * 60 * 60 * 1000, MS_30_DAYS = 30 * 24 * 60 * 60 * 1000;
    let authUsers: Array<{ id: string; email?: string; last_sign_in_at?: string | null; created_at: string; email_confirmed_at?: string | null }> = [];
    try {
      const { data } = await db.auth.admin.listUsers({ page: 1, perPage: 1000 });
      authUsers = (data?.users ?? []) as typeof authUsers;
    } catch {
      /* admin API unavailable */
    }
    const profileMap: Record<string, { first_name?: string; last_name?: string; email?: string }> = {};
    const { data: profiles } = await db.from("profiles").select("id, first_name, last_name, email");
    for (const p of profiles ?? []) profileMap[p.id as string] = p;
    const now = Date.now();
    const users = authUsers.map((u) => {
      const profile = profileMap[u.id] || {};
      const lastSeen = u.last_sign_in_at ? new Date(u.last_sign_in_at).getTime() : null;
      const sinceMs = lastSeen ? now - lastSeen : null;
      let presence: "online" | "recent" | "inactive" | "never" = "never";
      if (sinceMs !== null) presence = sinceMs < MS_30_MIN ? "online" : sinceMs < MS_24_H ? "recent" : "inactive";
      const displayName = [profile.first_name, profile.last_name].filter(Boolean).join(" ") || u.email?.split("@")[0] || u.id.slice(0, 8);
      return {
        id: u.id,
        email: u.email || profile.email || "",
        display_name: displayName,
        initials: displayName.split(" ").map((w) => w[0]).join("").slice(0, 2).toUpperCase() || "?",
        is_new: now - new Date(u.created_at).getTime() < MS_30_DAYS,
        presence,
        last_sign_in: u.last_sign_in_at || null,
        created_at: u.created_at,
        confirmed: !!u.email_confirmed_at,
      };
    });
    const order = { online: 0, recent: 1, inactive: 2, never: 3 };
    users.sort((a, b) => order[a.presence] - order[b.presence] || new Date(b.last_sign_in || 0).getTime() - new Date(a.last_sign_in || 0).getTime());
    const counts = {
      online: users.filter((u) => u.presence === "online").length,
      recent: users.filter((u) => u.presence === "recent").length,
      inactive: users.filter((u) => u.presence === "inactive").length,
      never: users.filter((u) => u.presence === "never").length,
      total: users.length,
      new_users: users.filter((u) => u.is_new).length,
    };
    return NextResponse.json({ ok: true, users, counts });
  }

  if (action === "check-migration") {
    const tables = ["cc_incidents", "cc_uptime_log", "cc_api_health", "cc_policy_checks", "cc_audit_log"];
    const tableResults = await Promise.all(
      tables.map(async (t) => {
        const { error } = await db.from(t).select("id", { head: true, count: "exact" }).limit(0);
        return { table: t, exists: !error };
      }),
    );
    const allTablesExist = tableResults.every((r) => r.exists);
    return NextResponse.json({ ok: true, tables: tableResults, triggers: [], triggerViewExists: false, allTablesExist, allTriggersInstalled: false, allExist: allTablesExist });
  }

  return NextResponse.json({ ok: false, error: `Unknown action: ${action}` }, { status: 400 });
}

export async function POST(req: Request) {
  const g = await gate();
  if (g.err) return g.err;
  const { db } = g;
  const action = new URL(req.url).searchParams.get("action") || "";
  const b = ((await req.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;

  // Deferred backend actions.
  if (action === "run-policy-checks-live") return NextResponse.json({ ok: true, checks: [], notice: DEFER });
  if (action === "run-health-check") return NextResponse.json({ ok: false, error: DEFER }, { status: 503 });
  if (action === "run-migration") return NextResponse.json({ ok: false, error: "Migration runner deferred — paste SQL in the Supabase SQL editor." }, { status: 503 });

  if (!db) return NextResponse.json({ ok: false, error: "RETAIL database not configured." }, { status: 503 });
  const now = new Date().toISOString();

  if (action === "create-incident") {
    const title = String(b.title || "").trim();
    if (!title) return NextResponse.json({ ok: false, error: "title is required" }, { status: 400 });
    const payload = {
      title,
      description: String(b.description || "").trim() || null,
      priority: VALID_PRIORITIES.includes(b.priority as string) ? b.priority : "medium",
      status: VALID_STATUSES.includes(b.status as string) ? b.status : "open",
      category: VALID_CATEGORIES.includes(b.category as string) ? b.category : "other",
      environment: VALID_ENVS.includes(b.environment as string) ? b.environment : "general",
      assigned_to: String(b.assigned_to || "").trim() || null,
      reported_by: String(b.reported_by || "").trim() || null,
      notes: String(b.notes || "").trim() || null,
      auto_generated: false,
      pending_resolve: false,
      created_at: now,
      updated_at: now,
    };
    const { data, error } = await db.from("cc_incidents").insert(payload).select().maybeSingle();
    if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    // NOTE: high/critical alert email is deferred (Resend backend bucket).
    return NextResponse.json({ ok: true, incident: data });
  }

  if (action === "update-incident") {
    const id = String(b.id || "").trim();
    if (!id) return NextResponse.json({ ok: false, error: "id is required" }, { status: 400 });
    const patch: Record<string, unknown> = { updated_at: now };
    if (b.title !== undefined) patch.title = String(b.title).trim();
    if (b.description !== undefined) patch.description = String(b.description || "").trim() || null;
    if (b.priority !== undefined && VALID_PRIORITIES.includes(b.priority as string)) patch.priority = b.priority;
    if (b.category !== undefined && VALID_CATEGORIES.includes(b.category as string)) patch.category = b.category;
    if (b.environment !== undefined && VALID_ENVS.includes(b.environment as string)) patch.environment = b.environment;
    if (b.assigned_to !== undefined) patch.assigned_to = String(b.assigned_to || "").trim() || null;
    if (b.reported_by !== undefined) patch.reported_by = String(b.reported_by || "").trim() || null;
    if (b.notes !== undefined) patch.notes = String(b.notes || "").trim() || null;
    if (b.status !== undefined && VALID_STATUSES.includes(b.status as string)) {
      patch.status = b.status;
      patch.pending_resolve = false;
      patch.resolved_at = b.status === "resolved" || b.status === "closed" ? now : null;
    }
    const { data, error } = await db.from("cc_incidents").update(patch).eq("id", id).select().maybeSingle();
    if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true, incident: data });
  }

  if (action === "confirm-resolve") {
    const id = String(b.id || "").trim();
    if (!id) return NextResponse.json({ ok: false, error: "id is required" }, { status: 400 });
    const { data, error } = await db
      .from("cc_incidents")
      .update({ status: "resolved", pending_resolve: false, resolved_at: now, updated_at: now })
      .eq("id", id)
      .select()
      .maybeSingle();
    if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true, incident: data });
  }

  if (action === "delete-incident") {
    const id = String(b.id || "").trim();
    if (!id) return NextResponse.json({ ok: false, error: "id is required" }, { status: 400 });
    const { error } = await db.from("cc_incidents").delete().eq("id", id);
    if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true });
  }

  if (action === "purge-kyc-audit") {
    const { data, error } = await db
      .from("cc_audit_log")
      .delete()
      .eq("operation", "UPDATE")
      .eq("changed_by", "system")
      .eq("table_name", "user_onboarding")
      .select();
    if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true, deleted: data?.length ?? 0 });
  }

  return NextResponse.json({ ok: false, error: `Unknown action: ${action}` }, { status: 400 });
}
