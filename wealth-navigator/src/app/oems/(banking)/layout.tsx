import type { ReactNode } from "react";

import { AdminProvider } from "@/lib/admin/context";
import { getAdminContext, type AdminContext } from "@/lib/admin/rbac";

/**
 * The /oems/(banking) pages (EFT, reconciliation, wallet top-up) use the admin
 * RBAC context via useAdmin(), but they live under the /oems shell, not /admin,
 * so nothing was providing <AdminProvider>, and the pages threw ("useAdmin must
 * be used within <AdminProvider>") at prerender and runtime. This group layout
 * resolves the signed-in admin context and provides it, mirroring the /admin
 * shell but without re-wrapping the PlatformShell (the /oems layout already
 * renders the chrome). force-dynamic because the context is session-derived.
 */

export const dynamic = "force-dynamic";

export default async function BankingLayout({ children }: { children: ReactNode }) {
  const res = await getAdminContext();
  const ctx: AdminContext =
    res.status === "ok"
      ? res.ctx
      : {
          email: "preview@local",
          fullName: "Design Preview",
          role: "admin",
          pageAccess: [],
          approverTier: null,
          permissions: {},
        };
  return <AdminProvider value={{ ctx, notice: null }}>{children}</AdminProvider>;
}
