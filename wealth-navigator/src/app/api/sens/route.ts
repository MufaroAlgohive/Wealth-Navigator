/**
 * GET /api/sens?sym=NPN
 *
 * JSE SENS (Securities Exchange News Service) announcements — official
 * regulatory tape from JSE. IRESS V4 does not expose a SENS feed on our
 * entitlement; the real alternative is the JSE SENS Web Feed (paid
 * subscription). Until that vendor lands we return an honest empty list with
 * a `reason: "vendor_not_contracted"` so the UI can render the empty state.
 *
 * Same response shape as the news BFF: `{ items, count, source, reason }`.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const sym = (url.searchParams.get("sym") ?? "").toUpperCase();
  return Response.json({
    items: [],
    count: 0,
    source: "unavailable",
    reason: "vendor_not_contracted",
    migration: "JSE SENS Web Feed subscription",
    message: sym
      ? `No SENS announcements for ${sym} — the JSE SENS Web Feed is a paid subscription, not on the IRESS V4 entitlement. Wire the vendor feed into sens_announcement_c.`
      : "SENS requires the JSE SENS Web Feed subscription. Wire the vendor feed into sens_announcement_c.",
  });
}
