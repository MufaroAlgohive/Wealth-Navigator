import type { ReactNode } from "react";
import { redirect } from "next/navigation";

import { getAdminContext, type AdminContext } from "@/lib/admin/rbac";
import { AdminProvider } from "@/lib/admin/context";
import { PlatformShell } from "@/components/platform/platform-shell";

export const dynamic = "force-dynamic";

/**
 * Mint CRM admin shell. Resolves the signed-in user's admin_team RBAC and
 * renders the sidebar/header chrome. Replaces the legacy access-guard.js gate.
 */
export default async function AdminLayout({ children }: { children: ReactNode }) {
  const res = await getAdminContext();

  // Dev-only design-preview escape hatch (matches middleware): with ADMIN_PREVIEW=1
  // in a non-production build, render the shell without a session for sign-off.
  const previewMode = process.env.NODE_ENV !== "production" && process.env.ADMIN_PREVIEW === "1";

  // Only a genuine no-session bounces to login. An authenticated user who is
  // simply not in `admin_team` yet must NOT be redirected: middleware sees an
  // authed user hitting /login and bounces them straight to /oems, so every
  // /admin/* sidebar link reads as "broken, refreshes back to OEMS". The
  // sidebar already shows every section to any signed-in user (documented
  // stopgap until per-user page_access RBAC lands), so render the shell here
  // to match, with an honest notice.
  if (res.status === "no-session" && !previewMode) redirect("/login?next=/admin");

  let ctx: AdminContext;
  let notice: string | null = null;
  if (res.status === "ok") {
    ctx = res.ctx;
  } else {
    // Render the shell with full visibility for:
    //  - 'not-member'   (authenticated, not yet provisioned in admin_team),
    //  - 'unconfigured' (service-role env not set in local dev), or
    //  - no-session under ADMIN_PREVIEW.
    notice =
      res.status === "not-member"
        ? `Signed in as ${res.email}: not yet in admin_team. Full access shown until RBAC is provisioned.`
        : res.status === "unconfigured"
          ? `Admin RBAC unavailable (${res.reason}). Dev fallback: showing all sections.`
          : "Design-preview mode (ADMIN_PREVIEW): not authenticated; all sections shown, no live data.";
    ctx = {
      email: res.status === "not-member" ? res.email : "preview@local",
      fullName: res.status === "not-member" ? null : "Design Preview",
      role: "admin",
      pageAccess: [],
      approverTier: null,
      permissions: {},
    };
  }

  const banner = notice ? (
    <div className="flex items-center gap-2 border-b border-warning/30 bg-warning/10 px-4 py-1.5 text-[11px] text-foreground/80">
      {notice}
    </div>
  ) : undefined;

  return (
    <AdminProvider value={{ ctx, notice }}>
      <PlatformShell banner={banner}>{children}</PlatformShell>
    </AdminProvider>
  );
}
