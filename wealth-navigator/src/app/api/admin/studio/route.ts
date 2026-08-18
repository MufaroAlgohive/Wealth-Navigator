import { NextResponse } from "next/server";

import { getAdminContext, isAdminRole } from "@/lib/admin/rbac";
import { createRetailServiceRoleClient } from "@/lib/supabase/server";

/** Admin-only Client View Studio. Every monetary response is ZAR, not cents. */
export const dynamic = "force-dynamic";

async function requireAdmin() {
  const auth=await getAdminContext();
  if(auth.status==="no-session")return {error:NextResponse.json({ok:false,error:"no-session"},{status:401})};
  if(auth.status!=="ok"||!isAdminRole(auth.ctx))return {error:NextResponse.json({ok:false,error:"Admins only"},{status:403})};
  return {auth};
}

export async function GET(req:Request) {
  const access=await requireAdmin();if("error" in access)return access.error;
  const url=new URL(req.url),action=url.searchParams.get("action")||"config";
  if(action==="config")return NextResponse.json({ok:true,dev:process.env.MINT_APP_URL_DEV||"",live:process.env.MINT_APP_URL_LIVE||""});
  let db;try{db=createRetailServiceRoleClient()}catch{return NextResponse.json({ok:false,error:"RETAIL database not configured"},{status:503})}

  if(action==="clients"){
    const scope=url.searchParams.get("scope")||"all";
    if(scope==="all"){
      const {data,error}=await db.from("profiles").select("id,first_name,last_name,email,mint_number,is_test").order("first_name").limit(5000);
      if(error)return NextResponse.json({ok:false,error:error.message},{status:500});
      return NextResponse.json({ok:true,clients:(data??[]).map(p=>({id:p.id,name:`${p.first_name||""} ${p.last_name||""}`.trim()||p.email,email:p.email,strategy:null,isTest:p.is_test===true}))});
    }
    return NextResponse.json({ok:true,clients:[]});
  }

  if(action==="portfolio"){
    const userId=url.searchParams.get("user_id")||"";if(!userId)return NextResponse.json({ok:false,error:"user_id required"},{status:400});
    const familyMemberId=url.searchParams.get("family_member_id")||null;
    let holdsQuery=db.from("stock_holdings_c").select("id,security_id,quantity,avg_fill,Expected_fill,strategy_id,strategy_name_snapshot,transaction_id").eq("user_id",userId).eq("is_active",true).eq("trade_side","BUY");
    if(familyMemberId) holdsQuery=holdsQuery.eq("family_member_id",familyMemberId);else holdsQuery=holdsQuery.is("family_member_id",null);
    const {data:holds,error}=await holdsQuery;
    if(error)return NextResponse.json({ok:false,error:error.message},{status:500});
    const secIds=[...new Set((holds??[]).map(h=>h.security_id).filter(Boolean))],secMap:Record<string,{symbol:string;name:string|null;logo_url:string|null;last_price:number|null}>={},intradayMap=new Map<string,number>();
    if(secIds.length){const [{data:securities},{data:intraday}]=await Promise.all([db.from("securities_c").select("id,symbol,name,logo_url,last_price").in("id",secIds),db.from("stock_intraday_c").select("security_id,current_price,timestamp").in("security_id",secIds).order("timestamp",{ascending:false}).limit(5000)]);for(const security of securities??[])secMap[String(security.id)]=security as never;for(const row of intraday??[]){const id=String(row.security_id);if(!intradayMap.has(id)&&Number(row.current_price)>0)intradayMap.set(id,Number(row.current_price)/100)}}
    const holdings=(holds??[]).map(h=>{const security=secMap[String(h.security_id)],quantity=Number(h.quantity)||0,avgRands=(Number(h.avg_fill)||0)/100,expected=Number(h.Expected_fill)||0,lastPrice=Number(security?.last_price)||0,cost=expected>0?(avgRands>0&&expected>avgRands*5?expected/100:expected):avgRands,live=intradayMap.get(String(h.security_id))??(lastPrice>0?lastPrice/100:cost),marketValue=quantity*live,costTotal=quantity*cost;return{id:h.id,symbol:security?.symbol??"—",name:security?.name??security?.symbol??"—",logo_url:security?.logo_url??null,quantity,cost,live,marketValue,pnl:marketValue-costTotal,pnlPct:costTotal>0?((marketValue-costTotal)/costTotal)*100:0,pending:!(Number(h.avg_fill)>0),strategyId:h.strategy_id,strategy:h.strategy_name_snapshot??null}}).sort((a,b)=>b.marketValue-a.marketValue);
    // Realised P&L on closed lots (rebalance sells etc.) — without this, totalPnl
    // only reflects currently-held positions and hides a booked loss/gain, same
    // class of bug as the MINT client-app "Unrealized PnL shown as total" fix.
    // Scoped by family_member_id the same way holdsQuery/txQuery are above.
    let closedQuery=db.from("stock_holdings_c").select("avg_fill,avg_exit,quantity").eq("user_id",userId).eq("is_active",false);
    closedQuery=familyMemberId?closedQuery.eq("family_member_id",familyMemberId):closedQuery.is("family_member_id",null);
    const {data:closed}=await closedQuery;
    const realizedTotal=(closed??[]).reduce((sum,c)=>{const fill=Number(c.avg_fill)||0,exit=Number(c.avg_exit)||0,qty=Number(c.quantity)||0;return fill&&exit&&qty?sum+((exit-fill)/100)*qty:sum},0);
    const totalValue=holdings.reduce((sum,h)=>sum+h.marketValue,0),totalPnl=holdings.reduce((sum,h)=>sum+h.pnl,0)+realizedTotal,invested=totalValue-totalPnl;
    let txQuery=db.from("transactions").select("id,name,description,amount,direction,status,transaction_date,created_at").eq("user_id",userId).order("created_at",{ascending:false}).limit(6);
    if(familyMemberId) txQuery=txQuery.eq("family_member_id",familyMemberId);else txQuery=txQuery.is("family_member_id",null);
    const {data:transactions}=await txQuery;
    const strategyMap=new Map<string,{id:string;name:string;value:number;holdings:number}>();for(const h of holdings){if(!h.strategyId)continue;const id=String(h.strategyId),item=strategyMap.get(id)??{id,name:String(h.strategy||"Strategy"),value:0,holdings:0};if(!h.pending)item.value+=h.marketValue;item.holdings+=1;strategyMap.set(id,item)}

    // Cash asset + canonical return%. Positions-only market value/naive P&L
    // ratio above matches what stock_holdings_c alone can tell us, but it
    // omits the cash sleeve (residual + reserve) entirely and re-derives a
    // return% that disagrees with the rest of OEM (e.g. Investors page showed
    // -4.15%/-2.52% for the same client from two naive calcs before both were
    // pointed at this same guarded view). client_strategy_returns_effective_latest_c
    // is the shared per-client contract (client-book, overall-portfolio,
    // wm/clients, investors already read it) — latest row per strategy, cash
    // included, canonical inception/YTD return.
    let cashCents=0,canonicalWeightedPct=0,canonicalWeight=0;
    try{
      let retQuery=db.from("client_strategy_returns_effective_latest_c").select("strategy_id,basket_value_cents,residual_cash_cents,unused_reserve_cents,inception_pct,ytd_pct").eq("user_id",userId);
      retQuery=familyMemberId?retQuery.eq("family_member_id",familyMemberId):retQuery.is("family_member_id",null);
      const {data:effRows}=await retQuery;
      for(const r of (effRows??[]) as Array<{strategy_id:string;basket_value_cents:number|null;residual_cash_cents:number|null;unused_reserve_cents:number|null;inception_pct:number|null;ytd_pct:number|null}>){
        cashCents+=(Number(r.residual_cash_cents)||0)+(Number(r.unused_reserve_cents)||0);
        const retPct=r.inception_pct!=null?Number(r.inception_pct):(r.ytd_pct!=null?Number(r.ytd_pct):null);
        const weight=Number(r.basket_value_cents)||0;
        if(retPct!=null&&Number.isFinite(retPct)&&weight>0){canonicalWeightedPct+=retPct*weight;canonicalWeight+=weight}
      }
    }catch{/* cash/return overlay is best-effort; positions-only figures below still render */}
    const cashRands=cashCents/100,totalValueWithCash=totalValue+cashRands;
    const pnlPct=canonicalWeight>0?canonicalWeightedPct/canonicalWeight:(invested>0?(totalPnl/invested)*100:0);
    return NextResponse.json({ok:true,holdings,transactions:(transactions??[]).map(t=>({...t,amount:(Number(t.amount)||0)/100})),totalValue:totalValueWithCash,cash:cashRands,totalPnl,pnlPct,strategyCount:strategyMap.size,strategies:[...strategyMap.values()],units:{money:"ZAR",sourcePrices:"ZAc normalized once on server"}});
  }
  return NextResponse.json({ok:false,error:`Unknown action: ${action}`},{status:400});
}

export async function POST(req:Request) {
  const access=await requireAdmin();if("error" in access)return access.error;
  let body:Record<string,unknown>;try{body=await req.json()}catch{return NextResponse.json({ok:false,error:"Invalid JSON"},{status:400})}
  const userId=String(body.user_id||""),target=body.target==="live"?"live":"dev";if(!userId)return NextResponse.json({ok:false,error:"user_id required"},{status:400});
  const targetUrl=target==="live"?process.env.MINT_APP_URL_LIVE:process.env.MINT_APP_URL_DEV;if(!targetUrl)return NextResponse.json({ok:false,error:`MINT_APP_URL_${target.toUpperCase()} is not configured`},{status:503});
  let db;try{db=createRetailServiceRoleClient()}catch{return NextResponse.json({ok:false,error:"RETAIL database not configured"},{status:503})}
  const {data:profile,error:profileError}=await db.from("profiles").select("id,email,first_name,last_name").eq("id",userId).maybeSingle();if(profileError||!profile?.email)return NextResponse.json({ok:false,error:profileError?.message||"Client email not found"},{status:404});
  const {data,error}=await db.auth.admin.generateLink({type:"magiclink",email:profile.email,options:{redirectTo:targetUrl}});const actionLink=(data as {properties?:{action_link?:string}}|null)?.properties?.action_link??null;if(error||!actionLink)return NextResponse.json({ok:false,error:error?.message||"Could not generate client sign-in link"},{status:500});
  return NextResponse.json({ok:true,actionLink,target,client:{id:profile.id,name:`${profile.first_name||""} ${profile.last_name||""}`.trim(),email:profile.email}});
}
