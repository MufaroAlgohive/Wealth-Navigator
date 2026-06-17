/** MINT OEMS chart palette — maps to globals.css --chart-1…6 */
export const CHART_COLORS = [
  "hsl(var(--chart-1))",
  "hsl(var(--chart-2))",
  "hsl(var(--chart-3))",
  "hsl(var(--chart-4))",
  "hsl(var(--chart-5))",
  "hsl(var(--chart-6))",
  "hsl(263 45% 45%)",
  "hsl(38 70% 48%)",
] as const;

export const CASH_COLOR = "hsl(var(--muted-foreground) / 0.35)";

export const tooltipStyle = {
  background: "hsl(var(--card))",
  border: "1px solid hsl(var(--border))",
  borderRadius: 8,
  fontSize: 11,
  fontFamily: "var(--font-jetbrains-mono)",
  boxShadow: "0 4px 12px hsl(var(--foreground) / 0.08)",
};
