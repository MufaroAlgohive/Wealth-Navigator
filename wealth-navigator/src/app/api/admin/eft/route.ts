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

  if (action === "today-reconciliation") {
    // Live rollup of TODAY's wallet_transactions so the desk sees how many
    // deposits still need a human. Matched = approved (auto-reconciled),
    // unmatched = pending (manual review); rejected count toward total only.
    // Full bank-statement <-> wallet matching lands in Phase C.
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const { data: txns, error } = await db
      .from("wallet_transactions")
      .select("amount, status, created_at")
      .gte("created_at", start.toISOString());
    if (error) {
      return NextResponse.json({
        ok: true,
        stats: { total: 0, matched: 0, unmatched: 0, totalRands: 0 },
        notice: error.message,
      });
    }
    let total = 0;
    let matched = 0;
    let unmatched = 0;
    let totalRands = 0;
    for (const t of txns ?? []) {
      total += 1;
      totalRands += Number(t.amount) || 0;
      const s = String(t.status ?? "").toLowerCase();
      if (s === "pending") unmatched += 1;
      else if (s === "approved" || s === "completed" || s === "credited") matched += 1;
    }
    return NextResponse.json({ ok: true, stats: { total, matched, unmatched, totalRands } });
  }

  return NextResponse.json({ ok: false, error: `Unknown action: ${action}` }, { status: 400 });
}

export async function POST(req: Request) {
  const g = await gate();
  if (g.err) return g.err;
  const { db } = g;
  if (!db) return NextResponse.json({ ok: false, error: "RETAIL database not configured." }, { status: 503 });

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const url = new URL(req.url);
  // The EFT page sends the action as a query param: POST /api/admin/eft?action=approved-deposit
  const action = (typeof body.action === "string" ? body.action : url.searchParams.get("action") ?? "").trim();
  if (action === "add-wallet") {
    return handleAddWallet(db, body);
  }

  const transactionId = typeof body.transaction_id === "string" ? body.transaction_id.trim() : "";

  if (!transactionId) {
    return NextResponse.json({ ok: false, error: "transaction_id is required" }, { status: 400 });
  }

  if (action === "approved-deposit" || action === "approve-deposit") {
    return handleApprove(db, transactionId);
  }
  if (action === "rejected-deposit" || action === "reject-deposit") {
    return handleReject(db, transactionId);
  }

  return NextResponse.json({ ok: false, error: `Unknown POST action: ${action}` }, { status: 400 });
}

async function handleApprove(db: SupabaseClient, transactionId: string): Promise<NextResponse> {
  // 1. Fetch the pending transaction
  const { data: txn, error: txnErr } = await db
    .from("wallet_transactions")
    .select("id, user_id, amount, status, metadata")
    .eq("id", transactionId)
    .maybeSingle();
  if (txnErr) return NextResponse.json({ ok: false, error: txnErr.message }, { status: 500 });
  if (!txn) return NextResponse.json({ ok: false, error: "Transaction not found." }, { status: 404 });
  const row = txn as { id: string; user_id: string; amount: number | string | null; status: string | null; metadata: Record<string, unknown> | null };
  if (row.status !== "pending") {
    return NextResponse.json({ ok: false, error: `Transaction is already ${row.status ?? "unknown"} — cannot approve.` }, { status: 409 });
  }

  const amountRands = Number(row.amount) || 0;
  if (amountRands <= 0) {
    return NextResponse.json({ ok: false, error: "Transaction has no positive amount." }, { status: 400 });
  }

  const now = new Date().toISOString();

  // 2. Update wallet_transactions status → approved
  const { error: updErr } = await db
    .from("wallet_transactions")
    .update({
      status: "approved",
      processed_at: now,
      metadata: {
        ...(row.metadata ?? {}),
        approved_at: now,
        approved_by: "admin",
      },
    })
    .eq("id", transactionId);
  if (updErr) return NextResponse.json({ ok: false, error: updErr.message }, { status: 500 });

  // 3. Credit the wallet balance (RANDS)
  let walletNotice: string | null = null;
  const { data: wallets, error: walletReadErr } = await db
    .from("wallets")
    .select("id, balance")
    .eq("user_id", row.user_id)
    .limit(1);

  const wallet = wallets?.[0];

  if (walletReadErr) {
    walletNotice = `Wallet read failed: ${walletReadErr.message}`;
  } else if (!wallet) {
    walletNotice = "No wallet row found for this user — balance not credited.";
  } else {
    const currentBalance = Number(wallet.balance) || 0;
    const newBalance = currentBalance + amountRands;
    const { error: walletUpdErr } = await db
      .from("wallets")
      .update({ balance: newBalance, updated_at: now })
      .eq("id", wallet.id);
    if (walletUpdErr) {
      walletNotice = `Wallet credit failed: ${walletUpdErr.message}`;
    }
  }

  // 4. Send "Wallet Funded" email
  let emailStatus: "sent" | "skipped" | "failed" = "skipped";
  try {
    const { buildWalletFundedHtml, sendEmail } = await import("@/lib/admin/email");
    const { data: profile } = await db
      .from("profiles")
      .select("email, first_name")
      .eq("id", row.user_id)
      .maybeSingle();
    const prof = profile as { email: string | null; first_name: string | null } | null;
    if (prof?.email) {
      await sendEmail({
        to: prof.email,
        subject: "Your MINT wallet has been funded",
        html: buildWalletFundedHtml({ firstName: prof.first_name ?? undefined, amount: amountRands }),
        emailType: "wallet_funded",
        source: "eft_approve",
        metadata: { transaction_id: transactionId, amount_rands: amountRands, user_id: row.user_id },
      });
      emailStatus = "sent";
    }
  } catch (e) {
    emailStatus = "failed";
    // eslint-disable-next-line no-console
    console.warn("[eft/approve] email send failed (non-fatal):", e instanceof Error ? e.message : e);
  }

  return NextResponse.json({
    ok: true,
    transaction_id: transactionId,
    status: "approved",
    amount_rands: amountRands,
    wallet_notice: walletNotice,
    email_status: emailStatus,
  });
}

async function handleReject(db: SupabaseClient, transactionId: string): Promise<NextResponse> {
  const { data: txn, error: txnErr } = await db
    .from("wallet_transactions")
    .select("id, status")
    .eq("id", transactionId)
    .maybeSingle();
  if (txnErr) return NextResponse.json({ ok: false, error: txnErr.message }, { status: 500 });
  if (!txn) return NextResponse.json({ ok: false, error: "Transaction not found." }, { status: 404 });
  const row = txn as { id: string; status: string | null };
  if (row.status !== "pending") {
    return NextResponse.json({ ok: false, error: `Transaction is already ${row.status ?? "unknown"} — cannot reject.` }, { status: 409 });
  }

  const now = new Date().toISOString();
  const { error: updErr } = await db
    .from("wallet_transactions")
    .update({
      status: "rejected",
      processed_at: now,
      metadata: { rejected_at: now, rejected_by: "admin" },
    })
    .eq("id", transactionId);
  if (updErr) return NextResponse.json({ ok: false, error: updErr.message }, { status: 500 });

  return NextResponse.json({
    ok: true,
    transaction_id: transactionId,
    status: "rejected",
  });
}

async function handleAddWallet(db: SupabaseClient, body: Record<string, unknown>): Promise<NextResponse> {
  const userId = typeof body.user_id === "string" ? body.user_id.trim() : "";
  const amount = typeof body.amount === "number" ? body.amount : parseFloat(String(body.amount));
  
  if (!userId) return NextResponse.json({ ok: false, error: "user_id is required" }, { status: 400 });
  if (isNaN(amount) || amount <= 0) return NextResponse.json({ ok: false, error: "valid amount is required" }, { status: 400 });

  // Make sure the wallet exists
  const { data: existingWallets, error: wErr } = await db
    .from("wallets")
    .select("id")
    .eq("user_id", userId)
    .limit(1);

  if (wErr) return NextResponse.json({ ok: false, error: wErr.message }, { status: 500 });
  
  const existingWallet = existingWallets?.[0];

  let walletId = existingWallet?.id;
  if (!walletId) {
    const { data: newWallet, error: insErr } = await db
      .from("wallets")
      .insert({ user_id: userId, balance: 0 })
      .select("id")
      .single();
    if (insErr) return NextResponse.json({ ok: false, error: `Failed to create wallet: ${insErr.message}` }, { status: 500 });
    walletId = newWallet.id;
  }

  // Insert a pending manual transaction
  const storeReference = `EFT-MANUAL-${Date.now()}`;
  const { error: tErr } = await db
    .from("wallet_transactions")
    .insert({
      wallet_id: walletId,
      user_id: userId,
      amount,
      transaction_type: "manual",
      status: "pending",
      reference: storeReference,
    });
    
  if (tErr) return NextResponse.json({ ok: false, error: `Failed to create pending deposit: ${tErr.message}` }, { status: 500 });

  return NextResponse.json({ ok: true, message: "Added pending deposit for approval." });
}
