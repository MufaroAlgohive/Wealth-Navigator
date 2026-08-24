"use client";

import * as React from "react";
import { cn } from "@/lib/cn";
import type { DataSourceKind, DbName } from "@/components/oems/primitives/data-source-badge";
import { DataSourceBadge } from "@/components/oems/primitives/data-source-badge";
import { useDevTools } from "@/lib/dev/dev-tools";

/** Full-page ambient wrapper for OEMS pages */
export function ResearchLabCanvas({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("relative space-y-5 pb-8", className)}>{children}</div>
  );
}

/** Alias for non–Research Lab pages */
export const PageCanvas = ResearchLabCanvas;

interface GlassSectionProps extends React.HTMLAttributes<HTMLElement> {
  title: string;
  subtitle?: string;
  endpoint?: string;
  dataSource?: DataSourceKind;
  /** Which Supabase DB the data lives in — renders an mfxng/nnwz chip by the source pill. */
  db?: DbName;
  right?: React.ReactNode;
  noPadding?: boolean;
}

export function GlassSection({
  title,
  subtitle,
  endpoint,
  dataSource,
  db,
  right,
  noPadding,
  className,
  children,
  ...rest
}: GlassSectionProps) {
  const dev = useDevTools();
  return (
    <section className={cn("glass-panel", className)} {...rest}>
      <header className="flex items-start justify-between gap-3 px-5 py-3.5">
        <div className="min-w-0 space-y-0.5">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-section">{title}</h2>
            {(dataSource || db) && <DataSourceBadge source={dataSource ?? "supabase"} db={db} />}
          </div>
          {(() => {
            // The `endpoint` (e.g. "GET /api/…") is a developer affordance. It is
            // hidden from normal users so the UI reads clean, and shown in local
            // dev OR to the allowlisted debug users (IRESS integration devs) in
            // any build, so they can trace which API each module calls.
            const showEndpoint = Boolean(endpoint) && (process.env.NODE_ENV !== "production" || dev.enabled);
            if (!subtitle && !showEndpoint) return null;
            return (
              <p className="text-caption truncate">
                {subtitle}
                {subtitle && showEndpoint ? " · " : ""}
                {showEndpoint && <span className="font-mono text-[10px] opacity-70">{endpoint}</span>}
              </p>
            );
          })()}
        </div>
        {right && <div className="shrink-0">{right}</div>}
      </header>
      {/* Body is a flex column that fills the section. Consumers that give the
          section a fixed height (e.g. `flex h-[300px] flex-col`) rely on this so
          their `flex-1` children — chart wrappers (recharts `height="100%"`) and
          `GlassScrollBody` — resolve a real height instead of collapsing to 0.
          For auto-height (block) sections the flex props are inert. */}
      <div className={cn("flex min-h-0 flex-1 flex-col", !noPadding && "p-5")}>{children}</div>
    </section>
  );
}

interface GlassKpiProps {
  label: string;
  value: string;
  sub?: React.ReactNode;
  accent?: "default" | "positive" | "negative" | "primary";
  /** Optional data-source badge (+ DB chip) shown beside the label. */
  dataSource?: DataSourceKind;
  db?: DbName;
}

export function GlassKpi({ label, value, sub, accent = "default", dataSource, db }: GlassKpiProps) {
  return (
    <div className="glass-kpi group">
      <div className="flex items-center justify-between gap-2">
        <p className="text-caption">{label}</p>
        {(dataSource || db) && <DataSourceBadge source={dataSource ?? "supabase"} db={db} />}
      </div>
      <p
        className={cn(
          "text-metric mt-1.5",
          accent === "positive" && "text-up",
          accent === "negative" && "text-down",
          accent === "primary" && "text-primary",
        )}
      >
        {value}
      </p>
      {sub && (
        <p
          className={cn(
            "mt-1 font-mono text-xs tabular-nums",
            accent === "positive" && "text-up/80",
            accent === "negative" && "text-down/80",
            accent === "default" && "text-muted-foreground",
          )}
        >
          {sub}
        </p>
      )}
      <div
        className={cn(
          "pointer-events-none absolute -right-6 -top-6 h-20 w-20 rounded-full opacity-0 blur-2xl transition-opacity duration-500 group-hover:opacity-100",
          accent === "primary" ? "bg-primary/20" : "bg-primary/10",
        )}
      />
    </div>
  );
}

interface GlassSegmentProps {
  value: string;
  options: { id: string; label: string }[];
  onChange: (id: string) => void;
}

export function GlassSegment({ value, options, onChange }: GlassSegmentProps) {
  return (
    <div className="glass-inset inline-flex p-1">
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          onClick={() => onChange(o.id)}
          className={cn(
            "rounded-lg px-3.5 py-1.5 text-xs font-medium transition-all duration-200",
            value === o.id
              ? "bg-primary text-primary-foreground shadow-[0_2px_12px_hsl(var(--primary)/0.35)]"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function GlassBadge({
  children,
  tone = "neutral",
}: {
  children: React.ReactNode;
  tone?: "neutral" | "primary" | "success" | "warning";
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium backdrop-blur-sm",
        tone === "primary" && "bg-primary/10 text-primary",
        tone === "success" && "bg-success/10 text-success",
        tone === "warning" && "bg-warning/10 text-warning",
        tone === "neutral" && "bg-[hsl(var(--foreground)/0.04)] text-muted-foreground",
      )}
    >
      {children}
    </span>
  );
}
