import { redirect } from "next/navigation";
import type { Route } from "next";

import { getAdminContext, firstAllowedPath } from "@/lib/admin/rbac";

export const dynamic = "force-dynamic";

/** Mint CRM admin root — lands on the first page the user may access. */
export default async function AdminIndex() {
  const res = await getAdminContext();
  if (res.status === "ok") redirect(firstAllowedPath(res.ctx) as Route);
  // dev-unconfigured / fallback → first nav item
  redirect("/admin/clients" as Route);
}
