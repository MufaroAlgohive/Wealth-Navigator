"use client";

import * as React from "react";
import { Info, CircleDot } from "lucide-react";
import { cn } from "@/lib/cn";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Badge } from "@/components/ui/badge";

type Status = "live" | "delayed" | "halt" | "stale";

interface PanelProps extends React.HTMLAttributes<HTMLDivElement> {
  title: string;
  /** IRESS V4 method or endpoint this panel is bound to. */
  endpoint?: string;
  /** Right-slot content (numeric eyebrow, action button, etc.). */
  right?: React.ReactNode;
  /** Whether the body is `comfortable`, `dense`, or `scroll`. */
  density?: "comfortable" | "dense" | "scroll";
  status?: Status;
  subtitle?: string;
}

/**
 * The Panel is the unit of the trading desk. A title, an IRESS V4 endpoint
 * pill (on hover, the method name), a status dot, and a body.
 */
export function Panel({
  title,
  endpoint,
  right,
  density = "comfortable",
  status = "live",
  subtitle,
  className,
  children,
  ...rest
}: PanelProps) {
  return (
    <section
      className={cn(
        "group flex min-h-0 flex-col rounded-lg border border-border bg-card text-card-foreground transition-colors",
        "shadow-[0_1px_0_0_hsl(var(--border))]",
        "hover:border-border-strong",
        className,
      )}
      {...rest}
    >
      <header className="flex shrink-0 items-center justify-between gap-3 border-b border-border/70 bg-card/60 px-3.5 py-2 backdrop-blur-sm">
        <div className="flex min-w-0 items-center gap-2">
          <StatusDot status={status} />
          <h3 className="truncate text-[11px] font-semibold uppercase tracking-wider text-foreground/90">
            {title}
          </h3>
          {endpoint && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Badge variant="ghost" className="ml-0.5 cursor-default gap-1 px-1.5 py-0 font-mono text-[9px] normal-case tracking-tight text-muted-foreground/80 hover:text-muted-foreground">
                  <Info className="h-2.5 w-2.5" />
                  {endpoint}
                </Badge>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="font-mono text-[10px]">
                IRESS V4 · {endpoint}
              </TooltipContent>
            </Tooltip>
          )}
          {subtitle && <span className="hidden truncate text-[10px] text-muted-foreground lg:inline">· {subtitle}</span>}
        </div>
        {right && <div className="shrink-0 text-right text-[10px] text-muted-foreground">{right}</div>}
      </header>
      <div
        className={cn(
          "min-h-0 flex-1",
          density === "comfortable" && "p-3.5",
          density === "dense" && "p-0",
          density === "scroll" && "overflow-y-auto scrollbar-thin",
        )}
      >
        {children}
      </div>
    </section>
  );
}

function StatusDot({ status }: { status: Status }) {
  const colour =
    status === "live" ? "bg-success" :
    status === "delayed" ? "bg-warning" :
    status === "stale" ? "bg-muted-foreground" :
    "bg-destructive";
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="relative inline-flex h-1.5 w-1.5 shrink-0">
          <span className={cn("absolute inline-flex h-full w-full rounded-full opacity-50", colour, status === "live" && "animate-ping")} />
          <span className={cn("relative inline-flex h-1.5 w-1.5 rounded-full", colour)} />
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="font-mono text-[10px]">
        {status.toUpperCase()}
      </TooltipContent>
    </Tooltip>
  );
}
