"use client";

import { useMemo } from "react";
import { GripVertical } from "lucide-react";

import { cn } from "@/lib/cn";

import {
  CanvasChartNode,
  CanvasEngineNode,
  CanvasFundamentalsNode,
  CanvasNewsNode,
  CanvasTechnicalsNode,
  CanvasThesisNode,
} from "./canvas-node-content";
import type { CanvasNode } from "./types";
import { NODE_SIZE, PORT_OFFSET_Y } from "./types";

const NODE_TYPE_BADGE: Record<CanvasNode["type"], string> = {
  chart: "Chart",
  fundamentals: "Fundamentals",
  thesis: "Thesis",
  notes: "Notes",
  technicals: "Technicals",
  news: "News",
  engine: "Engine",
};

export function NodeCard({
  node,
  sym,
  width,
  height,
  selected,
  onChangeNotes,
  onDragHandlePointerDown,
  onResizePointerDown,
}: {
  node: CanvasNode;
  sym: string;
  width?: number;
  height?: number;
  selected?: boolean;
  onChangeNotes?: (nextText: string) => void;
  onDragHandlePointerDown: (e: React.PointerEvent) => void;
  onResizePointerDown?: (e: React.PointerEvent) => void;
}) {
  const badge = NODE_TYPE_BADGE[node.type] ?? node.type;
  const isNotes = node.type === "notes";
  const notesText = node.data.text ?? node.contentText ?? "";
  const w = width ?? NODE_SIZE.w;
  const h = height ?? NODE_SIZE.h;
  const portY = Math.min(h * 0.35, PORT_OFFSET_Y);

  const content = useMemo(() => {
    if (!sym) {
      return <div className="p-4 text-[12px] text-muted-foreground">No symbol selected.</div>;
    }

    if (node.type === "engine") {
      return <CanvasEngineNode title={node.title} hint={node.contentText} />;
    }

    if (isNotes) {
      return (
        <div className="flex h-full min-h-0 flex-col gap-2 p-3.5">
          <div className="flex shrink-0 items-center justify-between gap-2">
            <span className="rounded-md border border-[hsl(var(--glass-border))]/50 bg-[hsl(var(--foreground)/0.04)] px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wider text-muted-foreground">
              Local
            </span>
            <span className="text-[9.5px] text-muted-foreground/70">Your notes · not market data</span>
          </div>
          <textarea
            value={notesText}
            onChange={(e) => onChangeNotes?.(e.target.value)}
            placeholder="Assumptions, constraints, or a prompt for Ask / Build…"
            className="min-h-0 flex-1 w-full resize-none rounded-xl border-0 bg-[hsl(var(--foreground)/0.03)] p-3.5 text-[13px] leading-relaxed outline-none ring-0 placeholder:text-muted-foreground/50 focus:bg-[hsl(var(--foreground)/0.045)]"
          />
          <p className="shrink-0 text-[10.5px] text-muted-foreground/60">
            Included in Ask / Build context.
          </p>
        </div>
      );
    }

    if (node.type === "chart") return <CanvasChartNode sym={sym} />;
    if (node.type === "fundamentals") return <CanvasFundamentalsNode sym={sym} />;
    if (node.type === "thesis") return <CanvasThesisNode sym={sym} />;
    if (node.type === "technicals") return <CanvasTechnicalsNode sym={sym} />;
    if (node.type === "news") return <CanvasNewsNode sym={sym} />;

    return <div className="p-4 text-[12px] text-muted-foreground">Unsupported node.</div>;
  }, [isNotes, node.contentText, node.title, node.type, notesText, onChangeNotes, sym]);

  const isEngine = node.type === "engine";

  return (
    <div
      className={cn(
        "group relative overflow-hidden rounded-2xl",
        "border border-[hsl(var(--glass-border))]/50",
        "bg-[hsl(var(--background)/0.72)] backdrop-blur-md",
        "shadow-[0_8px_40px_-24px_hsl(var(--foreground)/0.35)]",
        "transition-[box-shadow,border-color] duration-200",
        "hover:border-[hsl(var(--glass-border))]/80",
        selected && "border-primary/55 shadow-[0_0_0_1px_hsl(var(--primary)/0.25)]",
        isEngine && "rounded-xl bg-[hsl(var(--foreground)/0.035)]",
      )}
      style={{ width: w, height: h }}
      tabIndex={0}
      role="group"
      aria-label={`${node.title} (${badge})`}
    >
      {/* Single chrome header — no nested GlassSection titles */}
      <div
        className={cn(
          "absolute left-0 top-0 z-10 flex w-full cursor-grab items-center gap-2 border-b border-[hsl(var(--glass-border))]/40 bg-[hsl(var(--foreground)/0.02)] px-3 active:cursor-grabbing",
          isEngine ? "h-9" : "h-10",
        )}
        onPointerDown={onDragHandlePointerDown}
        role="button"
        aria-label={`Drag ${node.title}`}
      >
        <GripVertical className="h-3.5 w-3.5 shrink-0 text-muted-foreground/50" />
        <span className="min-w-0 truncate text-[12.5px] font-semibold tracking-tight">{node.title}</span>
        <span className="ml-auto shrink-0 rounded-md bg-[hsl(var(--foreground)/0.04)] px-2 py-0.5 font-mono text-[10px] text-muted-foreground/80">
          {badge}
        </span>
      </div>

      {/* Connection ports */}
      <div className="pointer-events-none absolute left-[-5px] top-0 z-20" style={{ width: 10, height: h }}>
        <div
          className="h-2.5 w-2.5 rounded-full border border-[hsl(var(--glass-border))]/60 bg-[hsl(var(--foreground)/0.08)]"
          style={{ position: "absolute", left: 0, top: portY - 5 }}
        />
      </div>
      <div className="pointer-events-none absolute right-[-5px] top-0 z-20" style={{ width: 10, height: h }}>
        <div
          className="h-2.5 w-2.5 rounded-full border border-[hsl(var(--muted-foreground)/0.35)] bg-[hsl(var(--muted-foreground)/0.12)]"
          style={{ position: "absolute", right: 0, top: portY - 5 }}
        />
      </div>

      <div className={cn("absolute inset-0 overflow-hidden", isEngine ? "pt-9" : "pt-10")}>{content}</div>

      {onResizePointerDown ? (
        <div
          className="absolute bottom-1 right-1 z-20 h-4 w-4 cursor-ew-resize opacity-0 transition-opacity group-hover:opacity-100"
          onPointerDown={onResizePointerDown}
          title="Resize width"
          aria-label="Resize node width"
        >
          <div className="absolute bottom-0.5 right-0.5 h-2.5 w-2.5 rounded-sm border-b-2 border-r-2 border-muted-foreground/50" />
        </div>
      ) : null}
    </div>
  );
}
