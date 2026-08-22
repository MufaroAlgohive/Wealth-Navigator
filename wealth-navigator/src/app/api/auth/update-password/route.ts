import { NextResponse } from "next/server";

import { isSupabaseAuthConfigured } from "@/lib/supabase/config";

/**
 * POST /api/auth/update-password
 *
 * Updates the signed-in user's password. The browser cookie session is
 * forwarded as the bearer for the Supabase admin SDK so this runs with the
 * caller's identity, not a service-role key.
 *
 * Body: { currentPassword: string, newPassword: string }
 *
 * Note: Supabase's `auth.updateUser({ password })` does NOT require the
 * current password — we treat `currentPassword` as advisory and require it
 * client-side to protect against an attacker who has only the session
 * cookie but not the actual password. Server-side, we still verify the
 * caller is authenticated (the cookie session is valid); we forward to
 * Supabase which actually performs the update.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: Request) {
  if (!isSupabaseAuthConfigured()) {
    return NextResponse.json({ ok: false, error: "unconfigured" }, { status: 503 });
  }

  let body: { currentPassword?: string; newPassword?: string };
  try {
    body = (await req.json()) as { currentPassword?: string; newPassword?: string };
  } catch {
    return NextResponse.json({ ok: false, error: "invalid-body" }, { status: 400 });
  }

  const newPassword = (body.newPassword ?? "").trim();
  if (newPassword.length < 12) {
    return NextResponse.json(
      { ok: false, error: "weak-password", message: "Password must be at least 12 characters." },
      { status: 400 },
    );
  }
  if (!body.currentPassword) {
    return NextResponse.json(
      { ok: false, error: "missing-current", message: "Confirm your current password." },
      { status: 400 },
    );
  }

  // Build a server-side Supabase client bound to the caller's cookies so
  // `auth.updateUser` updates the *same* user.
  const { createServerClient } = await import("@supabase/ssr");
  const { cookies } = await import("next/headers");

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL ?? "",
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "",
    {
      cookies: {
        async getAll() {
          const store = await cookies();
          return store.getAll().map((c) => ({ name: c.name, value: c.value }));
        },
        async setAll(toSet) {
          const store = await cookies();
          toSet.forEach(({ name, value, options }) => {
            try {
              store.set(name, value, options);
            } catch {
              /* Server Components cannot set cookies; the middleware handles it. */
            }
          });
        },
      },
    },
  );

  // Verify a session is present.
  const { data: sessionData } = await supabase.auth.getSession();
  if (!sessionData.session) {
    return NextResponse.json({ ok: false, error: "no-session" }, { status: 401 });
  }

  // Optional: verify the current password by signing in via the same email.
  // We deliberately use the email + current password here rather than calling
  // any admin endpoint so the verification is subject to the same rate limits
  // and lockout policy as a normal login.
  const email = sessionData.session.user.email;
  if (!email) {
    return NextResponse.json({ ok: false, error: "no-email" }, { status: 400 });
  }
  try {
    const verify = await supabase.auth.signInWithPassword({
      email,
      password: body.currentPassword,
    });
    if (verify.error) {
      return NextResponse.json(
        { ok: false, error: "wrong-current", message: "Current password is incorrect." },
        { status: 400 },
      );
    }
  } catch {
    return NextResponse.json(
      { ok: false, error: "verify-failed", message: "Could not verify current password." },
      { status: 500 },
    );
  }

  // Update the password.
  const { error } = await supabase.auth.updateUser({ password: newPassword });
  if (error) {
    return NextResponse.json(
      { ok: false, error: error.name ?? "update-failed", message: error.message },
      { status: 400 },
    );
  }

  return NextResponse.json({ ok: true });
}
