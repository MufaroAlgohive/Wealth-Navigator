import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

describe("OEM team re-invite flow", () => {
  const teamRoute = readFileSync(resolve("src/app/api/admin/team/route.ts"), "utf8");
  const confirmRoute = readFileSync(resolve("src/app/auth/confirm/route.ts"), "utf8");
  const teamPage = readFileSync(resolve("src/app/admin/team/page.tsx"), "utf8");

  it("uses recovery links for existing auth accounts and invite links for new accounts", () => {
    expect(teamRoute).toContain('const linkType = existingUser ? "recovery" : "invite"');
    expect(teamRoute).toContain("authDb.auth.admin.listUsers");
    expect(teamRoute).toContain("properties.hashed_token");
  });

  // REGRESSION GUARD (2026-08-04): staff invites were generated with the RETAIL
  // service client while sessions are issued by the NEXT_PUBLIC_SUPABASE_URL
  // project, so invited staff were created in a project the app never
  // authenticates against — they appeared fully set up but could never sign in.
  // Every auth.admin.* call in this route must go through the session-project
  // client (`authDb` from createAuthAdminClient), never the RETAIL `db`.
  it("runs staff auth-admin calls against the session project, not RETAIL", () => {
    expect(teamRoute).toContain("createAuthAdminClient");
    const authAdminCalls = teamRoute.match(/(\w+)\.auth\.admin\./g) ?? [];
    expect(authAdminCalls.length).toBeGreaterThan(0);
    for (const call of authAdminCalls) {
      expect(call).toBe("authDb.auth.admin.");
    }
  });

  it("relinks and activates an existing account when it is re-added or resent", () => {
    expect(teamRoute).toContain('update({ user_id: invite.userId, status: "active" })');
    expect(teamRoute).toContain('source: existingUser ? "team-reinvite" : "team-invite"');
  });

  it("shows an access-email action for active as well as pending members", () => {
    expect(teamPage).toContain('"/api/admin/team?action=resend"');
    expect(teamPage).toContain('"Send Access Email"');
    expect(teamPage).not.toContain('m.status === "pending" &&');
  });

  it("verifies token hashes server-side so no browser PKCE session is required", () => {
    expect(confirmRoute).toContain("supabase.auth.verifyOtp");
    expect(confirmRoute).toContain('type === "recovery" ? "/reset-password" : "/signup"');
    expect(confirmRoute).toContain("/login?error=auth_link_expired");
  });
});
