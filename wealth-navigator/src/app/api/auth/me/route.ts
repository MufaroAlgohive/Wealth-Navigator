import { NextResponse } from "next/server";

import { isSupabaseAuthConfigured } from "@/lib/supabase/config";
import { createRetailServiceRoleClient, isRetailSupabaseConfigured } from "@/lib/supabase/server";

/**
 * GET /api/auth/me — the signed-in user's basic profile.
 *
 * Used by the top-bar user chip (replaces the hardcoded demo persona) and by
 * the Clerk-style profile overlay (avatar dropdown → floating panel). Returns:
 *
 *   {
 *     ok: true,
 *     id, email,
 *     firstName, lastName, fullName, initials,
 *     role, persona,                          ← role from profiles.is_admin/role;
 *                                                persona = the demo persona store
 *                                                (only when not signed in via Supabase)
 *     lastSignInAt (ISO),                     ← from auth.users.last_sign_in_at
 *     profilePictureUrl,                      ← avatar_url from profiles if present
 *     createdAt (ISO),                        ← profile row created_at
 *   }
 *
 * On no session → 401 with `{ ok: false, error: "no-session" }` so the client
 * can distinguish "signed out" from "server unavailable".
 */

function initialsOf(firstName: string | null, lastName: string | null, email: string): string {
  if (firstName && lastName) return (firstName[0]! + lastName[0]!).toUpperCase();
  if (firstName) return firstName.slice(0, 2).toUpperCase();
  const handle = email.split("@")[0] ?? email;
  return handle.slice(0, 2).toUpperCase();
}

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  // Server-side client uses the user's cookie session automatically. We can't
  // call this from middleware because it requires the live request cookies.
  if (!isSupabaseAuthConfigured()) {
    return NextResponse.json({ ok: false, error: "unconfigured" }, { status: 503 });
  }

  const { createServerClient } = await import("@supabase/ssr");
  const { cookies } = await import("next/headers");

  const supabaseServer = createServerClient(
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

  const { data: sessionData } = await supabaseServer.auth.getSession();
  const session = sessionData.session;
  if (!session) {
    return NextResponse.json({ ok: false, error: "no-session" }, { status: 401 });
  }

  const email = session.user.email ?? "";
  const userId = session.user.id;
  const lastSignInAt = session.user.last_sign_in_at ?? null;

  // Pull the profiles row for first/last name + role + avatar + created_at.
  let firstName: string | null = null;
  let lastName: string | null = null;
  let role: string | null = null;
  let isAdmin = false;
  let avatarUrl: string | null = null;
  let createdAt: string | null = null;
  if (isRetailSupabaseConfigured()) {
    try {
      const db = createRetailServiceRoleClient();
      const { data: profile } = (await db
        .from("profiles")
        .select("first_name, last_name, role, is_admin, avatar_url, created_at")
        .eq("id", userId)
        .maybeSingle()) as {
        data: {
          first_name: string | null;
          last_name: string | null;
          role: string | null;
          is_admin: boolean | null;
          avatar_url: string | null;
          created_at: string | null;
        } | null;
      };
      if (profile) {
        firstName = profile.first_name;
        lastName = profile.last_name;
        role = profile.role;
        isAdmin = Boolean(profile.is_admin);
        avatarUrl = profile.avatar_url;
        createdAt = profile.created_at;
      }
    } catch {
      // Profiles lookup is best-effort; if retail DB is unconfigured, return
      // the auth.user info we already have.
    }
  }

  const fullName =
    [firstName, lastName].filter(Boolean).join(" ").trim() || email.split("@")[0] || "Signed-in user";

  return NextResponse.json({
    ok: true,
    id: userId,
    email,
    firstName,
    lastName,
    fullName,
    initials: initialsOf(firstName, lastName, email),
    role,
    isAdmin,
    avatarUrl,
    lastSignInAt,
    createdAt,
  });
}

/**
 * PATCH /api/auth/me — update the signed-in user's profiles row.
 *
 * Body: { firstName?: string, lastName?: string }
 *
 * Writes only to `profiles` — never to `auth.users`. Email changes go
 * through Supabase Auth's confirmation flow (separate, not exposed here).
 */
export async function PATCH(req: Request) {
  if (!isSupabaseAuthConfigured()) {
    return NextResponse.json({ ok: false, error: "unconfigured" }, { status: 503 });
  }
  if (!isRetailSupabaseConfigured()) {
    return NextResponse.json({ ok: false, error: "no-profile-db" }, { status: 503 });
  }

  let body: { firstName?: string; lastName?: string };
  try {
    body = (await req.json()) as { firstName?: string; lastName?: string };
  } catch {
    return NextResponse.json({ ok: false, error: "invalid-body" }, { status: 400 });
  }

  const { createServerClient } = await import("@supabase/ssr");
  const { cookies } = await import("next/headers");

  const supabaseServer = createServerClient(
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

  const { data: sessionData } = await supabaseServer.auth.getSession();
  const session = sessionData.session;
  if (!session) {
    return NextResponse.json({ ok: false, error: "no-session" }, { status: 401 });
  }

  const firstName = (body.firstName ?? "").trim().slice(0, 80);
  const lastName = (body.lastName ?? "").trim().slice(0, 80);
  if (firstName.length === 0 && lastName.length === 0 && body.firstName !== "" && body.lastName !== "") {
    return NextResponse.json({ ok: false, error: "empty-name" }, { status: 400 });
  }

  const db = createRetailServiceRoleClient();
  const { error } = await db
    .from("profiles")
    .update({ first_name: firstName, last_name: lastName })
    .eq("id", session.user.id);
  if (error) {
    return NextResponse.json(
      { ok: false, error: error.name ?? "update-failed", message: error.message },
      { status: 400 },
    );
  }
  return NextResponse.json({ ok: true, firstName, lastName });
}
