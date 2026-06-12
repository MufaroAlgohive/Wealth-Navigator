import { type NextRequest, NextResponse } from "next/server";

import { updateSupabaseSession } from "@/lib/supabase/middleware";

/**
 * Route gating uses Supabase Auth session cookies (refreshed here on every
 * request). The client-side `useAuth()` hook reads the same session via the
 * browser Supabase client for UI state only — middleware is the real gate.
 */

const PUBLIC_PREFIXES = [
  "/login",
  "/auth",
  "/api/auth",
  "/api/health",
  "/api/ticks",
];

function isPublic(pathname: string): boolean {
  return PUBLIC_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

export async function middleware(req: NextRequest) {
  const { pathname, search } = req.nextUrl;

  if (
    pathname.startsWith("/_next") ||
    pathname.startsWith("/favicon") ||
    pathname === "/robots.txt" ||
    pathname === "/sitemap.xml"
  ) {
    return NextResponse.next();
  }

  const { response: supabaseResponse, user } = await updateSupabaseSession(req);
  const authed = user !== null;

  if (pathname === "/login" || pathname.startsWith("/login/")) {
    if (authed) {
      const url = req.nextUrl.clone();
      url.pathname = "/oems";
      url.search = "";
      return NextResponse.redirect(url);
    }
    return supabaseResponse;
  }

  if (isPublic(pathname)) {
    return supabaseResponse;
  }

  if (!authed) {
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    url.search = `?next=${encodeURIComponent(pathname + search)}`;
    return NextResponse.redirect(url);
  }

  return supabaseResponse;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\..*).*)"],
};
