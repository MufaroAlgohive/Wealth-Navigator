// SSE tick stream — emits batches of price updates every ~700ms.
// In production this would proxy the IRESS edge WebSocket; in dev it just
// synthesises random walks on a subset of the seed instruments.

import { initialQuotes } from "@/lib/iress/seed";

const SEED_KEYS = [
  "J203", "J200", "USDZAR", "EURZAR", "GBPJPY",
  "Gold", "Brent", "Platinum",
  "R2030", "R2035", "R2040",
  "JIBAR_3M", "JIBAR_6M", "JIBAR_12M",
  "ZARONIA",
  "SPX", "NDX", "DJI", "N225", "HSI",
  "NPN", "PRX", "FSR", "SBK", "AGL", "BHG", "MTN", "SOL", "SHP", "CPI", "MSFT", "AAPL", "GFI",
];

// One mutable quote map, shared across all SSE clients.
const quotes: Map<string, number> = new Map(
  SEED_KEYS.map((k) => {
    const seed = initialQuotes();
    return [k, seed[k]?.last ?? 0] as const;
  }),
);

function tick() {
  const out: Array<{ sym: string; last: number }> = [];
  const keys = Array.from(quotes.keys());
  // tick ~25% of symbols per emit
  const n = Math.max(1, Math.floor(keys.length * 0.25));
  for (let i = 0; i < n; i++) {
    const k = keys[Math.floor(Math.random() * keys.length)];
    if (!k) continue;
    const cur = quotes.get(k) ?? 0;
    if (!cur) continue;
    const vol = cur > 1000 ? cur * 0.0004 : cur > 10 ? cur * 0.0008 : 0.02;
    const next = +(cur + (Math.random() - 0.5) * vol).toFixed(4);
    quotes.set(k, next);
    out.push({ sym: k, last: next });
  }
  return out;
}

export const dynamic = "force-dynamic";
export const runtime = "nodejs"; // SSE is fine on Node; Bun works too

export async function GET() {
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      // emit immediately
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(tick())}\n\n`));
      const id = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(tick())}\n\n`));
        } catch {
          clearInterval(id);
        }
      }, 700);
      // Heartbeat every 15s so proxies don't kill the connection
      const hb = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(`: heartbeat\n\n`));
        } catch {
          clearInterval(hb);
        }
      }, 15_000);

      // Best-effort cleanup when client disconnects
      const close = () => {
        clearInterval(id);
        clearInterval(hb);
        try { controller.close(); } catch { /* ignore */ }
      };
      // No request signal available here in a clean way; the interval
      // self-corrects via the try/catch above when controller is closed.
      void close;
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
