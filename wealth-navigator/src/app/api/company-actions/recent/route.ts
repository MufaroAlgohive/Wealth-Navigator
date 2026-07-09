/**
 * GET /api/company-actions/recent?days=30&type=dividend&limit=80
 *
 * Recent corporate actions across all symbols for the OEMS Cockpit News Flow
 * ("Corporate Actions" toggle alongside All / Alliance / SENS). Reads the
 * RETAIL `corp_action_c` table sorted by ex_date DESC.
 *
 *  - defaults: last 30 days, all action types
 *  - optional `?type=` filter (dividend|split|spinoff|rights|merger)
 *  - graceful degradation: missing table / unconfigured DB returns
 *    `{ ok: true, actions: [], source: "missing_table" | "unconfigured" }`
 *    with HTTP 200 so the toggle can render an honest empty state.
 */

import { isSupabaseSchemaMissing } from "@/lib/bff-reasons";
import { createRetailServiceRoleClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type ActionType = "dividend" | "split" | "spinoff" | "rights" | "merger";

interface CorpActionRow {
  id: string;
  symbol: string;
  ex_date: string;
  pay_date: string | null;
  record_date: string | null;
  amount_cents: number | null;
  currency: string;
  action_type: ActionType;
  notes: string | null;
  source: string | null;
  created_at: string;
}

const ALLOWED_TYPES: ReadonlyArray<ActionType> = ["dividend", "split", "spinoff", "rights", "merger"];

function tryOpenDb(): ReturnType<typeof createRetailServiceRoleClient> | null {
  try {
    return createRetailServiceRoleClient();
  } catch {
    return null;
  }
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const days = Math.min(Math.max(Number(url.searchParams.get("days") ?? 30) || 30, 1), 365);
  const typeRaw = (url.searchParams.get("type") ?? "").trim().toLowerCase();
  const type: ActionType | null = (ALLOWED_TYPES as readonly string[]).includes(typeRaw)
    ? (typeRaw as ActionType)
    : null;
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 80) || 80, 1), 200);

  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const db = tryOpenDb();
  if (!db) {
    return Response.json(
      {
        ok: true,
        actions: [],
        source: "unconfigured",
        notice:
          "RETAIL database not configured — apply 20260710000010_corp_action_c.sql and set RETAIL_SUPABASE_* env.",
      },
      { status: 200 },
    );
  }

  let q = db
    .from("corp_action_c")
    .select(
      "id, symbol, ex_date, pay_date, record_date, amount_cents, currency, action_type, notes, source, created_at",
    )
    .gte("ex_date", since)
    .order("ex_date", { ascending: false })
    .limit(limit);

  if (type) q = q.eq("action_type", type);

  const { data, error } = await q;
  if (error) {
    if (isSupabaseSchemaMissing(error)) {
      return Response.json(
        {
          ok: true,
          actions: [],
          source: "missing_table",
          notice:
            "corp_action_c table not migrated yet — apply supabase/retail/20260710000010_corp_action_c.sql.",
        },
        { status: 200 },
      );
    }
    return Response.json(
      {
        ok: false,
        actions: [],
        source: "supabase_query_failed",
        error: error.message,
      },
      { status: 200 },
    );
  }

  return Response.json({
    ok: true,
    actions: (data ?? []) as CorpActionRow[],
    source: "supabase",
    window: { days, since },
  });
}
