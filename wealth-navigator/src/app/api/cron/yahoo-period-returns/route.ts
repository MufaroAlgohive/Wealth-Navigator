import { NextResponse } from "next/server";

import { getAdminContext, isAdminRole } from "@/lib/admin/rbac";
import { createRetailServiceRoleClient } from "@/lib/supabase/server";
import { computePeriodReturns, fetchYahooHistory } from "@/lib/yahoo/returns";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const CACHE_TABLE = "equities_period_returns_cache_c";
const CONCURRENCY = 4;

async function authorized(request: Request): Promise<boolean> {
  const secret = process.env.CRON_SECRET;
  const bearer = request.headers.get("authorization")?.replace("Bearer ", "");
  if (secret && bearer === secret) return true;
  const auth = await getAdminContext();
  return auth.status === "ok" && isAdminRole(auth.ctx);
}

async function runBounded<T>(items: T[], work: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
    while (cursor < items.length) {
      const item = items[cursor] as T;
      cursor += 1;
      await work(item);
      await new Promise((resolve) => setTimeout(resolve, 125));
    }
  });
  await Promise.all(workers);
}

export async function GET(request: Request) {
  if (!(await authorized(request))) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const db = createRetailServiceRoleClient();
  const { data: securities, error } = await db
    .from("securities_c")
    .select("symbol")
    .eq("is_active", true)
    .order("symbol")
    .limit(1000);
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });

  const rows: Array<{
    symbol: string;
    return_1m: number | null;
    return_6m: number | null;
    bars_as_of: string | null;
    computed_at: string;
  }> = [];
  const failures: Array<{ symbol: string; error: string }> = [];

  await runBounded(securities ?? [], async (security) => {
    const symbol = String(security.symbol ?? "").replace(/\.(JO|JSE)$/i, "").trim().toUpperCase();
    if (!symbol) return;
    const history = await fetchYahooHistory(`${symbol}.JO`, { range: "1y", interval: "1d" });
    if (history.error || history.bars.length < 2) {
      if (failures.length < 25) failures.push({ symbol, error: history.error ?? "insufficient history" });
      return;
    }
    const calculated = computePeriodReturns(history.bars);
    rows.push({
      symbol,
      return_1m: calculated.period["1m_pct"] ?? null,
      return_6m: calculated.period["6m_pct"] ?? null,
      bars_as_of: calculated.asOf ? new Date(calculated.asOf).toISOString() : null,
      computed_at: new Date().toISOString(),
    });
  });

  let written = 0;
  for (let index = 0; index < rows.length; index += 100) {
    const chunk = rows.slice(index, index + 100);
    const { error: upsertError } = await db.from(CACHE_TABLE).upsert(chunk, { onConflict: "symbol" });
    if (upsertError) {
      return NextResponse.json(
        { ok: false, requested: securities?.length ?? 0, resolved: rows.length, written, error: upsertError.message },
        { status: 500 },
      );
    }
    written += chunk.length;
  }

  return NextResponse.json({
    ok: true,
    requested: securities?.length ?? 0,
    resolved: rows.length,
    written,
    failed: (securities?.length ?? 0) - rows.length,
    failureSample: failures,
    completedAt: new Date().toISOString(),
  });
}
