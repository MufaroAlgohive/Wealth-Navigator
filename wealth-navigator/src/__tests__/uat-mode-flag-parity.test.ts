import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { isUatEnv, uatModeEnabled } from "@/lib/oems/uat-scope";

/**
 * Regression guard for the IRESS_UAT_MODE grammar mismatch (found 2026-07-27).
 *
 * The Railway worker parses the flag with `parseBool`, which accepts "1" OR
 * "true", and its 403 response literally instructs the operator to
 * "set IRESS_UAT_MODE=1". Six Vercel routes meanwhile tested
 * `process.env.IRESS_UAT_MODE === "true"`.
 *
 * Consequence of setting "1" on both platforms — exactly what the worker tells
 * you to do: the worker enables UAT, every Vercel route silently falls back to
 * audit-only, and an order is accepted in the UI, written to the audit table,
 * and NEVER sent to a market. No error surfaces anywhere. On a trading day that
 * is a whole session lost to a phantom fill state.
 *
 * Both halves are asserted:
 *   1. the helper accepts the same grammar as the worker
 *   2. no route reads the raw env var again
 */

const original = process.env.IRESS_UAT_MODE;
const originalBase = process.env.IRESS_BASE_URL;

afterEach(() => {
  if (original === undefined) delete process.env.IRESS_UAT_MODE;
  else process.env.IRESS_UAT_MODE = original;
  if (originalBase === undefined) delete process.env.IRESS_BASE_URL;
  else process.env.IRESS_BASE_URL = originalBase;
});

describe("uatModeEnabled — grammar parity with the Railway worker", () => {
  // Exactly what workers/iress-ingest/src/env.ts::parseBool accepts.
  it.each(["1", "true", "TRUE", "True", " true "])("accepts %o", (value) => {
    process.env.IRESS_UAT_MODE = value;
    expect(uatModeEnabled()).toBe(true);
  });

  it.each(["0", "false", "", "yes", "on"])("rejects %o", (value) => {
    process.env.IRESS_UAT_MODE = value;
    expect(uatModeEnabled()).toBe(false);
  });

  it("is false when unset — production is the default posture", () => {
    delete process.env.IRESS_UAT_MODE;
    expect(uatModeEnabled()).toBe(false);
  });

  it('isUatEnv() honours "1", not just "true"', () => {
    delete process.env.IRESS_BASE_URL;
    process.env.IRESS_UAT_MODE = "1";
    expect(isUatEnv()).toBe(true);
  });

  it("isUatEnv() stays false on a production endpoint with the flag off", () => {
    delete process.env.IRESS_UAT_MODE;
    process.env.IRESS_BASE_URL = "https://webservices.iress.co.za/v4";
    expect(isUatEnv()).toBe(false);
  });

  it("isUatEnv() detects the CT host even with the flag off", () => {
    delete process.env.IRESS_UAT_MODE;
    process.env.IRESS_BASE_URL = "https://webservices-ct.iress.co.za/v4";
    expect(isUatEnv()).toBe(true);
  });
});

describe("no route re-introduces a raw IRESS_UAT_MODE comparison", () => {
  // These are the six that had it. Reading the env var directly in a route is
  // what allowed the two platforms to disagree; go through uatModeEnabled().
  const routes = [
    "src/app/api/admin/orderbook/send-to-market/route.ts",
    "src/app/api/admin/orderbook/stream/route.ts",
    "src/app/api/admin/orderbook/test-seed-holding/route.ts",
    "src/app/api/admin/orderbook/uat-order/route.ts",
    "src/app/api/admin/orderbook/uat-status/route.ts",
    "src/lib/oems/uat-scope.ts",
  ];

  it.each(routes)("%s reads the flag only through the helper", (rel) => {
    const source = readFileSync(join(process.cwd(), rel), "utf8");
    // Strip comments first: the explanatory notes legitimately quote the old
    // expression, and matching those would make this test unfixable.
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    const rawReads = code.match(/process\.env\.IRESS_UAT_MODE/g) ?? [];
    // uat-scope.ts is the ONE place allowed to touch the raw variable.
    const allowed = rel.endsWith("uat-scope.ts") ? 1 : 0;
    expect(rawReads.length).toBe(allowed);
  });
});
