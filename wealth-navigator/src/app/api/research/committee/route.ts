import { NextResponse } from "next/server";

import { getAdminContext } from "@/lib/admin/rbac";
import { COMMITTEE_ROSTER, resolveCommitteeMembers } from "@/lib/research-ic/committee";
import { createRetailServiceRoleClient } from "@/lib/supabase/server";

/**
 * GET /api/research/committee
 *
 * Resolves the standing 3-member IC roster to live admin_team rows. The
 * matching strategy:
 *   1. Look up admin_team by each member's display_name (case-insensitive).
 *   2. Fall back to matching by the part before `@` in the email column when
 *      no full_name row is found (handles accounts where full_name hasn't been
 *      filled in yet).
 *
 * If the lookup is unconfigured (e.g. env missing in a fresh environment),
 * the static roster is returned with empty emails so the UI can render the
 * pill shells without crashing.
 *
 * Gate: any signed-in admin (no committee whitelist check here — the page
 * uses this for *display*, not for authorisation; the vote route applies the
 * whitelist).
 */

export const dynamic = "force-dynamic";

export async function GET() {
  const auth = await getAdminContext();
  if (auth.status === "no-session") {
    return NextResponse.json({ ok: false, error: "no-session" }, { status: 401 });
  }
  if (auth.status !== "ok") {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }

  // 1. Search admin_team by full_name first.
  let sb;
  try {
    sb = createRetailServiceRoleClient();
  } catch (e) {
    return NextResponse.json(
      {
        ok: true,
        members: COMMITTEE_ROSTER.map((m) => ({ ...m, email: "" })),
        notice: `Retail Supabase not configured: ${(e as Error).message}`,
      },
      { status: 200 },
    );
  }

  const names = COMMITTEE_ROSTER.map((m) => m.displayName);
  const nameRes = await sb
    .from("admin_team")
    .select("email, full_name, status")
    .in("full_name", names);

  const emailsByName: Record<string, string> = {};
  if (!nameRes.error && nameRes.data) {
    for (const row of nameRes.data as Array<{ email: string; full_name: string | null; status: string | null }>) {
      if (!row.full_name || row.status === "inactive") continue;
      emailsByName[row.full_name.toLowerCase()] = row.email;
    }
  }

  // 2. For any unmatched name, try matching by the local part of the email
  //    column (e.g. "lonwabo@…" → "lonwabo"). PostgREST `.ilike('email',
  //    'foo@%')` doesn't accept an array of prefixes, so we do N single
  //    lookups so each slug is checked independently.
  const missing = COMMITTEE_ROSTER.filter((m) => !emailsByName[m.displayName.toLowerCase()]);
  for (const m of missing) {
    const prefix = `${m.displayName.toLowerCase()}@`;
    const r = await sb.from("admin_team").select("email, status").ilike("email", `${prefix}%`).maybeSingle();
    if (!r.error && r.data && (r.data as { status: string | null }).status !== "inactive") {
      emailsByName[m.displayName.toLowerCase()] = (r.data as { email: string }).email;
    }
  }

  const members = await resolveCommitteeMembers(sb, emailsByName);
  return NextResponse.json({ ok: true, members }, { status: 200 });
}
