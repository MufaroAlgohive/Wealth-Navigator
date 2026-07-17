"use client";

import * as React from "react";
import type { Route } from "next";
import { usePathname, useRouter } from "next/navigation";
import { ArrowUp, ArrowDown, Radio, AlertTriangle, Check, ChevronDown, Search, MoreHorizontal, Pencil, Info, Trash2, Users, Globe2, X } from "lucide-react";
import { toast } from "sonner";
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

interface StrategyOption { id: string; name: string; status: string; investorCount: number; isPublic: boolean; investorEnvironment: "LIVE" | "UAT"; shortName?: string | null; description?: string | null; riskLevel?: string | null; sector?: string | null; baseCurrency?: string | null; isFeatured?: boolean }

function StrategyBarSelect() {
  const router = useRouter();
  const root = React.useRef<HTMLDivElement>(null);
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const [options, setOptions] = React.useState<StrategyOption[]>([]);
  const [selected, setSelected] = React.useState("");
  const [menuId, setMenuId] = React.useState("");
  const [dialog, setDialog] = React.useState<"edit" | "details" | "rename" | "delete" | null>(null);
  const [target, setTarget] = React.useState<StrategyOption | null>(null);
  const [password, setPassword] = React.useState("");
  const [name, setName] = React.useState("");
  const [details, setDetails] = React.useState<Record<string, unknown> | null>(null);
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    setSelected(params.get("focus") || "");
    fetch("/api/strategies", { cache: "no-store" }).then((response) => response.json()).then((payload) => {
      setOptions(Array.isArray(payload.strategies) ? payload.strategies.map((strategy: StrategyOption) => strategy) : []);
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

  const beginAction = (action: "edit" | "details" | "rename" | "delete", option: StrategyOption) => {
    setTarget(option); setDialog(action); setPassword(""); setName(option.name); setDetails(null); setMenuId("");
  };
  const request = async (action: string, patch?: Record<string, unknown>) => {
    if (!target) return null;
    setBusy(true);
    const result = await fetch("/api/admin/strategies", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, id: target.id, password, patch }) }).then((response) => response.json()).catch(() => ({ ok: false, error: "Request failed" }));
    setBusy(false);
    if (!result.ok) { toast.error(result.error || "Strategy action failed"); return null; }
    return result;
  };
  const continueDialog = async () => {
    if (!target || !password) return;
    if (dialog === "delete") {
      const result = await request("delete"); if (!result) return;
      setOptions((rows) => rows.filter((row) => row.id !== target.id)); setDialog(null); toast.success("Strategy deleted"); return;
    }
    if (dialog === "rename") {
      const result = await request("rename", { name: name.trim() }); if (!result) return;
      setOptions((rows) => rows.map((row) => row.id === target.id ? { ...row, name: name.trim() } : row)); setDialog(null); toast.success("Strategy renamed"); return;
    }
    const result = await request("details"); if (!result) return;
    if (dialog === "edit") {
      const params = new URLSearchParams(window.location.search); params.set("tab", "builder"); params.set("edit", target.id);
      setDialog(null); router.push(`/strategies?${params.toString()}` as Route); return;
    }
    setDetails(result.strategy as Record<string, unknown>);
  };
  const saveDetails = async () => {
    if (!details) return;
    const patch = { short_name: details.short_name || null, description: details.description || null, risk_level: details.risk_level || null, sector: details.sector || null, base_currency: details.base_currency || "ZAR", investor_environment: details.investor_environment || "LIVE", is_public: Boolean(details.is_public), is_featured: Boolean(details.is_featured) };
    const result = await request("update", patch); if (!result) return;
    setOptions((rows) => rows.map((row) => row.id === target?.id ? { ...row, shortName: String(patch.short_name || "") || null, description: String(patch.description || "") || null, riskLevel: String(patch.risk_level || "") || null, sector: String(patch.sector || "") || null, investorEnvironment: patch.investor_environment as "LIVE" | "UAT", isPublic: patch.is_public, isFeatured: patch.is_featured } : row));
    setDialog(null); toast.success("Strategy details saved");
  };

  return <div ref={root} className="relative ml-auto shrink-0 font-sans"><button type="button" onClick={() => setOpen((value) => !value)} className="flex h-7 min-w-48 items-center gap-2 rounded-lg border border-primary/25 bg-primary/10 px-2.5 text-[10px] font-semibold text-foreground shadow-sm transition hover:border-primary/45 hover:bg-primary/15"><span className={cn("h-1.5 w-1.5 rounded-full", current?.investorEnvironment === "UAT" ? "bg-warning" : current?.status === "live" ? "bg-success" : "bg-muted-foreground")} /><span className="max-w-44 flex-1 truncate text-left">{current?.name || "Select strategy"}</span><ChevronDown className={cn("h-3 w-3 text-muted-foreground transition", open && "rotate-180")} /></button>{open && <div className="absolute right-0 top-9 z-[80] w-[390px] rounded-xl border border-border bg-popover text-popover-foreground shadow-2xl"><div className="relative border-b border-border p-2"><Search className="absolute left-4 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground"/><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search strategies…" className="h-8 w-full rounded-lg border border-border bg-background pl-8 pr-2 text-xs outline-none focus:border-primary"/></div><div className="max-h-[430px] overflow-y-auto p-1.5"><button type="button" onClick={() => choose("")} className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-xs hover:bg-accent"><span className="flex-1">All strategies</span>{!selected && <Check className="h-3.5 w-3.5 text-primary"/>}</button>{filtered.map((option) => <div key={option.id} className={cn("rounded-lg", selected === option.id && "bg-primary/10")}><div className="flex items-center gap-2 px-2 py-1.5"><button type="button" onClick={() => choose(option.id)} className="flex min-w-0 flex-1 items-center gap-2 text-left"><span title={option.investorEnvironment === "UAT" ? "UAT strategy" : option.status === "live" ? "Live strategy" : "Not live"} className={cn("h-2 w-2 shrink-0 rounded-full ring-2", option.investorEnvironment === "UAT" ? "bg-warning ring-warning/20" : option.status === "live" ? "bg-success ring-success/20" : "bg-muted-foreground ring-muted/30")}/><span className="min-w-0 flex-1 truncate text-xs font-semibold">{option.name}</span></button><span className={cn("rounded px-1.5 py-0.5 text-[8px] font-bold", option.investorEnvironment === "UAT" ? "bg-warning/15 text-warning" : "bg-success/15 text-success")}>{option.investorEnvironment}</span><span title={option.investorCount > 0 ? `${option.investorCount} investors` : "No investors"} className={cn("inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[8px] font-semibold", option.investorCount > 0 ? "bg-success/10 text-success" : "bg-muted text-muted-foreground")}><Users className="h-2.5 w-2.5"/>{option.investorCount || "None"}</span><span title={option.isPublic ? "Live on website" : "Private"} className={cn("inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[8px] font-semibold", option.isPublic ? "bg-info/10 text-info" : "bg-muted text-muted-foreground")}><Globe2 className="h-2.5 w-2.5"/>{option.isPublic ? "Live" : "Private"}</span>{selected === option.id && <Check className="h-3.5 w-3.5 text-primary"/>}<button type="button" aria-label={`Actions for ${option.name}`} onClick={(event) => { event.stopPropagation(); setMenuId((value) => value === option.id ? "" : option.id); }} className="flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"><MoreHorizontal className="h-3.5 w-3.5"/></button></div>{menuId === option.id && <div className="mx-2 mb-2 grid grid-cols-2 gap-1 rounded-lg border border-border bg-background p-1"><ActionButton icon={Pencil} label="Edit strategy" onClick={() => beginAction("edit", option)}/><ActionButton icon={Info} label="Strategy details" onClick={() => beginAction("details", option)}/><ActionButton icon={Pencil} label="Rename" onClick={() => beginAction("rename", option)}/><ActionButton icon={Trash2} label="Delete strategy" danger onClick={() => beginAction("delete", option)}/></div>}</div>)}{filtered.length === 0 && <p className="px-3 py-5 text-center text-[10px] text-muted-foreground">No matching strategies.</p>}</div></div>}{dialog && target && <StrategyActionDialog mode={dialog} target={target} password={password} setPassword={setPassword} name={name} setName={setName} details={details} setDetails={setDetails} busy={busy} onContinue={continueDialog} onSave={saveDetails} onClose={() => setDialog(null)}/>}</div>;
}

function ActionButton({ icon: Icon, label, danger, onClick }: { icon: React.ComponentType<{ className?: string }>; label: string; danger?: boolean; onClick: () => void }) { return <button type="button" onClick={onClick} className={cn("flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-[10px] font-medium hover:bg-accent", danger && "text-destructive hover:bg-destructive/10")}><Icon className="h-3 w-3"/>{label}</button>; }

function StrategyActionDialog({ mode, target, password, setPassword, name, setName, details, setDetails, busy, onContinue, onSave, onClose }: { mode: "edit" | "details" | "rename" | "delete"; target: StrategyOption; password: string; setPassword: (value: string) => void; name: string; setName: (value: string) => void; details: Record<string, unknown> | null; setDetails: React.Dispatch<React.SetStateAction<Record<string, unknown> | null>>; busy: boolean; onContinue: () => void; onSave: () => void; onClose: () => void }) {
  return <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/60 p-4" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><div className="w-full max-w-lg overflow-hidden rounded-2xl border border-border bg-card shadow-2xl"><div className="flex items-center justify-between border-b border-border bg-gradient-to-r from-primary/20 to-primary/5 px-5 py-4"><div><p className="text-[9px] font-bold uppercase tracking-widest text-primary">{mode === "details" ? "Strategy details" : mode === "edit" ? "Edit strategy" : mode}</p><h2 className="text-base font-bold text-foreground">{target.name}</h2></div><button type="button" onClick={onClose} className="rounded-lg p-2 text-muted-foreground hover:bg-accent"><X className="h-4 w-4"/></button></div><div className="max-h-[70vh] space-y-3 overflow-y-auto p-5">{details && mode === "details" ? <StrategyMetadataForm value={details} onChange={setDetails}/> : <>{mode === "rename" && <label className="block text-xs font-semibold">New strategy name<input value={name} onChange={(event) => setName(event.target.value)} className="mt-1 h-9 w-full rounded-lg border border-input bg-background px-3 text-sm outline-none focus:border-primary"/></label>}<p className={cn("text-xs leading-relaxed text-muted-foreground", mode === "delete" && "text-destructive")}>{mode === "delete" ? "This permanently deletes the strategy and cannot be undone." : mode === "edit" ? "Confirm your password to open the full strategy and holdings editor." : mode === "details" ? "Confirm your password to view and update strategy metadata." : "Confirm your password to rename this strategy."}</p><label className="block text-xs font-semibold">Admin password<input type="password" value={password} onChange={(event) => setPassword(event.target.value)} className="mt-1 h-9 w-full rounded-lg border border-input bg-background px-3 text-sm outline-none focus:border-primary"/></label></>}</div><div className="flex justify-end gap-2 border-t border-border px-5 py-3"><button type="button" onClick={onClose} className="rounded-lg border border-border px-3 py-2 text-xs font-semibold">Cancel</button><button type="button" disabled={busy || (!details && !password) || (mode === "rename" && !name.trim())} onClick={details && mode === "details" ? onSave : onContinue} className={cn("rounded-lg bg-primary px-4 py-2 text-xs font-bold text-primary-foreground disabled:opacity-50", mode === "delete" && "bg-destructive")}>{busy ? "Working…" : details && mode === "details" ? "Save changes" : mode === "delete" ? "Delete permanently" : "Continue"}</button></div></div></div>;
}

function StrategyMetadataForm({ value, onChange }: { value: Record<string, unknown>; onChange: React.Dispatch<React.SetStateAction<Record<string, unknown> | null>> }) {
  const field = (key: string, next: unknown) => onChange((current) => current ? { ...current, [key]: next } : current);
  return <div className="space-y-3"><div className="grid grid-cols-2 gap-3"><MetaField label="Short name"><input value={String(value.short_name ?? "")} onChange={(event) => field("short_name", event.target.value)} className="strategy-meta-input"/></MetaField><MetaField label="Risk"><select value={String(value.risk_level ?? "")} onChange={(event) => field("risk_level", event.target.value)} className="strategy-meta-input"><option value="">Unspecified</option><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option></select></MetaField></div><MetaField label="Description"><textarea rows={3} value={String(value.description ?? value.objective ?? "")} onChange={(event) => field("description", event.target.value)} className="strategy-meta-input resize-none"/></MetaField><div className="grid grid-cols-2 gap-3"><MetaField label="Sector"><input value={String(value.sector ?? "")} onChange={(event) => field("sector", event.target.value)} className="strategy-meta-input"/></MetaField><MetaField label="Investor environment"><select value={String(value.investor_environment ?? "LIVE")} onChange={(event) => field("investor_environment", event.target.value)} className="strategy-meta-input"><option value="LIVE">LIVE — real investors</option><option value="UAT">UAT — test investors</option></select></MetaField></div><div className="flex gap-5 rounded-lg border border-border p-3"><label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={Boolean(value.is_public)} onChange={(event) => field("is_public", event.target.checked)} className="accent-primary"/>Public</label><label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={Boolean(value.is_featured)} onChange={(event) => field("is_featured", event.target.checked)} className="accent-primary"/>Featured</label></div></div>;
}
function MetaField({ label, children }: { label: string; children: React.ReactNode }) { return <label className="block text-[10px] font-bold uppercase tracking-wider text-muted-foreground">{label}<div className="mt-1">{children}</div></label>; }

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
