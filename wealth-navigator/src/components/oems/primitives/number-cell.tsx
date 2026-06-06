"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowDown, ArrowUp, Minus } from "lucide-react";
import { cn } from "@/lib/cn";
import { useTick } from "@/lib/store/tick-stream-provider";

interface NumberCellProps {
  /** Tick-stream key. If absent, renders the fallback as a static value. */
  sym?: string;
  /** Static value when no tick key is given (or before the first tick). */
  fallback?: number;
  decimals?: number;
  signed?: boolean;
  showArrow?: boolean;
  showChange?: boolean;
  /** Render `+` prefix on positive values. */
  prefix?: boolean;
  /** Append this string to the rendered value (e.g. "%", " bp"). */
  suffix?: string;
  className?: string;
  size?: "xs" | "sm" | "md" | "lg" | "xl";
  /** Show a brief background flash when the value updates. */
  flash?: boolean;
  tone?: "default" | "up" | "down" | "muted";
  onClick?: () => void;
}

/**
 * A number cell that subscribes to the tick stream, flashes on update,
 * and is fully accessible (no animation-only signal — colour is also used).
 */
export function NumberCell({
  sym,
  fallback = 0,
  decimals = 2,
  signed = false,
  showArrow = false,
  showChange = false,
  prefix = false,
  suffix,
  className,
  size = "sm",
  flash = true,
  tone = "default",
  onClick,
}: NumberCellProps) {
  const t = sym ? useTick(sym) : undefined;
  const value = t ? t.last : fallback;
  const change = t ? t.changePct : 0;
  const prev = useRef(value);
  const [dir, setDir] = useState<"up" | "down" | null>(null);

  useEffect(() => {
    if (!t || !flash) return;
    if (value === prev.current) return;
    setDir(value > prev.current ? "up" : "down");
    prev.current = value;
    const id = setTimeout(() => setDir(null), 600);
    return () => clearTimeout(id);
  }, [value, t, flash]);

  const isUp = change > 0;
  const isDown = change < 0;
  const isFlat = change === 0;

  const toneClass =
    tone === "up" ? "text-up" :
    tone === "down" ? "text-down" :
    tone === "muted" ? "text-muted-foreground" :
    signed ? (isUp ? "text-up" : isDown ? "text-down" : "text-foreground") :
    "text-foreground";

  const sizeClass = {
    xs: "text-[11px]",
    sm: "text-xs",
    md: "text-sm",
    lg: "text-base",
    xl: "text-xl",
  }[size];

  return (
    <span
      data-num
      onClick={onClick}
      className={cn(
        "inline-flex items-baseline gap-1 font-mono tabular-nums transition-colors",
        sizeClass,
        toneClass,
        onClick && "cursor-pointer hover:underline underline-offset-2",
        className,
      )}
    >
      {showArrow && (
        isUp ? <ArrowUp className={cn("self-center", size === "xs" ? "h-2.5 w-2.5" : "h-3 w-3")} /> :
        isDown ? <ArrowDown className={cn("self-center", size === "xs" ? "h-2.5 w-2.5" : "h-3 w-3")} /> :
        <Minus className={cn("self-center opacity-40", size === "xs" ? "h-2.5 w-2.5" : "h-3 w-3")} />
      )}
      <span
        className={cn(
          "rounded-sm transition-colors duration-300",
          flash && dir === "up" && "bg-up/15",
          flash && dir === "down" && "bg-down/15",
        )}
      >
        {prefix && isUp ? "+" : ""}
        {value.toLocaleString("en-ZA", { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}
        {suffix && <span className="text-muted-foreground">{suffix}</span>}
      </span>
      {showChange && t && (
        <span className={cn("font-mono text-[10px] tabular-nums", isUp ? "text-up" : isDown ? "text-down" : "text-muted-foreground")}>
          {isFlat ? "0.00%" : `${isUp ? "+" : ""}${change.toFixed(2)}%`}
        </span>
      )}
    </span>
  );
}
