import { cn } from "@/lib/utils";

interface StatCardProps {
  label: string;
  value: string;
  change?: string;
  changeType?: "positive" | "negative" | "neutral";
  icon?: React.ReactNode;
  subtitle?: string;
}

export default function StatCard({ label, value, change, changeType = "neutral", icon, subtitle }: StatCardProps) {
  return (
    <div className="bg-card rounded-xl border border-border p-5 hover:shadow-sm transition-shadow">
      <div className="flex items-start justify-between mb-1">
        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">{label}</p>
        {icon && <div className="text-muted-foreground">{icon}</div>}
      </div>
      <p className="text-2xl font-semibold tracking-tight mt-1">{value}</p>
      <div className="flex items-center gap-2 mt-1">
        {change && (
          <span className={cn(
            "text-xs font-medium",
            changeType === "positive" && "text-ticker-positive",
            changeType === "negative" && "text-ticker-negative",
            changeType === "neutral" && "text-muted-foreground"
          )}>
            {change}
          </span>
        )}
        {subtitle && <span className="text-xs text-muted-foreground">{subtitle}</span>}
      </div>
    </div>
  );
}
