"use client";

import { OEMSShell } from "@/components/oems/shell/oems-shell";
import { CommandPaletteProvider } from "@/components/oems/command-palette";
import { SkipLink } from "@/components/oems/primitives/skip-link";
import { DevMockBanner } from "@/components/oems/primitives/dev-mock-banner";

export default function OEMSLayout({ children }: { children: React.ReactNode }) {
  return (
    <CommandPaletteProvider>
      <SkipLink />
      <DevMockBanner />
      <OEMSShell>{children}</OEMSShell>
    </CommandPaletteProvider>
  );
}
