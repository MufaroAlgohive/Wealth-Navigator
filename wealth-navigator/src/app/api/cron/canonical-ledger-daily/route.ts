import { NextResponse } from "next/server";

import { publishCanonicalLedgerCertification } from "@/lib/returns/publish-canonical-ledger-certification";
import { publishCanonicalLedgerDraft } from "@/lib/returns/publish-canonical-ledger-draft";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

function sastDate(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Johannesburg",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${byType.year}-${byType.month}-${byType.day}`;
}

/** Exact-close DRAFT first; independently checked atomic certification second. */
export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  const bearer = req.headers.get("authorization")?.replace("Bearer ", "");
  if (!secret || bearer !== secret)
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });

  const url = new URL(req.url);
  const asOfDate = url.searchParams.get("asOf") ?? sastDate();
  const draft = await publishCanonicalLedgerDraft({ asOfDate, apply: true, replaceExistingDraft: true });
  if (!draft.ok)
    return NextResponse.json(
      { ok: false, asOf: asOfDate, phase: "draft", draft, certification: null },
      { status: 502 },
    );

  const certification = await publishCanonicalLedgerCertification({ asOfDate });
  return NextResponse.json(
    {
      ok: certification.ok,
      asOf: asOfDate,
      phase: certification.ok ? "complete" : "certification",
      draft,
      certification,
    },
    { status: certification.ok ? 200 : 502 },
  );
}
