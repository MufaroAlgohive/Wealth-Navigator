"use client";

import * as React from "react";
import type { AdminContext } from "@/lib/admin/rbac";

export interface AdminProviderValue {
  ctx: AdminContext;
  /** Non-null when RBAC could not be resolved normally (e.g. dev fallback). */
  notice: string | null;
}

const Ctx = React.createContext<AdminProviderValue | null>(null);

export function AdminProvider({
  value,
  children,
}: {
  value: AdminProviderValue;
  children: React.ReactNode;
}) {
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAdmin(): AdminProviderValue {
  const v = React.useContext(Ctx);
  if (!v) throw new Error("useAdmin must be used within <AdminProvider>");
  return v;
}

/** Client mirror of the legacy `window.mintCan(section, field)` helper. */
export function useCan() {
  const { ctx } = useAdmin();
  return React.useCallback(
    (section: string, field: string): boolean | "pending" | "direct" => {
      if (ctx.approverTier === "dev") return true;
      const v = ctx.permissions?.[section]?.[field];
      if (v === "pending" || v === "direct") return v;
      return Boolean(v);
    },
    [ctx],
  );
}
