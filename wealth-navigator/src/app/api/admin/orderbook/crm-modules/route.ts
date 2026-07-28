import { NextResponse } from "next/server";

import { getAdminContext } from "@/lib/admin/rbac";
import { scopeRebalanceEvents } from "@/lib/oems/rebalance-scope";
import { createRetailServiceRoleClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const text = (value: unknown, fallback = "") => {
  const output = String(value ?? "").trim();
  return output || fallback;
};
const compactDate = (value: Date | string) => {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime())
    ? ""
    : `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, "0")}${String(date.getDate()).padStart(2, "0")}`;
};
const clean = (value: unknown) => text(value, "-").replace(/[|\r\n]/g, " ");

export async function GET(req: Request) {
  const auth = await getAdminContext();
  if (auth.status === "no-session") return NextResponse.json({ ok: false, error: "no-session" }, { status: 401 });
  if (auth.status !== "ok") return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });

  const url = new URL(req.url);
  const moduleName = url.searchParams.get("module");
  const scope = url.searchParams.get("scope") === "uat" ? "uat" : "live";
  let retail: ReturnType<typeof createRetailServiceRoleClient>;
  try {
    retail = createRetailServiceRoleClient();
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "Retail database unavailable" },
      { status: 503 },
    );
  }

  const [{ data: testProfiles }, { data: testWallets }] = await Promise.all([
    retail.from("profiles").select("id").eq("is_test", true),
    retail.from("wallets").select("user_id").eq("status", "test"),
  ]);
  const testIds = new Set([
    ...(testProfiles ?? []).map((row) => String(row.id)),
    ...(testWallets ?? []).map((row) => String(row.user_id)),
  ]);
  const inScope = (userId: unknown) => scope === "uat" ? testIds.has(String(userId)) : !testIds.has(String(userId));

  if (moduleName === "rebalances") {
    const [{ data: batches, error: batchError }, { data: events, error: eventError }] = await Promise.all([
      retail
        .from("rebalance_batch")
        .select("id,strategy_id,status,settlement_state,settlement_error,effective_date,sell_isin_code,buy_isin_code,extra_buy_isin_code,strategy_name_snapshot,created_at,settled_at,updated_at,reversed_at,reversed_reason")
        .order("created_at", { ascending: false })
        .limit(500),
      retail
        .from("rebalance_event")
        .select("id,batch_id,user_id,family_member_id,security_id,trade_side,quantity,price_at_commit,avg_fill,fill_date,closed_reason,created_at")
        .order("created_at", { ascending: false })
        .limit(5000),
    ]);
    if (batchError || eventError) {
      return NextResponse.json({ ok: false, error: batchError?.message ?? eventError?.message }, { status: 500 });
    }
    const scopedEvents = scopeRebalanceEvents(events ?? [], scope, testIds);
    const userIds = [...new Set(scopedEvents.map((event) => event.user_id).filter(Boolean))];
    const familyIds = [...new Set(scopedEvents.map((event) => event.family_member_id).filter(Boolean))];
    const securityIds = [...new Set(scopedEvents.map((event) => event.security_id).filter(Boolean))];
    const [{ data: profiles }, { data: families }, { data: securities }] = await Promise.all([
      userIds.length
        ? retail.from("profiles").select("id,first_name,last_name,email").in("id", userIds)
        : Promise.resolve({ data: [] }),
      familyIds.length
        ? retail.from("family_members").select("id,first_name,last_name,relationship").in("id", familyIds)
        : Promise.resolve({ data: [] }),
      securityIds.length
        ? retail.from("securities_c").select("id,name,symbol,isin").in("id", securityIds)
        : Promise.resolve({ data: [] }),
    ]);
    const profileBy = new Map((profiles ?? []).map((row) => [String(row.id), row]));
    const familyBy = new Map((families ?? []).map((row) => [String(row.id), row]));
    const securityBy = new Map((securities ?? []).map((row) => [String(row.id), row]));
    const eventsByBatch = new Map<string, typeof scopedEvents>();
    for (const event of scopedEvents) {
      const key = String(event.batch_id);
      eventsByBatch.set(key, [...(eventsByBatch.get(key) ?? []), event]);
    }
    const output = (batches ?? [])
      .map((batch) => {
        const batchEvents = eventsByBatch.get(String(batch.id)) ?? [];
        return {
          id: String(batch.id),
          strategy: text(batch.strategy_name_snapshot, "Unknown strategy"),
          status: text(batch.status, "PENDING").toUpperCase(),
          settlement_state: text(batch.settlement_state, "PENDING").toUpperCase(),
          settlement_error: batch.settlement_error,
          sell_isin: batch.sell_isin_code,
          buy_isin: batch.buy_isin_code,
          extra_buy_isin: batch.extra_buy_isin_code,
          created_at: batch.created_at,
          display_at: batch.settled_at ?? batch.reversed_at ?? batch.updated_at ?? batch.created_at,
          reversed_reason: batch.reversed_reason,
          events: batchEvents.map((event) => {
            const profile = profileBy.get(String(event.user_id));
            const family = event.family_member_id ? familyBy.get(String(event.family_member_id)) : null;
            const security = securityBy.get(String(event.security_id));
            const client =
              family
                ? [family.first_name, family.last_name].filter(Boolean).join(" ")
                : profile
                  ? [profile.first_name, profile.last_name].filter(Boolean).join(" ") || profile.email
                  : "Unknown client";
            const fillCents = event.avg_fill ?? event.price_at_commit;
            return {
              id: String(event.id),
              client,
              relationship: family?.relationship ?? null,
              instrument: security?.name ?? security?.isin ?? "-",
              ticker: security?.symbol ?? "-",
              side: text(event.trade_side, "-").toUpperCase(),
              qty: Number(event.quantity ?? 0),
              fill_rands: fillCents == null ? null : Number(fillCents) / 100,
              fill_date: event.fill_date,
              reason: event.closed_reason,
            };
          }),
        };
      })
      // Never retain an empty shell after environment filtering: doing so made
      // UAT-only batches appear on LIVE even though their test events were gone.
      .filter((batch) => batch.events.length > 0);
    return NextResponse.json({ ok: true, batches: output });
  }

  if (moduleName === "bir") {
    const { data: holdings, error } = await retail
      .from("stock_holdings_c")
      .select('id,user_id,family_member_id,security_id,quantity,market_value,created_at,rebalance_batch_id,"Status",is_active')
      .eq("is_active", true)
      .order("created_at", { ascending: true })
      .limit(5000);
    if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    const scoped = (holdings ?? []).filter(
      (holding) =>
        inScope(holding.user_id) &&
        !holding.rebalance_batch_id &&
        Number(holding.quantity ?? 0) > 0 &&
        !/exit|close/i.test(String(holding.Status ?? "")),
    );
    const userIds = [...new Set(scoped.map((holding) => holding.user_id).filter(Boolean))];
    const familyIds = [...new Set(scoped.map((holding) => holding.family_member_id).filter(Boolean))];
    const securityIds = [...new Set(scoped.map((holding) => holding.security_id).filter(Boolean))];
    const [{ data: profiles }, { data: families }, { data: securities }] = await Promise.all([
      userIds.length
        ? retail.from("profiles").select("id,first_name,last_name,email,mint_number,id_number,address").in("id", userIds)
        : Promise.resolve({ data: [] }),
      familyIds.length
        ? retail.from("family_members").select("id,first_name,last_name,relationship,id_number,mint_number").in("id", familyIds)
        : Promise.resolve({ data: [] }),
      securityIds.length
        ? retail.from("securities_c").select("id,name,symbol,isin,last_price").in("id", securityIds)
        : Promise.resolve({ data: [] }),
    ]);
    const profileBy = new Map((profiles ?? []).map((row) => [String(row.id), row]));
    const familyBy = new Map((families ?? []).map((row) => [String(row.id), row]));
    const securityBy = new Map((securities ?? []).map((row) => [String(row.id), row]));
    const grouped = new Map<string, typeof scoped>();
    for (const holding of scoped) {
      const key = `${holding.user_id}|${holding.family_member_id ?? ""}`;
      grouped.set(key, [...(grouped.get(key) ?? []), holding]);
    }
    const now = new Date();
    const date = compactDate(now);
    const time = `${String(now.getHours()).padStart(2, "0")}${String(now.getMinutes()).padStart(2, "0")}${String(now.getSeconds()).padStart(2, "0")}`;
    const lines = [`H1|MNT01|${date}|${time}|MINTBIR${date}${time}`];
    let ownerNumber = 1;
    let settlementNumber = 1;
    for (const ownerHoldings of grouped.values()) {
      const first = ownerHoldings[0];
      if (!first) continue;
      const profile = profileBy.get(String(first.user_id));
      const family = first.family_member_id ? familyBy.get(String(first.family_member_id)) : null;
      const name = family
        ? [family.first_name, family.last_name].filter(Boolean).join(" ")
        : [profile?.first_name, profile?.last_name].filter(Boolean).join(" ") || profile?.email || "Unknown Client";
      const account = clean(family?.mint_number ?? profile?.mint_number ?? profile?.email ?? first.user_id);
      const ownerRef = `BO${String(ownerNumber).padStart(4, "0")}`;
      lines.push(`B1|${account}|${ownerRef}|IND|${clean(name)}|NID|${clean(family?.id_number ?? profile?.id_number)}|ZAF`);
      lines.push(`B2|${ownerRef}|P|${clean(profile?.address)}|-|Johannesburg|0001|ZAF`);
      for (const holding of ownerHoldings) {
        const security = securityBy.get(String(holding.security_id));
        lines.push(
          [
            "B3",
            ownerRef,
            clean(security?.isin),
            clean(security?.name ?? security?.symbol),
            account,
            Math.abs(Number(holding.quantity ?? 0)).toFixed(6),
            "C",
            (
              security?.last_price != null && Number(security.last_price) > 0
                ? Math.abs(Number(holding.quantity ?? 0)) * (Number(security.last_price) / 100)
                : Number(holding.market_value ?? 0)
            ).toFixed(2),
            compactDate(String(holding.created_at)),
            `SETT${String(settlementNumber).padStart(4, "0")}`,
          ].join("|"),
        );
        settlementNumber += 1;
      }
      ownerNumber += 1;
    }
    lines.push(`T1|${lines.length}`);
    return NextResponse.json({
      ok: true,
      lines,
      file_name: `MINT_STRATE_BIR_${date}.txt`,
      client_count: Math.max(ownerNumber - 1, 0),
      holding_count: Math.max(settlementNumber - 1, 0),
      total_records: lines.length,
    });
  }

  return NextResponse.json({ ok: false, error: "Unknown module." }, { status: 400 });
}
