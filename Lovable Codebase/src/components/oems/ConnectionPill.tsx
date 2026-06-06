import { cn } from "@/lib/utils";
import { useConnectionTs } from "@/lib/oemsStream";
import { Activity } from "lucide-react";

export default function ConnectionPill() {
  const ts = useConnectionTs();
  const age = Math.max(0, Date.now() - ts);
  const ok = age < 3000;
  return (
    <div className={cn("flex items-center gap-2 px-2.5 py-1 rounded-md border text-[10px] font-mono",
      ok ? "border-success/30 bg-success/5 text-success" : "border-warning/30 bg-warning/5 text-warning")}>
      <Activity className="h-3 w-3" />
      <span>WS {ok ? "OK" : "LAG"}</span>
      <span className="text-muted-foreground">·</span>
      <span>{age < 1000 ? "<1s" : `${(age / 1000).toFixed(1)}s`}</span>
      <span className="text-muted-foreground">·</span>
      <span>seq 12.4M</span>
    </div>
  );
}
