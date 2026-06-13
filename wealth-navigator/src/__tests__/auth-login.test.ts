// @vitest-environment node
// Force the node env for this file. jsdom's `Request` / `Headers` globals
// are a different class from the one Next.js bundles (undici), so
// `NextResponse.next({ request })` rejects them with
// "request.headers must be an instance of Headers". Node's native fetch
// globals match what `next/server` expects, so the route handler's
// middleware-field check passes. The functional code under test is
// env-agnostic — only the `instanceof Headers` plumbing cares.
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const signInWithPassword = vi.fn();

const isSupabaseAuthConfiguredMock = vi.fn(() => true);

vi.mock("@/lib/supabase/config", () => ({
  isSupabaseAuthConfigured: () => isSupabaseAuthConfiguredMock(),
  getSupabaseUrl: () => "https://example.supabase.co",
  getSupabaseAnonKey: () => "test-anon-key",
}));

vi.mock("@supabase/ssr", () => ({
  createServerClient: vi.fn(() => ({
    auth: { signInWithPassword },
  })),
}));

import { mapLoginAuthError, POST } from "@/app/api/auth/login/route";

function makeRequest(body: unknown): NextRequest {
  // NextResponse.next({ request }) inside the route handler validates that
  // `request.headers` is a real `Headers` instance. The JSdom test
  // environment's `Request` global behaves correctly with a `Headers`
  // object, so construct a real `Request` first and then wrap it in
  // `NextRequest` — the wrap preserves the underlying `Headers` instead
  // of flattening them to a plain object.
  const req = new Request("http://localhost:3000/api/auth/login", {
    method: "POST",
    headers: new Headers({ "content-type": "application/json" }),
    body: JSON.stringify(body),
  });
  return new NextRequest(req);
}

describe("mapLoginAuthError", () => {
  it("rejects username-style logins without @", () => {
    const mapped = mapLoginAuthError("admin");
    expect(mapped.status).toBe(400);
    expect(mapped.error).toMatch(/full email/i);
  });

  it("maps email not confirmed", () => {
    const mapped = mapLoginAuthError("user@mint.co.za", "Email not confirmed");
    expect(mapped.status).toBe(401);
    expect(mapped.error).toMatch(/not confirmed/i);
  });

  it("maps invalid credentials", () => {
    const mapped = mapLoginAuthError("user@mint.co.za", "Invalid login credentials");
    expect(mapped.status).toBe(401);
    expect(mapped.error).toMatch(/incorrect email or password/i);
  });
});

describe("POST /api/auth/login", () => {
  beforeEach(() => {
    isSupabaseAuthConfiguredMock.mockReturnValue(true);
    signInWithPassword.mockReset();
  });

  it("authenticates with Supabase and returns the user email", async () => {
    signInWithPassword.mockResolvedValue({
      data: { user: { email: "trader@mint.co.za" } },
      error: null,
    });

    const res = await POST(makeRequest({ email: "trader@mint.co.za", password: "secret" }));

    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; user?: { email: string } };
    expect(json.ok).toBe(true);
    expect(json.user?.email).toBe("trader@mint.co.za");
    expect(signInWithPassword).toHaveBeenCalledWith({
      email: "trader@mint.co.za",
      password: "secret",
    });
  });

  it("returns 401 with a helpful message when Supabase rejects credentials", async () => {
    signInWithPassword.mockResolvedValue({
      data: { user: null },
      error: { message: "Invalid login credentials" },
    });

    const res = await POST(makeRequest({ email: "trader@mint.co.za", password: "wrong" }));

    expect(res.status).toBe(401);
    const json = (await res.json()) as { ok: boolean; error?: string };
    expect(json.ok).toBe(false);
    expect(json.error).toMatch(/incorrect email or password/i);
  });

  it("returns 400 when email looks like a username", async () => {
    const res = await POST(makeRequest({ email: "admin", password: "secret" }));

    expect(res.status).toBe(400);
    const json = (await res.json()) as { ok: boolean; error?: string };
    expect(json.error).toMatch(/full email/i);
    expect(signInWithPassword).not.toHaveBeenCalled();
  });

  it("returns 400 when email is empty after trim", async () => {
    const res = await POST(makeRequest({ email: "   ", password: "secret" }));

    expect(res.status).toBe(400);
    const json = (await res.json()) as { ok: boolean; error?: string };
    expect(json.error).toMatch(/required/i);
    expect(signInWithPassword).not.toHaveBeenCalled();
  });

  it("returns 400 when password is empty", async () => {
    const res = await POST(makeRequest({ email: "trader@mint.co.za", password: "" }));

    expect(res.status).toBe(400);
    expect(signInWithPassword).not.toHaveBeenCalled();
  });

  it("normalises email to lowercase", async () => {
    signInWithPassword.mockResolvedValue({
      data: { user: { email: "trader@mint.co.za" } },
      error: null,
    });

    await POST(makeRequest({ email: "  Trader@Mint.Co.Za  ", password: "secret" }));

    expect(signInWithPassword).toHaveBeenCalledWith({
      email: "trader@mint.co.za",
      password: "secret",
    });
  });

  it("returns 503 when Supabase auth env is not configured", async () => {
    isSupabaseAuthConfiguredMock.mockReturnValue(false);

    const res = await POST(makeRequest({ email: "a@b.com", password: "x" }));

    expect(res.status).toBe(503);
    expect(signInWithPassword).not.toHaveBeenCalled();
  });
});
