import { getIressCredentialsFromEnv, iressConfig } from "@/lib/iress";
import { getMintSession, getSessionStatus } from "@/lib/iress/session-manager";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * IRESS WS session health check — server-side only.
 *
 * Protected by middleware (Supabase session). Never returns passwords.
 * App login (`/api/auth/login`) is separate from IRESS SOAP session auth.
 */
export async function GET() {
  const mode = iressConfig.mode;

  if (mode === "mock") {
    return Response.json({ ok: true, mode: "mock", sessionStarted: false });
  }

  const creds = getIressCredentialsFromEnv();
  if (!creds.userName || !creds.password) {
    return Response.json(
      {
        ok: false,
        mode,
        error: "IRESS credentials not configured (IRESS_USERNAME / IRESS_PASSWORD)",
      },
      { status: 500 },
    );
  }

  const existing = getSessionStatus();
  if (existing.valid) {
    return Response.json({
      ok: true,
      mode,
      sessionStarted: true,
      cached: true,
      expiresAt: existing.expiresAt,
      services: existing.services,
    });
  }

  try {
    await getMintSession();
    const status = getSessionStatus();
    return Response.json({
      ok: true,
      mode,
      sessionStarted: true,
      cached: false,
      expiresAt: status.expiresAt,
      services: status.services,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to start IRESS session";
    return Response.json({ ok: false, mode, error: message }, { status: 500 });
  }
}
