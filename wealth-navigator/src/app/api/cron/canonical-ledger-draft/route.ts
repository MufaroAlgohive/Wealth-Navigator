import { NextResponse } from "next/server";

import { getAdminContext, isAdminRole } from "@/lib/admin/rbac";
import { publishCanonicalLedgerDraft } from "@/lib/returns/publish-canonical-ledger-draft";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  const bearer = req.headers.get("authorization")?.replace("Bearer ", "");
  const viaCron = Boolean(secret) && bearer === secret;
  let viaAdmin = false;
  if (!viaCron) {
    const auth = await getAdminContext();
    viaAdmin = auth.status === "ok" && isAdminRole(auth.ctx);
  }
  if (!viaCron && !viaAdmin) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const url = new URL(req.url);
  const asOfDate = url.searchParams.get("asOf") ?? undefined;
  const apply =
    process.env.CANONICAL_LEDGER_DRAFT_APPLY === "1" || (viaAdmin && url.searchParams.get("apply") === "1");
  const result = await publishCanonicalLedgerDraft({ asOfDate, apply });
  return NextResponse.json(result, { status: result.ok ? 200 : 502 });
}
