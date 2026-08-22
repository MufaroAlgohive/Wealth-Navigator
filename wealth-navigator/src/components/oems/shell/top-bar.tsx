"use client";

import { useCommandPalette } from "@/components/oems/command-palette";
import { ConnectionPill } from "@/components/oems/primitives/connection-pill";
import {
  NotificationsCenter,
  NotificationsTrigger,
  useUnreadNotifications,
} from "@/components/oems/shell/notifications-center";
import { ProvenanceStrip } from "@/components/oems/shell/provenance-strip";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { notifyAuthChange } from "@/lib/auth/store";
import { type CurrentUser, useCurrentUser } from "@/lib/auth/use-current-user";
import { cn } from "@/lib/cn";
import { PERSONA_HOME } from "@/lib/platform/nav";
import { isJseOpen } from "@/lib/sa-holidays";
import {
  PERSONA_USERS,
  type Persona,
  usePersona,
  useResetSession,
  useSetPersona,
  useUser,
} from "@/lib/store/session-provider";
import {
  Activity,
  Banknote,
  Bell,
  Briefcase,
  Building2,
  Cable,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  ClipboardList,
  Clock,
  Command,
  FileCheck,
  Globe2,
  HeartPulse,
  IdCard,
  KeyRound,
  Landmark,
  Layers,
  LineChart,
  LogIn,
  LogOut,
  Mail,
  Moon,
  Newspaper,
  Search,
  Settings,
  Shield,
  Sparkles,
  Sun,
  TrendingUp,
  UserCheck,
  UserCircle,
  Users,
} from "lucide-react";
import type { Route } from "next";
import { useTheme } from "next-themes";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import * as React from "react";
import { toast } from "sonner";

// Label + icon for each persona in the switcher. The landing route comes from
// the shared `PERSONA_HOME` map (nav.ts) — the single source of truth the
// sidebar Overview item also uses — so the switcher and the sidebar never
// disagree on where a persona "home" is.
const PERSONA_LABEL: Record<Persona, { label: string; icon: React.ElementType }> = {
  oems: { label: "OEMS · Trading Desk", icon: Activity },
  strategist: { label: "Strategist", icon: LineChart },
  wealth_manager: { label: "Wealth Manager", icon: Briefcase },
  admin: { label: "Admin / Compliance", icon: Shield },
  business: { label: "Business", icon: Building2 },
  funeral_cover: { label: "Funeral Cover", icon: HeartPulse },
};

export function TopBar() {
  const router = useRouter();
  const persona = usePersona();
  const setPersona = useSetPersona();
  const resetSession = useResetSession();
  const user = useUser();
  const { user: currentUser } = useCurrentUser();
  const notifications = useUnreadNotifications();
  const [notificationsOpen, setNotificationsOpen] = React.useState(false);
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

  React.useEffect(() => {
    setMounted(true);
  }, []);
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
          <span className="font-mono text-[9px] uppercase tracking-wider text-muted-foreground">
            v2.0 · institutional
          </span>
        </div>
      </Link>

      <div className="ml-1 flex h-7 items-center gap-1.5 rounded-md border border-border bg-secondary/60 px-2 font-mono text-[11px] text-muted-foreground">
        <span className="h-1.5 w-1.5 rounded-full bg-success" />
        JSE
        <span className="text-foreground">{marketOpen ? "OPEN" : "CLOSED"}</span>
        <span className="text-muted-foreground/60">·</span>
        <span>
          {now.toLocaleTimeString("en-ZA", {
            hour: "2-digit",
            minute: "2-digit",
            hour12: false,
            timeZone: "Africa/Johannesburg",
          })}{" "}
          SAST
        </span>
      </div>

      <div className="ml-auto flex items-center gap-2">
        <ProvenanceStrip />
        <div className="hidden md:flex">
          <CommandPaletteTrigger />
        </div>

        <ConnectionPill />

        <NotificationsTrigger
          unreadCount={notifications.unreadCount}
          onClick={() => setNotificationsOpen(true)}
        />
        <NotificationsCenter open={notificationsOpen} onOpenChange={setNotificationsOpen} />

        <Button
          variant="ghost"
          size="icon"
          aria-label="Toggle theme"
          onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
          className="h-8 w-8"
        >
          {mounted && theme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
        </Button>

        <ProfileMenu
          signedInUser={currentUser}
          persona={persona}
          meta={meta}
          personaName={user.name}
          personaInitials={user.initials}
          setPersona={setPersona}
          router={router}
          signingOut={signingOut}
          onSignOut={() => void handleSignOut()}
        />
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

// ─── ProfileMenu ──────────────────────────────────────────────────────────────────────
//
// Clerk-style floating overlay anchored to the avatar trigger. Shows the
// signed-in user's full profile (name, email, role, last login) when a Supabase
// session is present; falls back to the demo persona otherwise. The "Switch
// persona" submenu is only rendered in demo mode — when signed in via
// Supabase auth, the menu skips the persona switcher (persona is a demo-only
// concept).
//
function relativeTime(iso: string | null): string {
  if (!iso) return "—";
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "—";
  const diff = Math.max(0, Date.now() - then);
  const m = Math.floor(diff / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `${mo}mo ago`;
  return new Date(then).toLocaleDateString("en-ZA", { day: "2-digit", month: "short", year: "numeric" });
}

function ProfileMenu({
  signedInUser,
  persona,
  meta,
  personaName,
  personaInitials,
  setPersona,
  router,
  signingOut,
  onSignOut,
}: {
  signedInUser: CurrentUser | null;
  persona: Persona;
  meta: { label: string; icon: React.ElementType };
  personaName: string;
  personaInitials: string;
  setPersona: (p: Persona) => void;
  router: ReturnType<typeof useRouter>;
  signingOut: boolean;
  onSignOut: () => void;
}) {
  const isSignedIn = signedInUser != null;
  const displayName = signedInUser?.fullName ?? personaName;
  const displayEmail = signedInUser?.email ?? "";
  const displayInitials = signedInUser?.initials ?? personaInitials;
  const displayRole = signedInUser?.role ?? "";
  const displayLastSignIn = signedInUser?.lastSignInAt ?? null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={isSignedIn ? `Account menu for ${displayName}` : "Persona menu"}
          className={cn(
            "flex items-center gap-2 rounded-md border border-border bg-card px-2 py-1 text-xs",
            "transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
            isSignedIn && "ring-1 ring-primary/20",
          )}
        >
          <Avatar className="h-6 w-6">
            <AvatarFallback
              className={cn(
                "font-mono text-[10px] font-semibold",
                isSignedIn ? "bg-primary/20 text-primary" : "bg-primary/15 text-primary",
              )}
            >
              {displayInitials}
            </AvatarFallback>
          </Avatar>
          <div className="hidden text-left leading-tight md:block">
            <p className="text-[11px] font-medium">{displayName}</p>
            <p className="font-mono text-[9.5px] text-muted-foreground">
              {isSignedIn ? displayRole || meta.label : meta.label}
            </p>
          </div>
          <ChevronDown className="h-3 w-3 text-muted-foreground" />
        </button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="end" className="w-[320px] p-0 overflow-hidden">
        {/* ── Header (Clerk-style: clean identity card) ── */}
        <div className="relative bg-gradient-to-br from-primary/8 via-primary/3 to-transparent px-4 pb-4 pt-4">
          <div className="flex items-start gap-3">
            <Avatar className="h-12 w-12 shrink-0 ring-2 ring-card">
              <AvatarFallback className="bg-primary/20 font-mono text-[14px] font-semibold text-primary">
                {displayInitials}
              </AvatarFallback>
            </Avatar>
            <div className="min-w-0 flex-1">
              <p className="truncate text-[13.5px] font-semibold leading-tight text-foreground">
                {displayName}
              </p>
              {displayEmail ? (
                <p className="mt-0.5 truncate text-[11.5px] text-muted-foreground">{displayEmail}</p>
              ) : null}
              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                {isSignedIn ? (
                  <>
                    <span className="inline-flex items-center gap-1 rounded-full bg-success/10 px-2 py-0.5 text-[10px] font-medium text-success">
                      <span className="h-1.5 w-1.5 rounded-full bg-success" />
                      Active session
                    </span>
                    {displayRole ? (
                      <span className="inline-flex items-center rounded-full bg-muted/40 px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                        {displayRole}
                      </span>
                    ) : null}
                  </>
                ) : (
                  <span className="inline-flex items-center gap-1 rounded-full bg-warning/10 px-2 py-0.5 text-[10px] font-medium text-warning">
                    <span className="h-1.5 w-1.5 rounded-full bg-warning" />
                    Demo persona
                  </span>
                )}
              </div>
            </div>
          </div>
          {/* Session metadata — friendly, not technical */}
          {isSignedIn ? (
            <div className="mt-3 flex items-center gap-3 text-[10.5px] text-muted-foreground">
              <span className="inline-flex items-center gap-1">
                <Clock className="h-3 w-3" />
                Last active {relativeTime(displayLastSignIn)}
              </span>
            </div>
          ) : null}
        </div>

        {/* ── Primary actions (modern card list with chevrons) ── */}
        <div className="p-1">
          <DropdownMenuItem onSelect={() => router.push("/oems/account" as Route)} className="px-3 py-2.5">
            <UserCircle className="h-4 w-4 text-muted-foreground" />
            <div className="ml-2 flex-1">
              <p className="text-[12.5px] font-medium">Manage account</p>
              <p className="text-[10.5px] text-muted-foreground">Profile, security, notifications</p>
            </div>
            <ChevronRight className="h-3.5 w-3.5 text-muted-foreground/60" />
          </DropdownMenuItem>
          {isSignedIn ? (
            <DropdownMenuItem onSelect={() => router.push("/oems/integration")} className="px-3 py-2.5">
              <Activity className="h-4 w-4 text-muted-foreground" />
              <div className="ml-2 flex-1">
                <p className="text-[12.5px] font-medium">System status</p>
                <p className="text-[10.5px] text-muted-foreground">Data sources, IRESS, Yahoo fallback</p>
              </div>
              <ChevronRight className="h-3.5 w-3.5 text-muted-foreground/60" />
            </DropdownMenuItem>
          ) : null}
        </div>

        {!isSignedIn ? (
          <>
            <div className="mx-3 my-1 border-t border-border/40" />
            <div className="px-3 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70">
              Demo personas
            </div>
            <div className="p-1">
              {(Object.keys(PERSONA_USERS) as Persona[]).map((p) => {
                const P = PERSONA_LABEL[p];
                const Icon = P.icon;
                const u = PERSONA_USERS[p];
                return (
                  <DropdownMenuItem
                    key={p}
                    onSelect={() => {
                      setPersona(p);
                      router.push(PERSONA_HOME[p].href as Route);
                    }}
                    className={cn("px-3 py-2", p === persona && "bg-accent")}
                  >
                    <Icon className="h-4 w-4 text-muted-foreground" />
                    <div className="ml-2 flex-1">
                      <p className="text-xs">{P.label}</p>
                      <p className="text-[10px] text-muted-foreground">
                        {u.name} · {u.role}
                      </p>
                    </div>
                    {p === persona ? <CheckCircle2 className="h-3 w-3 text-primary" /> : null}
                  </DropdownMenuItem>
                );
              })}
            </div>
          </>
        ) : null}

        <div className="mx-3 my-1 border-t border-border/40" />

        {/* ── Footer: switch / sign out ── */}
        <div className="p-1">
          {isSignedIn ? (
            <DropdownMenuItem
              onSelect={(event) => {
                event.preventDefault();
                onSignOut();
              }}
              disabled={signingOut}
              className="px-3 py-2 text-[12.5px] text-destructive focus:text-destructive"
            >
              <LogOut className="h-4 w-4" />
              <span className="ml-2 flex-1">{signingOut ? "Signing out…" : "Sign out"}</span>
            </DropdownMenuItem>
          ) : (
            <DropdownMenuItem onSelect={() => router.push("/login")} className="px-3 py-2">
              <LogIn className="h-4 w-4 text-muted-foreground" />
              <span className="ml-2 flex-1">Sign in with Supabase</span>
              <ChevronRight className="h-3.5 w-3.5 text-muted-foreground/60" />
            </DropdownMenuItem>
          )}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
