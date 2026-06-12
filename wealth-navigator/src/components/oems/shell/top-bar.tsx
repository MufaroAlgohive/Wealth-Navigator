"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import type { Route } from "next";
import {
  Command, Search, Moon, Sun, ChevronDown, Bell, LogOut, Settings, Sparkles,
  TrendingUp, Briefcase, HeartPulse, Shield, Building2, LineChart, Users,
  Activity, Layers, ClipboardList, Banknote, Globe2, Newspaper, Cable,
  Landmark, UserCheck, FileCheck,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel,
  DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { useTheme } from "next-themes";
import { toast } from "sonner";
import {
  usePersona, useSetPersona, useUser, useResetSession, PERSONA_USERS,
  type Persona,
} from "@/lib/store/session-provider";
import { isJseOpen } from "@/lib/sa-holidays";
import { cn } from "@/lib/cn";
import { ConnectionPill } from "@/components/oems/primitives/connection-pill";
import { ProvenanceStrip } from "@/components/oems/shell/provenance-strip";
import { notifyAuthChange } from "@/lib/auth/store";
import { useCommandPalette } from "@/components/oems/command-palette";

const PERSONA_LABEL: Record<Persona, { label: string; home: string; icon: React.ElementType }> = {
  oems:           { label: "OEMS · Trading Desk",     home: "/oems",          icon: Activity },
  strategist:     { label: "Strategist",             home: "/strategist",    icon: LineChart },
  wealth_manager: { label: "Wealth Manager",         home: "/wm",            icon: Briefcase },
  admin:          { label: "Admin / Compliance",     home: "/admin",         icon: Shield },
  business:       { label: "Business",               home: "/business",      icon: Building2 },
  funeral_cover:  { label: "Funeral Cover",          home: "/fc/overview",   icon: HeartPulse },
};

export function TopBar() {
  const router = useRouter();
  const persona = usePersona();
  const setPersona = useSetPersona();
  const resetSession = useResetSession();
  const user = useUser();
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = React.useState(false);
  const [now, setNow] = React.useState<Date>(() => new Date());
  const [signingOut, setSigningOut] = React.useState(false);
  const marketOpen = isJseOpen(now);

  const handleSignOut = React.useCallback(async () => {
    if (signingOut) return;
    setSigningOut(true);
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } catch {
      // The cookie clear is best-effort; even if the request fails we
      // want the local persona to reset and the user to be sent back to
      // /login. The middleware will catch them there if the cookie is
      // still present.
    }
    resetSession();
    notifyAuthChange();
    setSigningOut(false);
    toast.success("Signed out", { description: "See you on the next session." });
    router.replace("/login");
  }, [router, resetSession, signingOut]);

  React.useEffect(() => { setMounted(true); }, []);
  React.useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(id);
  }, []);

  const meta = PERSONA_LABEL[persona];

  return (
    <header className="sticky top-0 z-40 flex h-12 shrink-0 items-center gap-3 border-b border-border bg-card/85 px-4 backdrop-blur-md">
      <Link href="/oems" className="flex items-center gap-2.5">
        <Logo />
        <div className="hidden flex-col leading-tight md:flex">
          <span className="text-xs font-semibold tracking-tight">Mint Wealth Navigator</span>
          <span className="font-mono text-[9px] uppercase tracking-wider text-muted-foreground">v2.0 · institutional</span>
        </div>
      </Link>

      <div className="ml-1 flex h-7 items-center gap-1.5 rounded-md border border-border bg-secondary/60 px-2 font-mono text-[11px] text-muted-foreground">
        <span className="h-1.5 w-1.5 rounded-full bg-success" />
        JSE
        <span className="text-foreground">{marketOpen ? "OPEN" : "CLOSED"}</span>
        <span className="text-muted-foreground/60">·</span>
        <span>
          {now.toLocaleTimeString("en-ZA", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Africa/Johannesburg" })} SAST
        </span>
      </div>

      <div className="ml-auto flex items-center gap-2">
        <ProvenanceStrip />
        <div className="hidden md:flex">
          <CommandPaletteTrigger />
        </div>

        <ConnectionPill />

        <Button
          variant="ghost"
          size="icon"
          aria-label="Toggle theme"
          onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
          className="h-8 w-8"
        >
          {mounted && theme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
        </Button>

        <Button variant="ghost" size="icon" aria-label="Notifications" className="relative h-8 w-8">
          <Bell className="h-4 w-4" />
          <span className="absolute right-1.5 top-1.5 h-1.5 w-1.5 rounded-full bg-warning" />
        </Button>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button className="flex items-center gap-2 rounded-md border border-border bg-card px-2 py-1 text-xs transition-colors hover:bg-accent">
              <Avatar className="h-6 w-6">
                <AvatarFallback className="bg-primary/15 font-mono text-[10px] font-semibold text-primary">
                  {user.initials}
                </AvatarFallback>
              </Avatar>
              <div className="hidden text-left leading-tight md:block">
                <p className="text-[11px] font-medium">{user.name}</p>
                <p className="text-[9.5px] text-muted-foreground">{meta.label}</p>
              </div>
              <ChevronDown className="h-3 w-3 text-muted-foreground" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-72">
            <DropdownMenuLabel>Switch persona</DropdownMenuLabel>
            {(Object.keys(PERSONA_USERS) as Persona[]).map((p) => {
              const P = PERSONA_LABEL[p];
              const Icon = P.icon;
              const u = PERSONA_USERS[p];
              return (
                <DropdownMenuItem
                  key={p}
                  onSelect={() => {
                    setPersona(p);
                    router.push(P.home as Route);
                  }}
                  className={cn(p === persona && "bg-accent")}
                >
                  <Icon className="h-3.5 w-3.5 text-muted-foreground" />
                  <div className="flex-1">
                    <p className="text-xs">{P.label}</p>
                    <p className="text-[10px] text-muted-foreground">{u.name} · {u.role}</p>
                  </div>
                </DropdownMenuItem>
              );
            })}
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => router.push("/settings")}>
              <Settings className="h-3.5 w-3.5 text-muted-foreground" /> Settings
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={(event) => {
                // onSelect fires before the menu closes; we don't want
                // the dropdown's open-state transitions to clash with
                // the route change, so prevent default and run the
                // async handler ourselves.
                event.preventDefault();
                void handleSignOut();
              }}
              disabled={signingOut}
            >
              <LogOut className="h-3.5 w-3.5 text-muted-foreground" /> Sign out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}

function Logo() {
  return (
    <div className="flex items-center gap-2">
      <div className="relative flex h-7 w-7 items-center justify-center overflow-hidden rounded-md bg-gradient-to-br from-primary to-primary/40 text-primary-foreground">
        <Sparkles className="h-3.5 w-3.5" />
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_30%_20%,_white_0%,_transparent_60%)] opacity-30" />
      </div>
    </div>
  );
}

function CommandPaletteTrigger() {
  const { open, toggle } = useCommandPalette();
  return (
    <button
      type="button"
      onClick={toggle}
      aria-haspopup="dialog"
      aria-expanded={open}
      aria-label="Open command palette"
      className={cn(
        "relative flex h-7 w-72 items-center gap-2 rounded-md border border-border bg-secondary/60 px-2 text-left text-[11px] text-muted-foreground transition-colors hover:bg-secondary",
        "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
      )}
    >
      <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      <span className="flex-1 truncate font-mono">Search securities, orders, strategies…</span>
      <kbd className="inline-flex h-5 select-none items-center gap-0.5 rounded border border-border bg-card px-1.5 font-mono text-[9.5px] text-muted-foreground">
        <Command className="h-2.5 w-2.5" />K
      </kbd>
    </button>
  );
}
