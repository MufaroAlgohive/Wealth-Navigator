import { useMemo } from "react";
import { LineChart, Line, ResponsiveContainer, YAxis } from "recharts";

interface Props {
  data?: number[];
  base?: number;
  points?: number;
  vol?: number;
  color?: string;
  height?: number;
}

export default function Sparkline({ data, base = 100, points = 30, vol = 0.01, color = "hsl(227, 71%, 55%)", height = 32 }: Props) {
  const series = useMemo(() => {
    if (data) return data.map(v => ({ v }));
    let p = base;
    return Array.from({ length: points }, () => {
      p = p * (1 + (Math.random() - 0.5) * vol);
      return { v: +p.toFixed(2) };
    });
  }, [data, base, points, vol]);

  return (
    <ResponsiveContainer width="100%" height={height}>
      <LineChart data={series} margin={{ top: 2, right: 2, bottom: 2, left: 2 }}>
        <YAxis hide domain={['dataMin', 'dataMax']} />
        <Line type="monotone" dataKey="v" stroke={color} strokeWidth={1.4} dot={false} isAnimationActive={false} />
      </LineChart>
    </ResponsiveContainer>
  );
}
