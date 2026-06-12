import { createServerClient } from "@supabase/ssr";
import { type NextRequest, NextResponse } from "next/server";

import { getSupabaseAnonKey, getSupabaseUrl, isSupabaseAuthConfigured } from "@/lib/supabase/config";

/**
 * Refresh the Supabase session on each request and return the user, if any.
 * Cookie mutations are applied to `supabaseResponse` per @supabase/ssr guidance.
 */
export async function updateSupabaseSession(request: NextRequest): Promise<{
  response: NextResponse;
  user: { id: string; email?: string } | null;
}> {
  let supabaseResponse = NextResponse.next({ request });

  if (!isSupabaseAuthConfigured()) {
    return { response: supabaseResponse, user: null };
  }

  const supabase = createServerClient(getSupabaseUrl(), getSupabaseAnonKey(), {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        for (const { name, value } of cookiesToSet) {
          request.cookies.set(name, value);
        }
        supabaseResponse = NextResponse.next({ request });
        for (const { name, value, options } of cookiesToSet) {
          supabaseResponse.cookies.set(name, value, options);
        }
      },
    },
  });

  const {
    data: { user },
  } = await supabase.auth.getUser();

  return {
    response: supabaseResponse,
    user: user ? { id: user.id, email: user.email } : null,
  };
}
