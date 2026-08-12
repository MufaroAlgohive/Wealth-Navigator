/**
 * Server-side committee membership check used by the IC vote routes.
 *
 * The whitelist lives in `committee_member_c` on the INSTITUTIONAL DB (see
 * supabase/seeds/ic_committee_discover.sql). When the table is unconfigured or
 * the row is missing, we fall back to the static roster in
 * `lib/research-ic/committee.ts` so the gate still works in fresh environments.
 *
 * Returning a structured `{ ok, error, member }` lets each route choose the
 * right HTTP status (403 vs 503) and lets the UI surface a precise reason.
 */

import { createInstitutionalServiceRoleClient } from "@/lib/supabase/server";
import {
  COMMITTEE_ROSTER,
  type CommitteeMember,
  type CommitteeRole,
  KNOWN_COMMITTEE_EMAILS,
} from "./committee";

interface MemberRow {
  voter_email: string;
  display_name: string | null;
  initials: string | null;
  role: string | null;
  is_active: boolean | null;
}

export type CommitteeGate =
  | { ok: true; member: CommitteeMember }
  | { ok: false; status: 403 | 503; error: string };

const slugForEmail = (email: string): string | null => {
  const e = email.toLowerCase();
  for (const [slug, emails] of Object.entries(KNOWN_COMMITTEE_EMAILS)) {
    if (emails.includes(e)) return slug;
  }
  return null;
};

/**
 * Look up `email` in `committee_member_c`. If the table isn't migrated yet
 * (e.g. before STEP 3 of the SQL seed has been run), fall back to the static
 * roster — any voter_email that exactly matches one of the standing display
 * names still passes the gate. This keeps the IC functional during a soft
 * rollout where the SQL hasn't run yet on a given environment.
 */
export async function committeeGate(email: string): Promise<CommitteeGate> {
  const lower = email.toLowerCase();

  let db;
  try {
    db = createInstitutionalServiceRoleClient();
  } catch (e) {
    return {
      ok: false,
      status: 503,
      error: `Institutional database not configured: ${(e as Error).message}`,
    };
  }

  const res = await db
    .from("committee_member_c")
    .select("voter_email, display_name, initials, role, is_active")
    .ilike("voter_email", lower)
    .maybeSingle();

  // Schema-missing → fall back to the static roster so the IC still works
  // pre-migration. Any other DB error → 503.
  if (res.error) {
    const code = (res.error as { code?: string }).code ?? "";
    const msg = (res.error as { message?: string }).message ?? "";
    if (code === "42P01" || /does not exist/i.test(msg)) {
      const slug = slugForEmail(email);
      if (slug) {
        const staticMatch = COMMITTEE_ROSTER.find((m) => m.slug === slug)!;
        return {
          ok: true,
          member: { ...staticMatch, email: lower },
        };
      }
      return {
        ok: false,
        status: 403,
        error: "Not on the IC committee roster. Apply committee_member_c seed and grant cast_vote.",
      };
    }
    return { ok: false, status: 503, error: res.error.message };
  }

  if (!res.data) {
    // Soft fallback: if the DB row is missing but the email matches a known
    // roster member by display name, accept it (lets the IC run before the
    // committee_member_c SQL has been seeded). Otherwise reject.
    const slug = slugForEmail(email);
    if (slug) {
      const staticMatch = COMMITTEE_ROSTER.find((m) => m.slug === slug)!;
      return { ok: true, member: { ...staticMatch, email: lower } };
    }
    return {
      ok: false,
      status: 403,
      error: "Not on the IC committee roster.",
    };
  }

  const row = res.data as MemberRow;
  if (row.is_active === false) {
    return { ok: false, status: 403, error: "Committee membership is inactive." };
  }
  const slug = slugForEmail(email) ?? slugForEmail(row.voter_email) ?? row.voter_email;
  return {
    ok: true,
    member: {
      slug,
      displayName: row.display_name ?? email,
      initials: row.initials ?? email.slice(0, 2).toUpperCase(),
      role: (row.role as CommitteeRole) ?? "voting",
      email: row.voter_email.toLowerCase(),
    },
  };
}
