/**
 * GET /api/alerts — list alert_log_c rows, optionally filtered to unacked.
 * The Cockpit banner (`src/components/cockpit/alert-banner.tsx`) calls this
 * on mount and every 30s. Approved research notes whose `triggers` JSONB
 * has been breached show up here, written by the worker
 * (`workers/iress-ingest/src/alerts.ts`).
 *
 * Query params:
 *   ?acked=true  → include acknowledged rows too (default false = only open)
 *   ?limit=50    → cap row count (default 50, max 200)
 *   ?symbol=NPN  → filter to one symbol
 */

import {
  createInstitutionalServiceRoleClient,
  isInstitutionalSupabaseConfigured,
} from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export interface AlertRow {
  id: string;
  note_id: string;
  symbol: string;
  trigger_kind: string;
  trigger_price: number;
  observed_price: number;
  breached_at: string;
  acknowledged_at: string | null;
  acknowledged_by: string | null;
  email_sent_at: string | null;
  email_to: string | null;
  payload: Record<string, unknown> | null;
  // Joined from research_note_c so the banner can render without a second round-trip.
  note_symbol?: string;
  note_company_name?: string | null;
  note_thesis?: { companyName?: string | null } | null;
}

function parseLimit(raw: string | null): number {
  if (!raw) return 50;
  const n = Math.max(1, Math.min(200, Number(raw)));
  return Number.isFinite(n) ? n : 50;
}

export async function GET(request: Request) {
  if (!isInstitutionalSupabaseConfigured()) {
    return Response.json({ error: "Supabase not configured", alerts: [] }, { status: 503 });
  }
  const url = new URL(request.url);
  const acked = url.searchParams.get("acked") === "true";
  const limit = parseLimit(url.searchParams.get("limit"));
  const symbolFilter = (url.searchParams.get("symbol") ?? "").toUpperCase().trim();

  const supabase = createInstitutionalServiceRoleClient();

  // Use the unacked index when `acked=false` for cheap scans of the typical
  // banner case. Otherwise fall back to a date-bounded select.
  const baseSelect = `
    id,
    note_id,
    symbol,
    trigger_kind,
    trigger_price,
    observed_price,
    breached_at,
    acknowledged_at,
    acknowledged_by,
    email_sent_at,
    email_to,
    payload,
    research_note_c:note_id(symbol, thesis)
  `;
  let q = supabase
    .from("alert_log_c")
    .select(baseSelect)
    .order("breached_at", { ascending: false })
    .limit(limit);

  if (!acked) {
    q = q.is("acknowledged_at", null);
  }
  if (symbolFilter) {
    q = q.eq("symbol", symbolFilter);
  } else if (!acked) {
    // Keep the default unacked list bounded to the last 30 days — the
    // operator rarely wants ancient ghost alerts, and a stale unacked
    // hit from 2025-08 is noise on a busy morning.
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    q = q.gte("breached_at", cutoff);
  }

  const { data, error } = await q;
  if (error) {
    return Response.json({ error: error.message, alerts: [] }, { status: 500 });
  }

  const alerts: AlertRow[] = (data ?? []).map((row: Record<string, unknown>) => {
    const note = row.research_note_c as { symbol?: string; thesis?: { companyName?: string | null } | null } | null;
    return {
      id: row.id as string,
      note_id: row.note_id as string,
      symbol: row.symbol as string,
      trigger_kind: row.trigger_kind as string,
      trigger_price: Number(row.trigger_price),
      observed_price: Number(row.observed_price),
      breached_at: row.breached_at as string,
      acknowledged_at: (row.acknowledged_at as string | null) ?? null,
      acknowledged_by: (row.acknowledged_by as string | null) ?? null,
      email_sent_at: (row.email_sent_at as string | null) ?? null,
      email_to: (row.email_to as string | null) ?? null,
      payload: (row.payload as Record<string, unknown> | null) ?? null,
      note_symbol: note?.symbol,
      note_company_name: note?.thesis?.companyName ?? null,
      note_thesis: note?.thesis ?? null,
    };
  });

  return Response.json({ alerts, count: alerts.length });
}