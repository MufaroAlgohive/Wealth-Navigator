import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * POST /api/admin/canonical-ledger/recompute — on-demand admin trigger for
 * the same draft -> certification sequence the canonical-ledger-daily cron
 * runs automatically. Gated on Master ★ (requireMasterPassword), NOT the
 * cron's CRON_SECRET bearer auth and NOT the granular can() permission
 * check — see the doc comment on the route for the reasoning.
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

  it("403s for a non-master admin (e.g. plain staff/admin tier)", async () => {
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

  it("passes strategyName through to both draft and certification when provided", async () => {
    await post({ asOfDate: "2026-08-21", strategyName: "Income" });
    expect(draftCalls[0]).toMatchObject({ strategyName: "Income" });
    expect(certificationCalls[0]).toMatchObject({ strategyName: "Income" });
  });

  it("returns 502 and skips certification when the draft phase fails", async () => {
    draftResult = { ok: false, asOf: "2026-08-21", apply: true, summary: { written: 0, planned: 0, skipped: 0, failed: 1, total: 1 }, results: [] };
    const res = await post({ asOfDate: "2026-08-21" });
    const body = (await res.json()) as { ok: boolean; phase: string };
    expect(res.status).toBe(502);
    expect(body.ok).toBe(false);
    expect(body.phase).toBe("draft");
    expect(certificationCalls).toHaveLength(0);
  });
});
