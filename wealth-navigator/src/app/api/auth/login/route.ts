import { AUTH_COOKIE, COOKIE_MAX_AGE } from "@/middleware";
import { type NextRequest, NextResponse } from "next/server";

/**
 * Mock application login (dev-only until real auth e.g. Supabase/Clerk).
 *
 * Accepts the long-standing dev `admin` / `admin` factory default. A
 * successful response carries the `mint-auth` cookie that middleware reads
 * on subsequent requests to gate protected routes.
 *
 * This is NOT IRESS Web Services authentication. IRESS SOAP session
 * credentials live in env vars (`IRESS_USERNAME`, `IRESS_PASSWORD`,
 * `IRESS_COMPANY_NAME`) and are bootstrapped server-side via
 * `bringUpMintSessionFromEnv()` — see `/api/iress/health`.
 *
 * If a `persona` is supplied, we additionally set a `mint-persona` cookie
 * so a hard reload (e.g. opening a fresh tab) keeps the right surface
 * selected. The persona store is the richer source of truth on the
 * client; this cookie is just a hint for SSR.
 *
 * Auth failures are deliberately non-leaky: a wrong username and a wrong
 * password both surface the same generic "Invalid credentials." so the
 * endpoint can't be used to enumerate which half of the pair was wrong.
 */

interface LoginBody {
  username?: unknown;
  password?: unknown;
  persona?: unknown;
}

interface LoginResponseBody {
  ok: boolean;
  error?: string;
  user?: { username: string };
  persona?: string | null;
}

const ALLOWED_PERSONAS = new Set([
  "oems",
  "wealth_manager",
  "strategist",
  "admin",
  "business",
  "funeral_cover",
]);

/** Dev-only app credentials. Not related to IRESS WS session auth. */
const ALLOWED_CREDENTIALS: ReadonlyArray<{ username: string; password: string }> = [
  { username: "admin", password: "admin" },
];

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  let body: LoginBody;
  try {
    body = (await req.json()) as LoginBody;
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON body." }, { status: 400 });
  }

  const username = typeof body.username === "string" ? body.username.trim() : "";
  const password = typeof body.password === "string" ? body.password : "";

  if (!username || !password) {
    return NextResponse.json({ ok: false, error: "Username and password are required." }, { status: 400 });
  }

  const match = ALLOWED_CREDENTIALS.find((c) => c.username === username && c.password === password);
  if (!match) {
    return NextResponse.json({ ok: false, error: "Invalid credentials." }, { status: 401 });
  }

  const persona =
    typeof body.persona === "string" && ALLOWED_PERSONAS.has(body.persona) ? body.persona : null;

  const responseBody: LoginResponseBody = {
    ok: true,
    user: { username },
    persona,
  };

  const res = NextResponse.json(responseBody);

  // Auth signal — HttpOnly so the client JS can't read or forge it,
  // SameSite=Lax so top-level navigations send it back. Path=/ so the
  // cookie applies to every route. 24h matches the brief.
  res.cookies.set({
    name: AUTH_COOKIE,
    value: "1",
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    maxAge: COOKIE_MAX_AGE,
  });

  // Persona hint is intentionally NOT HttpOnly — the client Zustand
  // store hydrates from it on mount so the right persona loads after
  // a hard refresh.
  if (persona) {
    res.cookies.set({
      name: "mint-persona",
      value: persona,
      path: "/",
      sameSite: "lax",
      maxAge: COOKIE_MAX_AGE,
    });
  }

  return res;
}
