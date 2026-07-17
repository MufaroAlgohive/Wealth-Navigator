"use client";

import * as React from "react";
import { ArrowLeft, LockKeyhole } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";

interface Holding { id:string;symbol:string;name:string;quantity:number;live:number;marketValue:number;pnl:number;pnlPct:number;pending:boolean }
interface Transaction { id:string;name:string|null;description:string|null;amount:number;direction:string;transaction_date:string|null }
interface Payload { actionLink:string;environment:"dev"|"live";client:{name:string;email:string|null};portfolio:{totalValue:number;totalPnl:number;pnlPct:number;strategyCount:number;holdings:Holding[];transactions:Transaction[]}|null }

const ZAR=(n:number)=>new Intl.NumberFormat("en-ZA",{style:"currency",currency:"ZAR",minimumFractionDigits:2}).format(Number(n||0));

function decodePayload():Payload|null{
  try{const value=new URLSearchParams(window.location.hash.slice(1)).get("payload");return value?JSON.parse(decodeURIComponent(escape(atob(decodeURIComponent(value))))):null}catch{return null}
}

export default function ClientPreviewPage(){
  const [data,setData]=React.useState<Payload|null>(null);
  const [loaded,setLoaded]=React.useState(false);
  const frame=React.useRef<HTMLIFrameElement>(null);
  React.useEffect(()=>setData(decodePayload()),[]);
  React.useEffect(()=>{if(!data)return;let count=0;const send=()=>{try{frame.current?.contentWindow?.postMessage({type:"MINT_ADMIN_PREVIEW"},"*")}catch{}};send();const timer=window.setInterval(()=>{send();if(++count>=15)window.clearInterval(timer)},2000);return()=>window.clearInterval(timer)},[data]);

  if(!data)return <div className="flex min-h-[65vh] items-center justify-center"><div className="rounded-2xl border border-border bg-card px-8 py-10 text-center"><p className="text-sm font-semibold text-foreground">Preparing secure client preview…</p><p className="mt-2 text-xs text-muted-foreground">This window will update when the sign-in link is ready.</p></div></div>;
  const p=data.portfolio;
  return <div className="mx-auto max-w-7xl space-y-4">
    <header className="flex flex-wrap items-center gap-3 rounded-xl border border-border bg-card px-4 py-3">
      <Button size="sm" variant="ghost" onClick={()=>window.close()}><ArrowLeft className="h-4 w-4"/>Close preview</Button><div className="h-5 w-px bg-border"/>
      <div className="min-w-0"><p className="truncate text-sm font-bold text-foreground">{data.client.name}</p><p className="truncate text-[10px] text-muted-foreground">{data.client.email}</p></div>
      <span className={cn("ml-auto rounded-full px-2.5 py-1 text-[10px] font-bold uppercase",data.environment==="live"?"bg-success/15 text-success":"bg-primary/15 text-primary")}>{data.environment}</span>
      <span className="inline-flex items-center gap-1 rounded-full border border-border px-2.5 py-1 text-[10px] font-semibold text-muted-foreground"><LockKeyhole className="h-3 w-3"/>Read-only admin view</span>
    </header>
    <div className="grid items-start gap-5 xl:grid-cols-[390px_minmax(0,1fr)]">
      <section className="mx-auto w-full max-w-[390px]">
        <div className="relative h-[720px] overflow-hidden rounded-[24px] border-2 border-white bg-white shadow-2xl shadow-black/20 ring-1 ring-border/50">
          {!loaded&&<div className="absolute inset-0 z-10 flex items-center justify-center bg-background"><div className="text-center"><div className="mx-auto h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent"/><p className="mt-3 text-xs text-muted-foreground">Opening Mint as client…</p></div></div>}
          <iframe ref={frame} src={data.actionLink} onLoad={()=>setLoaded(true)} title={`${data.client.name} client preview`} className="h-full w-full border-0 bg-white" allow="fullscreen" referrerPolicy="no-referrer-when-downgrade"/>
        </div><p className="mt-2 text-center text-[10px] text-muted-foreground">Phone-size preview · actions restricted by Admin Preview mode</p>
      </section>
      <aside className="space-y-4 rounded-2xl border border-border bg-card p-5">
        <div><p className="text-[10px] font-bold uppercase tracking-[.16em] text-primary">Client breakdown</p><h1 className="mt-1 text-xl font-bold text-foreground">Live portfolio inspector</h1><p className="mt-1 text-xs text-muted-foreground">CRM data remains visible beside the client-facing screen.</p></div>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4"><Metric label="Portfolio" value={ZAR(p?.totalValue||0)}/><Metric label="P&L" value={ZAR(p?.totalPnl||0)} valueNumber={p?.totalPnl}/><Metric label="Return" value={`${(p?.pnlPct||0)>=0?"+":""}${(p?.pnlPct||0).toFixed(2)}%`} valueNumber={p?.pnlPct}/><Metric label="Strategies" value={String(p?.strategyCount||0)}/></div>
        <DataList title="Top holdings">{p?.holdings?.length?p.holdings.slice(0,8).map(h=><div key={h.id} className="flex items-center gap-3 px-3 py-2.5"><div className="min-w-0 flex-1"><p className="text-sm font-semibold text-foreground">{h.symbol}{h.pending&&<span className="ml-1.5 text-[8px] text-warning">PENDING</span>}</p><p className="truncate text-[10px] text-muted-foreground">{h.quantity} × {ZAR(h.live)} · {h.name}</p></div><div className="text-right"><p className="text-xs font-semibold text-foreground">{ZAR(h.marketValue)}</p><p className={cn("text-[10px]",h.pnl>=0?"text-success":"text-destructive")}>{h.pnl>=0?"+":""}{ZAR(h.pnl)} · {h.pnlPct.toFixed(2)}%</p></div></div>):<Empty text="No active holdings."/>}</DataList>
        <DataList title="Recent transactions">{p?.transactions?.length?p.transactions.slice(0,6).map(t=><div key={t.id} className="flex items-center justify-between gap-3 px-3 py-2.5"><div className="min-w-0"><p className="truncate text-xs font-medium text-foreground">{t.name||t.description||"Transaction"}</p><p className="text-[10px] text-muted-foreground">{t.transaction_date?new Date(t.transaction_date).toLocaleDateString("en-ZA"):"—"}</p></div><p className="text-xs font-semibold text-foreground">{ZAR(Math.abs(t.amount||0))}</p></div>):<Empty text="No recent transactions."/>}</DataList>
      </aside>
    </div>
  </div>
}

function Metric({label,value,valueNumber}:{label:string;value:string;valueNumber?:number}){return <div className="rounded-xl border border-border bg-background px-3 py-3"><p className="text-[9px] font-bold uppercase tracking-wider text-muted-foreground">{label}</p><p className={cn("mt-1 truncate text-sm font-bold text-foreground",valueNumber!==undefined&&(valueNumber>=0?"text-success":"text-destructive"))}>{value}</p></div>}
function DataList({title,children}:{title:string;children:React.ReactNode}){return <section><h2 className="mb-2 text-xs font-bold uppercase tracking-wider text-muted-foreground">{title}</h2><div className="divide-y divide-border overflow-hidden rounded-xl border border-border">{children}</div></section>}
function Empty({text}:{text:string}){return <p className="p-4 text-xs text-muted-foreground">{text}</p>}
