import { NextResponse } from "next/server";

import { canResearchIc, getAdminContext } from "@/lib/admin/rbac";
import { isSupabaseSchemaMissing } from "@/lib/bff-reasons";
import { committeeGate } from "@/lib/research-ic/committee-gate";
import { createInstitutionalServiceRoleClient } from "@/lib/supabase/server";

/**
 * POST /api/research/notes/[id]/vote
 *
 * Cast an IC vote (yes / no / abstain) on a research note. Upserted per
 * (note_id, voter_email) so a committee member can revise their vote.
 *
 * Gate chain (all required):
 *   1. signed-in admin
 *   2. `research.cast_vote` granular permission
 *   3. voter_email is on the IC whitelist (committee_member_c on institutional
 *      DB, with a soft fallback to the static roster when the table isn't
 *      migrated yet — see lib/research-ic/committee.ts).
 *
 * Tally: majority of the 3-member committee (≥ 2 yes) → note auto-promotes
 * from `in_review` to `ic_pending`. Promotion is a separate concern handled by
 * the transition route; voting here only records the ballot.
 */

export const dynamic = "force-dynamic";

const VALID_VOTES = ["yes", "no", "abstain"] as const;
type VoteValue = (typeof VALID_VOTES)[number];

async function openDb() {
  try {
    return createInstitutionalServiceRoleClient();
  } catch {
    return null;
  }
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const auth = await getAdminContext();
  if (auth.status === "no-session") {
    return NextResponse.json({ ok: false, error: "no-session" }, { status: 401 });
  }
  if (auth.status !== "ok") {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }
  if (!canResearchIc(auth.ctx, "research-lab", "cast_vote")) {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }
  const gate = await committeeGate(auth.ctx.email);
  if (!gate.ok) {
    return NextResponse.json({ ok: false, error: gate.error }, { status: gate.status });
  }

  const body = ((await req.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;
  const vote = body.vote;
  if (typeof vote !== "string" || !VALID_VOTES.includes(vote as VoteValue)) {
    return NextResponse.json(
      { ok: false, error: `vote must be one of: ${VALID_VOTES.join(", ")}` },
      { status: 400 },
    );
  }
  const rationale = typeof body.rationale === "string" ? body.rationale.slice(0, 2000) : null;

  const db = await openDb();
  if (!db)
    return NextResponse.json({ ok: false, error: "INSTITUTIONAL database not configured" }, { status: 503 });

  // Confirm the note exists before we accept the vote. If the notes table
  // hasn't been migrated yet, surface the same migration hint that the
  // votes table would also need.
  const noteCheck = await db.from("research_note_c").select("id").eq("id", id).maybeSingle();
  if (noteCheck.error) {
    if (isSupabaseSchemaMissing(noteCheck.error)) {
      return NextResponse.json(
        {
          ok: false,
          error: "research_note_c table not migrated yet — apply 20260710000001_research_note_c.sql.",
          migration: "supabase/migrations/20260710000001_research_note_c.sql",
        },
        { status: 409 },
      );
    }
    return NextResponse.json({ ok: false, error: noteCheck.error.message }, { status: 500 });
  }
  if (!noteCheck.data) {
    return NextResponse.json({ ok: false, error: "research note not found" }, { status: 404 });
  }

  const { data, error } = await db
    .from("research_vote_c")
    .upsert(
      {
        note_id: id,
        voter_email: auth.ctx.email,
        vote,
        rationale,
        voted_at: new Date().toISOString(),
      },
      { onConflict: "note_id,voter_email" },
    )
    .select()
    .maybeSingle();

  if (error) {
    if (isSupabaseSchemaMissing(error)) {
      return NextResponse.json(
        {
          ok: false,
          error: "research_vote_c table not migrated yet — apply 20260710000002_research_vote_c.sql.",
          migration: "supabase/migrations/20260710000002_research_vote_c.sql",
        },
        { status: 409 },
      );
    }
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, vote: data }, { status: 201 });
}
