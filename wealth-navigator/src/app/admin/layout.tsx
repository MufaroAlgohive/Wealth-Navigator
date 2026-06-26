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

  // A genuine no-session goes to login. NB: do NOT redirect an authenticated
  // non-member to /login: middleware would bounce that authed user straight to
  // /oems, which reads as "the /admin link is broken". Handle not-member below
  // with an explicit access-denied surface instead.
  if (res.status === "no-session" && !previewMode) redirect("/login?next=/admin");

  // Locked down: an authenticated user who is not a member of admin_team gets a
  // clear access-denied surface (still inside the shell so they can navigate
  // away), never the admin pages. Provision the user in admin_team to grant it.
  if (res.status === "not-member") {
    return (
      <PlatformShell>
        <div className="mx-auto mt-20 max-w-md px-4">
          <div className="glass-panel rounded-2xl p-8 text-center">
            <h1 className="text-section text-base">Admin access required</h1>
            <p className="text-caption mt-2 leading-relaxed">
              {res.email} is signed in but is not a member of the admin team. Ask an
              administrator to add your account, then reload this page.
            </p>
          </div>
        </div>
      </PlatformShell>
    );
  }

  let ctx: AdminContext;
  let notice: string | null = null;
  if (res.status === "ok") {
    ctx = res.ctx;
  } else {
    // 'unconfigured' (service-role env not set in local dev) or no-session under
    // ADMIN_PREVIEW: render the shell with a dev fallback context for sign-off.
    notice =
      res.status === "unconfigured"
        ? `Admin RBAC unavailable (${res.reason}). Dev fallback: showing all sections.`
        : "Design-preview mode (ADMIN_PREVIEW): not authenticated; all sections shown, no live data.";
    ctx = {
      email: "preview@local",
      fullName: "Design Preview",
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
