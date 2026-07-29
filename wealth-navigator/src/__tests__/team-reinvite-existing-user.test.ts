import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

describe("OEM team re-invite flow", () => {
  const teamRoute = readFileSync(resolve("src/app/api/admin/team/route.ts"), "utf8");
  const confirmRoute = readFileSync(resolve("src/app/auth/confirm/route.ts"), "utf8");
  const teamPage = readFileSync(resolve("src/app/admin/team/page.tsx"), "utf8");

  it("uses recovery links for existing auth accounts and invite links for new accounts", () => {
    expect(teamRoute).toContain('const linkType = existingUser ? "recovery" : "invite"');
    expect(teamRoute).toContain("db.auth.admin.listUsers");
    expect(teamRoute).toContain("properties.hashed_token");
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
