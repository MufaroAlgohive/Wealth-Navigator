import { getAdminContext } from "@/lib/admin/rbac";
import { createAnonServerClient } from "@/lib/supabase/server";

/**
 * Step-up re-authentication for irreversible desk actions.
 *
 * "Send to Market" hands real client orders to a broker and cannot be undone
 * from this system. Being signed in is not enough: the person at the keyboard
 * re-enters THEIR OWN password, and it is only accepted if their account holds
 * the master approver tier.
 *
 * Deliberately their own password, not a shared "master password". A shared
 * secret has no attribution — the audit row would say who was logged in, which
 * is exactly what a shared password makes unprovable — and it cannot be revoked
 * for one person without rotating it for everyone. This way the audit trail
 * names a specific human who proved possession of their credential seconds
 * before the order went out, and removing someone's master tier revokes it
 * immediately.
 *
 * Verified against Supabase auth with a throwaway anon client
 * (`persistSession: false`), so a failed attempt cannot disturb or rotate the
 * caller's real session cookies.
 */

export type StepUpResult = { ok: true; email: string } | { ok: false; status: 401 | 403; error: string };

export async function requireMasterPassword(password: unknown): Promise<StepUpResult> {
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

  if (typeof password !== "string" || password.length === 0) {
    return { ok: false, status: 403, error: "password-required" };
  }

  let anon: ReturnType<typeof createAnonServerClient>;
  try {
    anon = createAnonServerClient();
  } catch (e) {
    // Fail CLOSED: if we cannot verify the password we do not let the order out.
    return {
      ok: false,
      status: 403,
      error: `Cannot verify password: ${e instanceof Error ? e.message : "auth unavailable"}`,
    };
  }

  const { error } = await anon.auth.signInWithPassword({ email: auth.ctx.email, password });
  if (error) return { ok: false, status: 403, error: "Incorrect password." };

  // Drop the throwaway session immediately — it exists only to prove the
  // password, and must never be reused as a credential.
  await anon.auth.signOut().catch(() => {});

  return { ok: true, email: auth.ctx.email };
}
