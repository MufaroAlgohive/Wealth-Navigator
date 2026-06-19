import type { ReactNode } from "react";

import { PlatformShell } from "@/components/platform/platform-shell";

/** Platform/environment settings (IRESS adapter + endpoint health) — in the one shell. */
export default function SettingsLayout({ children }: { children: ReactNode }) {
  return <PlatformShell>{children}</PlatformShell>;
}
