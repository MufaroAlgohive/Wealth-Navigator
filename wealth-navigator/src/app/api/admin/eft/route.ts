import { NextResponse } from "next/server";

import { getAdminContext } from "@/lib/admin/rbac";
import { createRetailServiceRoleClient } from "@/lib/supabase/server";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * EFT / wallet admin. Ports `/api/send-eft-email?action=…` + `/api/eft/
 * pending-transactions` over wallets / wallet_transactions / profiles /
 * family_members (RETAIL/LIVE DB).
 *
 * READS ported now (list-wallets, pending-transactions, search-clients,
 * member-children). WRITES are DEFERRED — add-wallet / approve-deposit /
 * reject-deposit / send-notice mutate LIVE client balances + send email, which
 * belong to the data/backend phase. They return an honest notice.
 */

export const dynamic = "force-dynamic";

const DEFER = "Wallet credit / deposit approval / notice email is deferred — it mutates live client balances (data/backend phase).";

async function gate(): Promise<{ db: SupabaseClient | null; member: boolean; err: NextResponse | null }> {
  const auth = await getAdminContext();
  if (auth.status === "no-session") return { db: null, member: false, err: NextResponse.json({ ok: false, error: "no-session" }, { status: 401 }) };
  if (auth.status === "not-member") return { db: null, member: false, err: NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 }) };
  let db: SupabaseClient | null = null;
  try {
    db = createRetailServiceRoleClient();
  } catch {
    db = null;
  }
  return { db, member: auth.status === "ok", err: null };
}

export async function GET(req: Request) {
  const g = await gate();
  if (g.err) return g.err;
  const { db } = g;
  const url = new URL(req.url);
  const action = url.searchParams.get("action") || "list-wallets";
  if (!db) return NextResponse.json({ ok: true, notice: "RETAIL database not configured.", wallets: [], transactions: [], clients: [], children: [], stats: { count: 0, total: 0 } });

  if (action === "list-wallets") {
    const filter = url.searchParams.get("filter") === "test" ? "test" : "active";
    const { data: wallets, error } = await db
      .from("wallets")
      .select("id, user_id, balance, currency, status, mint_number, mailer, updated_at")
      .eq("status", filter)
      .gt("balance", 0)
      .order("updated_at", { ascending: false });
    if (error) return NextResponse.json({ ok: true, wallets: [], stats: { count: 0, total: 0 }, notice: error.message });
    const rows = wallets ?? [];
    const userIds = [...new Set(rows.map((w) => w.user_id).filter(Boolean))];
    const profileMap: Record<string, Record<string, unknown>> = {};
    const childMap: Record<string, Record<string, unknown>[]> = {};
    if (userIds.length) {
      const { data: profiles } = await db.from("profiles").select("id, first_name, last_name, mint_number, email").in("id", userIds);
      for (const p of profiles ?? []) profileMap[p.id as string] = p;
      const { data: children } = await db
        .from("family_members")
        .select("id, first_name, last_name, available_balance, primary_user_id, parent_id, relationship")
        .or(`primary_user_id.in.(${userIds.join(",")}),parent_id.in.(${userIds.join(",")})`);
      for (const c of children ?? []) {
        const parent = (c.primary_user_id as string) || (c.parent_id as string);
        if (!parent) continue;
        (childMap[parent] ||= []).push(c);
      }
    }
    const enriched = rows.map((w) => ({ ...w, profile: profileMap[w.user_id] ?? null, children: childMap[w.user_id] ?? [] }));
    const total = rows.reduce((sum, w) => sum + Number(w.balance || 0), 0);
    return NextResponse.json({ ok: true, wallets: enriched, stats: { count: rows.length, total } });
  }

  if (action === "pending-transactions") {
    const { data: txns, error } = await db
      .from("wallet_transactions")
      .select("id, user_id, amount, created_at, status")
      .eq("status", "pending")
      .order("created_at", { ascending: false });
    if (error) return NextResponse.json({ ok: true, transactions: [], notice: error.message });
    const rows = txns ?? [];
    const userIds = [...new Set(rows.map((t) => t.user_id).filter(Boolean))];
    const profileMap: Record<string, Record<string, unknown>> = {};
    if (userIds.length) {
      const { data: profiles } = await db.from("profiles").select("id, first_name, last_name, mint_number, email").in("id", userIds);
      for (const p of profiles ?? []) profileMap[p.id as string] = p;
    }
    return NextResponse.json({ ok: true, transactions: rows.map((t) => ({ ...t, profile: profileMap[t.user_id] ?? null })) });
  }

  if (action === "search-clients") {
    const q = (url.searchParams.get("q") || "").trim();
    if (q.length < 1) return NextResponse.json({ ok: true, clients: [] });
    const { data } = await db
      .from("profiles")
      .select("id, first_name, last_name, email, mint_number")
      .or(`first_name.ilike.%${q}%,last_name.ilike.%${q}%,email.ilike.%${q}%,mint_number.ilike.%${q}%`)
      .limit(8);
    return NextResponse.json({ ok: true, clients: data ?? [] });
  }

  if (action === "member-children") {
    const parentId = url.searchParams.get("parent_id") || "";
    if (!parentId) return NextResponse.json({ ok: true, children: [] });
    const { data } = await db
      .from("family_members")
      .select("id, first_name, last_name, available_balance, relationship")
      .or(`primary_user_id.eq.${parentId},parent_id.eq.${parentId}`);
    const kids = (data ?? []).filter((c) => !c.relationship || c.relationship === "child");
    return NextResponse.json({ ok: true, children: kids });
  }

  return NextResponse.json({ ok: false, error: `Unknown action: ${action}` }, { status: 400 });
}

export async function POST() {
  // add-wallet / approve-deposit / reject-deposit / send-notice — all mutate
  // live client balances and/or send email → deferred to the data/backend phase.
  return NextResponse.json({ ok: false, error: DEFER, deferred: true }, { status: 501 });
}
