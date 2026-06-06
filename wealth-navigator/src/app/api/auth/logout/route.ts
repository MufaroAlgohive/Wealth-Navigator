import { NextResponse } from "next/server";
import { AUTH_COOKIE } from "@/middleware";

/**
 * Mock logout. Clears the auth + persona cookies and returns 200. The
 * client is expected to also reset its in-memory persona store (see the
 * `useResetSession` hook in `session-provider.tsx`) and `router.replace`
 * to `/login`.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST() {
  const res = NextResponse.json({ ok: true });
  res.cookies.set({
    name: AUTH_COOKIE,
    value: "",
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    maxAge: 0,
  });
  res.cookies.set({
    name: "mint-persona",
    value: "",
    path: "/",
    sameSite: "lax",
    maxAge: 0,
  });
  return res;
}
