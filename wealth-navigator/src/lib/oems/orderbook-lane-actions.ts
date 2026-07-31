export type OrderbookScope = "live" | "uat" | undefined;

export function allowsMarketRelease(scope: OrderbookScope): boolean {
  return scope !== "uat";
}

export function allowsUatSelfFill(scope: OrderbookScope, source: string | null | undefined): boolean {
  return scope === "uat" || source === "UAT_ADHOC_ORDER";
}
