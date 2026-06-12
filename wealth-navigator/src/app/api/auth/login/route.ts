import { createServerClient } from "@supabase/ssr";
import { type NextRequest, NextResponse } from "next/server";

import { getSupabaseAnonKey, getSupabaseUrl, isSupabaseAuthConfigured } from "@/lib/supabase/config";

/**
 * Application login via Supabase Auth (email + password).
 *
 * Sets HttpOnly Supabase session cookies on success. This is NOT IRESS Web
 * Services authentication — IRESS SOAP credentials remain server-side env
 * vars for the ingest worker.
 */

interface LoginBody {
  email?: unknown;
  password?: unknown;
}

interface LoginResponseBody {
  ok: boolean;
  error?: string;
  user?: { email: string };
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function looksLikeUsername(email: string): boolean {
  return !email.includes("@");
}

/** Map Supabase auth errors to user-safe messages (no credential oracle). */
export function mapLoginAuthError(
  email: string,
  supabaseMessage?: string,
): { error: string; status: number } {
  if (looksLikeUsername(email)) {
    return {
      error:
        'Sign in with your full email address (e.g. you@company.com). Usernames like "admin" are not valid — use the email you were given when your account was created.',
      status: 400,
    };
  }

  const msg = (supabaseMessage ?? "").toLowerCase();

  if (msg.includes("email not confirmed")) {
    return {
      error:
        "Your email is not confirmed yet. Check your inbox for a confirmation link, or ask an administrator to confirm your account in Supabase.",
      status: 401,
    };
  }

  if (msg.includes("invalid login credentials") || msg.includes("invalid credentials")) {
    return {
      error:
        "Incorrect email or password. Use the exact email on your Supabase account — not the old dev username.",
      status: 401,
    };
  }

  if (msg.includes("too many requests") || msg.includes("rate limit")) {
    return {
      error: "Too many sign-in attempts. Please wait a moment and try again.",
      status: 429,
    };
  }

  return { error: "Sign-in failed. Please try again.", status: 401 };
}

export async function POST(req: NextRequest) {
  if (!isSupabaseAuthConfigured()) {
    return NextResponse.json(
      {
        ok: false,
        error:
          "Authentication is not configured on this deployment. Contact your administrator.",
      },
      { status: 503 },
    );
  }

  let body: LoginBody;
  try {
    body = (await req.json()) as LoginBody;
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON body." }, { status: 400 });
  }

  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const password = typeof body.password === "string" ? body.password : "";

  if (!email || !password) {
    return NextResponse.json(
      { ok: false, error: "Email and password are required." },
      { status: 400 },
    );
  }

  const usernameCheck = looksLikeUsername(email) ? mapLoginAuthError(email) : null;
  if (usernameCheck) {
    return NextResponse.json({ ok: false, error: usernameCheck.error }, { status: usernameCheck.status });
  }

  let supabaseResponse = NextResponse.next({ request: req });

  const supabase = createServerClient(getSupabaseUrl(), getSupabaseAnonKey(), {
    cookies: {
      getAll() {
        return req.cookies.getAll();
      },
      setAll(cookiesToSet) {
        for (const { name, value } of cookiesToSet) {
          req.cookies.set(name, value);
        }
        supabaseResponse = NextResponse.next({ request: req });
        for (const { name, value, options } of cookiesToSet) {
          supabaseResponse.cookies.set(name, value, options);
        }
      },
    },
  });

  const { data, error } = await supabase.auth.signInWithPassword({ email, password });

  if (error || !data.user) {
    const mapped = mapLoginAuthError(email, error?.message);
    return NextResponse.json({ ok: false, error: mapped.error }, { status: mapped.status });
  }

  const responseBody: LoginResponseBody = {
    ok: true,
    user: { email: data.user.email ?? email },
  };

  const jsonResponse = NextResponse.json(responseBody);
  for (const cookie of supabaseResponse.cookies.getAll()) {
    jsonResponse.cookies.set(cookie);
  }

  return jsonResponse;
}
