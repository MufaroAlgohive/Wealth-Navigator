"use client";

import { DatabaseZap } from "lucide-react";
import { cn } from "@/lib/cn";
import { FEED_NOT_CONFIGURED } from "@/lib/data-policy";

interface EmptyDataStateProps {
  title?: string;
  message?: string;
  className?: string;
}

/** Honest empty state when no live feed is wired for a panel. */
export function EmptyDataState({
  title = "No live data",
  message = FEED_NOT_CONFIGURED,
  className,
}: EmptyDataStateProps) {
  return (
    <div
      className={cn(
        "flex h-full min-h-[120px] flex-col items-center justify-center gap-2 px-4 py-8 text-center",
        className,
      )}
    >
      <DatabaseZap className="h-5 w-5 text-muted-foreground/60" aria-hidden />
      <p className="text-xs font-medium text-foreground/90">{title}</p>
      <p className="max-w-xs text-[11px] text-muted-foreground">{message}</p>
    </div>
  );
}
