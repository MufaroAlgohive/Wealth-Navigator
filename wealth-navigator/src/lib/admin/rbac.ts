/**
 * Admin RBAC — server-side resolution of the signed-in user's Mint admin
 * permissions. Replaces the legacy `access-guard.js` + `/api/team?action=me`.
 *
 * The signed-in Supabase session is against the RETAIL/LIVE project (`mfxng…`,
 * NEXT_PUBLIC_SUPABASE_URL), which is where `admin_team` lives. We read the
 * team row with the RETAIL service-role client (bypasses RLS, server-only —
 * enforced transitively via `next/headers` in the supabase server client).
 */
import type { AdminPageKey } from "@/lib/admin/pages";
import { createRetailServiceRoleClient, createSupabaseServerClient } from "@/lib/supabase/server";

export { canAccessPage, firstAllowedPath, isAdminRole } from "@/lib/admin/pages";

export type AdminRole = "admin" | "staff" | "superadmin";
export type ApproverTier = "dev" | "master" | null;

export interface AdminContext {
  email: string;
  /** Supabase auth user id (= `profiles.id`), for actor attribution on audited writes. */
  userId: string;
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
      userId: user.id,
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

/**
 * Research & IC action check — `can()` plus the implicit admin grant.
 *
 * Admins and superadmins hold every Research & IC action without needing the
 * granular `permissions.rebalance.*` / `permissions.research-lab.*` rows set on
 * their `admin_team` record; staff still need the explicit grant. That rule was
 * already stated and implemented on the UI side (research-ic/server.ts) and in
 * one API route (research/notes POST), but the remaining rebalance/research
 * routes checked bare `can()` — so every non-`dev` admin saw the buttons
 * enabled and got a 403 on click. That was 10 of 14 active admins, including
 * both of Lonwabo's accounts; only `approver_tier: "dev"` holders worked,
 * because `can()` short-circuits to true for them.
 *
 * Returns a plain boolean: "pending"/"direct" both mean the action is allowed
 * to proceed here (the approval-queue distinction is handled by the callers
 * that care about it).
 */
/**
 * May this viewer see UAT/test surfaces at all?
 *
 * UAT strategies, their rebalances, their orders and their money are test
 * artefacts. They must not appear to anyone doing real work — not in AUM, not
 * in the strategy catalogue or its performance chart, not as a rebalance
 * awaiting approval, and not on the order book or blotter.
 *
 * `approver_tier: "dev"` is the existing convention for "runs the tests" — it
 * is what `/api/strategies` has always used to decide UAT visibility, so this
 * keeps one definition rather than inventing a second.
 *
 * Callers that need this for a REQUEST (rather than a viewer) should still
 * filter server-side: hiding a row in the UI is not the same as not sending it.
 */
export function canSeeUatSurfaces(ctx: Pick<AdminContext, "approverTier">): boolean {
  return ctx.approverTier === "dev";
}

export function canResearchIc(
  ctx: Pick<AdminContext, "permissions" | "approverTier" | "role">,
  section: "rebalance" | "research-lab",
  field: string,
): boolean {
  if (ctx.role === "admin" || ctx.role === "superadmin") return true;
  const v = can(ctx, section, field);
  return v === true || v === "direct";
}

/** Governance changes are restricted to the master owner, devs and superadmins. */
export function canManageCommittee(ctx: Pick<AdminContext, "approverTier" | "role">): boolean {
  return ctx.approverTier === "master" || ctx.approverTier === "dev" || ctx.role === "superadmin";
}

export type { AdminPageKey };
