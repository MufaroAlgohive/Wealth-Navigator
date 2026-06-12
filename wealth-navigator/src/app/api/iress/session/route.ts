import {
  getSessionStatus,
  getMintSession,
  tearDownMintSession,
  LICENSE_RELEASE_DELAY_MS,
} from "@/lib/iress/session-manager";
import { getIressCredentialsFromEnv, iressConfig } from "@/lib/iress";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * IRESS session status — never returns passwords or session keys.
 */
export async function GET() {
  const mode = iressConfig.mode;
  const creds = getIressCredentialsFromEnv();

  if (mode === "mock") {
    return Response.json({
      ok: true,
      mode: "mock",
      sessionStarted: false,
      message: "Mock mode — no SOAP session",
    });
  }

  if (!creds.userName || !creds.password) {
    return Response.json(
      {
        ok: false,
        mode,
        sessionStarted: false,
        error: "IRESS credentials not configured",
      },
      { status: 500 },
    );
  }

  const status = getSessionStatus();
  if (status.valid) {
    return Response.json({
      ok: true,
      mode,
      sessionStarted: true,
      startedAt: status.startedAt,
      expiresAt: status.expiresAt,
      services: status.services,
    });
  }

  try {
    await getMintSession();
    const refreshed = getSessionStatus();
    return Response.json({
      ok: true,
      mode,
      sessionStarted: true,
      startedAt: refreshed.startedAt,
      expiresAt: refreshed.expiresAt,
      services: refreshed.services,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to start IRESS session";
    return Response.json(
      { ok: false, mode, sessionStarted: false, error: message },
      { status: 500 },
    );
  }
}

/**
 * End the cached IRESS session (testing / license release).
 * Optional `?wait=1` waits for CT license release delay after SessionEnd.
 */
export async function DELETE(request: Request) {
  const mode = iressConfig.mode;
  if (mode === "mock") {
    return Response.json({ ok: true, mode, sessionEnded: false, message: "Mock mode — no session" });
  }

  const wait = new URL(request.url).searchParams.get("wait") === "1";
  const sessionEnded = await tearDownMintSession({
    releaseDelayMs: wait ? LICENSE_RELEASE_DELAY_MS : 0,
  });

  return Response.json({
    ok: true,
    mode,
    sessionEnded,
    licenseReleaseWaitMs: wait ? LICENSE_RELEASE_DELAY_MS : 0,
  });
}
