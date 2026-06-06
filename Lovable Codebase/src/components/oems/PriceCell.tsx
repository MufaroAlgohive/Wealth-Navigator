import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { ArrowDown, ArrowUp } from "lucide-react";
import { useTick } from "@/lib/oemsStream";

interface Props {
  tickKey: string;
  fallback: number;
  decimals?: number;
  showChange?: boolean;
  className?: string;
}

export default function PriceCell({ tickKey, fallback, decimals = 2, showChange = true, className }: Props) {
  const t = useTick(tickKey, fallback);
  const prev = useRef(t.last);
  const [flash, setFlash] = useState<"up" | "down" | null>(null);

  useEffect(() => {
    if (t.last !== prev.current) {
      setFlash(t.last > prev.current ? "up" : "down");
      prev.current = t.last;
      const id = setTimeout(() => setFlash(null), 350);
      return () => clearTimeout(id);
    }
  }, [t.last]);

  return (
    <span className={cn("font-mono tabular-nums inline-flex items-baseline gap-1 transition-colors rounded px-1",
      flash === "up" && "bg-success/25 text-success",
      flash === "down" && "bg-destructive/25 text-destructive",
      className)}>
      <span>{t.last.toFixed(decimals)}</span>
      {showChange && t.changePct !== 0 && (
        <span className={cn("text-[10px]", t.changePct >= 0 ? "text-success" : "text-destructive")}>
          {t.changePct >= 0 ? <ArrowUp className="inline h-2.5 w-2.5" /> : <ArrowDown className="inline h-2.5 w-2.5" />}
          {Math.abs(t.changePct).toFixed(2)}%
        </span>
      )}
    </span>
  );
}
