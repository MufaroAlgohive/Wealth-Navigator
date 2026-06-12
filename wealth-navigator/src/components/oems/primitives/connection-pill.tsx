"use client";

import { Activity, Radio } from "lucide-react";
import { cn } from "@/lib/cn";
import { deriveConnectionStatus } from "@/lib/connection-status";
import { isRealDataOnlyClient } from "@/lib/data-policy";
import { useLastTickTs, useQuoteFeedKind } from "@/lib/store/tick-stream-provider";
import { useEffect, useState } from "react";

export function ConnectionPill() {
  const last = useLastTickTs();
  const feedKind = useQuoteFeedKind();
  const realDataOnly = isRealDataOnlyClient();
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const age = Math.max(0, now - last);
  const { label, tone } = deriveConnectionStatus(age, feedKind, realDataOnly);
  const live = tone === "live";
  const stale = tone === "stale";

  return (
    <div
      className={cn(
        "flex items-center gap-1.5 rounded-md border px-2 py-1 font-mono text-[10px]",
        live && "border-success/30 bg-success/5 text-success",
        tone === "lag" && "border-warning/30 bg-warning/5 text-warning",
        stale && "border-destructive/30 bg-destructive/5 text-destructive",
      )}
    >
      {live ? <Radio className="h-3 w-3 animate-pulse" /> : <Activity className="h-3 w-3" />}
      <span>{label}</span>
      <span className="text-muted-foreground/70">·</span>
      <span>{age < 1000 ? "<1s" : `${(age / 1000).toFixed(1)}s`}</span>
    </div>
  );
}
