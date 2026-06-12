// SSE tick stream — emits batches of price updates every ~700ms.
//
// In mock mode (default): synthesises random walks on seed instruments.
// In live mode (IRESS_MODE=live): seeds from PricingQuoteGet, then polls
// PricingQuoteGetUpdates when a watch subscription is active; falls back to
// local simulation on IRESS errors.

import { initialQuotes } from "@/lib/iress/seed";
import { iressConfig } from "@/lib/iress";
import {
  DEFAULT_QUOTE_SYMBOLS,
  fetchQuotesSafe,
  pollQuoteUpdates,
  startQuoteWatch,
} from "@/lib/iress/live-queries";

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

function tickLocal() {
  const out: Array<{ sym: string; last: number }> = [];
  const keys = Array.from(quotes.keys());
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

function applyTicks(batch: Array<{ sym: string; last: number }>) {
  for (const t of batch) {
    if (t.last > 0) quotes.set(t.sym, t.last);
  }
  return batch;
}

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const isLive = iressConfig.mode === "live" || iressConfig.mode === "wsdl-stub";
  let watchRequestId: string | null = null;
  let liveActive = false;

  if (isLive) {
    try {
      const liveQuotes = await fetchQuotesSafe(DEFAULT_QUOTE_SYMBOLS, "JSE");
      for (const { symbol, quote } of liveQuotes) {
        if (quote.last > 0) quotes.set(symbol, quote.last);
      }
      const watch = await startQuoteWatch(DEFAULT_QUOTE_SYMBOLS.slice(0, 8), "JSE");
      if (watch) {
        watchRequestId = watch.requestId;
        for (const { symbol, quote } of watch.initial) {
          if (quote.last > 0) quotes.set(symbol, quote.last);
        }
        liveActive = true;
      }
    } catch (err) {
      console.warn("[ticks] live bootstrap failed, using local sim:", err);
    }
  }

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(applyTicks(
        Array.from(quotes.entries()).slice(0, 12).map(([sym, last]) => ({ sym, last })),
      ))}\n\n`));

      const id = setInterval(async () => {
        try {
          let batch: Array<{ sym: string; last: number }>;
          if (liveActive && watchRequestId) {
            const updates = await pollQuoteUpdates(watchRequestId);
            batch = updates.length > 0 ? applyTicks(updates) : tickLocal();
          } else {
            batch = tickLocal();
          }
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(batch)}\n\n`));
        } catch {
          clearInterval(id);
        }
      }, 700);

      const hb = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(`: heartbeat\n\n`));
        } catch {
          clearInterval(hb);
        }
      }, 15_000);

      void (() => {
        clearInterval(id);
        clearInterval(hb);
        try { controller.close(); } catch { /* ignore */ }
      });
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
      "X-Tick-Source": liveActive ? "iress-hybrid" : isLive ? "iress-fallback-sim" : "mock-sim",
    },
  });
}
