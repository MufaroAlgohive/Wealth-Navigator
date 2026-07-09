/**
 * GET    /api/admin/watchlist
 * POST   /api/admin/watchlist    body: { symbol: string, note?: string }
 * DELETE /api/admin/watchlist    query: ?symbol=ABC
 *
 * Per-user watchlist for the OEMS Cockpit + the modeling tab's "Add to watchlist"
 * button (A7.3). Persists into `watchlist_c` on the RETAIL Supabase DB so the
 * Cockpit's watchlist column can read from a shared source rather than localStorage.
 *
 * Graceful degradation:
 *   - If RETAIL is not configured (no SUPABASE env) the route returns an empty
 *     list and the POST/DELETE return 503. The ModelingTab falls back to its
 *     own localStorage on these errors, so nothing breaks end-to-end.
 *   - If the `watchlist_c` table hasn't been migrated yet (typical during the
 *     Phase A rollout) the GET returns `{ items: [], reason: 'table_missing' }`
 *     with HTTP 200; the POST/DELETE return 503. The ModelingTab treats the 503
 *     as "save locally" so users don't lose work while migrations land.
 *   - If the caller isn't signed in or isn't an admin team member, the route
 *     returns 401/403 like the rest of `/api/admin/*`.
 */
import { NextResponse } from "next/server";

import { getAdminContext } from "@/lib/admin/rbac";
import { isSupabaseSchemaMissing } from "@/lib/bff-reasons";
import { createRetailServiceRoleClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface WatchlistRow {
  id: string;
  symbol: string;
  note: string | null;
  created_at: string;
}

interface WatchlistGetResponse {
  ok: true;
  items: WatchlistRow[];
  source: "supabase" | "missing_table" | "unconfigured";
  reason?: string;
}

function tryOpen(): ReturnType<typeof createRetailServiceRoleClient> | null {
  try {
    return createRetailServiceRoleClient();
  } catch {
    return null;
  }
}

export async function GET() {
  const auth = await getAdminContext();
  if (auth.status === "no-session")
    return NextResponse.json({ ok: false, error: "no-session" }, { status: 401 });
  if (auth.status !== "ok") return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  if (!auth.ctx.email) return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });

  const db = tryOpen();
  if (!db) {
    const body: WatchlistGetResponse = {
      ok: true,
      items: [],
      source: "unconfigured",
      reason: "supabase_not_configured",
    };
    return NextResponse.json(body);
  }

  try {
    const { data, error } = await db
      .from("watchlist_c")
      .select("id, symbol, note, created_at")
      .ilike("user_email", auth.ctx.email)
      .order("created_at", { ascending: false })
      .limit(200);
    if (error) {
      if (isSupabaseSchemaMissing(error)) {
        const body: WatchlistGetResponse = {
          ok: true,
          items: [],
          source: "missing_table",
          reason: "table_not_migrated",
        };
        return NextResponse.json(body);
      }
      return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    }
    const body: WatchlistGetResponse = {
      ok: true,
      items: (data ?? []) as WatchlistRow[],
      source: "supabase",
    };
    return NextResponse.json(body);
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}

export async function POST(req: Request) {
  const auth = await getAdminContext();
  if (auth.status === "no-session")
    return NextResponse.json({ ok: false, error: "no-session" }, { status: 401 });
  if (auth.status !== "ok") return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  if (!auth.ctx.email) return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });

  let body: { symbol?: string; note?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }

  const symbol = String(body.symbol ?? "")
    .trim()
    .toUpperCase()
    .replace(/\.(JO|JSE)$/i, "");
  if (!symbol) return NextResponse.json({ ok: false, error: "symbol_required" }, { status: 400 });

  const note =
    typeof body.note === "string" && body.note.trim().length > 0 ? body.note.trim().slice(0, 280) : null;

  const db = tryOpen();
  if (!db) {
    return NextResponse.json(
      { ok: false, error: "supabase_not_configured", fallback: "localStorage" },
      { status: 503 },
    );
  }

  try {
    const { data, error } = await db
      .from("watchlist_c")
      .upsert(
        { user_email: auth.ctx.email, symbol, note },
        { onConflict: "user_email,symbol", ignoreDuplicates: false },
      )
      .select("id, symbol, note, created_at")
      .single();
    if (error) {
      if (isSupabaseSchemaMissing(error)) {
        return NextResponse.json(
          { ok: false, error: "table_not_migrated", fallback: "localStorage" },
          { status: 503 },
        );
      }
      return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    }
    return NextResponse.json({ ok: true, item: data as WatchlistRow });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}

export async function DELETE(req: Request) {
  const auth = await getAdminContext();
  if (auth.status === "no-session")
    return NextResponse.json({ ok: false, error: "no-session" }, { status: 401 });
  if (auth.status !== "ok") return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  if (!auth.ctx.email) return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });

  const url = new URL(req.url);
  const raw = url.searchParams.get("symbol") ?? "";
  const symbol = raw
    .trim()
    .toUpperCase()
    .replace(/\.(JO|JSE)$/i, "");
  if (!symbol) return NextResponse.json({ ok: false, error: "symbol_required" }, { status: 400 });

  const db = tryOpen();
  if (!db) {
    return NextResponse.json(
      { ok: false, error: "supabase_not_configured", fallback: "localStorage" },
      { status: 503 },
    );
  }

  try {
    const { error } = await db
      .from("watchlist_c")
      .delete()
      .ilike("user_email", auth.ctx.email)
      .eq("symbol", symbol);
    if (error) {
      if (isSupabaseSchemaMissing(error)) {
        return NextResponse.json(
          { ok: false, error: "table_not_migrated", fallback: "localStorage" },
          { status: 503 },
        );
      }
      return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    }
    return NextResponse.json({ ok: true, symbol });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
