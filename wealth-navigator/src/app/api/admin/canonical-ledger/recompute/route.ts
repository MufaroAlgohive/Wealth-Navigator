import { NextResponse } from "next/server";

import { requireMasterPassword } from "@/lib/admin/step-up";
import { publishCanonicalLedgerCertification } from "@/lib/returns/publish-canonical-ledger-certification";
import { publishCanonicalLedgerDraft } from "@/lib/returns/publish-canonical-ledger-draft";
import { createRetailServiceRoleClient, isRetailSupabaseConfigured } from "@/lib/supabase/server";

/**
 * POST /api/admin/canonical-ledger/recompute
 *
 * On-demand admin trigger for the SAME draft→certification sequence the
 * `canonical-ledger-daily` cron runs automatically at 17:30 UTC on weekdays
 * (`src/app/api/cron/canonical-ledger-daily/route.ts`). Exists so an admin
 * can pull today's corrected YTD figures forward immediately after a ledger
 * fix (e.g. the 2026-08 chain-linking fix, PR #142/#143) instead of waiting
 * for the next natural cron run, and as a standing capability for future
 * re-runs (data fixes, testing).
 *
 * AUTH: gated on `requireMasterPassword` (Master ★ approver tier), the SAME
 * tier `send-to-market` and `manual-fill` use — NOT the granular
 * `can(ctx, section, field)` permission check those two routes also choose
 * between. Reasoning (see `src/lib/admin/step-up.ts` and `src/lib/admin/rbac.ts`):
 *
 *   - `can()` grants are for routine, scoped desk actions (e.g. "may this
 *     staff member send THIS book to market"). This route has no such
 *     scope — a single call CERTIFIES the canonical ledger (writes real
 *     `certification_status='CERTIFIED'` rows) for every active strategy at
 *     once, and `strategy_returns_effective_c` mirrors those rows
 *     immediately (PR #143) — the figures every investor and the CEO see
 *     change the moment this call succeeds. That is a direct write to a
 *     certified financial record, not a scoped trading action.
 *   - `manual-fill` sits on Master ★ specifically because "there is no
 *     broker confirmation behind this call" (see its own comment) — the
 *     desk is trusting the operator's judgment with no independent check
 *     at the moment of write. Certifying a canonical ledger row is the
 *     analogous case here: `canonicalDraftShapeBlockers` validates
 *     *shape*, but nothing external re-verifies that recomputing today's
 *     numbers and certifying them right now is the right call — that's a
 *     judgment call reserved, by this codebase's existing convention, for
 *     Master ★ approvers.
 *   - `send-to-market` uses the granular permission specifically because it
 *     is routine desk workflow gated by role, with its own additional
 *     guards (limit guard, double-fill guard, UAT/production lane). This
 *     route has no such per-desk-role workflow — it is closer in kind to
 *     manual-fill's "irreversible, trust-the-operator" shape than to
 *     send-to-market's "routine, permissioned" shape.
 *
 * ATTRIBUTION: a manually-triggered certification must NOT be recorded
 * under `AUTOMATIC_CERTIFICATION_ACTOR` ("SYSTEM:WEALTH_NAVIGATOR_DAILY_V1")
 * — that constant is reserved for the cron path. This route stamps
 * `MANUAL:<admin-email>` on `certify_strategy_canonical_daily_ledger_c` so
 * the certification audit trail can distinguish "cron did this at 17:30" from
 * "an admin triggered this on demand", and always logs who/when/which
 * strategy/asOfDate server-side before running.
 *
 * Body (all optional): { asOfDate?: string, strategyName?: string }
 *   - asOfDate defaults to today in SAST (Africa/Johannesburg), matching the
 *     cron route's own `sastDate()` helper.
 *   - strategyName defaults to all active strategies (same default as
 *     `publishCanonicalLedgerDraft`'s own `options.strategyName`).
 *
 * Returns per-strategy draft + certification outcome, plus YTD return_pct
 * before/after so the UI can show what changed.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

function sastDate(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Johannesburg",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${byType.year}-${byType.month}-${byType.day}`;
}

type StrategyYtd = {
  strategy: string;
  ytdReturnPctBefore: number | null;
  ytdReturnPctAfter: number | null;
};

async function readYtdSnapshot(
  asOfDate: string,
  strategyName: string | undefined,
): Promise<Map<string, number | null>> {
  const out = new Map<string, number | null>();
  if (!isRetailSupabaseConfigured()) return out;
  const db = createRetailServiceRoleClient();
  let strategyQuery = db.from("strategies_c").select("id,name").eq("status", "active").neq("name", "Test Strategy");
  if (strategyName) strategyQuery = strategyQuery.eq("name", strategyName);
  const { data: strategies, error: strategyErr } = await strategyQuery;
  if (strategyErr || !strategies?.length) return out;

  const idToName = new Map(strategies.map((s) => [s.id as string, s.name as string]));
  const { data: ledgerRows, error: ledgerErr } = await db
    .from("strategy_canonical_daily_ledger_c")
    .select("strategy_id, period_metrics")
    .eq("as_of_date", asOfDate)
    .in("strategy_id", [...idToName.keys()]);
  if (ledgerErr) return out;

  // Every active strategy is represented, even if it has no row yet (null).
  for (const name of idToName.values()) out.set(name, null);
  for (const row of ledgerRows ?? []) {
    const name = idToName.get(row.strategy_id as string);
    if (!name) continue;
    const periodMetrics = (row.period_metrics ?? {}) as Record<string, { return_pct?: unknown } | undefined>;
    const ytd = periodMetrics.YTD?.return_pct;
    out.set(name, typeof ytd === "number" && Number.isFinite(ytd) ? ytd : null);
  }
  return out;
}

export async function POST(req: Request) {
  const stepUp = await requireMasterPassword(undefined);
  if (!stepUp.ok) {
    return NextResponse.json({ ok: false, error: stepUp.error }, { status: stepUp.status });
  }

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const asOfDate = typeof body.asOfDate === "string" && body.asOfDate.trim() ? body.asOfDate.trim() : sastDate();
  const strategyName =
    typeof body.strategyName === "string" && body.strategyName.trim() ? body.strategyName.trim() : undefined;

  const certificationActor = `MANUAL:${stepUp.email}`;
  console.log(
    `[admin/canonical-ledger/recompute] triggered by ${stepUp.email} at ${new Date().toISOString()} ` +
      `asOf=${asOfDate} strategy=${strategyName ?? "ALL_ACTIVE"}`,
  );

  const before = await readYtdSnapshot(asOfDate, strategyName);

  const draft = await publishCanonicalLedgerDraft({
    asOfDate,
    apply: true,
    replaceExistingDraft: true,
    strategyName,
  });
  if (!draft.ok) {
    return NextResponse.json(
      { ok: false, asOf: asOfDate, phase: "draft", triggeredBy: stepUp.email, draft, certification: null },
      { status: 502 },
    );
  }

  const certification = await publishCanonicalLedgerCertification({
    asOfDate,
    strategyName,
    certificationActor,
  });

  const after = await readYtdSnapshot(asOfDate, strategyName);
  const strategyNames = new Set<string>([...before.keys(), ...after.keys()]);
  const ytd: StrategyYtd[] = [...strategyNames].sort().map((strategy) => ({
    strategy,
    ytdReturnPctBefore: before.get(strategy) ?? null,
    ytdReturnPctAfter: after.get(strategy) ?? null,
  }));

  return NextResponse.json(
    {
      ok: certification.ok,
      asOf: asOfDate,
      phase: certification.ok ? "complete" : "certification",
      triggeredBy: stepUp.email,
      certificationActor,
      draft,
      certification,
      ytd,
    },
    { status: certification.ok ? 200 : 502 },
  );
}
