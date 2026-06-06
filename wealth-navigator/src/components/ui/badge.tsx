import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/cn";

const badgeVariants = cva(
  "inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] font-mono uppercase tracking-wider transition-colors focus:outline-none",
  {
    variants: {
      variant: {
        default: "border-transparent bg-primary/15 text-primary ring-1 ring-primary/30",
        secondary: "border-transparent bg-secondary text-secondary-foreground",
        destructive: "border-transparent bg-destructive/15 text-destructive ring-1 ring-destructive/30",
        success: "border-transparent bg-success/15 text-success ring-1 ring-success/30",
        warning: "border-transparent bg-warning/15 text-warning ring-1 ring-warning/30",
        outline: "border-border text-foreground",
        ghost: "border-transparent text-muted-foreground",
        live: "border-transparent bg-success/15 text-success ring-1 ring-success/30",
        halt: "border-transparent bg-destructive/15 text-destructive ring-1 ring-destructive/30",
      },
    },
    defaultVariants: { variant: "default" },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return <div className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { Badge, badgeVariants };
