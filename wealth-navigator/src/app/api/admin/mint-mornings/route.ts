import { NextResponse } from "next/server";

import { getAdminContext } from "@/lib/admin/rbac";
import { createRetailServiceRoleClient } from "@/lib/supabase/server";

/**
 * Mint Mornings digest status. Ports `/api/mint-mornings`.
 * READ ported: `status` (today's send + history from mint_mornings_log).
 * DEFERRED (email bucket): `preview` (renders the digest HTML) and the
 * send/test/force POSTs (dispatch via Resend) — return honest notices.
 */

export const dynamic = "force-dynamic";

const DEFER = "Digest preview/send is deferred (email rendering + Resend — backend phase).";

function sastDateStr(): string {
  const sast = new Date(Date.now() + 2 * 60 * 60 * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${sast.getUTCFullYear()}-${p(sast.getUTCMonth() + 1)}-${p(sast.getUTCDate())}`;
}

export async function GET(req: Request) {
  const auth = await getAdminContext();
  if (auth.status === "no-session") return NextResponse.json({ ok: false, error: "no-session" }, { status: 401 });
  if (auth.status === "not-member") return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });

  const action = new URL(req.url).searchParams.get("action") || "status";
  if (action === "preview") return NextResponse.json({ ok: true, html: null, notice: DEFER });
  if (action !== "status") return NextResponse.json({ ok: false, error: `Unknown action: ${action}` }, { status: 400 });

  let db;
  try {
    db = createRetailServiceRoleClient();
  } catch {
    return NextResponse.json({ ok: true, alreadySentToday: false, lastSend: null, recent: [], notice: "RETAIL database not configured." });
  }

  const { data, error } = await db
    .from("mint_mornings_log")
    .select("id, send_date, articles_sent, users_sent, created_at")
    .order("send_date", { ascending: false })
    .limit(30);
  if (error) return NextResponse.json({ ok: true, alreadySentToday: false, lastSend: null, recent: [], notice: "mint_mornings_log not available." });

  const rows = data ?? [];
  const today = sastDateStr();
  return NextResponse.json({
    ok: true,
    alreadySentToday: rows.some((r) => r.send_date === today),
    lastSend: rows[0] ?? null,
    recent: rows,
  });
}

export async function POST() {
  // send today / re-send (force) / test send — all dispatch email via Resend.
  return NextResponse.json({ ok: false, error: DEFER, deferred: true }, { status: 501 });
}
