import "server-only";

import { can, getAdminContext } from "@/lib/admin/rbac";
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
    return { viewerEmail: null, viewerName: "Design Preview", perms: FULL };
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
