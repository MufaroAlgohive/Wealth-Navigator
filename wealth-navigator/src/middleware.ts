import { type NextRequest, NextResponse } from "next/server";

import { updateSupabaseSession } from "@/lib/supabase/middleware";
import { isBlockedForEmail } from "@/lib/platform/access";

/**
 * Route gating uses Supabase Auth session cookies (refreshed here on every
 * request). The client-side `useAuth()` hook reads the same session via the
 * browser Supabase client for UI state only — middleware is the real gate.
 */

const PUBLIC_PREFIXES = [
  "/login",
  "/signup",
  "/reset-password",
  "/auth",
  "/api/auth",
  "/api/health",
  "/api/ticks",
  "/api/webhooks",
  "/api/cron",
  // Ozone EFT top-up callback: session-less server-to-server POST from the
  // payment provider, authenticated by HMAC (OZONE_WEBHOOK_SECRET) in the route,
  // not by a Supabase session. isPublic matches exact path, so only this route
  // opens — /api/admin/eft (admin actions) stays session-gated.
  "/api/admin/eft/ozone-callback",
  // Mint client-order forwarding: session-less server-to-server POST from the
  // mint retail app (no Supabase session to present), authenticated by its own
  // Bearer MINT_CLIENT_ORDER_SECRET check inside the route, not by a Supabase
  // session. Exact path only, same pattern as the Ozone callback above.
  "/api/admin/orderbook/client-order",
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

  // Dev-only design-preview escape hatch (double-gated): with ADMIN_PREVIEW=1 in
  // a NON-production build, render pages without a session so the merged UI can
  // be reviewed/signed-off before auth + data are wired. Never active in prod.
  const previewMode = process.env.NODE_ENV !== "production" && process.env.ADMIN_PREVIEW === "1";

  if (!authed && !previewMode) {
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    url.search = `?next=${encodeURIComponent(pathname + search)}`;
    return NextResponse.redirect(url);
  }

  // Restricted external accounts (e.g. IRESS integration staff) must not reach
  // the sensitive business surfaces, even by typing the URL. Bounce them to the
  // Cockpit. The nav also hides these items (see platform-nav.tsx).
  if (authed && isBlockedForEmail(user?.email, pathname)) {
    const url = req.nextUrl.clone();
    url.pathname = "/oems";
    url.search = "";
    return NextResponse.redirect(url);
  }

  return supabaseResponse;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\..*).*)"],
};
