import { NextResponse } from "next/server";

import { can, getAdminContext } from "@/lib/admin/rbac";
import { isSupabaseSchemaMissing } from "@/lib/bff-reasons";
import { createInstitutionalServiceRoleClient } from "@/lib/supabase/server";

/**
 * /api/research/notes — Research notes CRUD (IC pipeline source).
 *
 * GET  ?strategy_id=&status=&symbol=  list notes (any team member).
 * POST                            create a new note.
 *                                  Requires `research.create_note` permission
 *                                  (dev tier bypasses — full access).
 *
 * Both calls fall back to an empty array / honest notice if
 * `research_note_c` hasn't been migrated yet.
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

async function openDb() {
  try {
    return createInstitutionalServiceRoleClient();
  } catch {
    return null;
  }
}

export async function GET(req: Request) {
  const auth = await getAdminContext();
  if (auth.status === "no-session") {
    return NextResponse.json({ ok: false, error: "no-session" }, { status: 401 });
  }
  if (auth.status !== "ok") {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }

  const url = new URL(req.url);
  const status = url.searchParams.get("status");
  const symbol = url.searchParams.get("symbol");
  const strategyId = url.searchParams.get("strategy_id");

  const db = await openDb();
  if (!db) {
    return NextResponse.json({
      ok: true,
      notes: [],
      notice: "INSTITUTIONAL database not configured.",
    });
  }

  let q = db
    .from("research_note_c")
    .select(
      "id, symbol, author_email, status, thesis, triggers, valuation, ic_session_id, created_at, updated_at, submitted_at, approved_at",
    )
    .order("updated_at", { ascending: false })
    .limit(100);

  if (status) q = q.eq("status", status);
  if (symbol) q = q.eq("symbol", symbol.toUpperCase());
  // strategy_id isn't a column on research_note_c; the caller can filter
  // by symbol (one note per stock per IC cycle) or join via the
  // rebalance_request_c side. Keep the query param around for symmetry
  // with the Research Lab, even though today we ignore it.
  void strategyId;

  const { data, error } = await q;
  if (error) {
    if (isSupabaseSchemaMissing(error)) {
      return NextResponse.json({
        ok: true,
        notes: [],
        notice: "research_note_c table not migrated yet — apply 20260710000001_research_note_c.sql.",
      });
    }
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true, notes: (data ?? []) as ResearchNoteRow[] });
}

export async function POST(req: Request) {
  const auth = await getAdminContext();
  if (auth.status === "no-session") {
    return NextResponse.json({ ok: false, error: "no-session" }, { status: 401 });
  }
  if (auth.status !== "ok") {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }
  if (!can(auth.ctx, "research-lab", "create_research_note")) {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }

  const body = ((await req.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;
  const symbol = typeof body.symbol === "string" ? body.symbol.trim().toUpperCase() : "";
  const thesis = body.thesis ?? {};

  if (!symbol) {
    return NextResponse.json({ ok: false, error: "symbol is required" }, { status: 400 });
  }

  const db = await openDb();
  if (!db) {
    return NextResponse.json({ ok: false, error: "INSTITUTIONAL database not configured" }, { status: 503 });
  }

  const insert = {
    symbol,
    author_email: auth.ctx.email,
    status: "draft",
    thesis,
    triggers: body.triggers ?? null,
    valuation: body.valuation ?? null,
  };

  const { data, error } = await db.from("research_note_c").insert(insert).select().maybeSingle();

  if (error) {
    if (isSupabaseSchemaMissing(error)) {
      return NextResponse.json(
        {
          ok: false,
          error: "research_note_c table not migrated yet — apply 20260710000001_research_note_c.sql.",
          migration: "supabase/migrations/20260710000001_research_note_c.sql",
        },
        { status: 409 },
      );
    }
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, note: data }, { status: 201 });
}
