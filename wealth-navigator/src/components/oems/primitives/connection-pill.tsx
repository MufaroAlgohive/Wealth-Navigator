"use client";

import { Activity, Radio } from "lucide-react";
import { cn } from "@/lib/cn";
import { useLastTickTs } from "@/lib/store/tick-stream-provider";
import { useEffect, useState } from "react";

export function ConnectionPill() {
  const last = useLastTickTs();
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const age = Math.max(0, now - last);
  const live = age < 2000;
  const stale = age > 5000;
  return (
    <div
      className={cn(
        "flex items-center gap-1.5 rounded-md border px-2 py-1 font-mono text-[10px]",
        live && "border-success/30 bg-success/5 text-success",
        !live && !stale && "border-warning/30 bg-warning/5 text-warning",
        stale && "border-destructive/30 bg-destructive/5 text-destructive",
      )}
    >
      {live ? <Radio className="h-3 w-3 animate-pulse" /> : <Activity className="h-3 w-3" />}
      <span>{live ? "WS OK" : stale ? "STALE" : "LAG"}</span>
      <span className="text-muted-foreground/70">·</span>
      <span>{age < 1000 ? "<1s" : `${(age / 1000).toFixed(1)}s`}</span>
    </div>
  );
}
