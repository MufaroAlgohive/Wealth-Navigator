import { sectorHeatmap } from "@/lib/oemsExtra";
import { cn } from "@/lib/utils";

export default function SectorHeatmap() {
  const total = sectorHeatmap.reduce((s, x) => s + x.weight, 0);
  return (
    <div className="grid grid-cols-6 gap-1 auto-rows-[80px]">
      {sectorHeatmap.map(s => {
        const span = Math.max(1, Math.round((s.weight / total) * 8));
        const intensity = Math.min(1, Math.abs(s.change) / 2.5);
        const bg = s.change >= 0
          ? `hsl(142, 71%, ${50 - intensity * 25}%)`
          : `hsl(0, 84%, ${60 - intensity * 20}%)`;
        return (
          <div key={s.sector}
            className="rounded-sm p-2 flex flex-col justify-between text-white"
            style={{ gridColumn: `span ${Math.min(span, 3)}`, background: bg }}>
            <span className="text-[10px] font-medium leading-tight">{s.sector}</span>
            <div>
              <p className="text-sm font-mono font-semibold">{s.change >= 0 ? "+" : ""}{s.change.toFixed(2)}%</p>
              <p className="text-[9px] opacity-80 font-mono">w {s.weight.toFixed(1)}%</p>
            </div>
          </div>
        );
      })}
    </div>
  );
}
