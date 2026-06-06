import { createContext, useCallback, useContext, useEffect, useState, ReactNode } from "react";
import { useLocation } from "react-router-dom";
import type { UserRole } from "@/lib/mockData";

const ROLE_STORAGE_KEY = "mint-active-role";
const OEMS_PATHS = new Set([
  "/blotter",
  "/strategies",
  "/equities",
  "/fixed-income",
  "/money-market",
  "/curves",
  "/macro",
  "/news",
  "/security",
  "/integration",
]);

function inferRole(pathname: string, persistedRole?: UserRole): UserRole {
  if (pathname.startsWith("/oems") || OEMS_PATHS.has(pathname)) return "oems";
  if (pathname.startsWith("/fc/")) return "funeral_cover";
  return persistedRole ?? "wealth_manager";
}

interface RoleUser {
  id: string;
  name: string;
  initials: string;
  role: UserRole;
  subtitle: string;
}

const ROLE_USERS: Record<UserRole, RoleUser> = {
  strategist: { id: "st1", name: "Andile Khumalo", initials: "AK", role: "strategist", subtitle: "Investment Strategist" },
  wealth_manager: { id: "wm1", name: "James Mokoena", initials: "JM", role: "wealth_manager", subtitle: "Wealth Manager" },
  admin: { id: "adm1", name: "Refilwe Ntsoane", initials: "RN", role: "admin", subtitle: "Compliance Officer" },
  business: { id: "biz1", name: "Thabo Makgoba", initials: "TM", role: "business", subtitle: "Business Administrator" },
  funeral_cover: { id: "fc1", name: "Noluthando Maseko", initials: "NM", role: "funeral_cover", subtitle: "Funeral Cover Operations" },
  oems: { id: "oems1", name: "Lerato van der Merwe", initials: "LV", role: "oems", subtitle: "OEMS · Trading Desk" },
};

interface RoleContextValue {
  role: UserRole;
  setRole: (r: UserRole) => void;
  user: RoleUser;
}

const RoleContext = createContext<RoleContextValue | null>(null);

export function RoleProvider({ children }: { children: ReactNode }) {
  const location = useLocation();
  const [role, setRoleState] = useState<UserRole>(() => {
    const persistedRole = typeof window === "undefined"
      ? undefined
      : (window.localStorage.getItem(ROLE_STORAGE_KEY) as UserRole | null) ?? undefined;

    return inferRole(window.location.pathname, persistedRole);
  });

  const setRole = useCallback((nextRole: UserRole) => {
    setRoleState(nextRole);
  }, []);

  useEffect(() => {
    const inferredRole = inferRole(location.pathname, role);
    if (inferredRole !== role) {
      setRoleState(inferredRole);
    }
  }, [location.pathname, role]);

  useEffect(() => {
    if (typeof window !== "undefined") {
      window.localStorage.setItem(ROLE_STORAGE_KEY, role);
    }
  }, [role]);

  const user = ROLE_USERS[role];

  return (
    <RoleContext.Provider value={{ role, setRole, user }}>
      {children}
    </RoleContext.Provider>
  );
}

export function useRole() {
  const ctx = useContext(RoleContext);
  if (!ctx) throw new Error("useRole must be used within RoleProvider");
  return ctx;
}
