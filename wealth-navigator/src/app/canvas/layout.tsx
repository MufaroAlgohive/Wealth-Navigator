import type { ReactNode } from "react";

import { PlatformShell } from "@/components/platform/platform-shell";

/** /canvas — Fynca-style multi-persona trading assistant. */
export default function CanvasLayout({ children }: { children: ReactNode }) {
  return <PlatformShell>{children}</PlatformShell>;
}

