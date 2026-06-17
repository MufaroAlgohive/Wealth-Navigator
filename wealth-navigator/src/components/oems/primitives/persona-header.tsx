"use client";

import { Briefcase, Building2, HeartPulse, LineChart, Shield, ChevronUp } from "lucide-react";
import Link from "next/link";
import { GlassBadge } from "@/components/oems/primitives/glass";
import { PERSONA_USERS, type Persona } from "@/lib/store/session-provider";
import { cn } from "@/lib/cn";

const PERSONA_TONE: Record<Persona, "primary" | "success" | "warning" | "info" | "destructive"> = {
  oems:           "info",
  wealth_manager: "primary",
  strategist:     "success",
  admin:          "warning",
  business:       "info",
  funeral_cover:  "primary",
};

const PERSONA_ICON: Record<Persona, React.ElementType> = {
  oems:           LineChart,
  wealth_manager: Briefcase,
  strategist:     LineChart,
  admin:          Shield,
  business:       Building2,
  funeral_cover:  HeartPulse,
};

interface PersonaHeaderProps {
  /** Persona id from the session store. */
  persona: Persona;
  /** One-line description of what the persona surface shows. */
  description: string;
  className?: string;
}

/**
 * Standard header for persona landing pages. Shows the persona name,
 * subtitle (role), a one-line "What this is" description, and a small
 * affordance pointing the user at the top-bar persona switcher.
 */
export function PersonaHeader({ persona, description, className }: PersonaHeaderProps) {
  const user = PERSONA_USERS[persona];
  const Icon = PERSONA_ICON[persona];
  const badgeTone: "neutral" | "primary" | "success" =
    PERSONA_TONE[persona] === "success" ? "success" :
    PERSONA_TONE[persona] === "primary" ? "primary" :
    "neutral";
  return (
    <header className={cn("glass-panel relative overflow-hidden p-6 md:p-7", className)}>
      <div className="pointer-events-none absolute -right-16 -top-16 h-48 w-48 rounded-full bg-primary/12 blur-3xl" />
      <div className="relative flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0 space-y-3">
          <GlassBadge tone={badgeTone}>
            <Icon className="h-3.5 w-3.5" />
            Persona · {user.subtitle}
          </GlassBadge>
          <div>
            <h1 className="text-display">{user.name}</h1>
            <p className="mt-1.5 max-w-2xl text-sm leading-relaxed text-muted-foreground">
              {description}
            </p>
          </div>
        </div>
        <Link
          href="#persona-switcher"
          className="glass-inset inline-flex items-center gap-1.5 px-3 py-2 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
        >
          <ChevronUp className="h-3.5 w-3.5" />
          Switch persona
        </Link>
      </div>
    </header>
  );
}
