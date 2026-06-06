"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";

export type Persona =
  | "oems"
  | "wealth_manager"
  | "strategist"
  | "admin"
  | "business"
  | "funeral_cover";

export interface PersonaUser {
  id: string;
  name: string;
  initials: string;
  persona: Persona;
  subtitle: string;
  role: string;
}

const PERSONA_USERS: Record<Persona, PersonaUser> = {
  oems:           { id: "oems1", name: "Lerato van der Merwe", initials: "LV", persona: "oems",           subtitle: "OEMS · Trading Desk",          role: "Senior Trader" },
  strategist:     { id: "st1",  name: "Andile Khumalo",       initials: "AK", persona: "strategist",     subtitle: "Investment Strategist",       role: "Quant Lead" },
  wealth_manager: { id: "wm1",  name: "James Mokoena",        initials: "JM", persona: "wealth_manager", subtitle: "Wealth Manager",              role: "Senior WM" },
  admin:          { id: "ad1",  name: "Refilwe Ntsoane",      initials: "RN", persona: "admin",          subtitle: "Compliance Officer",          role: "Compliance Head" },
  business:       { id: "bz1",  name: "Thabo Makgoba",        initials: "TM", persona: "business",       subtitle: "Business Administrator",      role: "Head of Biz" },
  funeral_cover:  { id: "fc1",  name: "Noluthando Maseko",    initials: "NM", persona: "funeral_cover",  subtitle: "Funeral Cover Operations",    role: "Ops Manager" },
};

interface SessionState {
  persona: Persona;
  setPersona: (p: Persona) => void;
  user: PersonaUser;
  /**
   * Reset back to the default persona/user. Called on logout so the
   * next login starts from a clean slate.
   */
  reset: () => void;
}

export const useSessionStore = create<SessionState>()(
  persist(
    (set) => ({
      persona: "oems",
      user: PERSONA_USERS.oems,
      setPersona: (persona) => set({ persona, user: PERSONA_USERS[persona] }),
      reset: () => set({ persona: "oems", user: PERSONA_USERS.oems }),
    }),
    { name: "mint-session" },
  ),
);

export function usePersona() {
  return useSessionStore((s) => s.persona);
}
export function useUser() {
  return useSessionStore((s) => s.user);
}
export function useSetPersona() {
  return useSessionStore((s) => s.setPersona);
}
export function useResetSession() {
  return useSessionStore((s) => s.reset);
}
export { PERSONA_USERS };

/**
 * Mounts the session store. The Zustand store is module-scoped and
 * already initialised at import time, so this is a thin wrapper that
 * exists for symmetry with the other providers and so layout code can
 * keep the markup pattern: <ThemeProvider><QueryProvider><SessionProvider>.
 */
export function SessionProvider({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
