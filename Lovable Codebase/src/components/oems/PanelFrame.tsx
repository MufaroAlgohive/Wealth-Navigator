import { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Info } from "lucide-react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

interface Props {
  title: string;
  endpoint?: string;
  right?: ReactNode;
  children: ReactNode;
  className?: string;
  dense?: boolean;
  scroll?: boolean;
}

export default function PanelFrame({ title, endpoint, right, children, className, dense, scroll }: Props) {
  return (
    <div className={cn("rounded-md border border-border bg-card flex flex-col", className)}>
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-border bg-muted/30">
        <div className="flex items-center gap-1.5 min-w-0">
          <h3 className="text-[11px] font-semibold uppercase tracking-wider text-foreground truncate">{title}</h3>
          {endpoint && (
            <TooltipProvider delayDuration={200}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Info className="h-3 w-3 text-muted-foreground shrink-0 cursor-help" />
                </TooltipTrigger>
                <TooltipContent side="bottom" className="font-mono text-[10px]">
                  IRESS · {endpoint}
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}
        </div>
        {right && <div className="text-[10px] text-muted-foreground">{right}</div>}
      </div>
      <div className={cn(dense ? "p-0" : "p-3", scroll && "overflow-auto", "flex-1 min-h-0")}>{children}</div>
    </div>
  );
}
