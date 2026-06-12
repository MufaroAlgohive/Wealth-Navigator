import { provenanceSummary } from "@/lib/iress/provenance";
import { getSessionStatus } from "@/lib/iress/session-manager";
import { iressConfig } from "@/lib/iress";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Provenance counts + session snapshot for the dev strip. */
export async function GET() {
  const summary = provenanceSummary();
  const session = getSessionStatus();

  return Response.json({
    ...summary,
    session: {
      ok: session.valid || iressConfig.mode === "mock",
      mode: iressConfig.mode,
      started: session.valid,
      services: session.services,
    },
  });
}
