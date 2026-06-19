"use client";

import { PersonaHeader } from "@/components/oems/primitives/persona-header";
import { GlassSection, PageCanvas } from "@/components/oems/primitives/glass";
import { EmptyDataState } from "@/components/oems/primitives/empty-data-state";
import { PlatformShell } from "@/components/platform/platform-shell";
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
    <PlatformShell>
      <PageCanvas>
        <PersonaHeader persona={persona} description={description} />
        {realDataOnly ? (
          <GlassSection title="Not configured" endpoint={endpoint}>
            <EmptyDataState message={message} />
          </GlassSection>
        ) : (
          children
        )}
      </PageCanvas>
    </PlatformShell>
  );
}
