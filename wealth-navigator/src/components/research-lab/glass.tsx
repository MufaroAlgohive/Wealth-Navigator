"use client";

import * as React from "react";
import { cn } from "@/lib/cn";
import type { DataSourceKind } from "@/components/oems/primitives/data-source-badge";
import { DataSourceBadge } from "@/components/oems/primitives/data-source-badge";

/** Full-page ambient wrapper for Research Lab */
export function ResearchLabCanvas({ children }: { children: React.ReactNode }) {
  return <div className="relative space-y-5 pb-8">{children}</div>;
}

interface GlassSectionProps extends React.HTMLAttributes<HTMLElement> {
  title: string;
  subtitle?: string;
  endpoint?: string;
  dataSource?: DataSourceKind;
  right?: React.ReactNode;
  noPadding?: boolean;
}

export function GlassSection({
  title,
  subtitle,
  endpoint,
  dataSource,
  right,
  noPadding,
  className,
  children,
  ...rest
}: GlassSectionProps) {
  return (
    <section className={cn("glass-panel", className)} {...rest}>
      <header className="flex items-start justify-between gap-3 border-b border-[hsl(var(--glass-border))] px-5 py-3.5">
        <div className="min-w-0 space-y-0.5">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-section">{title}</h2>
            {dataSource && <DataSourceBadge source={dataSource} />}
          </div>
          {(subtitle || endpoint) && (
            <p className="text-caption truncate">
              {subtitle}
              {subtitle && endpoint ? " · " : ""}
              {endpoint && <span className="font-mono text-[10px] opacity-70">{endpoint}</span>}
            </p>
          )}
        </div>
        {right && <div className="shrink-0">{right}</div>}
      </header>
      <div className={cn(!noPadding && "p-5")}>{children}</div>
    </section>
  );
}

interface GlassKpiProps {
  label: string;
  value: string;
  sub?: React.ReactNode;
  accent?: "default" | "positive" | "negative" | "primary";
}

export function GlassKpi({ label, value, sub, accent = "default" }: GlassKpiProps) {
  return (
    <div className="glass-kpi group">
      <p className="text-caption">{label}</p>
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
  tone?: "neutral" | "primary" | "success";
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium backdrop-blur-sm",
        tone === "primary" && "border-primary/30 bg-primary/10 text-primary",
        tone === "success" && "border-success/30 bg-success/10 text-success",
        tone === "neutral" && "border-[hsl(var(--glass-border))] bg-[hsl(var(--foreground)/0.04)] text-muted-foreground",
      )}
    >
      {children}
    </span>
  );
}
