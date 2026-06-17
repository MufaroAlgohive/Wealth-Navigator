"use client";

// OEMS command palette (⌘K). A small context exposes `open` / `setOpen` /
// `toggle` so the top-bar's trigger button can open the dialog without
// prop-drilling, and the provider itself renders the dialog (so it lives
// at the layout root, sibling to the top-bar).

import * as React from "react";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import type { Route } from "next";
import { Command as CommandIcon, CornerDownLeft } from "lucide-react";

import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from "@/components/ui/command";
import { DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Pill } from "@/components/oems/primitives/pill";
import { useIress } from "@/lib/iress/provider";
import { cn } from "@/lib/cn";

// `NAV` is a hand-mirror of the structure in `shell/side-nav.tsx` so we
// don't have to touch that file (owned by another worker). The `to` strings
// must match — when side-nav gains or renames an entry, mirror the change
// here.
interface NavItem { to: string; label: string }
const NAV: { title: string; items: NavItem[] }[] = [
  {
    title: "Cockpit",
    items: [
      { to: "/oems",             label: "Overview" },
      { to: "/oems/blotter",     label: "Blotter" },
      { to: "/oems/strategies",  label: "Strategies" },
    ],
  },
  {
    title: "Markets",
    items: [
      { to: "/oems/equities",     label: "Equities" },
      { to: "/oems/fixed-income", label: "Fixed Income" },
      { to: "/oems/money-market", label: "Money Market" },
      { to: "/oems/curves",       label: "Curves" },
    ],
  },
  {
    title: "Intelligence",
    items: [
      { to: "/oems/macro",         label: "Macro" },
      { to: "/oems/news",          label: "News & SENS" },
      { to: "/oems/research-lab",  label: "Research Lab" },
      { to: "/oems/security",      label: "Security" },
    ],
  },
  {
    title: "System",
    items: [
      { to: "/oems/integration", label: "Integration" },
    ],
  },
];

// ─── Context ─────────────────────────────────────────────────────────────

interface CommandPaletteApi {
  open: boolean;
  setOpen: (v: boolean) => void;
  toggle: () => void;
}

const CommandPaletteContext = React.createContext<CommandPaletteApi | null>(null);

export function useCommandPalette(): CommandPaletteApi {
  const ctx = React.useContext(CommandPaletteContext);
  if (!ctx) throw new Error("useCommandPalette must be used within CommandPaletteProvider");
  return ctx;
}

// ─── Provider ────────────────────────────────────────────────────────────

export function CommandPaletteProvider({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = React.useState(false);

  // ⌘K / ⌘P (and their Ctrl aliases) toggles the palette. GitHub-style
  // muscle memory: both shortcuts do the same thing.
  React.useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const isMod = e.metaKey || e.ctrlKey;
      if (!isMod) return;
      const k = e.key.toLowerCase();
      if (k !== "k" && k !== "p") return;
      // Don't fight the browser's own ⌘P (print) inside editable surfaces.
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      e.preventDefault();
      setOpen((v) => !v);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const api = React.useMemo<CommandPaletteApi>(
    () => ({ open, setOpen, toggle: () => setOpen((v) => !v) }),
    [open],
  );

  return (
    <CommandPaletteContext.Provider value={api}>
      {children}
      <CommandPaletteDialog open={open} onOpenChange={setOpen} />
    </CommandPaletteContext.Provider>
  );
}

// ─── Dialog ──────────────────────────────────────────────────────────────

function CommandPaletteDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  return (
    <CommandDialog open={open} onOpenChange={onOpenChange}>
      {/* Visually hidden — Radix DialogContent needs a Title for screen readers. */}
      <DialogTitle className="sr-only">Command palette</DialogTitle>
      <DialogDescription className="sr-only">
        Search instruments, strategies, orders, and pages.
      </DialogDescription>
      <CommandInput
        placeholder="Type to search… instruments, strategies, orders, pages."
        autoFocus
      />
      <CommandList className="max-h-[420px]">
        <CommandEmpty>No results.</CommandEmpty>
        <PaletteResults onSelect={() => onOpenChange(false)} />
      </CommandList>
      <PaletteFooter />
    </CommandDialog>
  );
}

function PaletteFooter() {
  return (
    <div className="flex items-center justify-between border-t border-border/60 bg-surface-2/40 px-3 py-1.5 text-[10px] text-muted-foreground">
      <div className="flex items-center gap-3">
        <span className="flex items-center gap-1">
          <Kbd>↑</Kbd>
          <Kbd>↓</Kbd>
          navigate
        </span>
        <span className="flex items-center gap-1">
          <CornerDownLeft className="h-3 w-3" />
          open
        </span>
        <span className="flex items-center gap-1">
          <Kbd>esc</Kbd>
          close
        </span>
      </div>
      <span className="flex items-center gap-1 font-mono">
        <CommandIcon className="h-3 w-3" />K
      </span>
    </div>
  );
}

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="inline-flex h-4 min-w-[16px] items-center justify-center rounded border border-border bg-card px-1 font-mono text-[9.5px] text-muted-foreground">
      {children}
    </kbd>
  );
}

// ─── Results (fuzzy across NAV, instruments, strategies, orders) ───────

function PaletteResults({ onSelect }: { onSelect: () => void }) {
  const { data } = useIress();
  const equitiesQ = useQuery({ queryKey: ["equities"], queryFn: () => data.jseEquities() });
  const strategiesQ = useQuery({ queryKey: ["strategies"], queryFn: () => data.strategies() });
  const ordersQ = useQuery({ queryKey: ["orders"], queryFn: () => data.orders() });
  const router = useRouter();

  const groups: { heading: string; items: PaletteItem[] }[] = React.useMemo(() => {
    const navItems: PaletteItem[] = NAV.flatMap((s) =>
      s.items.map((i) => ({
        key: `nav:${i.to}`,
        label: i.label,
        hint: i.to,
        section: s.title,
        onSelect: () => {
          router.push(i.to as Route);
          onSelect();
        },
      })),
    );
    const equities = (equitiesQ.data ?? []).slice(0, 30).map<PaletteItem>((e) => ({
      key: `eq:${e.symbol}`,
      label: e.symbol,
      hint: `${e.name} · ${e.sector}`,
      section: e.exchange,
      onSelect: () => {
        router.push(`/oems/security?sym=${encodeURIComponent(e.symbol)}` as Route);
        onSelect();
      },
    }));
    const strategies = (strategiesQ.data ?? []).map<PaletteItem>((s) => ({
      key: `strat:${s.id}`,
      label: s.name,
      hint: s.manager,
      section: s.kind.toUpperCase(),
      right: (
        <Pill
          tone={s.status === "live" ? "success" : s.status === "paper" ? "neutral" : "destructive"}
          size="xs"
          dot
        >
          {s.status}
        </Pill>
      ),
      onSelect: () => {
        router.push(`/oems/strategies?focus=${encodeURIComponent(s.id)}` as Route);
        onSelect();
      },
    }));
    const orders = (ordersQ.data ?? []).slice(0, 25).map<PaletteItem>((o) => ({
      key: `ord:${o.id}`,
      label: `${o.side} ${o.symbol} · ${o.qty.toLocaleString()}`,
      hint: `${o.id} · ${o.strategy} · ${o.state}`,
      section: o.destination,
      right: <OrderSideTone side={o.side}>{o.side}</OrderSideTone>,
      onSelect: () => {
        router.push(`/oems/blotter?focus=${encodeURIComponent(o.id)}` as Route);
        onSelect();
      },
    }));

    return [
      { heading: "Navigation", items: navItems },
      { heading: "Equities",   items: equities },
      { heading: "Strategies", items: strategies },
      { heading: "Orders",     items: orders },
    ];
  }, [equitiesQ.data, strategiesQ.data, ordersQ.data, router, onSelect]);

  // While the queries are loading there's nothing to show — let cmdk
  // render the empty state.
  const hasAny = groups.some((g) => g.items.length > 0);
  if (!hasAny) return null;

  return (
    <>
      {groups.map((g) =>
        g.items.length === 0 ? null : (
          <CommandGroup key={g.heading} heading={g.heading}>
            {g.items.map((it) => (
              <CommandItem
                key={it.key}
                value={`${it.label} ${it.hint} ${it.section}`}
                onSelect={it.onSelect}
              >
                <div className="flex min-w-0 flex-1 items-center gap-2">
                  <span className="truncate font-mono text-[12px] font-semibold">{it.label}</span>
                  <span className="truncate text-[11px] text-muted-foreground">· {it.hint}</span>
                </div>
                {it.right}
                <CommandShortcut className="font-mono text-[9.5px] text-muted-foreground/70">
                  {it.section}
                </CommandShortcut>
              </CommandItem>
            ))}
          </CommandGroup>
        ),
      )}
    </>
  );
}

function OrderSideTone({ side, children }: { side: "BUY" | "SELL"; children: React.ReactNode }) {
  return (
    <span
      className={cn(
        "rounded border px-1.5 py-0.5 font-mono text-[9.5px] tracking-wider",
        side === "BUY"
          ? "border-success/30 bg-success/10 text-success"
          : "border-destructive/30 bg-destructive/10 text-destructive",
      )}
    >
      {children}
    </span>
  );
}

interface PaletteItem {
  key: string;
  label: string;
  hint: string;
  section: string;
  right?: React.ReactNode;
  onSelect: () => void;
}
