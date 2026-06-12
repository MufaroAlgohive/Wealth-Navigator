"use client";

import { PersonaHeader } from "@/components/oems/primitives/persona-header";
import { Panel } from "@/components/oems/primitives/panel";
import { EmptyDataState } from "@/components/oems/primitives/empty-data-state";
import { OEMSShell } from "@/components/oems/shell/oems-shell";
import { CommandPaletteProvider } from "@/components/oems/command-palette";
import { isRealDataOnlyClient } from "@/lib/data-policy";
import type { ComponentProps } from "react";

type PersonaKind = ComponentProps<typeof PersonaHeader>["persona"];

interface PersonaRealDataGateProps {
  persona: PersonaKind;
  description: string;
  message: string;
  endpoint?: string;
  children: React.ReactNode;
}

/** In production real-data mode, show honest empty state instead of seed KPIs. */
export function PersonaRealDataGate({
  persona,
  description,
  message,
  endpoint = "CRM / ops system",
  children,
}: PersonaRealDataGateProps) {
  const realDataOnly = isRealDataOnlyClient();

  return (
    <CommandPaletteProvider>
      <OEMSShell>
        <div className="space-y-3">
          <PersonaHeader persona={persona} description={description} />
          {realDataOnly ? (
            <Panel title="Not configured" endpoint={endpoint}>
              <EmptyDataState message={message} />
            </Panel>
          ) : (
            children
          )}
        </div>
      </OEMSShell>
    </CommandPaletteProvider>
  );
}
