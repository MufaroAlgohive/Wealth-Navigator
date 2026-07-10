import { NextResponse } from "next/server";

import { can, getAdminContext } from "@/lib/admin/rbac";
import { isSupabaseSchemaMissing } from "@/lib/bff-reasons";
import { createInstitutionalServiceRoleClient } from "@/lib/supabase/server";

/**
 * POST /api/research/notes/[id]/transition
 *
 * Advance a research note through the IC state machine:
 *
 *   draft        → in_review         (author or dev)
 *   in_review    → ic_pending        (author or dev)
 *   ic_pending   → approved | rejected  (requires `research-lab.approve_note`)
 *
 * `approved` is the terminal state for a research note (a note is never
 * "executed" — execution lives on `rebalance_request_c`, which has its own
 * status machine + `executed_at`). `research_note_c.status` CHECK only allows
 * draft/in_review/ic_pending/approved/rejected.
 *
 * Updates timestamp columns and (when moving into `ic_pending`) lets the
 * caller attach an IC session.
 *
 * Body: `{ to_status: NoteStatus, reason?: string, ic_session_id?: string }`.
 *
 * Returns 200 with the updated row, 409 on illegal transitions or
 * missing-migration, 401/403 on auth gates.
 */

export const dynamic = "force-dynamic";

const ALLOWED: Record<string, ReadonlyArray<string>> = {
  draft: ["in_review"],
  in_review: ["ic_pending"],
  ic_pending: ["approved", "rejected"],
  approved: [],
  rejected: [],
};

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

  const body = ((await req.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;
  const toStatus = typeof body.to_status === "string" ? body.to_status : "";
  if (!toStatus || !(toStatus in ALLOWED)) {
    return NextResponse.json({ ok: false, error: "to_status is required" }, { status: 400 });
  }

  const db = await openDb();
  if (!db)
    return NextResponse.json({ ok: false, error: "INSTITUTIONAL database not configured" }, { status: 503 });

  const { data: note, error: noteErr } = await db
    .from("research_note_c")
    .select("id, status, author_email, thesis")
    .eq("id", id)
    .maybeSingle();

  if (noteErr) {
    if (isSupabaseSchemaMissing(noteErr)) {
      return NextResponse.json(
        {
          ok: false,
          error: "research_note_c table not migrated yet — apply 20260710000001_research_note_c.sql.",
          migration: "supabase/migrations/20260710000001_research_note_c.sql",
        },
        { status: 409 },
      );
    }
    return NextResponse.json({ ok: false, error: noteErr.message }, { status: 500 });
  }
  if (!note) return NextResponse.json({ ok: false, error: "research note not found" }, { status: 404 });

  const from = note.status as string;
  const allowed = ALLOWED[from] ?? [];
  if (!allowed.includes(toStatus)) {
    return NextResponse.json(
      { ok: false, error: `illegal transition: ${from} → ${toStatus}` },
      { status: 409 },
    );
  }

  // Author (or dev) can push forward through the front of the pipeline; the
  // IC-decision side requires the explicit permission.
  const isAuthor = auth.ctx.email.toLowerCase() === String(note.author_email ?? "").toLowerCase();
  const isDev = auth.ctx.approverTier === "dev";
  const needsApprovalPerm = toStatus === "approved" || toStatus === "rejected";
  const fromStatusNeedsReview = from === "draft" || from === "in_review";

  if (needsApprovalPerm && !can(auth.ctx, "research-lab", "approve_note")) {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }
  if (fromStatusNeedsReview && !isAuthor && !isDev) {
    return NextResponse.json(
      { ok: false, error: "only the author may move this note forward" },
      { status: 403 },
    );
  }

  const now = new Date().toISOString();
  const update: Record<string, unknown> = {
    status: toStatus,
    updated_at: now,
  };
  if (from === "draft" && toStatus === "in_review") {
    // No dedicated timestamp column for in_review; left as updated_at.
  }
  if (toStatus === "ic_pending") {
    update.submitted_at = now;
    const sid = body.ic_session_id;
    if (typeof sid === "string" && sid.length > 0) update.ic_session_id = sid;
  }
  if (toStatus === "approved" || toStatus === "rejected") {
    if (toStatus === "approved") update.approved_at = now;
    // Merge the IC resolution into the thesis JSONB WITHOUT clobbering the
    // analyst's thesis/fundamentals/triggers. We spread the existing thesis
    // and append an ic_log entry so the decision travels with the note.
    const existing =
      note.thesis && typeof note.thesis === "object" && !Array.isArray(note.thesis)
        ? (note.thesis as Record<string, unknown>)
        : {};
    const reason = typeof body.reason === "string" ? body.reason : "";
    const prevLog = Array.isArray((existing as { ic_log?: unknown }).ic_log)
      ? ((existing as { ic_log?: unknown[] }).ic_log as unknown[])
      : [];
    update.thesis = {
      ...existing,
      _resolution: { status: toStatus, reason, by: auth.ctx.email, at: now },
      ic_log: [
        {
          actor: auth.ctx.fullName ?? auth.ctx.email,
          action: toStatus === "approved" ? "APPROVED" : "REJECTED",
          at: now,
          note: reason || undefined,
        },
        ...prevLog,
      ],
    };
  }

  const { data, error } = await db.from("research_note_c").update(update).eq("id", id).select().maybeSingle();
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, note: data });
}
