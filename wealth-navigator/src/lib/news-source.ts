export type NewsWire = "ALLIANCE" | "MONEYWEB" | "OTHER" | "SENS";

export function classifyNewsWire(source: unknown, category?: unknown): NewsWire {
  const sourceName = String(source ?? "").trim();
  const categoryName = String(category ?? "").trim();
  if (/sens/i.test(sourceName) || categoryName.toUpperCase() === "SENS") return "SENS";
  if (/alliance news/i.test(sourceName)) return "ALLIANCE";
  if (/moneyweb/i.test(sourceName)) return "MONEYWEB";
  return "OTHER";
}

export function newsWireLabel(wire: NewsWire): string {
  if (wire === "SENS") return "SENS";
  if (wire === "ALLIANCE") return "Alliance";
  if (wire === "MONEYWEB") return "Moneyweb";
  return "News";
}
