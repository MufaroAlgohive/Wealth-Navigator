import PanelFrame from "@/components/oems/PanelFrame";
import { LineChart, Line, ResponsiveContainer, XAxis, YAxis, CartesianGrid, Tooltip, BarChart, Bar, Cell } from "recharts";
import { zarCurveHistory, zarRealCurve, zarSwapCurve } from "@/lib/oemsExtra";

export default function OEMSCurves() {
  const overlay = zarCurveHistory.today.map((p, i) => ({
    ...p,
    govi: p.yield,
    swap: zarSwapCurve.find(s => s.tenor === p.tenor)?.yield ?? null,
    real: zarRealCurve.find(r => r.tenor === p.tenor)?.yield ?? null,
    breakeven: zarRealCurve.find(r => r.tenor === p.tenor) ? p.yield - (zarRealCurve.find(r => r.tenor === p.tenor)!.yield) : null,
  }));

  const change = zarCurveHistory.today.map((p, i) => ({
    tenor: p.tenor,
    d1: +(p.yield - zarCurveHistory.d1[i]).toFixed(3),
    w1: +(p.yield - zarCurveHistory.w1[i]).toFixed(3),
    m1: +(p.yield - zarCurveHistory.m1[i]).toFixed(3),
  }));

  return (
    <div className="space-y-3">
      <div>
        <h1 className="text-lg font-semibold">Curves & Rates</h1>
        <p className="text-xs text-muted-foreground">NSS-fitted ZAR govi · swap · real (CPI-linked) · breakeven inflation</p>
      </div>

      <div className="grid grid-cols-12 gap-3">
        <PanelFrame title="ZAR Yield Curves Overlay" endpoint="GET /v1/yieldcurve/zar?model=nss" className="col-span-8 h-[360px]">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={overlay} margin={{ top: 8, right: 12, left: -10, bottom: 0 }}>
              <CartesianGrid strokeDasharray="2 4" stroke="hsl(var(--border))" />
              <XAxis dataKey="tenor" tick={{ fontSize: 10 }} stroke="hsl(var(--muted-foreground))" />
              <YAxis tick={{ fontSize: 10 }} stroke="hsl(var(--muted-foreground))" unit="%" domain={[3, 14]} />
              <Tooltip contentStyle={{ fontSize: 11, borderRadius: 6 }} formatter={(v: any) => v === null ? "—" : `${(v as number).toFixed(2)}%`} />
              <Line type="monotone" dataKey="govi" name="Govi (nominal)" stroke="hsl(38,92%,50%)" strokeWidth={2} dot={{ r: 2 }} />
              <Line type="monotone" dataKey="swap" name="ZAR swap" stroke="hsl(227,71%,55%)" strokeWidth={1.6} dot={{ r: 2 }} />
              <Line type="monotone" dataKey="real" name="Real (ILB)" stroke="hsl(142,71%,45%)" strokeWidth={1.6} dot={{ r: 2 }} />
              <Line type="monotone" dataKey="breakeven" name="Breakeven CPI" stroke="hsl(0,84%,60%)" strokeWidth={1.4} strokeDasharray="3 3" dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </PanelFrame>

        <PanelFrame title="Curve Change (bp)" endpoint="GET /v1/yieldcurve/zar/history" className="col-span-4 h-[360px]" dense scroll>
          <table className="w-full text-[11px] font-mono">
            <thead className="bg-muted/40 text-[10px] uppercase tracking-wider text-muted-foreground">
              <tr><th className="text-left px-2 py-1.5">Tenor</th><th className="text-right px-2">vs 1D</th><th className="text-right px-2">vs 1W</th><th className="text-right px-2">vs 1M</th></tr>
            </thead>
            <tbody className="divide-y divide-border">
              {change.map(c => (
                <tr key={c.tenor}>
                  <td className="px-2 py-1.5 font-medium">{c.tenor}</td>
                  {[c.d1, c.w1, c.m1].map((v, i) => (
                    <td key={i} className={`px-2 text-right ${v >= 0 ? "text-destructive" : "text-success"}`}>
                      {(v * 100).toFixed(1)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </PanelFrame>
      </div>

      <div className="grid grid-cols-12 gap-3">
        <PanelFrame title="Curve Move Decomposition · Level / Slope / Curvature" endpoint="INTERNAL · PCA on curve history" className="col-span-12 h-[220px]">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={[
              { factor: "Level (parallel shift)", bp: 12 },
              { factor: "Slope (2s10s)", bp: -8 },
              { factor: "Curvature (butterfly)", bp: 3 },
              { factor: "Residual", bp: 1 },
            ]} layout="vertical" margin={{ top: 8, right: 16, left: 80, bottom: 0 }}>
              <CartesianGrid strokeDasharray="2 4" stroke="hsl(var(--border))" />
              <XAxis type="number" tick={{ fontSize: 10 }} stroke="hsl(var(--muted-foreground))" unit="bp" />
              <YAxis type="category" dataKey="factor" tick={{ fontSize: 11 }} stroke="hsl(var(--muted-foreground))" width={140} />
              <Tooltip contentStyle={{ fontSize: 11, borderRadius: 6 }} />
              <Bar dataKey="bp">
                {[12, -8, 3, 1].map((v, i) => <Cell key={i} fill={v >= 0 ? "hsl(0,84%,60%)" : "hsl(142,71%,45%)"} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </PanelFrame>
      </div>
    </div>
  );
}
