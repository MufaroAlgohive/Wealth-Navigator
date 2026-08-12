export type ModelUnitAction = "add" | "increase" | "decrease" | "remove" | "hold";

export function fullModelLots(currentQty: number, currentModelUnits: number): number {
  if (!Number.isFinite(currentQty) || !Number.isFinite(currentModelUnits) || currentModelUnits <= 0) {
    return 0;
  }
  return Math.max(0, Math.floor(currentQty / currentModelUnits));
}

export function calculateModelUnitImpact(input: {
  action: ModelUnitAction;
  currentQty: number;
  currentModelUnits: number;
  targetModelUnits: number;
  fallbackLots?: number;
}): { lots: number; targetQty: number; deltaQty: number } {
  const currentQty = Math.max(0, Math.round(input.currentQty));
  const currentUnits = Math.max(0, Math.round(input.currentModelUnits));
  const targetUnits = Math.max(0, Math.round(input.targetModelUnits));
  const lots = currentUnits > 0
    ? fullModelLots(currentQty, currentUnits)
    : Math.max(0, Math.floor(input.fallbackLots ?? 0));

  if (input.action === "hold") return { lots, targetQty: currentQty, deltaQty: 0 };
  if (input.action === "remove") return { lots, targetQty: 0, deltaQty: -currentQty };

  // A model-unit edit is a direct per-client share edit. The previous lot
  // multiplier meant that changing 3 → 4 units generated a +1 share change
  // for every complete lot a client held, so a client with two lots received
  // +2 shares. Rebalance compose controls now mean exactly what they show:
  // +1 / -1 changes each affected client's holding by one share.
  const requestedDelta = targetUnits - currentUnits;
  const deltaQty = Math.max(-currentQty, requestedDelta);
  if (input.action === "decrease" && deltaQty > 0) {
    throw new Error("A model decrease cannot create a client BUY.");
  }
  if ((input.action === "increase" || input.action === "add") && deltaQty < 0) {
    throw new Error("A model increase cannot create a client SELL.");
  }
  return { lots, targetQty: currentQty + deltaQty, deltaQty };
}
