export interface AssetDayPnlInput {
  currentQuantity: number;
  currentPriceCents: number;
  previousCloseCents: number;
  buys: Array<{ quantity: number; fillPriceCents: number }>;
  sells: Array<{ quantity: number; fillPriceCents: number }>;
}

/**
 * Select the bounded Yahoo refresh batch. Never-fetched symbols come first;
 * once coverage is warm, the oldest cached symbols rotate to the front.
 */
export function planQuoteRefresh(
  symbols: string[],
  refreshedAtBySymbol: ReadonlyMap<string, number>,
  limit: number,
): string[] {
  return [...new Set(symbols.map((symbol) => symbol.trim().toUpperCase()).filter(Boolean))]
    .sort((left, right) => {
      const leftAt = refreshedAtBySymbol.get(left);
      const rightAt = refreshedAtBySymbol.get(right);
      if (leftAt == null && rightAt != null) return -1;
      if (leftAt != null && rightAt == null) return 1;
      return (leftAt ?? 0) - (rightAt ?? 0) || left.localeCompare(right);
    })
    .slice(0, Math.max(0, limit));
}

/**
 * Gross market P&L for one owner/security/strategy position.
 *
 * Opening units mark from previous close to now. Units bought today only mark
 * from their actual fill; units sold today realise against previous close.
 * Internal rebalances therefore move value between cash and securities without
 * inheriting price movement that happened before a fill.
 */
export function calculateAssetDayPnlCents(input: AssetDayPnlInput): number {
  const currentQuantity = Math.max(0, Number(input.currentQuantity) || 0);
  const currentPrice = Number(input.currentPriceCents) || 0;
  const previousClose = Number(input.previousCloseCents) || 0;
  if (!(currentPrice > 0) || !(previousClose > 0)) throw new Error("positive current and previous-close prices are required");

  const buys = input.buys.filter((fill) => fill.quantity > 0 && fill.fillPriceCents > 0);
  const sells = input.sells.filter((fill) => fill.quantity > 0 && fill.fillPriceCents > 0);
  const boughtQuantity = buys.reduce((sum, fill) => sum + fill.quantity, 0);
  const remainingOpeningQuantity = Math.max(0, currentQuantity - boughtQuantity);

  const openingPnl = remainingOpeningQuantity * (currentPrice - previousClose);
  const boughtPnl = buys.reduce(
    (sum, fill) => sum + fill.quantity * (currentPrice - fill.fillPriceCents),
    0,
  );
  const soldPnl = sells.reduce(
    (sum, fill) => sum + fill.quantity * (fill.fillPriceCents - previousClose),
    0,
  );
  return Math.round(openingPnl + boughtPnl + soldPnl);
}
