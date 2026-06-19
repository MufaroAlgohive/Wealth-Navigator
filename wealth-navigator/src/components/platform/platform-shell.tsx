"use client";

import type { ReactNode } from "react";

import { CommandPaletteProvider } from "@/components/oems/command-palette";
import { SkipLink } from "@/components/oems/primitives/skip-link";
import { TopBar } from "@/components/oems/shell/top-bar";
import { TickerBar } from "@/components/oems/primitives/ticker-bar";
import { PlatformNav } from "@/components/platform/platform-nav";

/**
 * The single platform shell — one top bar + ticker + the unified role-gated
 * PlatformNav, used by BOTH the desk (`/oems/*`) and the retail admin
 * (`/admin/*`). Replaces OEMSShell + AdminShell so the app is one product.
 * App-wide providers (theme/query/iress/tick/tooltip) live in the root layout;
 * surface-specific providers (e.g. AdminProvider RBAC) wrap this from outside.
 */
export function PlatformShell({ children, banner }: { children: ReactNode; banner?: ReactNode }) {
  return (
    <CommandPaletteProvider>
      <SkipLink />
      <div className="flex h-screen flex-col overflow-hidden bg-canvas text-foreground">
        <TopBar />
        <TickerBar />
        {banner}
        <div className="flex min-h-0 flex-1">
          <PlatformNav />
          <main
            id="main-content"
            tabIndex={-1}
            className="mint-ambient relative flex-1 min-w-0 overflow-y-auto p-4 scrollbar-thin focus:outline-none md:p-5"
          >
            <div className="relative mx-auto max-w-[1800px] animate-fade-in">{children}</div>
          </main>
        </div>
      </div>
    </CommandPaletteProvider>
  );
}
