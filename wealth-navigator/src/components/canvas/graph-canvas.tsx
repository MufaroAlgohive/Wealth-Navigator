"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Focus, Minus, Plus, RotateCcw } from "lucide-react";

import { cn } from "@/lib/cn";
import type { RemoteCursor } from "@/hooks/use-canvas-presence";
import { loadCanvasView, saveCanvasView } from "@/lib/canvas/view-storage";

import type { CanvasBoardSettings, CanvasEdge, CanvasNode } from "./types";
import {
  BOARD_PAD,
  DEFAULT_BOARD_SETTINGS,
  MAX_ZOOM,
  MIN_ZOOM,
  ZOOM_STEP,
  nodeDims,
} from "./types";
import { CanvasSettingsDock } from "./canvas-settings-dock";
import { NodeCard } from "./node-card";

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

function edgePath(x1: number, y1: number, x2: number, y2: number) {
  const dx = Math.max(100, Math.abs(x2 - x1) * 0.45);
  return `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
}

function snap(n: number, density: number, enabled: boolean) {
  if (!enabled || density <= 0) return n;
  return Math.round(n / density) * density;
}

/** Normalize wheel delta across mice / trackpads into a zoom step. */
function wheelZoomDelta(e: WheelEvent): number {
  // ctrl/meta+wheel is often browser pinch-zoom (deltaMode=0, large deltaY)
  const raw = e.deltaY;
  if (raw === 0) return 0;
  // Line mode (~100) vs pixel mode (trackpad)
  const normalized = e.deltaMode === 1 ? raw * 16 : e.deltaMode === 2 ? raw * 800 : raw;
  const magnitude = Math.min(0.35, Math.max(0.04, Math.abs(normalized) / 400));
  return raw > 0 ? -magnitude : magnitude;
}

export function GraphCanvas({
  sym,
  nodes,
  edges,
  onNodesChange,
  settings: settingsProp,
  onSettingsChange,
  onResetLayout,
  remoteCursors = [],
  onCursorMove,
  onNodeDragEnd,
  selectedNodeId,
  onSelectNode,
}: {
  sym: string;
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  onNodesChange: (next: CanvasNode[]) => void;
  settings?: CanvasBoardSettings;
  onSettingsChange: (next: CanvasBoardSettings) => void;
  onResetLayout: () => void;
  remoteCursors?: RemoteCursor[];
  onCursorMove?: (x: number, y: number) => void;
  onNodeDragEnd?: (nodeId: string, x: number, y: number) => void;
  selectedNodeId?: string | null;
  onSelectNode?: (id: string | null) => void;
}) {
  const settings = settingsProp ?? DEFAULT_BOARD_SETTINGS;
  const rootRef = useRef<HTMLDivElement | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const [viewportSize, setViewportSize] = useState({ w: 960, h: 720 });
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [spaceDown, setSpaceDown] = useState(false);
  const [isPanning, setIsPanning] = useState(false);

  const [view, setView] = useState(() => loadCanvasView(sym) ?? { scale: 1, tx: 40, ty: 56 });
  const viewRef = useRef(view);
  viewRef.current = view;

  useEffect(() => {
    setView(loadCanvasView(sym) ?? { scale: 1, tx: 40, ty: 56 });
  }, [sym]);

  useEffect(() => {
    saveCanvasView(sym, view);
  }, [sym, view]);

  const nodesById = useMemo(() => new Map(nodes.map((n) => [n.id, n] as const)), [nodes]);

  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      setViewportSize({ w: el.clientWidth, h: el.clientHeight });
    });
    ro.observe(el);
    setViewportSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  const zoomAtClientPoint = useCallback((clientX: number, clientY: number, deltaScale: number) => {
    const el = viewportRef.current;
    if (!el || deltaScale === 0) return;
    const rect = el.getBoundingClientRect();
    const mx = clientX - rect.left;
    const my = clientY - rect.top;
    setView((v) => {
      const nextScale = clamp(v.scale + deltaScale, MIN_ZOOM, MAX_ZOOM);
      if (nextScale === v.scale) return v;
      const wx = (mx - v.tx) / v.scale;
      const wy = (my - v.ty) / v.scale;
      return {
        scale: nextScale,
        tx: mx - wx * nextScale,
        ty: my - wy * nextScale,
      };
    });
  }, []);

  // Space / keyboard zoom shortcuts
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const typing =
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement ||
        (e.target instanceof HTMLElement && e.target.isContentEditable);
      if (e.code === "Space" && !typing) {
        e.preventDefault();
        setSpaceDown(true);
      }
      if ((e.metaKey || e.ctrlKey) && (e.key === "=" || e.key === "+")) {
        e.preventDefault();
        const el = viewportRef.current;
        if (!el) return;
        const r = el.getBoundingClientRect();
        zoomAtClientPoint(r.left + r.width / 2, r.top + r.height / 2, ZOOM_STEP);
      }
      if ((e.metaKey || e.ctrlKey) && e.key === "-") {
        e.preventDefault();
        const el = viewportRef.current;
        if (!el) return;
        const r = el.getBoundingClientRect();
        zoomAtClientPoint(r.left + r.width / 2, r.top + r.height / 2, -ZOOM_STEP);
      }
      if ((e.metaKey || e.ctrlKey) && e.key === "0") {
        e.preventDefault();
        setView({ scale: 1, tx: 40, ty: 56 });
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === "Space") setSpaceDown(false);
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, [zoomAtClientPoint]);

  /**
   * HARD FIX: attach non-passive wheel on the canvas root in the capture phase.
   * Plain wheel = zoom (Fynca-like). Ctrl/Cmd+wheel also zooms.
   * preventDefault stops the page from stealing scroll / browser pinch-zoom.
   */
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    const onWheel = (e: WheelEvent) => {
      // Only when pointer is over this board
      if (!root.contains(e.target as Node)) return;
      // Don't steal wheel from notes textarea while focused
      if (
        e.target instanceof HTMLTextAreaElement ||
        e.target instanceof HTMLInputElement ||
        (e.target instanceof HTMLElement && e.target.isContentEditable)
      ) {
        return;
      }

      e.preventDefault();
      e.stopPropagation();

      const delta = wheelZoomDelta(e);
      // Slightly larger steps for explicit ctrl/cmd+wheel
      const step = e.ctrlKey || e.metaKey ? delta * 1.35 : delta;
      zoomAtClientPoint(e.clientX, e.clientY, step);
    };

    root.addEventListener("wheel", onWheel, { passive: false, capture: true });
    return () => root.removeEventListener("wheel", onWheel, true);
  }, [zoomAtClientPoint]);

  const dragRef = useRef<{
    kind: "node" | "pan" | "resize";
    nodeId?: string;
    startX: number;
    startY: number;
    originX: number;
    originY: number;
    originW?: number;
    originTx?: number;
    originTy?: number;
  } | null>(null);

  const clientToWorld = useCallback((clientX: number, clientY: number) => {
    const el = viewportRef.current;
    if (!el) return { x: 0, y: 0 };
    const rect = el.getBoundingClientRect();
    const v = viewRef.current;
    return {
      x: (clientX - rect.left - v.tx) / v.scale,
      y: (clientY - rect.top - v.ty) / v.scale,
    };
  }, []);

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;

      if (d.kind === "pan") {
        const dx = e.clientX - d.startX;
        const dy = e.clientY - d.startY;
        setView({
          scale: viewRef.current.scale,
          tx: (d.originTx ?? 0) + dx,
          ty: (d.originTy ?? 0) + dy,
        });
        return;
      }

      if (d.kind === "resize" && d.nodeId) {
        const world = clientToWorld(e.clientX, e.clientY);
        const node = nodesById.get(d.nodeId);
        if (!node) return;
        const dims = nodeDims(node, settings);
        const nextW = clamp(world.x - node.x, 220, 720);
        onNodesChange(
          nodes.map((n) =>
            n.id === d.nodeId
              ? { ...n, w: snap(nextW, settings.gridDensity, settings.snapToGrid), h: n.h ?? dims.h }
              : n,
          ),
        );
        return;
      }

      if (d.kind === "node" && d.nodeId) {
        const scale = viewRef.current.scale;
        const dx = (e.clientX - d.startX) / scale;
        const dy = (e.clientY - d.startY) / scale;
        const nextX = snap(d.originX + dx, settings.gridDensity, settings.snapToGrid);
        const nextY = snap(d.originY + dy, settings.gridDensity, settings.snapToGrid);
        onNodesChange(
          nodes.map((n) =>
            n.id === d.nodeId
              ? { ...n, x: Math.max(BOARD_PAD, nextX), y: Math.max(BOARD_PAD, nextY) }
              : n,
          ),
        );
      }
    };

    const onUp = () => {
      const d = dragRef.current;
      if (d?.kind === "node" && d.nodeId) {
        const node = nodesById.get(d.nodeId);
        if (node) onNodeDragEnd?.(d.nodeId, node.x, node.y);
      }
      if (d?.kind === "pan") setIsPanning(false);
      dragRef.current = null;
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [clientToWorld, nodes, nodesById, onNodeDragEnd, onNodesChange, settings]);

  const beginPan = (e: React.PointerEvent) => {
    e.preventDefault();
    onSelectNode?.(null);
    setIsPanning(true);
    dragRef.current = {
      kind: "pan",
      startX: e.clientX,
      startY: e.clientY,
      originX: 0,
      originY: 0,
      originTx: viewRef.current.tx,
      originTy: viewRef.current.ty,
    };
  };

  const onDragHandlePointerDown = (nodeId: string) => (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    if (spaceDown) {
      beginPan(e);
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    onSelectNode?.(nodeId);
    dragRef.current = {
      kind: "node",
      nodeId,
      startX: e.clientX,
      startY: e.clientY,
      originX: nodesById.get(nodeId)?.x ?? BOARD_PAD,
      originY: nodesById.get(nodeId)?.y ?? BOARD_PAD,
    };
    try {
      (e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
  };

  const onResizePointerDown = (nodeId: string) => (e: React.PointerEvent) => {
    if (e.button !== 0 || spaceDown) return;
    e.preventDefault();
    e.stopPropagation();
    const node = nodesById.get(nodeId);
    if (!node) return;
    const dims = nodeDims(node, settings);
    dragRef.current = {
      kind: "resize",
      nodeId,
      startX: e.clientX,
      startY: e.clientY,
      originX: node.x,
      originY: node.y,
      originW: dims.w,
    };
  };

  const onViewportPointerDown = (e: React.PointerEvent) => {
    const isMiddle = e.button === 1;
    const target = e.target as HTMLElement | null;
    const onSurface = Boolean(target?.closest?.("[data-canvas-surface='1']"));
    const onNode = Boolean(target?.closest?.("[data-canvas-node='1']"));
    const isEmptyLeft = e.button === 0 && (spaceDown || (onSurface && !onNode));
    if (!isMiddle && !isEmptyLeft) return;
    beginPan(e);
  };

  const onPointerMoveSurface = (e: React.PointerEvent) => {
    if (!onCursorMove) return;
    const world = clientToWorld(e.clientX, e.clientY);
    onCursorMove(world.x, world.y);
  };

  const contentBounds = useMemo(() => {
    if (!nodes.length) return { minX: 0, minY: 0, maxX: 1200, maxY: 800 };
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const n of nodes) {
      const d = nodeDims(n, settings);
      minX = Math.min(minX, n.x);
      minY = Math.min(minY, n.y);
      maxX = Math.max(maxX, n.x + d.w);
      maxY = Math.max(maxY, n.y + d.h);
    }
    return {
      minX: minX - BOARD_PAD,
      minY: minY - BOARD_PAD,
      maxX: maxX + BOARD_PAD,
      maxY: maxY + BOARD_PAD,
    };
  }, [nodes, settings]);

  const stageSize = useMemo(() => {
    const w = Math.max(viewportSize.w / MIN_ZOOM + 400, contentBounds.maxX + 400, 1800);
    const h = Math.max(viewportSize.h / MIN_ZOOM + 400, contentBounds.maxY + 400, 1400);
    return { w, h };
  }, [contentBounds.maxX, contentBounds.maxY, viewportSize.h, viewportSize.w]);

  const wires = useMemo(() => {
    if (!settings.showWires) return [];
    return edges
      .map((edge) => {
        const from = nodesById.get(edge.from);
        const to = nodesById.get(edge.to);
        if (!from || !to) return null;
        const fd = nodeDims(from, settings);
        const td = nodeDims(to, settings);
        const portYFrom = Math.min(fd.h * 0.35, 44);
        const portYTo = Math.min(td.h * 0.35, 44);
        return {
          id: edge.id,
          path: edgePath(from.x + fd.w, from.y + portYFrom, to.x, to.y + portYTo),
        };
      })
      .filter(Boolean) as Array<{ id: string; path: string }>;
  }, [edges, nodesById, settings]);

  const fitToContent = useCallback(() => {
    const pad = 56;
    const bw = contentBounds.maxX - contentBounds.minX;
    const bh = contentBounds.maxY - contentBounds.minY;
    if (bw <= 0 || bh <= 0) return;
    const scale = clamp(
      Math.min((viewportSize.w - pad * 2) / bw, (viewportSize.h - pad * 2) / bh),
      MIN_ZOOM,
      1.15,
    );
    const tx = (viewportSize.w - bw * scale) / 2 - contentBounds.minX * scale;
    const ty = (viewportSize.h - bh * scale) / 2 - contentBounds.minY * scale;
    setView({ scale, tx, ty });
  }, [contentBounds, viewportSize.h, viewportSize.w]);

  const resetView = () => setView({ scale: 1, tx: 40, ty: 56 });

  const zoomBy = (delta: number) => {
    const el = viewportRef.current;
    if (!el) {
      setView((v) => ({ ...v, scale: clamp(v.scale + delta, MIN_ZOOM, MAX_ZOOM) }));
      return;
    }
    const r = el.getBoundingClientRect();
    zoomAtClientPoint(r.left + r.width / 2, r.top + r.height / 2, delta);
  };

  const onUpdateNodeNotes = (nodeId: string, nextText: string) => {
    onNodesChange(
      nodes.map((n) => {
        if (n.id !== nodeId) return n;
        return {
          ...n,
          data: { ...n.data, text: nextText },
          contentText: nextText,
        };
      }),
    );
  };

  const zoomPct = Math.round(view.scale * 100);

  return (
    <div
      ref={rootRef}
      className="relative flex min-h-[70vh] h-[min(78vh,860px)] w-full flex-col overflow-hidden rounded-2xl border border-[hsl(var(--glass-border))]/40 bg-[hsl(var(--foreground)/0.015)]"
    >
      {/* Settings — top-right only (zoom toolbar moved to bottom to avoid overlapping nodes) */}
      <div className="pointer-events-none absolute right-3 top-3 z-40">
        <div className="pointer-events-auto">
          <CanvasSettingsDock
            open={settingsOpen}
            onOpenChange={setSettingsOpen}
            settings={settings}
            onSettingsChange={onSettingsChange}
            onResetLayout={onResetLayout}
          />
        </div>
      </div>

      <div
        ref={viewportRef}
        className={cn(
          "relative min-h-0 flex-1 touch-none overflow-hidden",
          spaceDown || isPanning ? "cursor-grab active:cursor-grabbing" : "cursor-default",
        )}
        onPointerDown={onViewportPointerDown}
        onPointerMove={onPointerMoveSurface}
        data-canvas-surface="1"
      >
        <div
          className="absolute left-0 top-0 origin-top-left will-change-transform"
          style={{
            width: stageSize.w,
            height: stageSize.h,
            transform: `translate(${view.tx}px, ${view.ty}px) scale(${view.scale})`,
          }}
          data-canvas-surface="1"
        >
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 opacity-[0.45]"
            data-canvas-surface="1"
            style={{
              backgroundImage:
                "radial-gradient(hsl(var(--muted-foreground) / 0.18) 1px, transparent 1px)",
              backgroundSize: `${settings.gridDensity}px ${settings.gridDensity}px`,
              backgroundPosition: `${settings.gridDensity / 2}px ${settings.gridDensity / 2}px`,
            }}
          />
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0"
            data-canvas-surface="1"
            style={{
              background:
                "radial-gradient(ellipse 70% 50% at 20% 0%, hsl(var(--primary) / 0.06), transparent 55%)",
            }}
          />

          {settings.showWires ? (
            <svg className="pointer-events-none absolute inset-0" width={stageSize.w} height={stageSize.h}>
              {wires.map((w) => (
                <path
                  key={w.id}
                  d={w.path}
                  fill="none"
                  stroke="hsl(var(--muted-foreground) / 0.28)"
                  strokeWidth={2.25}
                  strokeLinecap="round"
                />
              ))}
            </svg>
          ) : null}

          {nodes.map((node) => {
            const dims = nodeDims(node, settings);
            const selected = selectedNodeId === node.id;
            return (
              <div
                key={node.id}
                className="absolute"
                data-canvas-node="1"
                style={{ left: node.x, top: node.y, width: dims.w, height: dims.h }}
                onPointerDown={(e) => {
                  if (spaceDown) {
                    beginPan(e);
                    return;
                  }
                  onSelectNode?.(node.id);
                }}
              >
                <NodeCard
                  node={node}
                  sym={sym}
                  width={dims.w}
                  height={dims.h}
                  selected={selected}
                  onChangeNotes={node.type === "notes" ? (t) => onUpdateNodeNotes(node.id, t) : undefined}
                  onDragHandlePointerDown={onDragHandlePointerDown(node.id)}
                  onResizePointerDown={
                    node.type !== "engine" ? onResizePointerDown(node.id) : undefined
                  }
                />
              </div>
            );
          })}

          {remoteCursors.map((c) => (
            <div
              key={c.clientId}
              className="pointer-events-none absolute z-50"
              style={{ left: c.x, top: c.y, transform: "translate(-2px, -2px)" }}
            >
              <svg width="16" height="20" viewBox="0 0 16 20" fill="none" aria-hidden>
                <path
                  d="M1 1L1 17L5.5 12.5L9.5 19L12 17.5L8 11H14L1 1Z"
                  fill={c.color}
                  stroke="hsl(var(--background))"
                  strokeWidth="1"
                />
              </svg>
              <span
                className="ml-3 -mt-1 inline-block rounded-md px-1.5 py-0.5 text-[10px] font-medium text-white shadow-sm"
                style={{ backgroundColor: c.color }}
              >
                {c.name}
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* Zoom toolbar — bottom center so it never covers starter engines/nodes */}
      <div className="pointer-events-none absolute inset-x-0 bottom-3 z-40 flex justify-center px-3">
        <div className="pointer-events-auto flex items-center gap-1 rounded-xl border border-[hsl(var(--glass-border))]/50 bg-[hsl(var(--background)/0.88)] p-1 shadow-[0_8px_28px_-18px_hsl(var(--foreground)/0.45)] backdrop-blur-md">
          <button
            type="button"
            className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground hover:text-foreground"
            onClick={() => zoomBy(-ZOOM_STEP)}
            title="Zoom out"
            aria-label="Zoom out"
          >
            <Minus className="h-3.5 w-3.5" />
          </button>
          <span className="min-w-[3.25rem] text-center font-mono text-[11px] tabular-nums text-muted-foreground">
            {zoomPct}%
          </span>
          <button
            type="button"
            className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground hover:text-foreground"
            onClick={() => zoomBy(ZOOM_STEP)}
            title="Zoom in"
            aria-label="Zoom in"
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
          <div className="mx-0.5 h-5 w-px bg-[hsl(var(--glass-border))]/50" />
          <button
            type="button"
            className="inline-flex h-8 items-center gap-1.5 rounded-lg px-2 text-[11px] font-medium text-muted-foreground hover:text-foreground"
            onClick={fitToContent}
            title="Fit to content"
          >
            <Focus className="h-3.5 w-3.5" />
            Fit
          </button>
          <button
            type="button"
            className="inline-flex h-8 items-center gap-1.5 rounded-lg px-2 text-[11px] font-medium text-muted-foreground hover:text-foreground"
            onClick={resetView}
            title="Reset view"
          >
            <RotateCcw className="h-3.5 w-3.5" />
            Reset
          </button>
        </div>
      </div>

      <div className="pointer-events-none absolute bottom-14 left-4 text-[10.5px] text-muted-foreground/55">
        Scroll to zoom · Space+drag to pan · Drag nodes by header
      </div>
    </div>
  );
}

export { DEFAULT_BOARD_SETTINGS };
