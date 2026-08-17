import { getAdminContext } from "@/lib/admin/rbac";

/**
 * Step-up gate for irreversible desk actions ("Send to Market" hands real
 * client orders to a broker and cannot be undone from this system).
 *
 * Password re-verification was deliberately removed on 2026-08-17 at the
 * user's explicit request, after being warned it drops the protection
 * against an already-logged-in master session being used unattended or
 * after a session hijack, and that the audit row can no longer prove a
 * specific human re-entered their own credential seconds before release.
 * What remains: the account must still hold the master approver tier —
 * that check is unchanged and still enforced below.
 */

export type StepUpResult = { ok: true; email: string } | { ok: false; status: 401 | 403; error: string };

export async function requireMasterPassword(_password: unknown): Promise<StepUpResult> {
  const auth = await getAdminContext();
  if (auth.status === "no-session") return { ok: false, status: 401, error: "no-session" };
  if (auth.status !== "ok") return { ok: false, status: 403, error: "forbidden" };

  if (auth.ctx.approverTier !== "master") {
    return {
      ok: false,
      status: 403,
      error: "Send to Market requires a Master ★ account. Ask a master approver to release this book.",
    };
  }

  return { ok: true, email: auth.ctx.email };
}
