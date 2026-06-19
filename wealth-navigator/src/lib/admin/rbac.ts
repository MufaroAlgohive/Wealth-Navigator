/**
 * Admin RBAC — server-side resolution of the signed-in user's Mint admin
 * permissions. Replaces the legacy `access-guard.js` + `/api/team?action=me`.
 *
 * The signed-in Supabase session is against the RETAIL/LIVE project (`mfxng…`,
 * NEXT_PUBLIC_SUPABASE_URL), which is where `admin_team` lives. We read the
 * team row with the RETAIL service-role client (bypasses RLS, server-only —
 * enforced transitively via `next/headers` in the supabase server client).
 */
import { createSupabaseServerClient, createRetailServiceRoleClient } from "@/lib/supabase/server";
import type { AdminPageKey } from "@/lib/admin/pages";

export { canAccessPage, firstAllowedPath, isAdminRole } from "@/lib/admin/pages";

export type AdminRole = "admin" | "staff" | "superadmin";
export type ApproverTier = "dev" | "master" | null;

export interface AdminContext {
  email: string;
  fullName: string | null;
  role: AdminRole;
  pageAccess: string[];
  approverTier: ApproverTier;
  /** Granular permissions[section][field] → boolean | "pending" | "direct". */
  permissions: Record<string, Record<string, unknown>>;
}

export type AdminResolution =
  | { status: "ok"; ctx: AdminContext }
  | { status: "no-session" }
  | { status: "not-member"; email: string }
  | { status: "unconfigured"; reason: string };

/** Resolve the current admin context, or a non-ok status to act on. */
export async function getAdminContext(): Promise<AdminResolution> {
  let auth;
  try {
    auth = await createSupabaseServerClient();
  } catch (e) {
    return { status: "unconfigured", reason: (e as Error).message };
  }

  const {
    data: { user },
  } = await auth.auth.getUser();
  if (!user?.email) return { status: "no-session" };

  let admin;
  try {
    admin = createRetailServiceRoleClient();
  } catch (e) {
    return { status: "unconfigured", reason: (e as Error).message };
  }

  const { data, error } = await admin
    .from("admin_team")
    .select("role, page_access, approver_tier, permissions, full_name, status, email")
    .ilike("email", user.email)
    .maybeSingle();

  if (error) return { status: "unconfigured", reason: error.message };
  if (!data) return { status: "not-member", email: user.email };

  const role = (data.role as AdminRole) ?? "staff";
  return {
    status: "ok",
    ctx: {
      email: user.email,
      fullName: (data.full_name as string | null) ?? null,
      role,
      pageAccess: Array.isArray(data.page_access) ? (data.page_access as string[]) : [],
      approverTier: (data.approver_tier as ApproverTier) ?? null,
      permissions: (data.permissions as AdminContext["permissions"]) ?? {},
    },
  };
}

/** Granular control check (legacy `window.mintCan`). */
export function can(
  ctx: Pick<AdminContext, "permissions" | "approverTier">,
  section: string,
  field: string,
): boolean | "pending" | "direct" {
  if (ctx.approverTier === "dev") return true;
  const v = ctx.permissions?.[section]?.[field];
  if (v === "pending" || v === "direct") return v;
  return Boolean(v);
}

export type { AdminPageKey };
