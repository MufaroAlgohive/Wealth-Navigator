"use client";

import { Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { BrainCircuit } from "lucide-react";

import { TickerSearch } from "@/components/analysis/ticker-search";
import { FyncaCanvas } from "@/components/canvas/fynca-canvas";
import { PageCanvas } from "@/components/oems/primitives/glass";
import { Pill } from "@/components/oems/primitives/pill";

function CanvasContent() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const sym = (searchParams.get("sym") ?? "MSFT").toUpperCase();
  const board = searchParams.get("board") ?? undefined;

  const go = (next: string) => {
    const v = next.trim().toUpperCase();
    if (!v) return;
    const sp = new URLSearchParams(Array.from(searchParams.entries()));
    sp.set("sym", v);
    router.replace(`/canvas?${sp.toString()}` as never);
  };

  return (
    <PageCanvas>
      <div className="space-y-5 pb-8">
        <header className="glass-panel relative overflow-hidden p-5 md:p-6">
          <div className="pointer-events-none absolute -right-24 -top-24 h-60 w-60 rounded-full bg-primary/10 blur-3xl" />
          <div className="relative flex flex-wrap items-start justify-between gap-4">
            <div className="space-y-1.5">
              <div className="flex flex-wrap items-center gap-2">
                <BrainCircuit className="h-5 w-5 text-primary" />
                <h1 className="text-display text-2xl">Canvas</h1>
                <Pill tone="neutral" size="xs">
                  AI workspace
                </Pill>
              </div>
              <p className="max-w-xl text-caption text-muted-foreground">
                Infinite board with engines, Chatsight Ask/Build, and live presence. Scroll to zoom ·
                Space+drag to pan.
              </p>
            </div>
            <TickerSearch current={sym} onSelect={go} />
          </div>
        </header>

        <FyncaCanvas sym={sym} boardId={board} />
      </div>
    </PageCanvas>
  );
}

export default function CanvasPage() {
  return (
    <Suspense
      fallback={
        <PageCanvas>
          <div className="glass-panel p-6 text-caption text-muted-foreground">
            Loading canvas…
          </div>
        </PageCanvas>
      }
    >
      <CanvasContent />
    </Suspense>
  );
}
