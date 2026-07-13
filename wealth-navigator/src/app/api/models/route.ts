import { NextResponse } from "next/server";

import { getAdminContext } from "@/lib/admin/rbac";
import { createInstitutionalServiceRoleClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/**
 * GET /api/models
 *
 * Registry of quant models pushed from local Docker containers into the
 * INSTITUTIONAL DB (model_*_c). Returns each model plus its headline backtest
 * and live metric snapshots and a computed heartbeat freshness, for the OEMS
 * Models tab. Read-only; any authenticated staff session may view.
 */

// A model is considered "live/warm" if it has pushed within this window.
const HEARTBEAT_FRESH_MS = 36 * 60 * 60 * 1000; // 36h (models run on a daily cadence)

export async function GET() {
  const auth = await getAdminContext();
  if (auth.status === "no-session") {
    return NextResponse.json({ ok: false, error: "no-session" }, { status: 401 });
  }
  if (auth.status !== "ok") {
    // unconfigured / not-member: return an honest empty payload, not a hard error.
    return NextResponse.json({ ok: true, models: [], notice: "Model registry not available for this session." });
  }

  const db = createInstitutionalServiceRoleClient();

  const { data: registry, error: regErr } = await db
    .from("model_registry_c")
    .select("*")
    .order("created_at", { ascending: true });

  if (regErr) {
    // Table missing (migration not applied) → honest notice, not a 500.
    return NextResponse.json({
      ok: true,
      models: [],
      notice: "model_registry_c not found. Apply migration 20260712000001_model_tracking_c.sql.",
    });
  }
  if (!registry || registry.length === 0) {
    return NextResponse.json({ ok: true, models: [] });
  }

  const slugs = registry.map((r) => r.slug as string);
  const { data: metrics } = await db
    .from("model_metric_c")
    .select("*")
    .in("model_slug", slugs);

  const now = Date.now();
  const bySlug = new Map<string, { backtest?: unknown; live?: unknown }>();
  for (const m of metrics ?? []) {
    const slug = m.model_slug as string;
    const bucket = bySlug.get(slug) ?? {};
    if (m.kind === "backtest") {
      // keep the metric with the latest as_of
      if (!bucket.backtest || new Date(m.as_of) > new Date((bucket.backtest as { as_of: string }).as_of)) {
        bucket.backtest = m;
      }
    } else if (m.kind === "live" || m.kind === "paper") {
      if (!bucket.live || new Date(m.as_of) > new Date((bucket.live as { as_of: string }).as_of)) {
        bucket.live = m;
      }
    }
    bySlug.set(slug, bucket);
  }

  const models = registry.map((r) => {
    const hb = r.last_heartbeat_at ? new Date(r.last_heartbeat_at).getTime() : 0;
    const fresh = hb > 0 && now - hb < HEARTBEAT_FRESH_MS;
    const m = bySlug.get(r.slug as string) ?? {};
    return {
      ...r,
      heartbeatFresh: fresh,
      heartbeatAgeMs: hb > 0 ? now - hb : null,
      backtestMetric: m.backtest ?? null,
      liveMetric: m.live ?? null,
    };
  });

  return NextResponse.json({ ok: true, models });
}
