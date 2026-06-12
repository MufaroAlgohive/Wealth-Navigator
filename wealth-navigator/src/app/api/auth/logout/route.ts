import { NextResponse } from "next/server";

import { createSupabaseServerClient } from "@/lib/supabase/server";

/**
 * Signs out the Supabase session and clears auth cookies. The client should
 * reset its in-memory persona store and navigate to `/login`.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST() {
  const supabase = await createSupabaseServerClient();
  await supabase.auth.signOut();

  const res = NextResponse.json({ ok: true });
  res.cookies.set({
    name: "mint-persona",
    value: "",
    path: "/",
    sameSite: "lax",
    maxAge: 0,
  });
  return res;
}
