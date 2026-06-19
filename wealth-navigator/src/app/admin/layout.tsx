import type { ReactNode } from "react";
import { redirect } from "next/navigation";

import { getAdminContext, type AdminContext } from "@/lib/admin/rbac";
import { AdminProvider } from "@/lib/admin/context";
import { AdminShell } from "@/components/admin/admin-shell";

export const dynamic = "force-dynamic";

/**
 * Mint CRM admin shell. Resolves the signed-in user's admin_team RBAC and
 * renders the sidebar/header chrome. Replaces the legacy access-guard.js gate.
 */
export default async function AdminLayout({ children }: { children: ReactNode }) {
  const res = await getAdminContext();

  if (res.status === "no-session") redirect("/login?next=/admin");
  if (res.status === "not-member") redirect("/login?reason=not-a-member");

  let ctx: AdminContext;
  let notice: string | null = null;
  if (res.status === "ok") {
    ctx = res.ctx;
  } else {
    // Service-role env not configured (e.g. local dev): render the shell with a
    // visible banner and full visibility so the merged frontend is reviewable.
    // Never reached in prod where RETAIL_SUPABASE_* is set.
    notice = `Admin RBAC unavailable (${res.reason}) — dev fallback: showing all sections.`;
    ctx = {
      email: "dev@local",
      fullName: "Dev (unconfigured)",
      role: "admin",
      pageAccess: [],
      approverTier: null,
      permissions: {},
    };
  }

  return (
    <AdminProvider value={{ ctx, notice }}>
      <AdminShell>{children}</AdminShell>
    </AdminProvider>
  );
}
