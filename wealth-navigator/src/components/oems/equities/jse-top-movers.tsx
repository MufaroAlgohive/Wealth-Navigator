"use client";

/**
 * JSE Top Movers with column-level filters + time-range pill (A7.2).
 *
 * Filters are client-side only — the `/api/equities` BFF returns the full
 * retail `securities_c` snapshot and we slice in the browser. No BFF
 * changes are needed; this keeps the wiring simple and matches the
 * fiscal.ai-style filtering experience on the Analysis tab.
 *
 * Filters:
 *   - sector (Select, "All sectors" + the universe's distinct sectors)
 *   - name search (Input, matches symbol OR name)
 *   - last price range (two numeric inputs, in Rands)
 *   - performance range (two numeric inputs, in percent)
 * Time-range pill:
 *   - 1D | 1M | 6M — re-orders the movers list by the matching trailing
 *     return (`change_percent` for 1D, `return_1m` for 1M, `return_6m`
 *     for 6M) and re-slices gainers + losers.
 */

import { Search } from "lucide-react";
import { useMemo, useState } from "react";

import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/cn";
import { formatPct, formatZAR } from "@/lib/format";

interface UniverseSecurity {
  symbol: string;
  name: string | null;
  sector: string | null;
  last_price: number | null;
  change_percent: number | null;
  return_1m?: number | null;
  return_6m?: number | null;
}

type Range = "1D" | "1M" | "6M";

function bareSymbol(symbol: string): string {
  return symbol.replace(/\.JO$/i, "");
}

function perfFor(s: UniverseSecurity, range: Range): number | null {
  if (range === "1D") return s.change_percent ?? null;
  if (range === "1M") return s.return_1m ?? null;
  return s.return_6m ?? null;
}

export function JseTopMovers({ universe }: { universe: UniverseSecurity[] }) {
  const [range, setRange] = useState<Range>("1D");
  const [sector, setSector] = useState<string>("all");
  const [search, setSearch] = useState("");
  const [priceMin, setPriceMin] = useState<string>("");
  const [priceMax, setPriceMax] = useState<string>("");
  const [perfMin, setPerfMin] = useState<string>("");
  const [perfMax, setPerfMax] = useState<string>("");

  const sectors = useMemo(() => {
    const set = new Set<string>();
    for (const s of universe) {
      if (s.sector) set.add(s.sector);
    }
    return Array.from(set).sort();
  }, [universe]);

  const filtered = useMemo(() => {
    const ql = search.trim().toLowerCase();
    const pMin = priceMin === "" ? Number.NEGATIVE_INFINITY : Number(priceMin);
    const pMax = priceMax === "" ? Number.POSITIVE_INFINITY : Number(priceMax);
    const pfMin = perfMin === "" ? Number.NEGATIVE_INFINITY : Number(perfMin);
    const pfMax = perfMax === "" ? Number.POSITIVE_INFINITY : Number(perfMax);
    return universe.filter((s) => {
      if (sector !== "all" && s.sector !== sector) return false;
      if (ql) {
        const haystack = `${bareSymbol(s.symbol)} ${s.name ?? ""}`.toLowerCase();
        if (!haystack.includes(ql)) return false;
      }
      const lastRands = s.last_price != null ? s.last_price / 100 : null;
      if (lastRands != null && Number.isFinite(lastRands)) {
        if (lastRands < pMin || lastRands > pMax) return false;
      }
      const perf = perfFor(s, range);
      if (perf != null && Number.isFinite(perf)) {
        if (perf < pfMin || perf > pfMax) return false;
      }
      return true;
    });
  }, [universe, sector, search, priceMin, priceMax, perfMin, perfMax, range]);

  // Top movers are the top-4 gainers + top-4 losers (by the active range)
  // from the filtered set. When a range has no return column populated yet
  // the slice is empty — the empty-state copy makes that explicit.
  const movers = useMemo(() => {
    const withPerf = filtered.filter((s) => Number.isFinite(perfFor(s, range)));
    if (withPerf.length === 0) return [];
    const gainers = [...withPerf]
      .sort((a, b) => (perfFor(b, range) ?? 0) - (perfFor(a, range) ?? 0))
      .slice(0, 4);
    const losers = [...withPerf]
      .sort((a, b) => (perfFor(a, range) ?? 0) - (perfFor(b, range) ?? 0))
      .slice(0, 4)
      .reverse();
    const seen = new Set<string>();
    return [...gainers, ...losers].filter((s) => {
      if (seen.has(s.symbol)) return false;
      seen.add(s.symbol);
      return true;
    });
  }, [filtered, range]);

  const rangeLabel = range === "1D" ? "1D" : range === "1M" ? "1M" : "6M";
  const hasPerf = movers.length > 0;

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-center gap-2 px-5 pt-4">
        <TimeRange value={range} onChange={setRange} />
        <div className="flex-1" />
        <span className="font-mono text-[10px] text-muted-foreground">
          {filtered.length}/{universe.length} match · {movers.length} movers · {rangeLabel}
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-2 px-5 pt-3">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Symbol or name…"
            className="h-7 w-40 pl-7 text-xs"
            aria-label="Search symbol or name"
          />
        </div>
        <Select value={sector} onValueChange={setSector}>
          <SelectTrigger className="h-7 w-[160px] text-xs" aria-label="Filter by sector">
            <SelectValue placeholder="All sectors" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All sectors</SelectItem>
            {sectors.map((s) => (
              <SelectItem key={s} value={s}>
                {s}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <RangeInput label="Price R" min={priceMin} max={priceMax} onMin={setPriceMin} onMax={setPriceMax} />
        <RangeInput label="Perf %" min={perfMin} max={perfMax} onMin={setPerfMin} onMax={setPerfMax} />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-5 pt-3 scrollbar-thin">
        {!hasPerf ? (
          <p className="rounded-xl border border-dashed border-[hsl(var(--glass-border))] p-4 text-center text-[11px] text-muted-foreground">
            No movers match these filters in the {rangeLabel} window.
            {range !== "1D" ? " Trailing-period returns are populated by the worker — try 1D for now." : ""}
          </p>
        ) : (
          <ul className="glass-inset divide-y divide-[hsl(var(--glass-border))]/60 overflow-hidden">
            {movers.map((m) => {
              const perf = perfFor(m, range) ?? 0;
              const up = perf > 0;
              const down = perf < 0;
              const price = m.last_price != null ? m.last_price / 100 : null;
              return (
                <li
                  key={m.symbol}
                  className="flex items-center gap-2 px-3 py-2 transition-colors hover:bg-[hsl(var(--primary)/0.04)]"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-mono text-xs font-semibold">{bareSymbol(m.symbol)}</p>
                    <p className="truncate text-[9.5px] text-muted-foreground">
                      {m.name ?? bareSymbol(m.symbol)}
                      {m.sector ? ` · ${m.sector}` : ""}
                    </p>
                  </div>
                  <span className="shrink-0 font-mono text-[11px] tabular-nums text-foreground">
                    {price != null ? formatZAR(price) : "—"}
                  </span>
                  <span
                    className={cn(
                      "ml-1 shrink-0 font-mono text-[11px] tabular-nums",
                      up ? "text-up" : down ? "text-down" : "text-muted-foreground",
                    )}
                  >
                    {formatPct(perf)}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

function TimeRange({ value, onChange }: { value: Range; onChange: (r: Range) => void }) {
  const opts: Array<[Range, string]> = [
    ["1D", "1D"],
    ["1M", "1M"],
    ["6M", "6M"],
  ];
  return (
    <div className="glass-inset inline-flex p-0.5">
      {opts.map(([id, label]) => (
        <button
          key={id}
          type="button"
          onClick={() => onChange(id)}
          className={cn(
            "h-6 rounded-md px-2.5 text-[11px] font-medium transition-all duration-150 ease-out",
            value === id
              ? "bg-primary text-primary-foreground shadow-[0_2px_12px_hsl(var(--primary)/0.35)]"
              : "text-muted-foreground hover:text-foreground",
          )}
          aria-pressed={value === id}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

function RangeInput({
  label,
  min,
  max,
  onMin,
  onMax,
}: {
  label: string;
  min: string;
  max: string;
  onMin: (v: string) => void;
  onMax: (v: string) => void;
}) {
  return (
    <div className="flex items-center gap-1">
      <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">{label}</span>
      <Input
        value={min}
        onChange={(e) => onMin(e.target.value)}
        type="number"
        inputMode="decimal"
        placeholder="min"
        className="h-7 w-16 text-xs"
        aria-label={`${label} min`}
      />
      <span className="text-muted-foreground/60">–</span>
      <Input
        value={max}
        onChange={(e) => onMax(e.target.value)}
        type="number"
        inputMode="decimal"
        placeholder="max"
        className="h-7 w-16 text-xs"
        aria-label={`${label} max`}
      />
    </div>
  );
}
