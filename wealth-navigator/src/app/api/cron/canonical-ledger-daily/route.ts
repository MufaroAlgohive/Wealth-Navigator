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

  // IMPORTANT: do NOT early-return when draft.ok is false. publishCanonicalLedgerDraft
  // writes real per-strategy DRAFT rows independently — one strategy hitting a
  // data gap (e.g. a missing stored close) must not block certification, and
  // therefore corrected YTD, for every OTHER healthy strategy on a given
  // night. Certification is itself per-strategy and will naturally only
  // fail the strategies that have no valid draft row for today. See the
  // matching comment on the admin recompute route for the full reasoning.
  const draft = await publishCanonicalLedgerDraft({ asOfDate, apply: true, replaceExistingDraft: true });

  const certification = await publishCanonicalLedgerCertification({ asOfDate });

  const certifiedCount = certification.summary.certified + certification.summary.alreadyCertified;
  const anyCertified = certifiedCount > 0;
  const allOk = draft.ok && certification.ok;
  const phase = allOk ? "complete" : anyCertified ? "partial" : "certification";
  const status = allOk || anyCertified ? 200 : 502;

  return NextResponse.json(
    {
      ok: allOk,
      asOf: asOfDate,
      phase,
      draft,
      certification,
    },
    { status },
  );
}
