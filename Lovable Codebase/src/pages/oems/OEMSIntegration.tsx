import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Code2, KeyRound, Webhook, ShieldCheck, GitBranch, Activity } from "lucide-react";
import { IRIS_INTEGRATION_MAP } from "@/lib/oemsData";
import { endpointHealth } from "@/lib/oemsExtra";
import { cn } from "@/lib/utils";

export default function OEMSIntegration() {
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium flex items-center gap-2"><Activity className="h-4 w-4 text-primary" />Endpoint Health · Live</CardTitle>
          <p className="text-xs text-muted-foreground">p50/p95 latency, last-seq cursor and throughput per IRESS endpoint · replay from seq on disconnect</p>
        </CardHeader>
        <CardContent className="p-0">
          <table className="w-full text-xs">
            <thead className="bg-secondary/50 text-muted-foreground">
              <tr className="text-left">
                <th className="px-4 py-2 font-medium">Status</th>
                <th className="px-3 py-2 font-medium">Endpoint</th>
                <th className="px-3 py-2 font-medium">Domain</th>
                <th className="px-3 py-2 font-medium text-right">p50 (ms)</th>
                <th className="px-3 py-2 font-medium text-right">p95 (ms)</th>
                <th className="px-3 py-2 font-medium text-right">msg/s</th>
                <th className="px-3 py-2 font-medium text-right">last seq</th>
                <th className="px-3 py-2 font-medium">Note</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border font-mono">
              {endpointHealth.map(e => (
                <tr key={e.path} className="hover:bg-secondary/30">
                  <td className="px-4 py-2"><span className={cn("inline-block h-2 w-2 rounded-full",
                    e.status === "green" && "bg-success",
                    e.status === "amber" && "bg-warning",
                    e.status === "red" && "bg-destructive")} /></td>
                  <td className="px-3 py-2 text-primary">{e.path}</td>
                  <td className="px-3 py-2 text-muted-foreground">{e.domain}</td>
                  <td className="px-3 py-2 text-right">{e.p50}</td>
                  <td className="px-3 py-2 text-right">{e.p95}</td>
                  <td className="px-3 py-2 text-right">{e.msgsPerSec.toLocaleString()}</td>
                  <td className="px-3 py-2 text-right">{e.lastSeq.toLocaleString()}</td>
                  <td className="px-3 py-2 text-[10px] text-muted-foreground">{e.lastError ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium flex items-center gap-2"><Code2 className="h-4 w-4 text-primary" />IRIS Integration Map</CardTitle>
          <p className="text-xs text-muted-foreground">Single source of truth for engineering — what to pull, from where, how often, for which UI surface.</p>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="bg-secondary/50 text-muted-foreground">
                <tr className="text-left">
                  <th className="px-4 py-2 font-medium">UI Surface</th>
                  <th className="px-3 py-2 font-medium">IRIS Endpoint</th>
                  <th className="px-3 py-2 font-medium">Refresh</th>
                  <th className="px-3 py-2 font-medium">Auth</th>
                  <th className="px-3 py-2 font-medium">Notes</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {IRIS_INTEGRATION_MAP.map((row, i) => (
                  <tr key={i} className="hover:bg-secondary/30 align-top">
                    <td className="px-4 py-2.5 font-medium">{row.surface}</td>
                    <td className="px-3 py-2.5 font-mono text-[11px] text-primary whitespace-nowrap">{row.endpoint}</td>
                    <td className="px-3 py-2.5 font-mono text-[11px]">{row.refresh}</td>
                    <td className="px-3 py-2.5 font-mono text-[11px] text-muted-foreground">{row.auth}</td>
                    <td className="px-3 py-2.5 text-muted-foreground">{row.notes}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm font-medium flex items-center gap-2"><KeyRound className="h-4 w-4 text-primary" />Auth model</CardTitle></CardHeader>
          <CardContent className="text-xs space-y-3 font-mono">
            <pre className="bg-secondary/50 p-3 rounded-md overflow-x-auto leading-relaxed">{`POST https://api.iress.com/oauth/token
  grant_type=client_credentials
  client_id=$IRIS_CLIENT_ID
  client_secret=$IRIS_CLIENT_SECRET
  scope=markets news macro

→ { access_token, expires_in: 3600 }

GET https://api.iress.com/v1/securities/quotes
  Authorization: Bearer <access_token>
  X-Iris-Tenant: mint-prod
  ?exchange=JSE&symbols=NPN,PRX,FSR`}</pre>
            <p className="text-muted-foreground font-sans">Rotate tokens every 55 min · cache in Redis · per-tenant entitlement check on every call.</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm font-medium flex items-center gap-2"><Webhook className="h-4 w-4 text-primary" />Streaming (recommended)</CardTitle></CardHeader>
          <CardContent className="text-xs space-y-3 font-mono">
            <pre className="bg-secondary/50 p-3 rounded-md overflow-x-auto leading-relaxed">{`wss://stream.iress.com/v1
→ subscribe: {
    "channel": "quotes",
    "symbols": ["NPN.JSE","PRX.JSE","SPX"]
  }
→ subscribe: { "channel": "news",  "sources": ["reuters","sens"] }
→ subscribe: { "channel": "macro", "countries": ["ZA","US"] }

← { type:"quote",  sym:"NPN.JSE", last:4180.55, ts:... }
← { type:"news",   id:"…", headline:"…", tickers:[…] }
← { type:"macro",  indicator:"ZACPI", actual:3.8, ts:… }`}</pre>
            <p className="text-muted-foreground font-sans">Connection multiplexed per browser tab via Mint Edge WS proxy — backpressure handled, auto-reconnect with last-seq cursor.</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm font-medium flex items-center gap-2"><ShieldCheck className="h-4 w-4 text-success" />Pre-trade rebalance gate</CardTitle></CardHeader>
          <CardContent className="text-xs space-y-2">
            <ol className="list-decimal pl-5 space-y-1.5 text-muted-foreground">
              <li><span className="text-foreground">investorCount &gt; 0</span> — strategy has at least one underlying allocation</li>
              <li><span className="text-foreground">status === "live"</span> — not in paper / not halted by Risk</li>
              <li>For each target holding, call <code className="text-primary">GET /v1/securities/&#123;id&#125;/flags</code> — reject if HALTED, SUSPENDED, NON-TRADEABLE, or CIRCUIT_BREAKER</li>
              <li>Money market only: <span className="text-foreground">issuer concentration ≤ 25%, duration ≤ mandate cap, no sub-investment-grade beyond limit</span></li>
              <li>Generate order block, RFQ to OMS, route via FIX 4.4 to JSE / Inter-bank desk</li>
            </ol>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm font-medium flex items-center gap-2"><GitBranch className="h-4 w-4 text-primary" />Repo layout (where devs pull what)</CardTitle></CardHeader>
          <CardContent className="text-xs font-mono">
            <pre className="bg-secondary/50 p-3 rounded-md overflow-x-auto leading-relaxed">{`src/lib/oemsData.ts        ← swap mocks for IRIS adapters
src/lib/iris/
  client.ts               ← REST + WS client, token mgmt
  quotes.ts               ← /v1/securities, /v1/indices, /v1/fx
  rates.ts                ← /v1/rates/jibar, /v1/yieldcurve
  news.ts                 ← /v1/news + stream
  macro.ts                ← /v1/macro/{calendar,series}
src/pages/oems/*.tsx       ← all UI tabs (this dashboard)
supabase/functions/iris-proxy/
                          ← server-side gate (entitlement,
                            rate-limit, cache, audit log)
src/store/quotes.ts       ← Zustand: { [sym]: Quote } + WS hydrate`}</pre>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-sm font-medium">IRIS coverage we tap into</CardTitle></CardHeader>
        <CardContent className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
          {[
            { k: "Exchanges",   v: "240+",  s: "JSE, LSE, NYSE, NASDAQ, EUREX, HKEX, SGX, ASX, JPX, CME, ICE…" },
            { k: "Instruments", v: "~1.4M", s: "equities, ETFs, bonds, MM, FX, commodities, indices, futures, options" },
            { k: "Depth",       v: "L1+L2", s: "intraday tick, EOD, 25y history, corp actions" },
            { k: "Reference",   v: "Cross-walk", s: "ISIN ↔ SEDOL ↔ RIC ↔ Bloomberg ticker" },
            { k: "News",        v: "6+ wires", s: "Reuters, Dow Jones, Bloomberg, SENS, Moneyweb, BD" },
            { k: "Macro",       v: "ZA + G10", s: "SARB, StatsSA, Fed, ECB, BoE, BoJ, IMF, World Bank" },
            { k: "Fundamentals", v: "10y", s: "financials, consensus, ratios, ESG scores" },
            { k: "Rates",       v: "Full curve", s: "JIBAR, SWAP, FRA, gov + corp YC, NSS fit" },
          ].map(b => (
            <div key={b.k} className="border border-border rounded-md p-3">
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground">{b.k}</p>
              <p className="text-lg font-semibold font-mono mt-1">{b.v}</p>
              <p className="text-[10px] text-muted-foreground mt-1 leading-snug">{b.s}</p>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
