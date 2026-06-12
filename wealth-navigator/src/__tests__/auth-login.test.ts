import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";

import { POST } from "@/app/api/auth/login/route";
import { AUTH_COOKIE, COOKIE_MAX_AGE } from "@/middleware";

/**
 * Build a NextRequest with a JSON body that the route handler can parse.
 * The route only reads `req.json()` and the URL, so a minimal URL is
 * sufficient for the request side.
 */
function makeRequest(body: unknown): NextRequest {
  return new NextRequest("http://localhost:3000/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/auth/login", () => {
  it("authenticates the dev `admin` / `admin` credential and sets `mint-auth`", async () => {
    const res = await POST(makeRequest({ username: "admin", password: "admin" }));

    expect(res.status).toBe(200);

    const json = (await res.json()) as {
      ok: boolean;
      user?: { username: string };
    };
    expect(json.ok).toBe(true);
    expect(json.user?.username).toBe("admin");

    const auth = res.cookies.get(AUTH_COOKIE);
    expect(auth?.value).toBe("1");
    expect(auth?.httpOnly).toBe(true);
    expect(auth?.sameSite).toBe("lax");
    expect(auth?.path).toBe("/");
    expect(auth?.maxAge).toBe(COOKIE_MAX_AGE);
  });

  it("rejects the right username with a wrong password with a generic 401 (no leak)", async () => {
    const res = await POST(makeRequest({ username: "admin", password: "wrong" }));

    expect(res.status).toBe(401);

    const json = (await res.json()) as { ok: boolean; error?: string };
    expect(json.ok).toBe(false);
    expect(json.error).toBe("Invalid credentials.");

    expect(res.cookies.get(AUTH_COOKIE)).toBeUndefined();
  });

  it("rejects a wrong username with the right password with the same generic 401", async () => {
    const res = await POST(makeRequest({ username: "wrong", password: "admin" }));

    expect(res.status).toBe(401);

    const json = (await res.json()) as { ok: boolean; error?: string };
    expect(json.ok).toBe(false);
    expect(json.error).toBe("Invalid credentials.");

    expect(res.cookies.get(AUTH_COOKIE)).toBeUndefined();
  });

  it("returns 400 when the username is empty (after trim)", async () => {
    const res = await POST(makeRequest({ username: "   ", password: "admin" }));

    expect(res.status).toBe(400);

    const json = (await res.json()) as { ok: boolean; error?: string };
    expect(json.ok).toBe(false);
    expect(json.error).toMatch(/required/i);

    expect(res.cookies.get(AUTH_COOKIE)).toBeUndefined();
  });

  it("returns 400 when the password is empty", async () => {
    const res = await POST(makeRequest({ username: "admin", password: "" }));

    expect(res.status).toBe(400);

    const json = (await res.json()) as { ok: boolean; error?: string };
    expect(json.ok).toBe(false);
    expect(json.error).toMatch(/required/i);

    expect(res.cookies.get(AUTH_COOKIE)).toBeUndefined();
  });

  it("does NOT trim the password (leading/trailing spaces are rejected)", async () => {
    const res = await POST(makeRequest({ username: "admin", password: " admin " }));

    expect(res.status).toBe(401);
    const json = (await res.json()) as { ok: boolean; error?: string };
    expect(json.error).toBe("Invalid credentials.");
    expect(res.cookies.get(AUTH_COOKIE)).toBeUndefined();
  });

  it("DOES trim the username so a pasted username with surrounding whitespace still works", async () => {
    const res = await POST(makeRequest({ username: "  admin  ", password: "admin" }));

    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      ok: boolean;
      user?: { username: string };
    };
    expect(json.user?.username).toBe("admin");
    expect(res.cookies.get(AUTH_COOKIE)?.value).toBe("1");
  });

  it("treats the username as case-sensitive (lowercase `admin` variant is rejected)", async () => {
    const res = await POST(makeRequest({ username: "Admin", password: "admin" }));

    expect(res.status).toBe(401);
    const json = (await res.json()) as { ok: boolean; error?: string };
    expect(json.error).toBe("Invalid credentials.");
    expect(res.cookies.get(AUTH_COOKIE)).toBeUndefined();
  });
});
