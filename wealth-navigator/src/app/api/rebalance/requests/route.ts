import { NextResponse } from "next/server";

import { canResearchIc, canSeeUatSurfaces, getAdminContext } from "@/lib/admin/rbac";
import { isSupabaseSchemaMissing } from "@/lib/bff-reasons";
import { type RebalanceVote, tallyVotes } from "@/lib/rebalance/ic-vote";
import { createInstitutionalServiceRoleClient, createRetailServiceRoleClient } from "@/lib/supabase/server";

/**
 * /api/rebalance/requests — strategy rebalance queue.
 *
 * GET  ?status=ic_approved   list rebalance requests.
 * POST                      raise a new request from a research note.
 *
 * Both calls fall back to an empty array / honest notice if
 * `rebalance_request_c` hasn't been migrated yet.
 */

export const dynamic = "force-dynamic";

interface RebalanceRow {
  id: string;
  strategy_id: string;
  requested_by: string;
  current_composition: unknown;
  proposed_composition: unknown;
  affected_investors: unknown | null;
  status: string;
  ic_session_id: string | null;
  research_note_id: string | null;
  executed_at: string | null;
  created_at: string;
  updated_at: string;
}

async function openDb() {
  try {
    return createInstitutionalServiceRoleClient();
  } catch {
    return null;
  }
}

export async function GET(req: Request) {
  const auth = await getAdminContext();
  if (auth.status === "no-session") {
    return NextResponse.json({ ok: false, error: "no-session" }, { status: 401 });
  }
  if (auth.status !== "ok") {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }

  const url = new URL(req.url);
  const status = url.searchParams.get("status");
  const requestedScope = url.searchParams.get("scope") === "uat" ? "uat" : "live";
  if (requestedScope === "uat" && !canSeeUatSurfaces(auth.ctx)) {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }

  const db = await openDb();
  if (!db) {
    return NextResponse.json({
      ok: true,
      requests: [],
      notice: "INSTITUTIONAL database not configured.",
    });
  }

  let q = db
    .from("rebalance_request_c")
    .select(
      "id, strategy_id, requested_by, current_composition, proposed_composition, affected_investors, status, environment_scope, ic_session_id, research_note_id, executed_at, created_at, updated_at",
    )
    .order("created_at", { ascending: false })
    .limit(100);
  if (status) q = q.eq("status", status);
  q = q.eq("environment_scope", requestedScope);

  const { data, error } = await q;
  if (error) {
    if (isSupabaseSchemaMissing(error)) {
      return NextResponse.json({
        ok: true,
        requests: [],
        notice: "rebalance_request_c table not migrated yet — apply 20260710000004_rebalance_request_c.sql.",
      });
    }
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  let rows = (data ?? []) as RebalanceRow[];

  // A UAT strategy's rebalances are test artefacts and must not appear to
  // anyone doing real work — not on the IC agenda, not on the Rebalances tab,
  // not in recent activity. Filtered here rather than in the UI so the rows are
  // never sent at all. `strategy_id` on this table holds the strategy NAME (see
  // the convention noted in transition/route.ts), so match on name.
  if (!canSeeUatSurfaces(auth.ctx)) {
    try {
      const retail = createRetailServiceRoleClient();
      const { data: strats } = await retail.from("strategies_c").select("name, investor_environment");
      const uatNames = new Set(
        ((strats ?? []) as Array<{ name: string | null; investor_environment: string | null }>)
          .filter((s) => String(s.investor_environment ?? "LIVE").toUpperCase() === "UAT")
          .map((s) => String(s.name ?? "")),
      );
      rows = rows.filter((r) => !uatNames.has(String(r.strategy_id ?? "")));
    } catch {
      // Retail unreachable — we cannot tell which are UAT. Fail CLOSED and
      // show nothing rather than risk surfacing test rebalances as real ones.
      rows = [];
    }
  }

  // Enrich each proposal with its IC votes + tally in one batched query, so the
  // committee UI can render the 60% gate without an N+1 fetch. Best-effort: if
  // rebalance_vote_c isn't migrated yet, every proposal simply shows 0 votes.
  const byRequest = new Map<string, RebalanceVote[]>();
  const ids = rows.map((r) => r.id);
  if (ids.length > 0) {
    const votesRes = await db
      .from("rebalance_vote_c")
      .select("request_id, voter_email, vote, voted_at")
      .in("request_id", ids);
    if (!votesRes.error) {
      for (const v of (votesRes.data ?? []) as Array<RebalanceVote & { request_id: string }>) {
        const list = byRequest.get(v.request_id) ?? [];
        list.push({ voter_email: v.voter_email, vote: v.vote, voted_at: v.voted_at });
        byRequest.set(v.request_id, list);
      }
    }
  }

  const requests = rows.map((r) => {
    const votes = byRequest.get(r.id) ?? [];
    return { ...r, votes, tally: tallyVotes(votes) };
  });

  return NextResponse.json({ ok: true, requests });
}

/**
 * Report the first declared cash shortfall in a submitted `affected_investors`
 * payload, or null if there is none. Handles both shapes the compose surfaces
 * send: a strategy-wide `{ investors: [{ shortfall, ... }] }` and a
 * single-client `{ scope: "single_user", bridge: { shortfall } }`.
 */
function findDeclaredShortfall(affectedInvestors: unknown): string | null {
  if (!affectedInvestors || typeof affectedInvestors !== "object") return null;
  const a = affectedInvestors as { investors?: unknown; bridge?: unknown };

  if (a.bridge && typeof a.bridge === "object" && (a.bridge as { shortfall?: unknown }).shortfall === true) {
    return "This client's sale proceeds and execution reserve don't cover the fees. Reduce the buy size or trim something else.";
  }

  if (Array.isArray(a.investors)) {
    const short = a.investors.filter(
      (inv) => inv && typeof inv === "object" && (inv as { shortfall?: unknown }).shortfall === true,
    );
    if (short.length > 0) {
      return `Insufficient cash for ${short.length} investor${short.length === 1 ? "" : "s"} — fees exceed sale proceeds plus their execution reserve. Reduce the buy size or trim something else.`;
    }
  }
  return null;
}

function bareSymbol(value: unknown): string {
  return String(value ?? "")
    .trim()
    .toUpperCase()
    .replace(/\.(JO|JSE)$/i, "");
}

function changedSymbols(current: unknown[], proposed: unknown[]): string[] {
  const sharesOf = (row: unknown): number | null => {
    if (!row || typeof row !== "object") return null;
    const value = Number((row as { shares?: unknown }).shares);
    return Number.isFinite(value) ? value : null;
  };
  const symbolOf = (row: unknown): string =>
    row && typeof row === "object" ? bareSymbol((row as { ticker?: unknown }).ticker) : "";
  const toSymbolMap = (rows: unknown[]) => {
    const map = new Map<string, number | null>();
    for (const row of rows) {
      const symbol = symbolOf(row);
      if (symbol) map.set(symbol, sharesOf(row));
    }
    return map;
  };
  const currentBySymbol = toSymbolMap(current);
  const proposedBySymbol = toSymbolMap(proposed);
  const changed = new Set<string>();
  for (const [symbol, shares] of proposedBySymbol) {
    if (!currentBySymbol.has(symbol) || currentBySymbol.get(symbol) !== shares) changed.add(symbol);
  }
  for (const symbol of currentBySymbol.keys()) {
    if (!proposedBySymbol.has(symbol)) changed.add(symbol);
  }
  return [...changed];
}

async function missingResearchNotes(
  db: NonNullable<Awaited<ReturnType<typeof openDb>>>,
  current: unknown[],
  proposed: unknown[],
  environmentScope: "live" | "uat",
) {
  const required = changedSymbols(current, proposed);
  if (!required.length) return [];
  const { data, error } = await db
    .from("research_note_c")
    .select("symbol")
    .eq("environment_scope", environmentScope);
  if (error) throw new Error(error.message);
  const covered = new Set((data ?? []).map((note) => bareSymbol(note.symbol)));
  return required.filter((symbol) => !covered.has(symbol));
}

export async function POST(req: Request) {
  const auth = await getAdminContext();
  if (auth.status === "no-session") {
    return NextResponse.json({ ok: false, error: "no-session" }, { status: 401 });
  }
  if (auth.status !== "ok") {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }
  if (!canResearchIc(auth.ctx, "rebalance", "raise_rebalance")) {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }

  const body = ((await req.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;
  const strategyId = typeof body.strategy_id === "string" ? body.strategy_id.trim() : "";
  const currentComposition = body.current_composition;
  const proposedComposition = body.proposed_composition;
  if (!strategyId) {
    return NextResponse.json({ ok: false, error: "strategy_id is required" }, { status: 400 });
  }
  if (!Array.isArray(currentComposition) || !Array.isArray(proposedComposition)) {
    return NextResponse.json(
      { ok: false, error: "current_composition and proposed_composition must be arrays" },
      { status: 400 },
    );
  }

  // A reset draft must never become a convincing-looking all-HOLD IC item.
  if (changedSymbols(currentComposition, proposedComposition).length === 0) {
    return NextResponse.json(
      { ok: false, error: "A rebalance proposal needs at least one composition change." },
      { status: 422 },
    );
  }

  // Cash-availability guard. A proposal whose fees can't be covered by sale
  // proceeds plus the 8% execution reserve leaves the client short, and the
  // proceeds bridge floors their strategy cash at zero rather than going
  // negative — so the shortfall silently becomes destroyed value at
  // settlement. Both compose surfaces already block submit on this flag; this
  // is the same invariant stated at the API boundary, so a regression in
  // either UI gate can't quietly write an unfundable proposal.
  //
  // Scope: this trusts the shortfall the caller computed (via
  // /api/rebalance/impact or /api/rebalance/client-target-impact, both
  // server-side and authoritative). It is not a recomputation — a caller that
  // omits affected_investors, or forges it, is not caught here. Closing that
  // properly means extracting the impact engine out of its route handler so
  // this one can re-derive the numbers itself.
  const shortfallError = findDeclaredShortfall(body.affected_investors);
  if (shortfallError) {
    return NextResponse.json({ ok: false, error: shortfallError }, { status: 422 });
  }

  const db = await openDb();
  if (!db)
    return NextResponse.json({ ok: false, error: "INSTITUTIONAL database not configured" }, { status: 503 });

  // Snapshot the strategy environment when the proposal is raised. This is the
  // boundary that keeps UAT votes and policies from ever being counted for a
  // LIVE proposal (or vice versa), even if a strategy is renamed later.
  let environmentScope: "live" | "uat";
  try {
    const retail = createRetailServiceRoleClient();
    const strategy = await retail
      .from("strategies_c")
      .select("investor_environment")
      .eq("name", strategyId)
      .maybeSingle();
    if (strategy.error || !strategy.data) {
      return NextResponse.json(
        { ok: false, error: "Could not determine the strategy environment for IC voting." },
        { status: 409 },
      );
    }
    environmentScope =
      String(strategy.data.investor_environment ?? "LIVE").toUpperCase() === "UAT" ? "uat" : "live";
  } catch {
    return NextResponse.json(
      { ok: false, error: "Could not determine the strategy environment for IC voting." },
      { status: 503 },
    );
  }

  // A note for AME must never satisfy an HYP change, and a LIVE note must
  // never satisfy a UAT proposal (or vice versa). Enforce this at the write
  // boundary so a direct API request cannot bypass the builder's gate.
  try {
    const missing = await missingResearchNotes(db, currentComposition, proposedComposition, environmentScope);
    if (missing.length) {
      return NextResponse.json(
        { ok: false, error: `Research required before creating this rebalance: ${missing.join(", ")}.` },
        { status: 422 },
      );
    }
  } catch {
    return NextResponse.json(
      { ok: false, error: "Could not verify research coverage. Rebalance creation is blocked until coverage can be checked." },
      { status: 503 },
    );
  }

  const insert: Record<string, unknown> = {
    strategy_id: strategyId,
    requested_by: auth.ctx.email,
    current_composition: currentComposition,
    proposed_composition: proposedComposition,
    affected_investors: body.affected_investors ?? null,
    status: "pending",
    environment_scope: environmentScope,
    research_note_id:
      typeof body.research_note_id === "string" && body.research_note_id.length > 0
        ? body.research_note_id
        : null,
    ic_session_id:
      typeof body.ic_session_id === "string" && body.ic_session_id.length > 0 ? body.ic_session_id : null,
  };

  const { data, error } = await db.from("rebalance_request_c").insert(insert).select().maybeSingle();
  if (error) {
    if (isSupabaseSchemaMissing(error)) {
      return NextResponse.json(
        {
          ok: false,
          error: "rebalance_request_c table not migrated yet — apply 20260710000004_rebalance_request_c.sql.",
          migration: "supabase/migrations/20260710000004_rebalance_request_c.sql",
        },
        { status: 409 },
      );
    }
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true, request: data }, { status: 201 });
}
