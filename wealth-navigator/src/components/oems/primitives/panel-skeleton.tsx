import { cn } from "@/lib/cn";

interface PanelSkeletonProps {
  /** Number of shimmering rows to render inside the body. Defaults to 4. */
  rows?: number;
  /** Tailwind height class for the panel itself (e.g. "h-[300px]"). */
  height?: string;
  /** Whether to render a placeholder header strip. */
  showHeader?: boolean;
  /** Tailwind classes appended to the panel. */
  className?: string;
  /** Width overrides for the first N rows (Tailwind classes, e.g. "w-3/4").
   * Useful for mimicking the lopsided text density of real panel bodies. */
  rowWidths?: string[];
}

/**
 * PanelSkeleton — a `Panel`-shaped placeholder rendered while a `useQuery`
 * is in flight. The body is N 8px-tall shimmering bars on a transparent
 * background. Pure CSS animation (no JS timers, no SSR hazards). The
 * shimmer keyframe lives in `globals.css`.
 *
 * Usage: drop it in place of the real panel content while `isLoading` is
 * true. On `isError`, render a small inline error in the panel header
 * instead — the skeleton is for first-paint only.
 */
export function PanelSkeleton({
  rows = 4,
  height,
  showHeader = true,
  className,
  rowWidths,
}: PanelSkeletonProps) {
  // Pre-resolve each row's width + stable key. The key is derived from the
  // resolved width string (not the array index) so the same row across
  // renders is matched by React, even though the index would change if
  // `rows` ever changed mid-render.
  const resolvedRows = Array.from({ length: Math.max(1, rows) }, (_, n) => {
    const width = rowWidths?.[n] ?? defaultWidths(n);
    return { key: `panel-row-${n}-${width}`, width };
  });
  return (
    <section
      aria-busy="true"
      aria-live="polite"
      className={cn(
        "flex min-h-0 flex-col rounded-lg border border-border bg-card text-card-foreground",
        "shadow-[0_1px_0_0_hsl(var(--border))]",
        height,
        className,
      )}
    >
      {showHeader && (
        <header className="flex shrink-0 items-center gap-2 border-b border-border/70 bg-card/60 px-3.5 py-2 backdrop-blur-sm">
          <span className="shimmer h-1.5 w-1.5 rounded-full" />
          <span className="shimmer h-2.5 w-32 rounded" />
        </header>
      )}
      <div className="flex flex-1 flex-col gap-1.5 p-3.5">
        {resolvedRows.map((row) => (
          <span
            key={row.key}
            className="shimmer h-2 rounded"
            style={{ width: row.width }}
          />
        ))}
      </div>
    </section>
  );
}

/**
 * A variant for a single KPI tile — a 3-bar skeleton (label / value / sub)
 * with a 24px icon box. Used for KPI strips that load as a row.
 */
export function KpiTileSkeleton({ className }: { className?: string }) {
  return (
    <div
      aria-busy="true"
      aria-live="polite"
      className={cn(
        "rounded-md border border-border bg-card p-3",
        "shadow-[inset_0_1px_0_0_hsl(var(--border)/0.3)]",
        className,
      )}
    >
      <div className="flex items-center gap-2">
        <span className="shimmer h-5 w-5 rounded" />
        <span className="shimmer h-2.5 w-20 rounded" />
      </div>
      <span className="shimmer mt-2.5 block h-4 w-28 rounded" />
      <span className="shimmer mt-1.5 block h-2 w-16 rounded" />
    </div>
  );
}

/**
 * A row-shaped skeleton for table cells. The caller controls the width
 * with a Tailwind class (e.g. `w-32`). Renders 2 stacked lines to mimic
 * the row height of dense trading tables.
 */
export function TableRowSkeleton({ className }: { className?: string }) {
  return (
    <div aria-busy="true" aria-live="polite" className={cn("px-2.5 py-1.5", className)}>
      <span className="shimmer block h-2.5 rounded" />
    </div>
  );
}

/**
 * A 2-bar list-item skeleton for the watchlist / movers column.
 */
export function ListItemSkeleton({ className }: { className?: string }) {
  return (
    <div aria-busy="true" aria-live="polite" className={cn("px-3 py-1.5", className)}>
      <div className="flex items-center justify-between gap-2">
        <span className="shimmer h-2.5 w-16 rounded" />
        <span className="shimmer h-2.5 w-12 rounded" />
      </div>
      <span className="shimmer mt-1.5 block h-2 w-3/4 rounded" />
    </div>
  );
}

/**
 * Inline error placeholder for when a `useQuery` resolves to `isError`.
 * Lighter than a full empty state — the rest of the desk still renders
 * normally. Renders inside the same grid cell the panel would have
 * occupied, so layout doesn't shift.
 */
export function PanelErrorShell({
  title,
  className,
  height,
  message = "IRESS adapter unreachable",
}: {
  title: string;
  className?: string;
  height?: string;
  message?: string;
}) {
  return (
    <section
      role="alert"
      className={cn(
        "flex min-h-0 flex-col rounded-lg border border-destructive/40 bg-destructive/5 text-card-foreground",
        height,
        className,
      )}
    >
      <header className="flex shrink-0 items-center gap-2 border-b border-destructive/30 bg-card/60 px-3.5 py-2">
        <span className="h-1.5 w-1.5 rounded-full bg-destructive" />
        <h3 className="truncate text-[11px] font-semibold uppercase tracking-wider text-foreground/90">
          {title}
        </h3>
      </header>
      <div className="flex flex-1 items-center justify-center px-3.5 py-3 text-[11px] text-destructive">
        {message}
      </div>
    </section>
  );
}

/**
 * Vary the shimmer bar width by index so the body looks more natural
 * than a uniform grid of identical stripes.
 */
function defaultWidths(i: number): string {
  const cycle = ["88%", "72%", "94%", "60%", "82%", "68%"];
  return cycle[i % cycle.length] ?? "80%";
}
