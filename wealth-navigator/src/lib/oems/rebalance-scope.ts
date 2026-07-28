export type RebalanceEnvironment = "live" | "uat";

export function isOwnerInRebalanceEnvironment(
  userId: unknown,
  environment: RebalanceEnvironment,
  testUserIds: ReadonlySet<string>,
): boolean {
  const isTest = testUserIds.has(String(userId ?? ""));
  return environment === "uat" ? isTest : !isTest;
}

export function scopeRebalanceEvents<T extends { user_id: unknown }>(
  events: T[],
  environment: RebalanceEnvironment,
  testUserIds: ReadonlySet<string>,
): T[] {
  return events.filter((event) => isOwnerInRebalanceEnvironment(event.user_id, environment, testUserIds));
}
