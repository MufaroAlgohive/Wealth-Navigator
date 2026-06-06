import { sensFeed } from "@/lib/oemsExtra";
import { cn } from "@/lib/utils";

const categoryColor: Record<string, string> = {
  RESULTS: "border-primary/40 text-primary bg-primary/5",
  TRADING: "border-blue-400/40 text-blue-400 bg-blue-400/5",
  DIVIDEND: "border-success/40 text-success bg-success/5",
  DIRECTORATE: "border-muted-foreground/40 text-muted-foreground bg-muted/30",
  "RELATED PARTY": "border-muted-foreground/40 text-muted-foreground bg-muted/30",
  "CORP ACTION": "border-warning/40 text-warning bg-warning/5",
  CAUTIONARY: "border-destructive/40 text-destructive bg-destructive/5",
};

export default function SensFeed({ limit = 10 }: { limit?: number }) {
  return (
    <div className="divide-y divide-border text-xs">
      {sensFeed.slice(0, limit).map(s => (
        <div key={s.id} className="px-3 py-2 hover:bg-muted/30">
          <div className="flex items-center gap-2 mb-1">
            <span className={cn("text-[9px] font-mono px-1.5 py-0.5 rounded border uppercase tracking-wider", categoryColor[s.category])}>
              {s.category}
            </span>
            {s.severity === "regulatory" && (
              <span className="text-[9px] font-mono px-1.5 py-0.5 rounded bg-destructive/15 text-destructive uppercase tracking-wider">REG</span>
            )}
            <span className="text-[10px] font-mono text-muted-foreground ml-auto">{s.ts}</span>
          </div>
          <p className="font-medium leading-snug">{s.headline}</p>
          <div className="flex items-center gap-2 mt-1 text-[10px] text-muted-foreground font-mono">
            <span className="text-primary">{s.ticker}</span>·<span>{s.issuer}</span>
          </div>
        </div>
      ))}
    </div>
  );
}
