import { useEffect } from "react";
import { cn } from "@/lib/utils";
import { ArrowDown, ArrowUp, Wifi } from "lucide-react";
import { seedTicks, useTick, useConnectionTs } from "@/lib/oemsStream";
import { globalIndices, fxQuotes, commodityQuotes, jibarFixings } from "@/lib/oemsData";

const TICKER_ITEMS = [
  { k: "J203",       label: "ALSI",      base: 87412.18, decimals: 0 },
  { k: "J200",       label: "TOP40",     base: 80115.40, decimals: 0 },
  { k: "USDZAR",     label: "USDZAR",    base: 18.4520,  decimals: 4 },
  { k: "EURZAR",     label: "EURZAR",    base: 19.8810,  decimals: 4 },
  { k: "GBPZAR",     label: "GBPZAR",    base: 23.4180,  decimals: 4 },
  { k: "Brent",      label: "BRENT",     base: 78.12,    decimals: 2 },
  { k: "Gold",       label: "GOLD",      base: 2682.40,  decimals: 2 },
  { k: "R2030",      label: "R2030",     base: 10.42,    decimals: 3, suffix: "%" },
  { k: "R2035",      label: "R2035",     base: 11.42,    decimals: 3, suffix: "%" },
  { k: "R2040",      label: "R2040",     base: 12.05,    decimals: 3, suffix: "%" },
  { k: "JIBAR3M",    label: "JIBAR 3M",  base: 8.11,     decimals: 3, suffix: "%" },
  { k: "ZARONIA",    label: "ZARONIA",   base: 7.48,     decimals: 3, suffix: "%" },
  { k: "SPX",        label: "SPX",       base: 5812.45,  decimals: 0 },
  { k: "NDX",        label: "NDX",       base: 20445.20, decimals: 0 },
];

function TickItem({ k, label, base, decimals, suffix }: { k: string; label: string; base: number; decimals: number; suffix?: string }) {
  const t = useTick(k, base);
  const up = t.changePct >= 0;
  return (
    <span className="flex items-center gap-1.5 shrink-0">
      <span className="text-muted-foreground text-[10px] uppercase tracking-wider">{label}</span>
      <span className="font-mono tabular-nums text-foreground">{t.last.toFixed(decimals)}{suffix ?? ""}</span>
      <span className={cn("flex items-center gap-0.5 text-[10px] font-mono", up ? "text-success" : "text-destructive")}>
        {up ? <ArrowUp className="h-2.5 w-2.5" /> : <ArrowDown className="h-2.5 w-2.5" />}
        {Math.abs(t.changePct).toFixed(2)}%
      </span>
    </span>
  );
}

export default function TickerBar() {
  useEffect(() => {
    const seeds: Record<string, number> = {};
    TICKER_ITEMS.forEach(i => { seeds[i.k] = i.base; });
    globalIndices.forEach(i => { seeds[i.code] = i.last; });
    fxQuotes.forEach(f => { seeds[f.pair.replace("/", "")] = f.last; });
    commodityQuotes.forEach(c => { seeds[c.name.split(" ")[0]] = c.last; });
    jibarFixings.forEach(j => { seeds[`JIBAR_${j.tenor}`] = j.rate; });
    // Seed equity prices for blotter/orders
    ["NPN","PRX","FSR","SBK","AGL","BHG","MTN","SOL","SHP","CPI","MSFT","AAPL","GFI"].forEach((s,i) => {
      const fallback = [4180.55,2295.10,78.42,226.75,552.10,528.40,108.65,162.80,281.30,2840.25,442.78,231.40,414.20][i];
      seeds[s] = fallback;
    });
    seedTicks(seeds);
  }, []);

  const ts = useConnectionTs();
  const stale = Date.now() - ts > 5000;

  return (
    <div className="flex items-center gap-4 overflow-x-auto whitespace-nowrap py-1.5 px-3 bg-[hsl(225,33%,8%)] text-[hsl(220,20%,90%)] border border-[hsl(225,20%,16%)] rounded-md text-xs">
      <span className={cn("flex items-center gap-1.5 shrink-0 text-[10px] uppercase tracking-wider", stale ? "text-warning" : "text-success")}>
        <Wifi className="h-3 w-3" />{stale ? "STALE" : "IRESS LIVE"}
      </span>
      <span className="text-[hsl(220,15%,40%)] text-[10px] shrink-0">·</span>
      {TICKER_ITEMS.map(it => <TickItem key={it.k} {...it} />)}
    </div>
  );
}
