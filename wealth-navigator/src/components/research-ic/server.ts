import "server-only";

import { can, canSeeUatSurfaces, getAdminContext } from "@/lib/admin/rbac";
import type { ResearchPerms } from "./types";

/**
 * Resolve the signed-in user's Research & IC permissions server-side and hand a
 * plain boolean map to the client tabs. This avoids needing an <AdminProvider>
 * under /oems for these routes. The API routes still enforce `can()` themselves
 * as the source of truth — these booleans only gate the UI affordances.
 */
export interface ResearchSession {
  viewerEmail: string | null;
  viewerName: string | null;
  canSeeUat: boolean;
  /** `approverTier === "master"` — mirrors the server's own step-up gate
   *  (lib/admin/step-up.ts) exactly. Resolved here, not via useAdmin()/
   *  <AdminProvider>, for the same reason every other field on this session
   *  is: that provider isn't mounted under /oems (see this file's docstring). */
  isMaster: boolean;
  perms: ResearchPerms;
}

const FULL: ResearchPerms = {
  createNote: true,
  approveNote: true,
  castVote: true,
  raiseRebalance: true,
  approveRebalance: true,
  pushRebalance: true,
};

export async function resolveResearchSession(): Promise<ResearchSession> {
  const res = await getAdminContext();
  if (res.status !== "ok") {
    // Design-preview / local fallback (mirrors the /oems/(banking) group layout):
    // render the surface fully. The API still 401s an unauthenticated mutation.
    return { viewerEmail: null, viewerName: "Design Preview", canSeeUat: true, isMaster: true, perms: FULL };
  }
  const ctx = res.ctx;
  const b = (v: boolean | "pending" | "direct") => v === true || v === "direct";
  // Admins and superadmins implicitly get every Research & IC action — they don't
  // need the granular `permissions.research-lab.*` row set on their `admin_team`
  // record to create a note or push a rebalance. Staff analysts still need the
  // explicit grant, which is what we want.
  const isAdmin = ctx.role === "admin" || ctx.role === "superadmin";
  return {
    viewerEmail: ctx.email,
    viewerName: ctx.fullName ?? ctx.email,
    canSeeUat: canSeeUatSurfaces(ctx),
    isMaster: ctx.approverTier === "master",
    perms: {
      createNote: isAdmin || b(can(ctx, "research-lab", "create_research_note")),
      approveNote: isAdmin || b(can(ctx, "research-lab", "approve_note")),
      castVote: isAdmin || b(can(ctx, "research-lab", "cast_vote")),
      raiseRebalance: isAdmin || b(can(ctx, "rebalance", "raise_rebalance")),
      approveRebalance: isAdmin || b(can(ctx, "rebalance", "approve_rebalance")),
      pushRebalance: isAdmin || b(can(ctx, "rebalance", "push_rebalance")),
    },
  };
}
