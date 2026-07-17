"use client";

import * as React from "react";
import type { Route } from "next";
import { usePathname, useRouter } from "next/navigation";
import { ArrowUp, ArrowDown, Radio, AlertTriangle, Check, ChevronDown, Search } from "lucide-react";
import { cn } from "@/lib/cn";
import { useTick, useLastTickTs, useQuoteFeedKind, type TickFeedKind } from "@/lib/store/tick-stream-provider";
import { isRealDataOnlyClient } from "@/lib/data-policy";
import { useLiveQuotes } from "@/lib/hooks/use-live-quotes";
import { Badge } from "@/components/ui/badge";
import { Pill } from "@/components/oems/primitives/pill";
import { WORKER_TRACKED_SYMBOL_SET } from "@/lib/iress/universe";

const FEED_LABELS = {
  supabase: "SUPABASE",
  stream: "STREAM",
  mock: "MOCK",
} as const;

/** Symbols the worker may have Supabase ticks for — derived from the shared
 *  `JSE_TRACKED_UNIVERSE` so the UI never subscribes to a name the worker
 *  isn't polling. The static hardcoded set used to be a 10-name slice of
 *  the worker watchlist that excluded the rate codes; the shared module
 *  is now the single source of truth. */
const WORKER_WATCHLIST = WORKER_TRACKED_SYMBOL_SET;

interface TickerItem {
  k: string;
  label: string;
  decimals: number;
  suffix?: string;
  base: number;
  prev: number;
}

const DEFAULT_ITEMS: TickerItem[] = [
  { k: "J203",     label: "ALSI",     decimals: 0,  base: 87412.18, prev: 86990.88 },
  { k: "J200",     label: "TOP40",    decimals: 0,  base: 80115.40, prev: 79727.30 },
  { k: "USDZAR",   label: "USDZAR",   decimals: 4,  base: 18.452,   prev: 18.494 },
  { k: "EURZAR",   label: "EURZAR",   decimals: 4,  base: 19.881,   prev: 19.860 },
  { k: "GBPZAR",   label: "GBPZAR",   decimals: 4,  base: 23.452,   prev: 23.408 },
  { k: "Gold",     label: "GOLD",     decimals: 0,  base: 2682.40,  prev: 2664.10 },
  { k: "Brent",    label: "BRENT",    decimals: 2,  base: 78.12,    prev: 78.57 },
  { k: "R2030",    label: "R2030",    decimals: 3,  suffix: "%", base: 10.42, prev: 10.38 },
  { k: "R2035",    label: "R2035",    decimals: 3,  suffix: "%", base: 11.42, prev: 11.40 },
  { k: "R2040",    label: "R2040",    decimals: 3,  suffix: "%", base: 12.05, prev: 12.01 },
  { k: "JIBAR_3M", label: "JIBAR 3M", decimals: 3,  suffix: "%", base: 8.11,  prev: 8.14 },
  { k: "ZARONIA",  label: "ZARONIA",  decimals: 3,  suffix: "%", base: 7.48,  prev: 7.50 },
  { k: "SPX",      label: "S&P 500",  decimals: 0,  base: 5812.45,  prev: 5788.27 },
  { k: "NDX",      label: "NDX",      decimals: 0,  base: 20445.20, prev: 20302.65 },
  { k: "NPN",      label: "NPN",      decimals: 2,  base: 4180.55,  prev: 4158.30 },
  { k: "AGL",      label: "AGL",      decimals: 2,  base: 552.10,   prev: 539.70 },
];

function isIndexOrFxSymbol(k: string): boolean {
  return !WORKER_WATCHLIST.has(k);
}

export function TickerBar({ items = DEFAULT_ITEMS }: { items?: TickerItem[] }) {
  const pathname = usePathname();
  const realDataOnly = isRealDataOnlyClient();
  const watchlistSyms = items.filter((it) => WORKER_WATCHLIST.has(it.k)).map((it) => it.k);
  useLiveQuotes(realDataOnly ? watchlistSyms : []);

  const last = useLastTickTs();
  const feedKind = useQuoteFeedKind();
  const age = Math.max(0, Date.now() - last);
  const stale = age > 20_000;
  const fresh = age < 5_000;

  const feedLabel = FEED_LABELS[feedKind];
  const badgeVariant = stale ? "warning" : feedKind === "mock" ? "secondary" : "live";

  const visibleItems = realDataOnly
    ? items.filter((it) => !isIndexOrFxSymbol(it.k))
    : items;
  const hasHiddenSim = realDataOnly && items.some((it) => isIndexOrFxSymbol(it.k));

  return (
    <div className="relative z-40 flex items-center gap-2 overflow-visible whitespace-nowrap border-y border-border bg-surface-2/60 py-1.5 pl-3 pr-3 text-[11px] font-mono text-foreground/80">
      <div className="flex min-w-0 flex-1 items-center gap-3 overflow-x-auto scrollbar-thin mask-fade-x">
      <Badge variant={badgeVariant} className="shrink-0">
        {stale ? <AlertTriangle className="h-2.5 w-2.5" /> : fresh ? <Radio className="h-2.5 w-2.5 animate-pulse" /> : null}
        {stale ? "STALE" : feedLabel}
      </Badge>
      <span className="shrink-0 text-muted-foreground/60">·</span>
      {visibleItems.map((it) => (
        <TickerChipMaybe key={it.k} item={it} feedKind={feedKind} realDataOnly={realDataOnly} />
      ))}
      {hasHiddenSim && (
        <>
          <span className="shrink-0 text-muted-foreground/60">·</span>
          <Pill tone="neutral" size="xs" dot>
            FX/INDICES OFF
          </Pill>
        </>
      )}
      </div>
      {pathname === "/strategies" && <StrategyBarSelect />}
    </div>
  );
}

interface StrategyOption { id: string; name: string; status: string }

function StrategyBarSelect() {
  const router = useRouter();
  const root = React.useRef<HTMLDivElement>(null);
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const [options, setOptions] = React.useState<StrategyOption[]>([]);
  const [selected, setSelected] = React.useState("");

  React.useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    setSelected(params.get("focus") || "");
    fetch("/api/strategies", { cache: "no-store" }).then((response) => response.json()).then((payload) => {
      setOptions(Array.isArray(payload.strategies) ? payload.strategies.map((strategy: StrategyOption) => ({ id: strategy.id, name: strategy.name, status: strategy.status })) : []);
    }).catch(() => setOptions([]));
  }, []);

  React.useEffect(() => {
    const close = (event: MouseEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);

  const choose = (id: string) => {
    setSelected(id); setOpen(false); setQuery("");
    const params = new URLSearchParams(window.location.search);
    if (id) params.set("focus", id); else params.delete("focus");
    const destination = `/strategies${params.size ? `?${params.toString()}` : ""}` as Route;
    router.push(destination);
  };
  const current = options.find((option) => option.id === selected);
  const filtered = options.filter((option) => option.name.toLowerCase().includes(query.trim().toLowerCase()));

  return <div ref={root} className="relative ml-auto shrink-0 font-sans"><button type="button" onClick={() => setOpen((value) => !value)} className="flex h-7 min-w-48 items-center gap-2 rounded-lg border border-primary/25 bg-primary/10 px-2.5 text-[10px] font-semibold text-foreground shadow-sm transition hover:border-primary/45 hover:bg-primary/15"><span className={cn("h-1.5 w-1.5 rounded-full", current?.status === "live" ? "bg-success" : "bg-muted-foreground")} /><span className="max-w-44 flex-1 truncate text-left">{current?.name || "Select strategy"}</span><ChevronDown className={cn("h-3 w-3 text-muted-foreground transition", open && "rotate-180")} /></button>{open && <div className="absolute right-0 top-9 z-[80] w-72 overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground shadow-2xl"><div className="relative border-b border-border p-2"><Search className="absolute left-4 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground"/><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search strategies…" className="h-8 w-full rounded-lg border border-border bg-background pl-8 pr-2 text-xs outline-none focus:border-primary"/></div><div className="max-h-72 overflow-y-auto p-1.5"><button type="button" onClick={() => choose("")} className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-xs hover:bg-accent"><span className="flex-1">All strategies</span>{!selected && <Check className="h-3.5 w-3.5 text-primary"/>}</button>{filtered.map((option) => <button key={option.id} type="button" onClick={() => choose(option.id)} className={cn("flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-xs hover:bg-accent", selected === option.id && "bg-primary/10")}><span className={cn("h-1.5 w-1.5 rounded-full", option.status === "live" ? "bg-success" : "bg-muted-foreground")}/><span className="min-w-0 flex-1 truncate">{option.name}</span>{selected === option.id && <Check className="h-3.5 w-3.5 text-primary"/>}</button>)}{filtered.length === 0 && <p className="px-3 py-5 text-center text-[10px] text-muted-foreground">No matching strategies.</p>}</div></div>}</div>;
}

function TickerChipMaybe({
  item,
  feedKind,
  realDataOnly,
}: {
  item: TickerItem;
  feedKind: TickFeedKind;
  realDataOnly: boolean;
}) {
  const t = useTick(item.k);
  if (realDataOnly && t.ts === 0) return null;
  return <TickerChip item={item} feedKind={feedKind} />;
}

function TickerChip({ item, feedKind }: { item: TickerItem; feedKind: TickFeedKind }) {
  const t = useTick(item.k);
  // Fall back to the seed's `base` when no live tick has arrived (t.ts === 0)
  // so the displayed value AND the change derive from the same number. Without
  // this, an un-seeded symbol (e.g. GBPJPY, never in the local sim) showed its
  // base value but computed change from t.last = 0 → a bogus −100.00%.
  const displayLast = t.ts > 0 ? t.last : item.base;
  const change =
    feedKind === "supabase" ? t.change : displayLast - item.prev;
  const changePct =
    feedKind === "supabase"
      ? t.changePct
      : item.prev > 0
        ? (change / item.prev) * 100
        : 0;
  const isUp = change > 0;
  const isDown = change < 0;

  return (
    <span className="flex shrink-0 items-center gap-1.5">
      <span className="text-[9.5px] uppercase tracking-wider text-muted-foreground/80">{item.label}</span>
      <span className="font-semibold tabular-nums text-foreground">
        {displayLast.toLocaleString("en-ZA", { minimumFractionDigits: item.decimals, maximumFractionDigits: item.decimals })}
        {item.suffix ?? ""}
      </span>
      <span
        className={cn(
          "flex items-center gap-0.5 text-[10px] tabular-nums",
          isUp && "text-up",
          isDown && "text-down",
          !isUp && !isDown && "text-muted-foreground/70",
        )}
      >
        {t.ts > 0 ? (
          <>
            {isUp ? <ArrowUp className="h-2.5 w-2.5" /> : isDown ? <ArrowDown className="h-2.5 w-2.5" /> : null}
            {Math.abs(changePct).toFixed(2)}%
          </>
        ) : feedKind === "mock" ? (
          <>
            {isUp ? <ArrowUp className="h-2.5 w-2.5" /> : isDown ? <ArrowDown className="h-2.5 w-2.5" /> : null}
            {Math.abs(changePct).toFixed(2)}%
          </>
        ) : (
          <span>—</span>
        )}
      </span>
    </span>
  );
}
