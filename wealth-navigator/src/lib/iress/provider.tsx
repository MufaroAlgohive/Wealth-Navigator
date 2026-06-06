"use client";

// IRESS React context — exposes the typed client + config to descendants.

import { createContext, useContext, type ReactNode } from "react";
import { iress, iressConfig, iressData } from "@/lib/iress";
import type { IressClient } from "@/lib/iress/client";

const IressContext = createContext<{ client: IressClient; config: typeof iressConfig; data: typeof iressData } | null>(null);

export function IressProvider({ children }: { children: ReactNode }) {
  return (
    <IressContext.Provider value={{ client: iress, config: iressConfig, data: iressData }}>
      {children}
    </IressContext.Provider>
  );
}

export function useIress() {
  const ctx = useContext(IressContext);
  if (!ctx) throw new Error("useIress must be used within IressProvider");
  return ctx;
}
