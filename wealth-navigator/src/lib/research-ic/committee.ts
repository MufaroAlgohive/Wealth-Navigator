/**
 * Investment Committee — membership & voting rules.
 *
 * Single source of truth for:
 *   - who the 3 IC voting members are (chair + 2 voting)
 *   - which emails are allowed to cast / receive a ballot
 *   - the majority threshold (≥ 2 of 3) the committee requires to pass
 *
 * The whitelist is also mirrored in the institutional DB (`committee_member_c`,
 * see supabase/seeds/ic_committee_discover.sql). Keep both in sync when a
 * member joins or leaves — the DB whitelist is what the vote route enforces
 * server-side; this constant is what the UI uses to render the member pills.
 *
 * Email values are populated lazily from the runtime `admin_team` lookup in
 * `resolveCommitteeMembers()` — but the DISPLAY order and roles come from
 * `COMMITTEE_MEMBERS` so the chair slot is always Lonwabo's regardless of
 * alphabetical email sort.
 */

export type CommitteeRole = "chair" | "voting" | "observer";

export interface CommitteeMember {
  /** Stable slug, used as React key + sort key. */
  slug: string;
  /** Display name shown in pills & member card. Falls back to slug when the
   *  runtime lookup can't resolve the DB row. */
  displayName: string;
  /** Two-letter initials shown in the avatar pill. */
  initials: string;
  /** IC role — chair has casting vote on a tie. */
  role: CommitteeRole;
  /** Lower-cased email used for exact, case-insensitive vote attribution.
   *  Empty string until resolved by resolveCommitteeMembers(). */
  email: string;
}

/**
 * Standing roster — display order + role. Email is filled in at runtime from
 * the `admin_team` lookup so we don't hard-code addresses that may differ
 * between staging and prod.
 */
export const COMMITTEE_ROSTER: ReadonlyArray<Omit<CommitteeMember, "email">> = [
  { slug: "lonwabo", displayName: "Lonwabo", initials: "LN", role: "chair" },
  { slug: "juan", displayName: "Juan", initials: "JN", role: "voting" },
  { slug: "lethabo", displayName: "Lethabo", initials: "LT", role: "voting" },
];

/** Committee size — fixed at 3 by charter. */
export const IC_COMMITTEE_SIZE = COMMITTEE_ROSTER.length;

/** Majority threshold: ≥ ceil(size / 2) + 1 yes votes. For size=3, that's 2. */
export const IC_MAJORITY_REQUIRED_YES = Math.floor(IC_COMMITTEE_SIZE / 2) + 1;

/** Threshold expressed as a fraction (≥0.5 by definition). Useful for the UI
 *  progress bar where we show "needs 50%". For size=3 this is 0.667 so
 *  ceil(3 * 0.667) === 2 === IC_MAJORITY_REQUIRED_YES. */
export const IC_MAJORITY_THRESHOLD = IC_MAJORITY_REQUIRED_YES / IC_COMMITTEE_SIZE;

/** True when yes votes have reached the majority threshold. */
export function majorityPassed(yesVotes: number, abstainVotes = 0): boolean {
  // Abstentions do NOT lower the bar — a 2-yes-1-abstain still passes (2 ≥ 2).
  return yesVotes >= IC_MAJORITY_REQUIRED_YES;
}

/**
 * Resolve the runtime committee roster by joining `COMMITTEE_ROSTER` with the
 * `admin_team` rows from the retail DB (the only place user emails + names are
 * canonically stored). Falls back to the static roster with an empty email
 * placeholder when the lookup fails — the UI then renders pills without a
 * click handler so casting votes is disabled, rather than crashing.
 */
export async function resolveCommitteeMembers(
  // Accept the Supabase client structurally — keeping the type loose here
  // avoids TypeScript "excessively deep" complaints from the full Postgrest
  // builder generic chain. The body only touches `.from`, `.select`, `.in`.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: any,
  /** Candidate emails to match against (e.g. from admin_team.full_name lower-cased). */
  emailsByName: Record<string, string>,
): Promise<CommitteeMember[]> {
  const emails = COMMITTEE_ROSTER
    .map((m) => emailsByName[m.displayName.toLowerCase()]?.toLowerCase())
    .filter((e): e is string => Boolean(e));
  if (emails.length === 0) {
    return COMMITTEE_ROSTER.map((m) => ({ ...m, email: "" }));
  }
  let resolved: Array<{ email: string; full_name: string | null }> = [];
  try {
    const r: { data: Array<{ email: string; full_name: string | null }> | null; error: { message: string } | null } =
      await supabase.from("admin_team").select("email, full_name").in("email", emails);
    if (r.data) resolved = r.data;
  } catch {
    resolved = [];
  }
  const byEmail = new Map(resolved.map((r) => [r.email.toLowerCase(), r]));
  return COMMITTEE_ROSTER.map((m) => {
    const candidate = emailsByName[m.displayName.toLowerCase()]?.toLowerCase() ?? "";
    const row = byEmail.get(candidate);
    return {
      ...m,
      email: candidate,
      displayName: row?.full_name?.trim() || m.displayName,
    };
  });
}
