/**
 * READ-ONLY scan of the RETAIL prod DB (mfxng…) — flatten every holding
 * referenced by every row in strategies_c.
 *
 * For each strategy we parse the `holdings` JSONB (shape {symbol|ticker, name,
 * shares|quantity, weight, pending?}) and join to securities_c for the canonical
 * name/sector/last_price. We exclude `pending: true` rows because the Research
 * Lab UI does the same (`buildHoldings({includePending: false})`) — pending
 * rows are proposed adds/removes, not current constituents.
 *
 * Run from the wealth-navigator/ folder:
 *   bun run scripts/scan-strategy-holdings.ts
 */
import { createClient } from "@supabase/supabase-js";

const url = process.env.RETAIL_SUPABASE_URL;
const key = process.env.RETAIL_SUPABASE_SERVICE_ROLE_KEY;

if (!url || !key) {
  console.error(
    "[scan-holdings] Missing RETAIL_SUPABASE_URL / RETAIL_SUPABASE_SERVICE_ROLE_KEY.\n" +
      "Add them to wealth-navigator/.env.local (gitignored), then re-run.",
  );
  process.exit(1);
}

const db = createClient(url, key, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const bare = (sym: string) => sym.replace(/\.(JO|JSE)$/i, "").toUpperCase();

interface RawHolding {
  name?: string;
  symbol?: string;
  ticker?: string;
  shares?: number;
  quantity?: number;
  weight?: number;
  pending?: boolean;
}

interface StrategyRow {
  id: string;
  name: string | null;
  sector: string | null;
  provider_name: string | null;
  status: string | null;
  benchmark_name: string | null;
  min_investment: number | null;
  holdings: unknown;
  updated_at: string | null;
}

async function main(): Promise<void> {
  const { data: stratData, error: stratErr } = await db
    .from("strategies_c")
    .select("id,name,sector,provider_name,status,benchmark_name,min_investment,holdings,updated_at")
    .order("name");

  if (stratErr) {
    console.error("[scan-holdings] strategies_c error:", stratErr.message);
    process.exit(1);
  }
  const strategies = (stratData ?? []) as StrategyRow[];

  // Collect every distinct bare ticker so we hit securities_c in one round trip.
  const tickers = new Set<string>();
  for (const s of strategies) {
    if (!Array.isArray(s.holdings)) continue;
    for (const h of s.holdings as RawHolding[]) {
      const sym = bare(String(h.symbol ?? h.ticker ?? ""));
      if (sym) tickers.add(sym);
    }
  }

  const tickerList = [...tickers].sort();
  const secMap = new Map<string, { name: string | null; sector: string | null; last_price: number | null }>();
  if (tickerList.length > 0) {
    const { data: secData, error: secErr } = await db
      .from("securities_c")
      .select("symbol,name,sector,last_price")
      .in("symbol", tickerList);
    if (secErr) {
      console.error("[scan-holdings] securities_c error:", secErr.message);
    } else {
      for (const r of secData ?? []) {
        secMap.set(bare(String(r.symbol)), {
          name: r.name ?? null,
          sector: r.sector ?? null,
          last_price: r.last_price ?? null,
        });
      }
    }
  }

  // Per-strategy current holdings (pending=false) — same rule as the UI.
  const perStrategy = strategies
    .map((s) => {
      const raw = Array.isArray(s.holdings) ? (s.holdings as RawHolding[]) : [];
      const current = raw
        .filter((h) => !h.pending)
        .map((h) => {
          const sym = bare(String(h.symbol ?? h.ticker ?? ""));
          if (!sym) return null;
          const sec = secMap.get(sym);
          return {
            ticker: sym,
            name: h.name ?? sec?.name ?? sym,
            sector: sec?.sector ?? null,
            shares: Number(h.quantity ?? h.shares ?? 0),
            weight: Number(h.weight ?? 0),
            last_price_cents: sec?.last_price ?? null,
          };
        })
        .filter((x): x is NonNullable<typeof x> => x !== null);
      return {
        id: s.id,
        name: s.name ?? "Unnamed strategy",
        sector: s.sector ?? null,
        provider: s.provider_name ?? null,
        benchmark: s.benchmark_name ?? null,
        status: s.status ?? null,
        min_investment: Number(s.min_investment ?? 0),
        holdings_count: current.length,
        updated_at: s.updated_at ?? null,
        holdings: current,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  // Flatten every ticker across all strategies (dedupe on ticker) with the
  // list of strategies that hold it.
  const byTicker = new Map<
    string,
    {
      ticker: string;
      name: string | null;
      sector: string | null;
      last_price_cents: number | null;
      held_by: Array<{ strategy: string; weight: number; shares: number }>;
    }
  >();
  for (const s of perStrategy) {
    for (const h of s.holdings) {
      const entry = byTicker.get(h.ticker) ?? {
        ticker: h.ticker,
        name: h.name,
        sector: h.sector,
        last_price_cents: h.last_price_cents,
        held_by: [],
      };
      entry.held_by.push({ strategy: s.name, weight: h.weight, shares: h.shares });
      byTicker.set(h.ticker, entry);
    }
  }
  const flat = [...byTicker.values()].sort((a, b) => {
    if (b.held_by.length !== a.held_by.length) return b.held_by.length - a.held_by.length;
    return a.ticker.localeCompare(b.ticker);
  });

  // Buckets for the summary
  const oneOff = flat.filter((t) => t.held_by.length === 1);
  const multi = flat.filter((t) => t.held_by.length >= 2);

  const summary = {
    strategies_total: strategies.length,
    strategies_with_holdings: perStrategy.filter((s) => s.holdings.length > 0).length,
    distinct_tickers: flat.length,
    held_by_one_strategy: oneOff.length,
    held_by_two_or_more: multi.length,
    strategies: perStrategy.map((s) => ({
      name: s.name,
      sector: s.sector,
      provider: s.provider,
      benchmark: s.benchmark,
      status: s.status,
      min_investment: s.min_investment,
      holdings_count: s.holdings_count,
      updated_at: s.updated_at,
    })),
    flat_holdings: flat,
  };

  const fs = await import("node:fs/promises");
  await fs.writeFile("scripts/scan-holdings.json", JSON.stringify(summary, null, 2));

  console.log(
    `Strategies: ${summary.strategies_total} total, ${summary.strategies_with_holdings} with holdings`,
  );
  console.log(`Distinct tickers across all strategies: ${summary.distinct_tickers}`);
  console.log(`  held by exactly 1 strategy: ${summary.held_by_one_strategy}`);
  console.log(`  held by 2+ strategies:      ${summary.held_by_two_or_more}`);
  console.log("");
  console.log("=== All tickers (sorted by # strategies holding, then ticker) ===");
  for (const t of flat) {
    const names = t.held_by.map((h) => h.strategy).join(", ");
    const last = t.last_price_cents != null ? `R ${(t.last_price_cents / 100).toFixed(2)}` : "(no price)";
    const sec = t.sector ?? "—";
    console.log(
      `  ${t.ticker.padEnd(6)} ${(t.name ?? "—").padEnd(36)} ${sec.padEnd(22)} ${last.padStart(12)}  in ${t.held_by.length} → ${names}`,
    );
  }
  console.log("\n[scan-holdings] full detail → wealth-navigator/scripts/scan-holdings.json");
}

main().catch((e) => {
  console.error("[scan-holdings] failed:", e instanceof Error ? e.message : e);
  process.exit(1);
});
