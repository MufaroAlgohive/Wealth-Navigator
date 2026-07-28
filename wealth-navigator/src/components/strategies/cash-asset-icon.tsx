import { Coins } from "lucide-react";

import { cn } from "@/lib/cn";
import { CASH_ASSET_NAME } from "@/lib/strategy-cash-asset";

export { CASH_ASSET_COLOR, CASH_ASSET_NAME, CASH_ASSET_SYMBOL } from "@/lib/strategy-cash-asset";

export function CashAssetIcon({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-full border border-success/30 bg-success/15 text-success",
        className,
      )}
      aria-label={CASH_ASSET_NAME}
    >
      <Coins className="h-1/2 w-1/2" aria-hidden="true" />
    </span>
  );
}
