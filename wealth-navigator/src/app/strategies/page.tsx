"use client";

import { Suspense } from "react";
import { useSearchParams } from "next/navigation";

import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { usePersona } from "@/lib/store/session-provider";
import { StrategiesMonitor } from "@/components/strategies/strategies-monitor";
import { StrategyBuilder } from "@/components/strategies/strategy-builder";

/**
 * Unified Strategies page — one entity, two views:
 *  • Mandates  — read-only live book (AUM / YTD / P&L / rebalance), every role.
 *  • Builder   — create / edit / browse the catalogue; strategist + admin only.
 * Replaces the separate `/oems/strategies` (Mandates) and `/admin/strategies`
 * (Builder) pages, which now redirect here. Deep-link a tab with `?tab=builder`.
 */
function StrategiesContent() {
  const persona = usePersona();
  const canBuild = persona === "admin" || persona === "strategist";
  const tabParam = useSearchParams().get("tab");

  // Desk / wealth-manager: read-only Mandates only — no tab chrome.
  if (!canBuild) return <StrategiesMonitor />;

  const initial = tabParam === "builder" ? "builder" : "mandates";
  return (
    <Tabs defaultValue={initial} className="space-y-4">
      <TabsList>
        <TabsTrigger value="mandates">Mandates</TabsTrigger>
        <TabsTrigger value="builder">Builder</TabsTrigger>
      </TabsList>
      <TabsContent value="mandates">
        <StrategiesMonitor />
      </TabsContent>
      <TabsContent value="builder">
        <StrategyBuilder />
      </TabsContent>
    </Tabs>
  );
}

export default function StrategiesPage() {
  return (
    <Suspense fallback={null}>
      <StrategiesContent />
    </Suspense>
  );
}
