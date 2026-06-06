import { NextResponse, type NextRequest } from "next/server";

/**
 * Single source of truth for the session signal: a plain cookie. Middleware
 * runs on the Edge runtime where the Zustand store isn't available, so the
 * cookie is the only thing we can read here. The client-side `useAuth()`
 * hook re-reads the same cookie on mount to stay in sync.
 */
export const AUTH_COOKIE = "mint-auth";
const COOKIE_MAX_AGE = 60 * 60 * 24; // 24h

/**
 * Paths anyone can visit without a session.
 *
 * `/api/auth/*` must be public so the login / logout routes can be reached
 * before the user has a cookie. The SSE tick stream and health check are
 * left public because they are also useful for the integration page once
 * the user is signed in — and the tick data is mock data anyway.
 */
const PUBLIC_PREFIXES = [
  "/login",
  "/api/auth",
  "/api/health",
  "/api/ticks",
];

function isPublic(pathname: string): boolean {
  return PUBLIC_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

function isAuthed(req: NextRequest): boolean {
  return req.cookies.get(AUTH_COOKIE)?.value === "1";
}

export function middleware(req: NextRequest) {
  const { pathname, search } = req.nextUrl;

  // Static assets, _next internals, favicons, etc. — never gate these.
  if (
    pathname.startsWith("/_next") ||
    pathname.startsWith("/favicon") ||
    pathname === "/robots.txt" ||
    pathname === "/sitemap.xml"
  ) {
    return NextResponse.next();
  }

  const authed = isAuthed(req);

  // Logged-in users shouldn't see /login — bounce them to the OEMS front
  // door so a stale tab doesn't get them stuck on the form.
  if (pathname === "/login") {
    if (authed) {
      const url = req.nextUrl.clone();
      url.pathname = "/oems";
      url.search = "";
      return NextResponse.redirect(url);
    }
    return NextResponse.next();
  }

  // Public routes pass through.
  if (isPublic(pathname)) {
    return NextResponse.next();
  }

  // Everything else is gated. Unauthenticated → /login (preserve where
  // they were trying to go via ?next= so the post-login redirect can
  // honour it).
  if (!authed) {
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    url.search = `?next=${encodeURIComponent(pathname + search)}`;
    return NextResponse.redirect(url);
  }

  return NextResponse.next();
}

export const config = {
  // Run on every request EXCEPT static assets and image optimisations —
  // we let Next.js handle those at the framework level for performance.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\..*).*)"],
};

export { COOKIE_MAX_AGE };
