"use client";

/**
 * Ticker typeahead for the Analysis tab. Debounced search across the SA/JSE
 * universe (our IRESS-backed securities_c) and US/global (Yahoo), with a
 * keyboard-navigable dropdown. Selecting a row (or pressing Enter on an exact
 * ticker) loads that company. Real symbols only.
 */

import { useQuery } from "@tanstack/react-query";
import { Loader2, Search } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Pill } from "@/components/oems/primitives/pill";
import type { SymbolHit } from "@/lib/company-analysis/yahoo";
import { cn } from "@/lib/cn";
import { queryOpts } from "@/lib/store/query-provider";

interface SearchResponse {
  ok: boolean;
  query: string;
  results: SymbolHit[];
  saCount: number;
  yahooCount: number;
}

export function TickerSearch({ current, onSelect }: { current: string; onSelect: (symbol: string) => void }) {
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const boxRef = useRef<HTMLDivElement | null>(null);

  // Debounce keystrokes before hitting the search BFF.
  useEffect(() => {
    const id = setTimeout(() => setDebounced(query.trim()), 220);
    return () => clearTimeout(id);
  }, [query]);

  // Close on outside click.
  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  const q = useQuery<SearchResponse>({
    queryKey: ["ticker-search", debounced],
    queryFn: async () => {
      const r = await fetch(`/api/company-analysis/search?q=${encodeURIComponent(debounced)}`, { cache: "no-store" });
      if (!r.ok) throw new Error(`search ${r.status}`);
      return r.json();
    },
    ...queryOpts("reference"),
    enabled: debounced.length >= 1,
    staleTime: 60_000,
  });

  const results = q.data?.results ?? [];
  useEffect(() => setHighlight(0), [debounced]);

  const choose = (hit: SymbolHit) => {
    setQuery("");
    setDebounced("");
    setOpen(false);
    onSelect(hit.symbol);
  };

  const submitRaw = () => {
    const v = query.trim().toUpperCase();
    if (!v) return;
    setOpen(false);
    onSelect(v);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setOpen(true);
      setHighlight((h) => Math.min(h + 1, Math.max(0, results.length - 1)));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlight((h) => Math.max(h - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const hit = results[highlight];
      if (open && hit) choose(hit);
      else submitRaw();
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  };

  return (
    <div ref={boxRef} className="relative">
      <div className="glass-inset flex h-10 items-center gap-2 rounded-xl px-3">
        {q.isFetching && debounced ? (
          <Loader2 className="h-4 w-4 animate-spin text-primary" />
        ) : (
          <Search className="h-4 w-4 text-muted-foreground" />
        )}
        <input
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onFocus={() => query && setOpen(true)}
          onKeyDown={onKeyDown}
          placeholder="Search any company — Tesla, TSLA, Naspers, NPN…"
          aria-label="Search a company or ticker"
          autoComplete="off"
          spellCheck={false}
          className="w-64 bg-transparent text-sm outline-none placeholder:text-muted-foreground/60"
        />
      </div>

      {open && debounced.length >= 1 ? (
        <div className="glass-panel absolute z-50 mt-1.5 max-h-80 w-[min(28rem,90vw)] overflow-y-auto rounded-xl border border-[hsl(var(--glass-border))] p-1.5 shadow-2xl scrollbar-thin">
          {q.isLoading ? (
            <div className="flex items-center gap-2 px-3 py-3 text-caption text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> Searching SA + global…
            </div>
          ) : results.length === 0 ? (
            <div className="px-3 py-3 text-caption text-muted-foreground">
              No match for “{debounced}”. Press Enter to try it as an exact ticker.
            </div>
          ) : (
            <ul role="listbox">
              {results.map((hit, i) => (
                <li key={`${hit.source}-${hit.symbol}`} role="option" aria-selected={i === highlight}>
                  <button
                    type="button"
                    onMouseEnter={() => setHighlight(i)}
                    onClick={() => choose(hit)}
                    className={cn(
                      "flex w-full items-center justify-between gap-3 rounded-lg px-3 py-2 text-left transition-colors",
                      i === highlight ? "bg-primary/10" : "hover:bg-[hsl(var(--primary)/0.05)]",
                    )}
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      <span className="font-mono text-sm font-semibold">{hit.display}</span>
                      <span className="truncate text-[12px] text-muted-foreground">{hit.name}</span>
                    </span>
                    <span className="flex shrink-0 items-center gap-1.5">
                      {hit.type === "ETF" ? (
                        <Pill tone="neutral" size="xs">
                          ETF
                        </Pill>
                      ) : null}
                      <Pill tone={hit.source === "iress" ? "success" : "info"} size="xs">
                        {hit.source === "iress" ? "JSE" : hit.exchange || "Yahoo"}
                      </Pill>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {results.length > 0 ? (
            <p className="px-3 py-1.5 font-mono text-[9.5px] text-muted-foreground/70">
              {q.data?.saCount ?? 0} SA (IRESS) · {q.data?.yahooCount ?? 0} global (Yahoo) · current: {current}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
