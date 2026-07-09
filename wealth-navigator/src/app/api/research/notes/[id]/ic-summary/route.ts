import { NextResponse } from "next/server";

import { getAdminContext } from "@/lib/admin/rbac";
import { isSupabaseSchemaMissing } from "@/lib/bff-reasons";
import { createInstitutionalServiceRoleClient } from "@/lib/supabase/server";

/**
 * GET /api/research/notes/[id]/ic-summary
 *
 * IC-ready summary for a single research note — combines the note's stored
 * thesis / valuation / triggers JSONB with the live vote tally on
 * `research_vote_c`. Returns 200 with an honest notice when the underlying
 * tables haven't been migrated yet so the IC UI can render an empty state
 * instead of crashing.
 */

export const dynamic = "force-dynamic";

interface ResearchNoteRow {
  id: string;
  symbol: string;
  author_email: string;
  status: string;
  thesis: unknown;
  triggers: unknown | null;
  valuation: unknown | null;
  ic_session_id: string | null;
  created_at: string;
  updated_at: string;
  submitted_at: string | null;
  approved_at: string | null;
}

interface VoteRow {
  id: string;
  note_id: string;
  voter_email: string;
  vote: "yes" | "no" | "abstain";
  rationale: string | null;
  voted_at: string;
}

async function openDb() {
  try {
    return createInstitutionalServiceRoleClient();
  } catch {
    return null;
  }
}

function tallyVotes(votes: VoteRow[]) {
  let yes = 0;
  let no = 0;
  let abstain = 0;
  for (const v of votes) {
    if (v.vote === "yes") yes += 1;
    else if (v.vote === "no") no += 1;
    else if (v.vote === "abstain") abstain += 1;
  }
  return { yes, no, abstain, total: votes.length };
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const auth = await getAdminContext();
  if (auth.status === "no-session")
    return NextResponse.json({ ok: false, error: "no-session" }, { status: 401 });
  if (auth.status !== "ok") return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });

  const db = await openDb();
  if (!db) {
    return NextResponse.json({
      ok: true,
      summary: null,
      votes: [],
      tally: { yes: 0, no: 0, abstain: 0, total: 0 },
      notice: "INSTITUTIONAL database not configured.",
    });
  }

  const noteRes = await db
    .from("research_note_c")
    .select(
      "id, symbol, author_email, status, thesis, triggers, valuation, ic_session_id, created_at, updated_at, submitted_at, approved_at",
    )
    .eq("id", id)
    .maybeSingle();

  if (noteRes.error) {
    if (isSupabaseSchemaMissing(noteRes.error)) {
      return NextResponse.json({
        ok: true,
        summary: null,
        votes: [],
        tally: { yes: 0, no: 0, abstain: 0, total: 0 },
        notice: "research_note_c table not migrated yet — apply 20260710000001_research_note_c.sql.",
      });
    }
    return NextResponse.json({ ok: false, error: noteRes.error.message }, { status: 500 });
  }

  const note = (noteRes.data ?? null) as ResearchNoteRow | null;

  const voteRes = await db
    .from("research_vote_c")
    .select("id, note_id, voter_email, vote, rationale, voted_at")
    .eq("note_id", id)
    .order("voted_at", { ascending: true });

  if (voteRes.error && !isSupabaseSchemaMissing(voteRes.error)) {
    return NextResponse.json({ ok: false, error: voteRes.error.message }, { status: 500 });
  }

  const votes = (voteRes.data ?? []) as VoteRow[];
  const tally = tallyVotes(votes);

  return NextResponse.json({
    ok: true,
    summary: note,
    votes,
    tally,
    notice:
      voteRes.error && isSupabaseSchemaMissing(voteRes.error)
        ? "research_vote_c table not migrated yet — apply 20260710000002_research_vote_c.sql."
        : undefined,
  });
}
