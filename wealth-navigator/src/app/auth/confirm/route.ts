import { type EmailOtpType } from "@supabase/supabase-js";
import { NextResponse, type NextRequest } from "next/server";

import { createSupabaseServerClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ALLOWED_TYPES = new Set<EmailOtpType>(["invite", "recovery", "magiclink", "signup"]);

function safeNextPath(raw: string | null, type: EmailOtpType): string {
  const fallback = type === "recovery" ? "/reset-password" : "/signup";
  if (!raw || !raw.startsWith("/") || raw.startsWith("//")) return fallback;
  return raw;
}

/**
 * Verify server-generated admin email links without relying on browser PKCE
 * state. This is required for re-inviting an existing Supabase Auth user:
 * generateLink("recovery") gives us a token hash that can be verified here,
 * establishes the cookie session, then safely hands off to reset-password.
 */
export async function GET(request: NextRequest) {
  const { searchParams, origin } = request.nextUrl;
  const tokenHash = searchParams.get("token_hash");
  const rawType = searchParams.get("type") as EmailOtpType | null;
  if (!tokenHash || !rawType || !ALLOWED_TYPES.has(rawType)) {
    return NextResponse.redirect(`${origin}/login?error=invalid_auth_link`);
  }

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.auth.verifyOtp({ token_hash: tokenHash, type: rawType });
  if (error) {
    return NextResponse.redirect(`${origin}/login?error=auth_link_expired`);
  }

  return NextResponse.redirect(`${origin}${safeNextPath(searchParams.get("next"), rawType)}`);
}
