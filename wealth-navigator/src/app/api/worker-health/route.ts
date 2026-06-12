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
  symbol_exchanges?: Record<string, string>;
  accounts?: string[];
  account_configured?: boolean;
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
    const symbolExchanges = meta.symbol_exchanges;
    const accounts = meta.accounts;
    return {
      ...row,
      metadata: meta,
      symbols_covered: Array.isArray(symbols) ? (symbols as string[]) : undefined,
      symbol_exchanges:
        symbolExchanges && typeof symbolExchanges === "object" && !Array.isArray(symbolExchanges)
          ? (symbolExchanges as Record<string, string>)
          : undefined,
      accounts: Array.isArray(accounts) ? (accounts as string[]) : [],
      account_configured: typeof meta.account_configured === "boolean"
        ? (meta.account_configured as boolean)
        : Array.isArray(accounts) && accounts.length > 0,
    } satisfies WorkerHealthRow;
  });

  return Response.json({ workers, count: workers.length });
}
