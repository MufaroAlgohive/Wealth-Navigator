/**
 * POST /api/alerts/[id]/ack — mark one alert_log_c row as acknowledged.
 * Body: { by?: string } → recorded as `acknowledged_by`. The Cockpit banner
 * button calls this and clears the row from the unacked list. Idempotent
 * re-acks are no-ops.
 */

import {
  createInstitutionalServiceRoleClient,
  isInstitutionalSupabaseConfigured,
} from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!isInstitutionalSupabaseConfigured()) {
    return Response.json({ error: "Supabase not configured" }, { status: 503 });
  }
  const { id } = await params;
  if (!id || typeof id !== "string") {
    return Response.json({ error: "missing id" }, { status: 400 });
  }

  let by = "ui";
  try {
    const body = (await request.json()) as { by?: string };
    if (body && typeof body.by === "string" && body.by.trim()) by = body.by.trim().slice(0, 64);
  } catch {
    /* empty body is fine — defaults to "ui" */
  }

  const supabase = createInstitutionalServiceRoleClient();
  const now = new Date().toISOString();

  // Conditional update: only stamp when `acknowledged_at IS NULL` so a
  // double-click doesn't bump `acknowledged_by` mid-session.
  const { data, error } = await supabase
    .from("alert_log_c")
    .update({ acknowledged_at: now, acknowledged_by: by })
    .eq("id", id)
    .is("acknowledged_at", null)
    .select("id, acknowledged_at, acknowledged_by");
  if (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
  if (!data || data.length === 0) {
    // Either the row is already acked, or it doesn't exist. Look it up so the
    // caller can tell which.
    const { data: existing, error: lookupErr } = await supabase
      .from("alert_log_c")
      .select("id, acknowledged_at, acknowledged_by")
      .eq("id", id);
    if (lookupErr) {
      return Response.json({ error: lookupErr.message }, { status: 500 });
    }
    if (!existing || existing.length === 0) {
      return Response.json({ error: "alert not found" }, { status: 404 });
    }
    return Response.json({ alreadyAcked: true, row: existing[0] });
  }
  return Response.json({ ok: true, row: data[0] });
}