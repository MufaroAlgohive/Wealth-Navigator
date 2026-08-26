export function canRetryRebalanceSettlement(
  environmentScope: unknown,
  approverTier: unknown,
): boolean {
  const isUat = String(environmentScope ?? "live").toLowerCase() === "uat";
  return isUat || approverTier === "master";
}
