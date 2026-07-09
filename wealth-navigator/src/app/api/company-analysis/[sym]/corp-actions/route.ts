/**
 * GET /api/company-analysis/[sym]/corp-actions?type=dividend&limit=80
 *
 * Per-symbol corporate-action history from the RETAIL `corp_action_c` table.
 * Drives the "Corporate Actions" sub-tab of the OEMS Analysis page and is
 * meant to complement the Yahoo-only dividend payment feed.
 *
 *  - sort: ex_date DESC (most recent first)
 *  - filter: optional `?type=dividend|split|spinoff|rights|merger`
 *  - graceful degradation: if the table hasn't been migrated yet the route
 *    returns `{ ok: true, symbol, actions: [], source: "missing_table", notice }`
 *    with HTTP 200, so the UI can show the honest "no corporate actions yet"
 *    state instead of a spinner / error chip.
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

function normaliseSymbol(raw: string): string {
  return raw
    .trim()
    .toUpperCase()
    .replace(/\.(JO|JSE)$/i, "");
}

export async function GET(req: Request, ctx: { params: Promise<{ sym: string }> }) {
  const { sym } = await ctx.params;
  const symbol = normaliseSymbol(sym ?? "");
  if (!symbol) return Response.json({ ok: false, error: "Missing symbol" }, { status: 400 });

  const url = new URL(req.url);
  const typeRaw = (url.searchParams.get("type") ?? "").trim().toLowerCase();
  const type: ActionType | null = (ALLOWED_TYPES as readonly string[]).includes(typeRaw)
    ? (typeRaw as ActionType)
    : null;
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 80) || 80, 1), 200);

  const db = tryOpenDb();
  if (!db) {
    return Response.json(
      {
        ok: true,
        symbol,
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
    .eq("symbol", symbol)
    .order("ex_date", { ascending: false })
    .limit(limit);

  if (type) q = q.eq("action_type", type);

  const { data, error } = await q;
  if (error) {
    if (isSupabaseSchemaMissing(error)) {
      return Response.json(
        {
          ok: true,
          symbol,
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
        symbol,
        actions: [],
        source: "supabase_query_failed",
        error: error.message,
      },
      { status: 200 },
    );
  }

  return Response.json({
    ok: true,
    symbol,
    actions: (data ?? []) as CorpActionRow[],
    source: "supabase",
  });
}
