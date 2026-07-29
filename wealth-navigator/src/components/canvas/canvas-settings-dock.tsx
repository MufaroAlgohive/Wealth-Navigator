"use client";

import { Settings2, X } from "lucide-react";

import { cn } from "@/lib/cn";

import type { CanvasBoardSettings } from "./types";
import { DEFAULT_BOARD_SETTINGS } from "./types";

export function CanvasSettingsDock({
  open,
  onOpenChange,
  settings,
  onSettingsChange,
  onResetLayout,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  settings: CanvasBoardSettings;
  onSettingsChange: (next: CanvasBoardSettings) => void;
  onResetLayout: () => void;
}) {
  const set = <K extends keyof CanvasBoardSettings>(key: K, value: CanvasBoardSettings[K]) => {
    onSettingsChange({ ...settings, [key]: value });
  };

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => onOpenChange(!open)}
        className={cn(
          "inline-flex h-8 w-8 items-center justify-center rounded-lg border border-[hsl(var(--glass-border))]/60",
          "bg-[hsl(var(--background)/0.7)] text-muted-foreground backdrop-blur-sm transition-colors hover:text-foreground",
          open && "border-primary/40 text-foreground",
        )}
        title="Canvas settings"
        aria-expanded={open}
        aria-label="Canvas settings"
      >
        <Settings2 className="h-3.5 w-3.5" />
      </button>

      {open ? (
        <div
          className={cn(
            "absolute right-0 top-10 z-40 w-72 overflow-hidden rounded-xl border border-[hsl(var(--glass-border))]/50",
            "bg-[hsl(var(--background)/0.92)] p-3.5 shadow-[0_16px_48px_-28px_hsl(var(--foreground)/0.45)] backdrop-blur-md",
          )}
          role="dialog"
          aria-label="Board settings"
        >
          <div className="mb-3 flex items-center justify-between gap-2">
            <p className="text-[12.5px] font-semibold tracking-tight">Board settings</p>
            <button
              type="button"
              className="rounded-md p-1 text-muted-foreground hover:text-foreground"
              onClick={() => onOpenChange(false)}
              aria-label="Close settings"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>

          <div className="space-y-3 text-[12px]">
            <label className="flex items-center justify-between gap-3">
              <span className="text-muted-foreground">Snap to grid</span>
              <input
                type="checkbox"
                checked={settings.snapToGrid}
                onChange={(e) => set("snapToGrid", e.target.checked)}
                className="h-3.5 w-3.5 accent-[hsl(var(--primary))]"
              />
            </label>

            <label className="flex items-center justify-between gap-3">
              <span className="text-muted-foreground">Show wires</span>
              <input
                type="checkbox"
                checked={settings.showWires}
                onChange={(e) => set("showWires", e.target.checked)}
                className="h-3.5 w-3.5 accent-[hsl(var(--primary))]"
              />
            </label>

            <label className="block space-y-1.5">
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Grid density</span>
                <span className="font-mono text-[10.5px] tabular-nums text-muted-foreground/80">
                  {settings.gridDensity}px
                </span>
              </div>
              <input
                type="range"
                min={16}
                max={48}
                step={4}
                value={settings.gridDensity}
                onChange={(e) => set("gridDensity", Number(e.target.value))}
                className="w-full accent-[hsl(var(--primary))]"
              />
            </label>

            <label className="block space-y-1.5">
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Default node width</span>
                <span className="font-mono text-[10.5px] tabular-nums text-muted-foreground/80">
                  {settings.defaultNodeW}px
                </span>
              </div>
              <input
                type="range"
                min={280}
                max={560}
                step={20}
                value={settings.defaultNodeW}
                onChange={(e) => set("defaultNodeW", Number(e.target.value))}
                className="w-full accent-[hsl(var(--primary))]"
              />
            </label>

            <label className="block space-y-1.5">
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Default node height</span>
                <span className="font-mono text-[10.5px] tabular-nums text-muted-foreground/80">
                  {settings.defaultNodeH}px
                </span>
              </div>
              <input
                type="range"
                min={220}
                max={480}
                step={20}
                value={settings.defaultNodeH}
                onChange={(e) => set("defaultNodeH", Number(e.target.value))}
                className="w-full accent-[hsl(var(--primary))]"
              />
            </label>

            <div className="flex gap-2 pt-1">
              <button
                type="button"
                className="h-8 flex-1 rounded-lg border border-[hsl(var(--glass-border))]/60 text-[11px] font-medium text-muted-foreground hover:text-foreground"
                onClick={() => onSettingsChange({ ...DEFAULT_BOARD_SETTINGS })}
              >
                Reset settings
              </button>
              <button
                type="button"
                className="h-8 flex-1 rounded-lg border border-[hsl(var(--glass-border))]/60 text-[11px] font-medium text-muted-foreground hover:text-foreground"
                onClick={onResetLayout}
              >
                Reset layout
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
