import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * POST /api/admin/canonical-ledger/recompute — on-demand admin trigger for
 * the same draft -> certification sequence the canonical-ledger-daily cron
 * runs automatically. Gated on Dev-or-Master approver tier
 * (requireElevatedTier), NOT the cron's CRON_SECRET bearer auth and NOT the
 * granular can() permission check — see the doc comment on the route for
 * the reasoning.
 */

let getAdminContextResult: { status: string; ctx?: Record<string, unknown> } = {
  status: "ok",
  ctx: { email: "master@mint.test", permissions: {}, approverTier: "master" },
};

vi.mock("@/lib/admin/rbac", () => ({
  getAdminContext: async () => getAdminContextResult,
  can: () => true,
}));

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

// Query builders that stay chainable no matter how many .eq()/.neq() calls
// the route makes (order/count varies with whether strategyName is passed),
// resolving only when awaited — matching real Supabase's thenable builder.
function makeYtdRetailClient() {
  const strategiesBuilder: Record<string, unknown> = {
    eq: () => strategiesBuilder,
    neq: () => strategiesBuilder,
    then: (resolve: (v: { data: unknown; error: null }) => void) =>
      resolve({ data: [{ id: "strat-1", name: "Growth" }], error: null }),
  };
  const ledgerBuilder: Record<string, unknown> = {
    eq: () => ledgerBuilder,
    in: () =>
      Promise.resolve({
        data: [{ strategy_id: "strat-1", period_metrics: { YTD: { return_pct: 4.2 } } }],
        error: null,
      }),
  };
  return {
    from: (table: string) => {
      if (table === "strategies_c") return { select: () => strategiesBuilder };
      // strategy_canonical_daily_ledger_c
      return { select: () => ledgerBuilder };
    },
  };
}

vi.mock("@/lib/supabase/server", () => ({
  createRetailServiceRoleClient: () => makeYtdRetailClient(),
  isRetailSupabaseConfigured: () => true,
}));

const post = async (bodyObj: Record<string, unknown>) => {
  const { POST } = await import("@/app/api/admin/canonical-ledger/recompute/route");
  return POST(new Request("http://x/recompute", { method: "POST", body: JSON.stringify(bodyObj) }));
};

beforeEach(() => {
  vi.resetModules();
  draftCalls = [];
  certificationCalls = [];
  getAdminContextResult = { status: "ok", ctx: { email: "master@mint.test", permissions: {}, approverTier: "master" } };
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

describe("POST /api/admin/canonical-ledger/recompute", () => {
  it("401s with no session", async () => {
    getAdminContextResult = { status: "no-session" };
    const res = await post({});
    expect(res.status).toBe(401);
    expect(draftCalls).toHaveLength(0);
  });

  it("403s for a non-elevated admin (e.g. plain staff/admin tier, no dev/master)", async () => {
    getAdminContextResult = {
      status: "ok",
      ctx: { email: "staff@mint.test", permissions: {}, approverTier: null },
    };
    const res = await post({});
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(res.status).toBe(403);
    expect(body.ok).toBe(false);
    expect(draftCalls).toHaveLength(0);
    expect(certificationCalls).toHaveLength(0);
  });

  it("runs draft then certification for a master session, attributed to the admin (not the automatic system actor)", async () => {
    const res = await post({ asOfDate: "2026-08-21" });
    const body = (await res.json()) as {
      ok: boolean;
      asOf: string;
      triggeredBy: string;
      certificationActor: string;
      ytd: Array<{ strategy: string; ytdReturnPctAfter: number | null }>;
    };

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.triggeredBy).toBe("master@mint.test");
    expect(body.certificationActor).toBe("MANUAL:master@mint.test");
    expect(body.certificationActor).not.toBe("SYSTEM:WEALTH_NAVIGATOR_DAILY_V1");

    expect(draftCalls).toHaveLength(1);
    expect(draftCalls[0]).toMatchObject({ asOfDate: "2026-08-21", apply: true, replaceExistingDraft: true });

    expect(certificationCalls).toHaveLength(1);
    expect(certificationCalls[0]).toMatchObject({
      asOfDate: "2026-08-21",
      certificationActor: "MANUAL:master@mint.test",
    });

    expect(body.ytd).toEqual([{ strategy: "Growth", ytdReturnPctBefore: 4.2, ytdReturnPctAfter: 4.2 }]);
  });

  it("runs draft then certification for a dev-tier session (previously would have been rejected, Master-only)", async () => {
    getAdminContextResult = {
      status: "ok",
      ctx: { email: "dev@mint.test", permissions: {}, approverTier: "dev" },
    };
    const res = await post({ asOfDate: "2026-08-21" });
    const body = (await res.json()) as { ok: boolean; triggeredBy: string; certificationActor: string };

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.triggeredBy).toBe("dev@mint.test");
    expect(body.certificationActor).toBe("MANUAL:dev@mint.test");

    expect(draftCalls).toHaveLength(1);
    expect(certificationCalls).toHaveLength(1);
  });

  it("passes strategyName through to both draft and certification when provided", async () => {
    await post({ asOfDate: "2026-08-21", strategyName: "Income" });
    expect(draftCalls[0]).toMatchObject({ strategyName: "Income" });
    expect(certificationCalls[0]).toMatchObject({ strategyName: "Income" });
  });

  it("returns 502 when nothing certifies at all (total failure, e.g. infra outage)", async () => {
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
    const res = await post({ asOfDate: "2026-08-21" });
    const body = (await res.json()) as { ok: boolean; phase: string };
    expect(res.status).toBe(502);
    expect(body.ok).toBe(false);
    expect(body.phase).toBe("certification");
    // certification still ran — it is per-strategy and naturally reports
    // DRAFT_MISSING for the strategy that never got a draft row.
    expect(certificationCalls).toHaveLength(1);
  });

  it("REGRESSION: one strategy's draft failure (e.g. a missing stored close) no longer blocks certification for its healthy siblings", async () => {
    // Mirrors the real bug report: 7 of 8 active strategies draft
    // successfully, one ("Blended Focus") fails with EXACT_CLOSE_MISSING:CLS.
    // Certification must still run and certify the 7 healthy strategies,
    // with real YTD before/after values for each — only Blended Focus should
    // show up as its own isolated failure.
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

    const res = await post({ asOfDate: "2026-08-21" });
    const body = (await res.json()) as {
      ok: boolean;
      phase: string;
      draft: { results: Array<{ strategy: string; action: string; reason?: string }> };
      certification: { results: Array<{ strategy: string; action: string; reason?: string }> };
      ytd: Array<{ strategy: string; ytdReturnPctBefore: number | null; ytdReturnPctAfter: number | null }>;
    };

    // Certification must still have been attempted — this is the crux of
    // the fix: the draft failure must not gate the certification call.
    expect(certificationCalls).toHaveLength(1);

    // 200, not 502 — one isolated data gap must not read as a full request
    // failure when other strategies fully succeeded.
    expect(res.status).toBe(200);
    expect(body.ok).toBe(false); // honest: not everything succeeded
    expect(body.phase).toBe("partial");

    // Growth: real success, visible in both draft and certification.
    expect(body.draft.results).toContainEqual({ strategy: "Growth", action: "written", asOf: "2026-08-21" });
    expect(body.certification.results).toContainEqual({
      strategy: "Growth",
      action: "certified",
      asOf: "2026-08-21",
    });
    expect(body.ytd).toContainEqual({
      strategy: "Growth",
      ytdReturnPctBefore: 4.2,
      ytdReturnPctAfter: 4.2,
    });

    // Blended Focus: real, un-swallowed failure with its real reason.
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
});
