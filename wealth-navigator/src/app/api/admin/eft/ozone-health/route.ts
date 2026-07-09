import { NextResponse } from "next/server";

import { getOzoneProvider } from "@/lib/payments/ozone";

/**
 * GET /api/admin/eft/ozone-health
 *
 * Tiny probe used by the Banking › Wallet Top-ups page to surface the
 * configured provider mode (`mock` | `live` | `unconfigured`) and a
 * human-readable message. Allows the page to flip its `data-source`
 * badge between `SUPABASE`, `MOCK`, or `CODE-GAP` without exposing the
 * live-mode transport surface to the browser.
 *
 * No gating — the route returns the same one-line payload to anyone
 * that hits it; it's not sensitive.
 */

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const provider = getOzoneProvider();
    const health = await provider.health();
    const h = health as {
      status: "ok" | "degraded" | "unconfigured";
      mode: "mock" | "live" | "unconfigured";
      message?: string;
    };
    const modeForUi =
      h.mode === "live" && h.status === "ok" ? "live" : h.mode === "mock" ? "mock" : "unconfigured";
    return NextResponse.json({
      ok: true,
      mode: modeForUi,
      status: h.status,
      message: h.message ?? null,
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, mode: "unconfigured", error: err instanceof Error ? err.message : String(err) },
      { status: 200 },
    );
  }
}
