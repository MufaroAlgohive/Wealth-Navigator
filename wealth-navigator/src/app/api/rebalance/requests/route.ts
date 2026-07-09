import { NextResponse } from "next/server";

import { can, getAdminContext } from "@/lib/admin/rbac";
import { isSupabaseSchemaMissing } from "@/lib/bff-reasons";
import { createInstitutionalServiceRoleClient } from "@/lib/supabase/server";

/**
 * /api/rebalance/requests — strategy rebalance queue.
 *
 * GET  ?status=ic_approved   list rebalance requests.
 * POST                      raise a new request from a research note.
 *
 * Both calls fall back to an empty array / honest notice if
 * `rebalance_request_c` hasn't been migrated yet.
 */

export const dynamic = "force-dynamic";

interface RebalanceRow {
  id: string;
  strategy_id: string;
  requested_by: string;
  current_composition: unknown;
  proposed_composition: unknown;
  affected_investors: unknown | null;
  status: string;
  ic_session_id: string | null;
  research_note_id: string | null;
  executed_at: string | null;
  created_at: string;
  updated_at: string;
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

  const db = await openDb();
  if (!db) {
    return NextResponse.json({
      ok: true,
      requests: [],
      notice: "INSTITUTIONAL database not configured.",
    });
  }

  let q = db
    .from("rebalance_request_c")
    .select(
      "id, strategy_id, requested_by, current_composition, proposed_composition, affected_investors, status, ic_session_id, research_note_id, executed_at, created_at, updated_at",
    )
    .order("created_at", { ascending: false })
    .limit(100);
  if (status) q = q.eq("status", status);

  const { data, error } = await q;
  if (error) {
    if (isSupabaseSchemaMissing(error)) {
      return NextResponse.json({
        ok: true,
        requests: [],
        notice: "rebalance_request_c table not migrated yet — apply 20260710000004_rebalance_request_c.sql.",
      });
    }
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true, requests: (data ?? []) as RebalanceRow[] });
}

export async function POST(req: Request) {
  const auth = await getAdminContext();
  if (auth.status === "no-session") {
    return NextResponse.json({ ok: false, error: "no-session" }, { status: 401 });
  }
  if (auth.status !== "ok") {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }
  if (!can(auth.ctx, "research", "raise_rebalance")) {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }

  const body = ((await req.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;
  const strategyId = typeof body.strategy_id === "string" ? body.strategy_id.trim() : "";
  const currentComposition = body.current_composition;
  const proposedComposition = body.proposed_composition;
  if (!strategyId) {
    return NextResponse.json({ ok: false, error: "strategy_id is required" }, { status: 400 });
  }
  if (!Array.isArray(currentComposition) || !Array.isArray(proposedComposition)) {
    return NextResponse.json(
      { ok: false, error: "current_composition and proposed_composition must be arrays" },
      { status: 400 },
    );
  }

  const db = await openDb();
  if (!db)
    return NextResponse.json({ ok: false, error: "INSTITUTIONAL database not configured" }, { status: 503 });

  const insert: Record<string, unknown> = {
    strategy_id: strategyId,
    requested_by: auth.ctx.email,
    current_composition: currentComposition,
    proposed_composition: proposedComposition,
    affected_investors: body.affected_investors ?? null,
    status: "pending",
    research_note_id:
      typeof body.research_note_id === "string" && body.research_note_id.length > 0
        ? body.research_note_id
        : null,
    ic_session_id:
      typeof body.ic_session_id === "string" && body.ic_session_id.length > 0 ? body.ic_session_id : null,
  };

  const { data, error } = await db.from("rebalance_request_c").insert(insert).select().maybeSingle();
  if (error) {
    if (isSupabaseSchemaMissing(error)) {
      return NextResponse.json(
        {
          ok: false,
          error: "rebalance_request_c table not migrated yet — apply 20260710000004_rebalance_request_c.sql.",
          migration: "supabase/migrations/20260710000004_rebalance_request_c.sql",
        },
        { status: 409 },
      );
    }
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true, request: data }, { status: 201 });
}
