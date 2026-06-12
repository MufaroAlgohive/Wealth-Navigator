import { isSupabaseConfigured, createServiceRoleClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export interface WorkerHealthRow {
  worker_id: string;
  service_name: string;
  status: string;
  last_heartbeat_at: string;
  last_quote_sync_at: string | null;
  iress_mode: string | null;
  metadata: Record<string, unknown>;
  updated_at: string;
  symbols_covered?: string[];
}

export async function GET() {
  if (!isSupabaseConfigured()) {
    return Response.json(
      { error: "Supabase not configured", workers: [] as WorkerHealthRow[] },
      { status: 503 },
    );
  }

  const supabase = createServiceRoleClient();
  const { data, error } = await supabase
    .from("integration_worker_health")
    .select("*")
    .order("last_heartbeat_at", { ascending: false });

  if (error) {
    return Response.json({ error: error.message, workers: [] as WorkerHealthRow[] }, { status: 500 });
  }

  const workers = (data ?? []).map((row) => {
    const meta = (row.metadata ?? {}) as Record<string, unknown>;
    const symbols = meta.symbols_covered;
    return {
      ...row,
      metadata: meta,
      symbols_covered: Array.isArray(symbols) ? (symbols as string[]) : undefined,
    } satisfies WorkerHealthRow;
  });

  return Response.json({ workers, count: workers.length });
}
