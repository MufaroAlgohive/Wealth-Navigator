import { NextResponse } from "next/server";

import { getAdminContext, isAdminRole } from "@/lib/admin/rbac";
import { createRetailServiceRoleClient } from "@/lib/supabase/server";

/**
 * Platform app settings (fees). Ports the legacy
 * `/api/team?action=app-settings-get` (any team member) and
 * `app-settings-save` (admin only). Stored in `app_settings` (RETAIL DB).
 */

const FEE_KEYS = [
  "isinFeePerAsset",
  "brokerFeeRate",
  "executionReserveRate",
  "transactionFeeRate",
  "monthlyStrategyFee",
  "rebBrokerageRate",
  "rebCustodyFee",
] as const;

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const auth = await getAdminContext();
  if (auth.status === "no-session") return NextResponse.json({ ok: false, error: "no-session" }, { status: 401 });
  if (auth.status === "not-member") return NextResponse.json({ ok: false, error: "not-a-member" }, { status: 403 });

  const key = (new URL(req.url).searchParams.get("key") || "fees").trim();

  let db;
  try {
    db = createRetailServiceRoleClient();
  } catch {
    return NextResponse.json({ ok: true, key, value: null, notice: "RETAIL database not configured." });
  }

  const { data, error } = await db
    .from("app_settings")
    .select("value, updated_at, updated_by")
    .eq("key", key)
    .limit(1)
    .maybeSingle();

  if (error) {
    return NextResponse.json({ ok: true, key, value: null, notice: "app_settings table not found — run the migration SQL." });
  }
  return NextResponse.json({
    ok: true,
    key,
    value: data?.value ?? null,
    updated_at: data?.updated_at ?? null,
    updated_by: data?.updated_by ?? null,
  });
}

export async function POST(req: Request) {
  const auth = await getAdminContext();
  if (auth.status !== "ok") {
    const code = auth.status === "no-session" ? 401 : auth.status === "not-member" ? 403 : 503;
    return NextResponse.json({ ok: false, error: auth.status }, { status: code });
  }
  if (!isAdminRole(auth.ctx)) {
    return NextResponse.json({ ok: false, error: "Admins only" }, { status: 403 });
  }

  const body = (await req.json().catch(() => null)) as { key?: string; value?: Record<string, unknown> } | null;
  const key = (body?.key || "fees").trim();
  const incoming = body?.value;
  if (!incoming || typeof incoming !== "object") {
    return NextResponse.json({ error: "value object is required" }, { status: 400 });
  }

  let value: Record<string, unknown> = incoming;
  if (key === "fees") {
    value = {};
    for (const k of FEE_KEYS) {
      const raw = incoming[k];
      const n = Number(raw);
      if (raw == null || raw === "" || Number.isNaN(n) || n < 0) {
        return NextResponse.json({ error: `Invalid value for ${k}` }, { status: 400 });
      }
      value[k] = n;
    }
  }

  const db = createRetailServiceRoleClient();

  let before: unknown = null;
  try {
    const { data } = await db.from("app_settings").select("value").eq("key", key).limit(1).maybeSingle();
    before = (data as { value?: unknown } | null)?.value ?? null;
  } catch {
    /* table may not exist yet */
  }

  const { data: saved, error } = await db
    .from("app_settings")
    .upsert({ key, value, updated_at: new Date().toISOString(), updated_by: auth.ctx.email }, { onConflict: "key" })
    .select("value")
    .maybeSingle();

  if (error) {
    return NextResponse.json(
      { error: `Could not save settings: ${error.message}. Has the app_settings table been created?` },
      { status: 500 },
    );
  }

  // Best-effort audit (legacy writeAudit → admin_team_audit).
  try {
    await db.from("admin_team_audit").insert({
      action: "update",
      target_email: auth.ctx.email,
      actor_email: auth.ctx.email,
      details: { setting: key, before, after: value },
    });
  } catch {
    /* audit table optional */
  }

  return NextResponse.json({ ok: true, value: (saved as { value?: unknown } | null)?.value ?? value });
}
