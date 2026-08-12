import { NextResponse } from "next/server";

import { canSeeUatSurfaces, getAdminContext } from "@/lib/admin/rbac";
import { isSupabaseSchemaMissing } from "@/lib/bff-reasons";
import { createInstitutionalServiceRoleClient } from "@/lib/supabase/server";

/**
 * /api/research/notes/[id] — single-note read/update/delete.
 *
 * GET    any team member
 * PATCH  author-only while the note is in {draft, in_review}; allowed
 *        fields: thesis / triggers / valuation / symbol
 * DELETE author-only and only while status='draft'
 *
 * Returns 200 with an honest notice when the table hasn't been migrated.
 */

export const dynamic = "force-dynamic";

type NoteStatus = "draft" | "in_review" | "ic_pending" | "approved" | "rejected";

interface ResearchNoteRow {
  id: string;
  symbol: string;
  environment_scope: "live" | "uat";
  author_email: string;
  status: NoteStatus;
  thesis: unknown;
  triggers: unknown | null;
  valuation: unknown | null;
  ic_session_id: string | null;
  created_at: string;
  updated_at: string;
  submitted_at: string | null;
  approved_at: string | null;
}

async function openDb() {
  try {
    return createInstitutionalServiceRoleClient();
  } catch {
    return null;
  }
}

async function loadNote(
  db: NonNullable<Awaited<ReturnType<typeof openDb>>>,
  id: string,
): Promise<
  { ok: true; note: ResearchNoteRow } | { ok: false; status: number; body: Record<string, unknown> }
> {
  const { data, error } = await db
    .from("research_note_c")
    .select(
      "id, symbol, environment_scope, author_email, status, thesis, triggers, valuation, ic_session_id, created_at, updated_at, submitted_at, approved_at",
    )
    .eq("id", id)
    .maybeSingle();

  if (error) {
    if (isSupabaseSchemaMissing(error)) {
      return {
        ok: false,
        status: 409,
        body: {
          ok: false,
          error: "research_note_c table not migrated yet — apply 20260710000001_research_note_c.sql.",
          migration: "supabase/migrations/20260710000001_research_note_c.sql",
        },
      };
    }
    return { ok: false, status: 500, body: { ok: false, error: error.message } };
  }
  if (!data) return { ok: false, status: 404, body: { ok: false, error: "note not found" } };
  return { ok: true, note: data as ResearchNoteRow };
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const auth = await getAdminContext();
  if (auth.status === "no-session") {
    return NextResponse.json({ ok: false, error: "no-session" }, { status: 401 });
  }
  if (auth.status !== "ok") {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }
  const db = await openDb();
  if (!db)
    return NextResponse.json({ ok: false, error: "INSTITUTIONAL database not configured" }, { status: 503 });
  const loaded = await loadNote(db, id);
  if (!loaded.ok) return NextResponse.json(loaded.body, { status: loaded.status });
  return NextResponse.json({ ok: true, note: loaded.note });
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const auth = await getAdminContext();
  if (auth.status === "no-session") {
    return NextResponse.json({ ok: false, error: "no-session" }, { status: 401 });
  }
  if (auth.status !== "ok") {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }

  const db = await openDb();
  if (!db)
    return NextResponse.json({ ok: false, error: "INSTITUTIONAL database not configured" }, { status: 503 });

  const loaded = await loadNote(db, id);
  if (!loaded.ok) return NextResponse.json(loaded.body, { status: loaded.status });

  // Author-or-dev only.
  if (
    auth.ctx.email.toLowerCase() !== loaded.note.author_email.toLowerCase() &&
    auth.ctx.approverTier !== "dev"
  ) {
    return NextResponse.json({ ok: false, error: "only the author may edit this note" }, { status: 403 });
  }
  if (loaded.note.status !== "draft" && loaded.note.status !== "in_review") {
    return NextResponse.json(
      { ok: false, error: `note is locked in status '${loaded.note.status}'` },
      { status: 409 },
    );
  }

  const body = ((await req.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (typeof body.symbol === "string") patch.symbol = body.symbol.trim().toUpperCase();
  if (body.thesis !== undefined) patch.thesis = body.thesis;
  if (body.triggers !== undefined) patch.triggers = body.triggers;
  if (body.valuation !== undefined) patch.valuation = body.valuation;
  if (body.environment_scope !== undefined) {
    if (body.environment_scope !== "live" && body.environment_scope !== "uat") {
      return NextResponse.json({ ok: false, error: "environment_scope must be live or uat" }, { status: 400 });
    }
    if (!canSeeUatSurfaces(auth.ctx)) {
      return NextResponse.json({ ok: false, error: "only a developer can move research between LIVE and UAT" }, { status: 403 });
    }
    patch.environment_scope = body.environment_scope;
  }

  const { data, error } = await db.from("research_note_c").update(patch).eq("id", id).select().maybeSingle();

  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, note: data });
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const auth = await getAdminContext();
  if (auth.status === "no-session") {
    return NextResponse.json({ ok: false, error: "no-session" }, { status: 401 });
  }
  if (auth.status !== "ok") {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }

  const db = await openDb();
  if (!db)
    return NextResponse.json({ ok: false, error: "INSTITUTIONAL database not configured" }, { status: 503 });

  const loaded = await loadNote(db, id);
  if (!loaded.ok) return NextResponse.json(loaded.body, { status: loaded.status });

  if (
    auth.ctx.email.toLowerCase() !== loaded.note.author_email.toLowerCase() &&
    auth.ctx.approverTier !== "dev"
  ) {
    return NextResponse.json({ ok: false, error: "only the author may delete this note" }, { status: 403 });
  }
  if (loaded.note.status !== "draft") {
    return NextResponse.json(
      { ok: false, error: `cannot delete a note past draft (status='${loaded.note.status}')` },
      { status: 409 },
    );
  }

  const { error } = await db.from("research_note_c").delete().eq("id", id);
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
