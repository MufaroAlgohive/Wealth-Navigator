/**
 * Realtime latency probe — subscribes to stock_intraday_c on the test
 * project, then inserts a row via the service-role client and times
 * insert→received. Exits after one round-trip.
 *
 *   bun run scripts/realtime-quote-test.ts
 *
 * Required env (loaded from .env.local by the bun --env-file flag, or
 * exported manually):
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *   NEXT_PUBLIC_SUPABASE_ANON_KEY   (used to subscribe; non-privileged)
 *
 * Test target: any securities_c row that already exists.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SERVICE_KEY || !ANON_KEY) {
  console.error("Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / NEXT_PUBLIC_SUPABASE_ANON_KEY");
  process.exit(1);
}

const subscribeClient: SupabaseClient = createClient(SUPABASE_URL, ANON_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
  realtime: { params: { eventsPerSecond: 10 } },
});
const writeClient: SupabaseClient = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const TEST_SYMBOL = "RT-LATENCY-" + Date.now().toString(36);
const PROBE_PRICE = 12345;

interface SecurityRow {
  id: string;
  symbol: string;
}

async function ensureTestSecurity(): Promise<SecurityRow> {
  const { data, error } = await writeClient
    .from("securities_c")
    .upsert({ symbol: TEST_SYMBOL, name: "RT Latency Probe", last_price: 10000 }, { onConflict: "symbol" })
    .select("id, symbol")
    .single();
  if (error || !data) {
    throw new Error(`securities_c upsert failed: ${error?.message ?? "no data"}`);
  }
  return data as SecurityRow;
}

async function runOnce(): Promise<number> {
  const sec = await ensureTestSecurity();
  let received = false;
  let latencyMs = -1;
  const insertedAt = Date.now();

  const channel = subscribeClient
    .channel(`rt-latency-${insertedAt}`)
    .on(
      "postgres_changes",
      { event: "INSERT", schema: "public", table: "stock_intraday_c", filter: `security_id=eq.${sec.id}` },
      (payload) => {
        if (received) return;
        const newRow = payload.new as { security_id: string; current_price: number };
        if (newRow.security_id !== sec.id || newRow.current_price !== PROBE_PRICE) return;
        received = true;
        latencyMs = Date.now() - insertedAt;
        console.log(JSON.stringify({ event: "received", latencyMs, row: newRow }));
      },
    );

  const subStart = Date.now();
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("subscribe timed out (10s)")), 10_000);
    channel.subscribe((status) => {
      if (status === "SUBSCRIBED") {
        clearTimeout(timeout);
        resolve();
      } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
        clearTimeout(timeout);
        reject(new Error(`subscribe status: ${status}`));
      }
    });
  });
  const subElapsed = Date.now() - subStart;
  console.log(JSON.stringify({ event: "subscribed", subscribeElapsedMs: subElapsed }));

  // Brief pause so the realtime socket is fully open before we insert.
  await new Promise((r) => setTimeout(r, 250));

  const insertStart = Date.now();
  const { error: insErr } = await writeClient.from("stock_intraday_c").insert({
    security_id: sec.id,
    current_price: PROBE_PRICE,
    timestamp: new Date(insertedAt).toISOString(),
  });
  if (insErr) throw new Error(`insert failed: ${insErr.message}`);
  console.log(JSON.stringify({ event: "inserted", symbol: TEST_SYMBOL, insertElapsedMs: Date.now() - insertStart }));

  // Wait up to 10s for the realtime event.
  const waitStart = Date.now();
  while (!received && Date.now() - waitStart < 10_000) {
    await new Promise((r) => setTimeout(r, 25));
  }

  await subscribeClient.removeChannel(channel);

  if (!received) {
    throw new Error("realtime event never arrived within 10s");
  }
  return latencyMs;
}

async function main(): Promise<void> {
  console.log(JSON.stringify({ event: "starting", url: SUPABASE_URL }));
  try {
    const latency = await runOnce();
    console.log(JSON.stringify({ event: "done", latencyMs: latency }));
    process.exit(0);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(JSON.stringify({ event: "error", error: msg }));
    process.exit(1);
  }
}

void main();
