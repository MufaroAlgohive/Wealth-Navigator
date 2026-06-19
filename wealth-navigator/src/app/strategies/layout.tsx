import type { ReactNode } from "react";

import { PlatformShell } from "@/components/platform/platform-shell";

/** Unified Strategies surface — Mandates monitor + Builder, in the one shell. */
export default function StrategiesLayout({ children }: { children: ReactNode }) {
  return <PlatformShell>{children}</PlatformShell>;
}
