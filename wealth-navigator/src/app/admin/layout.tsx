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

  if (res.status === "no-session" && !previewMode) redirect("/login?next=/admin");
  if (res.status === "not-member" && !previewMode) redirect("/login?reason=not-a-member");

  let ctx: AdminContext;
  let notice: string | null = null;
  if (res.status === "ok") {
    ctx = res.ctx;
  } else {
    // Render the shell with full visibility so the merged frontend is reviewable:
    //  - 'unconfigured' (service-role env not set in local dev), or
    //  - no-session / not-member under ADMIN_PREVIEW.
    // Never reached in prod where RETAIL_SUPABASE_* is set and ADMIN_PREVIEW is off.
    notice =
      res.status === "unconfigured"
        ? `Admin RBAC unavailable (${res.reason}) — dev fallback: showing all sections.`
        : "Design-preview mode (ADMIN_PREVIEW) — not authenticated; all sections shown, no live data.";
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
