import { NextResponse } from "next/server";

import { getAdminContext } from "@/lib/admin/rbac";
import { createRetailServiceRoleClient } from "@/lib/supabase/server";

/**
 * Email send-log reader. Ports the legacy `/api/email-logs` (read-only) over
 * `email_logs` (RETAIL DB). type filter + limit (default 50, max 200).
 */

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const auth = await getAdminContext();
  if (auth.status === "no-session") return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (auth.status === "not-member") return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const url = new URL(req.url);
  const type = url.searchParams.get("type");
  const limit = Math.min(parseInt(url.searchParams.get("limit") || "50", 10) || 50, 200);

  let db;
  try {
    db = createRetailServiceRoleClient();
  } catch {
    return NextResponse.json({ error: "RETAIL database not configured" });
  }

  let query = db
    .from("email_logs")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (type) query = query.eq("email_type", type);

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message });
  return NextResponse.json(data ?? []);
}
