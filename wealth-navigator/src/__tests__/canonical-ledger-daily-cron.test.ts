import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * GET /api/cron/canonical-ledger-daily — the nightly (17:30 UTC weekdays)
 * automatic draft -> certification run for every active strategy. Gated on
 * CRON_SECRET bearer auth, not admin session auth.
 *
 * This is the production twin of the admin recompute route's regression:
 * a single strategy's draft failure (e.g. a missing stored close) must not
 * gate certification for every OTHER healthy strategy every single night.
 * Before the fix, `if (!draft.ok) return early` meant ANY one bad ticker on
 * ANY given day silently withheld certified/corrected YTD figures for the
 * WHOLE platform until the next successful cron run.
 */

const CRON_SECRET = "test-cron-secret";

let draftCalls: Array<Record<string, unknown>> = [];
let certificationCalls: Array<Record<string, unknown>> = [];
let draftResult: Record<string, unknown> = {
  ok: true,
  asOf: "2026-08-21",
  apply: true,
  summary: { written: 1, planned: 0, skipped: 0, failed: 0, total: 1 },
  results: [{ strategy: "Growth", action: "written", asOf: "2026-08-21" }],
};
let certificationResult: Record<string, unknown> = {
  ok: true,
  asOf: "2026-08-21",
  summary: { certified: 1, alreadyCertified: 0, failed: 0, total: 1 },
  results: [{ strategy: "Growth", action: "certified", asOf: "2026-08-21" }],
};

vi.mock("@/lib/returns/publish-canonical-ledger-draft", () => ({
  publishCanonicalLedgerDraft: async (opts: Record<string, unknown>) => {
    draftCalls.push(opts);
    return draftResult;
  },
}));

vi.mock("@/lib/returns/publish-canonical-ledger-certification", () => ({
  publishCanonicalLedgerCertification: async (opts: Record<string, unknown>) => {
    certificationCalls.push(opts);
    return certificationResult;
  },
  AUTOMATIC_CERTIFICATION_ACTOR: "SYSTEM:WEALTH_NAVIGATOR_DAILY_V1",
}));

const get = async (asOf?: string) => {
  const { GET } = await import("@/app/api/cron/canonical-ledger-daily/route");
  const url = asOf
    ? `http://x/api/cron/canonical-ledger-daily?asOf=${asOf}`
    : "http://x/api/cron/canonical-ledger-daily";
  return GET(new Request(url, { headers: { authorization: `Bearer ${CRON_SECRET}` } }));
};

beforeEach(() => {
  vi.resetModules();
  process.env.CRON_SECRET = CRON_SECRET;
  draftCalls = [];
  certificationCalls = [];
  draftResult = {
    ok: true,
    asOf: "2026-08-21",
    apply: true,
    summary: { written: 1, planned: 0, skipped: 0, failed: 0, total: 1 },
    results: [{ strategy: "Growth", action: "written", asOf: "2026-08-21" }],
  };
  certificationResult = {
    ok: true,
    asOf: "2026-08-21",
    summary: { certified: 1, alreadyCertified: 0, failed: 0, total: 1 },
    results: [{ strategy: "Growth", action: "certified", asOf: "2026-08-21" }],
  };
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("GET /api/cron/canonical-ledger-daily", () => {
  it("401s without the correct bearer secret", async () => {
    const { GET } = await import("@/app/api/cron/canonical-ledger-daily/route");
    const res = await GET(new Request("http://x/api/cron/canonical-ledger-daily"));
    expect(res.status).toBe(401);
    expect(draftCalls).toHaveLength(0);
  });

  it("runs draft then certification and returns 200 when everything succeeds", async () => {
    const res = await get("2026-08-21");
    const body = (await res.json()) as { ok: boolean; phase: string; asOf: string };
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.phase).toBe("complete");
    expect(draftCalls).toHaveLength(1);
    expect(certificationCalls).toHaveLength(1);
  });

  it("REGRESSION: one strategy's draft failure no longer blocks certification for its healthy siblings", async () => {
    draftResult = {
      ok: false,
      asOf: "2026-08-21",
      apply: true,
      summary: { written: 1, planned: 0, skipped: 0, failed: 1, total: 2 },
      results: [
        { strategy: "Growth", action: "written", asOf: "2026-08-21" },
        { strategy: "Blended Focus", action: "failed", reason: "EXACT_CLOSE_MISSING:CLS" },
      ],
    };
    certificationResult = {
      ok: false,
      asOf: "2026-08-21",
      summary: { certified: 1, alreadyCertified: 0, failed: 1, total: 2 },
      results: [
        { strategy: "Growth", action: "certified", asOf: "2026-08-21" },
        { strategy: "Blended Focus", action: "failed", reason: "DRAFT_MISSING", asOf: "2026-08-21" },
      ],
    };

    const res = await get("2026-08-21");
    const body = (await res.json()) as {
      ok: boolean;
      phase: string;
      draft: { results: Array<{ strategy: string; action: string; reason?: string }> };
      certification: { results: Array<{ strategy: string; action: string; reason?: string }> };
    };

    // Certification must still have been attempted — the draft failure must
    // not gate the certification call.
    expect(certificationCalls).toHaveLength(1);

    // 200, not 502 — one isolated data gap on a given night must not read as
    // a full cron failure when other strategies fully certified.
    expect(res.status).toBe(200);
    expect(body.ok).toBe(false); // honest: not everything succeeded
    expect(body.phase).toBe("partial");

    expect(body.draft.results).toContainEqual({ strategy: "Growth", action: "written", asOf: "2026-08-21" });
    expect(body.certification.results).toContainEqual({
      strategy: "Growth",
      action: "certified",
      asOf: "2026-08-21",
    });
    expect(body.draft.results).toContainEqual({
      strategy: "Blended Focus",
      action: "failed",
      reason: "EXACT_CLOSE_MISSING:CLS",
    });
    expect(body.certification.results).toContainEqual({
      strategy: "Blended Focus",
      action: "failed",
      reason: "DRAFT_MISSING",
      asOf: "2026-08-21",
    });
  });

  it("returns 502 when nothing certifies at all (total failure)", async () => {
    draftResult = {
      ok: false,
      asOf: "2026-08-21",
      apply: true,
      summary: { written: 0, planned: 0, skipped: 0, failed: 1, total: 1 },
      results: [{ strategy: "Growth", action: "failed", reason: "EXACT_CLOSE_MISSING:CLS" }],
    };
    certificationResult = {
      ok: false,
      asOf: "2026-08-21",
      summary: { certified: 0, alreadyCertified: 0, failed: 1, total: 1 },
      results: [{ strategy: "Growth", action: "failed", reason: "DRAFT_MISSING", asOf: "2026-08-21" }],
    };
    const res = await get("2026-08-21");
    const body = (await res.json()) as { ok: boolean; phase: string };
    expect(res.status).toBe(502);
    expect(body.ok).toBe(false);
    expect(body.phase).toBe("certification");
    expect(certificationCalls).toHaveLength(1);
  });
});
