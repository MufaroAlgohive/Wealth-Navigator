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

/**
 * Elevated-tier gate for admin actions that need more trust than routine
 * staff/admin desk work, but are not the "irreversible, no broker
 * confirmation behind this call" shape `requireMasterPassword` protects
 * (send-to-market, manual-fill, release-to-orderbook — leave those on
 * Master ★ only).
 *
 * Accepts EITHER approver tier — `dev` or `master` — not just Master ★.
 * The business owner's stated intent (2026-08, canonical-ledger recompute)
 * was explicitly "most likely devs are who will be running it", so a
 * Master-only gate over-restricted this action. This still requires an
 * elevated tier, though: plain `staff`/`admin` roles with no
 * `approver_tier` set are rejected, same as before.
 */
export async function requireElevatedTier(): Promise<StepUpResult> {
  const auth = await getAdminContext();
  if (auth.status === "no-session") return { ok: false, status: 401, error: "no-session" };
  if (auth.status !== "ok") return { ok: false, status: 403, error: "forbidden" };

  if (auth.ctx.approverTier !== "master" && auth.ctx.approverTier !== "dev") {
    return {
      ok: false,
      status: 403,
      error: "This action requires a Dev or Master ★ account.",
    };
  }

  return { ok: true, email: auth.ctx.email };
}
