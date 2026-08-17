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
    const scope=url.searchParams.get("scope")==="all"?"all":"invested";
    if(scope==="all"){
      const {data,error}=await db.from("profiles").select("id,first_name,last_name,email,mint_number,is_test").order("first_name").limit(5000);
      if(error)return NextResponse.json({ok:false,error:error.message},{status:500});
      return NextResponse.json({ok:true,clients:(data??[]).map(p=>({id:p.id,name:`${p.first_name||""} ${p.last_name||""}`.trim()||p.email,email:p.email,strategy:null,isTest:p.is_test===true}))});
    }
    const {data:holds,error}=await db.from("stock_holdings_c").select("user_id,strategy_id,strategy_name_snapshot").eq("is_active",true).eq("trade_side","BUY").limit(10000);
    if(error)return NextResponse.json({ok:false,error:error.message},{status:500});
    const ids=[...new Set((holds??[]).map(h=>String(h.user_id||"")).filter(Boolean))];if(!ids.length)return NextResponse.json({ok:true,clients:[]});
    const strategyByUser=new Map<string,Set<string>>();for(const h of holds??[]){const id=String(h.user_id||"");if(!id)continue;const set=strategyByUser.get(id)??new Set<string>();if(h.strategy_name_snapshot)set.add(String(h.strategy_name_snapshot));strategyByUser.set(id,set)}
    const {data:profiles,error:profileError}=await db.from("profiles").select("id,first_name,last_name,email,mint_number,is_test").in("id",ids);
    if(profileError)return NextResponse.json({ok:false,error:profileError.message},{status:500});
    const clients=(profiles??[]).map(p=>({id:p.id,name:`${p.first_name||""} ${p.last_name||""}`.trim()||p.email,email:p.email,strategy:[...(strategyByUser.get(String(p.id))??[])].join(", ")||null,isTest:p.is_test===true})).sort((a,b)=>String(a.name).localeCompare(String(b.name)));
    return NextResponse.json({ok:true,clients});
  }

  if(action==="portfolio"){
    const userId=url.searchParams.get("user_id")||"";if(!userId)return NextResponse.json({ok:false,error:"user_id required"},{status:400});
    const {data:holds,error}=await db.from("stock_holdings_c").select("id,security_id,quantity,avg_fill,Expected_fill,strategy_id,strategy_name_snapshot,transaction_id").eq("user_id",userId).eq("is_active",true).eq("trade_side","BUY");
    if(error)return NextResponse.json({ok:false,error:error.message},{status:500});
    const secIds=[...new Set((holds??[]).map(h=>h.security_id).filter(Boolean))],secMap:Record<string,{symbol:string;name:string|null;logo_url:string|null;last_price:number|null}>={},intradayMap=new Map<string,number>();
    if(secIds.length){const [{data:securities},{data:intraday}]=await Promise.all([db.from("securities_c").select("id,symbol,name,logo_url,last_price").in("id",secIds),db.from("stock_intraday_c").select("security_id,current_price,timestamp").in("security_id",secIds).order("timestamp",{ascending:false}).limit(5000)]);for(const security of securities??[])secMap[String(security.id)]=security as never;for(const row of intraday??[]){const id=String(row.security_id);if(!intradayMap.has(id)&&Number(row.current_price)>0)intradayMap.set(id,Number(row.current_price)/100)}}
    const holdings=(holds??[]).map(h=>{const security=secMap[String(h.security_id)],quantity=Number(h.quantity)||0,avgRands=(Number(h.avg_fill)||0)/100,expected=Number(h.Expected_fill)||0,lastPrice=Number(security?.last_price)||0,cost=expected>0?(avgRands>0&&expected>avgRands*5?expected/100:expected):avgRands,live=intradayMap.get(String(h.security_id))??(lastPrice>0?lastPrice/100:cost),marketValue=quantity*live,costTotal=quantity*cost;return{id:h.id,symbol:security?.symbol??"—",name:security?.name??security?.symbol??"—",logo_url:security?.logo_url??null,quantity,cost,live,marketValue,pnl:marketValue-costTotal,pnlPct:costTotal>0?((marketValue-costTotal)/costTotal)*100:0,pending:!(Number(h.avg_fill)>0),strategyId:h.strategy_id,strategy:h.strategy_name_snapshot??null}}).sort((a,b)=>b.marketValue-a.marketValue);
    // Realised P&L on closed lots (rebalance sells etc.) — without this, totalPnl
    // only reflects currently-held positions and hides a booked loss/gain, same
    // class of bug as the MINT client-app "Unrealized PnL shown as total" fix.
    const {data:closed}=await db.from("stock_holdings_c").select("avg_fill,avg_exit,quantity").eq("user_id",userId).eq("is_active",false);
    const realizedTotal=(closed??[]).reduce((sum,c)=>{const fill=Number(c.avg_fill)||0,exit=Number(c.avg_exit)||0,qty=Number(c.quantity)||0;return fill&&exit&&qty?sum+((exit-fill)/100)*qty:sum},0);
    const totalValue=holdings.reduce((sum,h)=>sum+h.marketValue,0),totalPnl=holdings.reduce((sum,h)=>sum+h.pnl,0)+realizedTotal,invested=totalValue-totalPnl;
    const {data:transactions}=await db.from("transactions").select("id,name,description,amount,direction,status,transaction_date,created_at").eq("user_id",userId).order("created_at",{ascending:false}).limit(6);
    const strategyMap=new Map<string,{id:string;name:string;value:number;holdings:number}>();for(const h of holdings){if(!h.strategyId)continue;const id=String(h.strategyId),item=strategyMap.get(id)??{id,name:String(h.strategy||"Strategy"),value:0,holdings:0};if(!h.pending)item.value+=h.marketValue;item.holdings+=1;strategyMap.set(id,item)}
    return NextResponse.json({ok:true,holdings,transactions:(transactions??[]).map(t=>({...t,amount:(Number(t.amount)||0)/100})),totalValue,totalPnl,pnlPct:invested>0?(totalPnl/invested)*100:0,strategyCount:strategyMap.size,strategies:[...strategyMap.values()],units:{money:"ZAR",sourcePrices:"ZAc normalized once on server"}});
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
