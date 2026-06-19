import { NextResponse } from "next/server";

import { getAdminContext } from "@/lib/admin/rbac";

/**
 * Current admin context (role / page_access / permissions). Ports the legacy
 * `GET /api/team?action=me` used by `access-guard.js`.
 */
export async function GET() {
  const res = await getAdminContext();

  if (res.status === "ok") {
    return NextResponse.json({ ok: true, ...res.ctx });
  }
  if (res.status === "no-session") {
    return NextResponse.json({ ok: false, error: "no-session" }, { status: 401 });
  }
  if (res.status === "not-member") {
    return NextResponse.json(
      { ok: false, error: "not-a-member", email: res.email },
      { status: 403 },
    );
  }
  return NextResponse.json({ ok: false, error: "unconfigured", reason: res.reason }, { status: 503 });
}
