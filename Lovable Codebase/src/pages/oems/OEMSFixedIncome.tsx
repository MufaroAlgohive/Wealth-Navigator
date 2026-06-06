import { useState } from "react";
import PanelFrame from "@/components/oems/PanelFrame";
import { bonds, zarCurveHistory } from "@/lib/oemsExtra";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { LineChart, Line, ResponsiveContainer, XAxis, YAxis, CartesianGrid, Tooltip, BarChart, Bar, Cell } from "recharts";
import { cn } from "@/lib/utils";
import { Search } from "lucide-react";

export default function OEMSFixedIncome() {
  const [selected, setSelected] = useState(bonds[1].isin);
  const [q, setQ] = useState("");
  const bond = bonds.find(b => b.isin === selected)!;
  const list = bonds.filter(b => q === "" || b.name.toLowerCase().includes(q.toLowerCase()) || b.isin.includes(q) || b.issuer.toLowerCase().includes(q.toLowerCase()));

  const krd = [
    { tenor: "1Y", krd: 0.04 }, { tenor: "2Y", krd: 0.18 }, { tenor: "3Y", krd: 0.42 },
    { tenor: "5Y", krd: 1.21 }, { tenor: "7Y", krd: 2.18 }, { tenor: "10Y", krd: 2.84 },
    { tenor: "15Y", krd: 0.12 },
  ];

  const sensitivity = [-100, -50, -25, 0, 25, 50, 100].map(bp => ({
    bp: `${bp >= 0 ? "+" : ""}${bp}`,
    pnl: -bond.dv01 * bp - 0.5 * bond.convexity * Math.pow(bp / 100, 2) * 10000,
  }));

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold">Fixed Income</h1>
          <p className="text-xs text-muted-foreground">Clean/dirty pricing · DV01 · convexity · KRD · spread to curve</p>
        </div>
      </div>

      <div className="grid grid-cols-12 gap-3">
        <PanelFrame title="Bond Screener" endpoint="GET /v1/bonds/screener" className="col-span-7" dense scroll
          right={<div className="flex items-center gap-2">
            <div className="relative w-44"><Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground" />
              <Input value={q} onChange={e => setQ(e.target.value)} placeholder="ISIN / issuer / name" className="h-6 pl-6 text-[10px]" />
            </div>
          </div>}>
          <table className="w-full text-[11px]">
            <thead className="bg-muted/40 text-[10px] uppercase tracking-wider text-muted-foreground sticky top-0">
              <tr>
                <th className="text-left px-2 py-1.5">Name</th>
                <th className="text-left px-2">Issuer</th>
                <th className="text-right px-2">YTM</th>
                <th className="text-right px-2">Clean</th>
                <th className="text-right px-2">MD</th>
                <th className="text-right px-2">DV01</th>
                <th className="text-right px-2">Spd</th>
                <th className="text-left px-2">Rtg</th>
                <th className="text-left px-2">Liq</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border font-mono">
              {list.map(b => (
                <tr key={b.isin} onClick={() => setSelected(b.isin)}
                  className={cn("cursor-pointer hover:bg-muted/30", selected === b.isin && "bg-primary/10")}>
                  <td className="px-2 py-1.5 font-medium">{b.name}</td>
                  <td className="px-2 text-muted-foreground">{b.issuer}</td>
                  <td className="px-2 text-right">{b.ytm.toFixed(2)}%</td>
                  <td className="px-2 text-right">{b.clean.toFixed(2)}</td>
                  <td className="px-2 text-right">{b.modDur.toFixed(2)}</td>
                  <td className="px-2 text-right">{b.dv01}</td>
                  <td className={cn("px-2 text-right", b.spread > 0 ? "text-warning" : "text-muted-foreground")}>{b.spread > 0 ? `+${b.spread}` : "—"}</td>
                  <td className="px-2"><Badge variant="outline" className="text-[9px] font-mono h-4">{b.rating}</Badge></td>
                  <td className="px-2 text-[9px] text-muted-foreground uppercase">{b.liquidity}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </PanelFrame>

        <div className="col-span-5 space-y-3">
          <PanelFrame title={`${bond.name} · ${bond.isin}`} endpoint={`GET /v1/bonds/${bond.isin}/pricing`}>
            <div className="grid grid-cols-3 gap-2 text-xs">
              {[
                ["Issuer", bond.issuer], ["Coupon", `${bond.coupon}%`], ["Maturity", bond.maturity],
                ["YTM", `${bond.ytm.toFixed(3)}%`], ["Clean", bond.clean.toFixed(3)], ["Dirty", bond.dirty.toFixed(3)],
                ["Mod Dur", bond.modDur.toFixed(2)], ["DV01", `R${bond.dv01}`], ["Convexity", bond.convexity.toFixed(1)],
                ["Rating", bond.rating], ["Spread", `${bond.spread}bp`], ["Liquidity", bond.liquidity],
              ].map(([l, v]) => (
                <div key={l as string} className="border border-border rounded p-1.5">
                  <p className="text-[9px] text-muted-foreground uppercase tracking-wider">{l}</p>
                  <p className="font-mono font-semibold mt-0.5">{v}</p>
                </div>
              ))}
            </div>
          </PanelFrame>

          <PanelFrame title="Key-Rate Duration" endpoint={`GET /v1/bonds/${bond.isin}/krd`} className="h-[180px]">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={krd} margin={{ top: 4, right: 8, left: -20, bottom: 0 }}>
                <CartesianGrid strokeDasharray="2 4" stroke="hsl(var(--border))" />
                <XAxis dataKey="tenor" tick={{ fontSize: 9 }} stroke="hsl(var(--muted-foreground))" />
                <YAxis tick={{ fontSize: 9 }} stroke="hsl(var(--muted-foreground))" />
                <Tooltip contentStyle={{ fontSize: 11, borderRadius: 6 }} />
                <Bar dataKey="krd" fill="hsl(227,71%,55%)" />
              </BarChart>
            </ResponsiveContainer>
          </PanelFrame>
        </div>
      </div>

      <div className="grid grid-cols-12 gap-3">
        <PanelFrame title="ZAR Govi Curve · Today vs 1D / 1W / 1M" endpoint="GET /v1/yieldcurve/zar/history" className="col-span-7 h-[280px]">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={zarCurveHistory.today.map((p, i) => ({ ...p, d1: zarCurveHistory.d1[i], w1: zarCurveHistory.w1[i], m1: zarCurveHistory.m1[i] }))}
              margin={{ top: 8, right: 12, left: -20, bottom: 0 }}>
              <CartesianGrid strokeDasharray="2 4" stroke="hsl(var(--border))" />
              <XAxis dataKey="tenor" tick={{ fontSize: 10 }} stroke="hsl(var(--muted-foreground))" />
              <YAxis tick={{ fontSize: 10 }} stroke="hsl(var(--muted-foreground))" unit="%" />
              <Tooltip contentStyle={{ fontSize: 11, borderRadius: 6 }} formatter={(v: number) => `${v.toFixed(2)}%`} />
              <Line type="monotone" dataKey="yield" name="Today" stroke="hsl(38,92%,50%)" strokeWidth={2.2} dot={{ r: 2 }} />
              <Line type="monotone" dataKey="d1" name="-1D" stroke="hsl(227,71%,55%)" strokeWidth={1.2} dot={false} strokeDasharray="3 3" />
              <Line type="monotone" dataKey="w1" name="-1W" stroke="hsl(220,9%,46%)" strokeWidth={1.2} dot={false} strokeDasharray="3 3" />
              <Line type="monotone" dataKey="m1" name="-1M" stroke="hsl(220,9%,30%)" strokeWidth={1.2} dot={false} strokeDasharray="2 6" />
            </LineChart>
          </ResponsiveContainer>
        </PanelFrame>

        <PanelFrame title="P&L Sensitivity (±bp)" endpoint="INTERNAL · price-yield grid" className="col-span-5 h-[280px]">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={sensitivity} margin={{ top: 8, right: 8, left: -20, bottom: 0 }}>
              <CartesianGrid strokeDasharray="2 4" stroke="hsl(var(--border))" />
              <XAxis dataKey="bp" tick={{ fontSize: 10 }} stroke="hsl(var(--muted-foreground))" />
              <YAxis tick={{ fontSize: 10 }} stroke="hsl(var(--muted-foreground))" />
              <Tooltip contentStyle={{ fontSize: 11, borderRadius: 6 }} formatter={(v: number) => `R${v.toFixed(0)}/Rm`} />
              <Bar dataKey="pnl">
                {sensitivity.map((d, i) => <Cell key={i} fill={d.pnl >= 0 ? "hsl(142,71%,45%)" : "hsl(0,84%,60%)"} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </PanelFrame>
      </div>
    </div>
  );
}
