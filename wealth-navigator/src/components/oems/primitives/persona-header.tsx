"use client";

import { Briefcase, Building2, HeartPulse, LineChart, Shield, ChevronUp } from "lucide-react";
import Link from "next/link";
import { Pill } from "@/components/oems/primitives/pill";
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
  return (
    <header className={cn("flex flex-wrap items-end justify-between gap-3 pb-1", className)}>
      <div>
        <div className="mb-1.5 flex items-center gap-2">
          <Pill tone={PERSONA_TONE[persona]} size="sm">
            <Icon className="h-3 w-3" />
            Persona · {user.subtitle}
          </Pill>
        </div>
        <h1 className="text-lg font-semibold tracking-tight">{user.name}</h1>
        <p className="text-xs text-muted-foreground">
          {description}
        </p>
      </div>
      <Link
        href="#persona-switcher"
        className="inline-flex items-center gap-1 rounded-md border border-border bg-card px-2 py-1 text-[10.5px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      >
        <ChevronUp className="h-3 w-3" />
        Switch persona (top bar avatar)
      </Link>
    </header>
  );
}
