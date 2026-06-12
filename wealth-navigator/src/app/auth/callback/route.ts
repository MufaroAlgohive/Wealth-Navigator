import { NextResponse, type NextRequest } from "next/server";

import { createSupabaseServerClient } from "@/lib/supabase/server";

/**
 * OAuth / magic-link / password-reset callback. Exchanges `code` for a session
 * and redirects to `next` (same-origin path only).
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function safeNextPath(raw: string | null): string {
  if (!raw) return "/oems";
  if (!raw.startsWith("/") || raw.startsWith("//")) return "/oems";
  return raw;
}

export async function GET(request: NextRequest) {
  const { searchParams, origin } = request.nextUrl;
  const code = searchParams.get("code");
  const next = safeNextPath(searchParams.get("next"));

  if (code) {
    const supabase = await createSupabaseServerClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) {
      return NextResponse.redirect(`${origin}${next}`);
    }
  }

  return NextResponse.redirect(`${origin}/login?error=auth_callback_failed`);
}
