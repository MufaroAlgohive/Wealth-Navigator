import { NextResponse } from "next/server";

import { createRetailServiceRoleClient } from "@/lib/supabase/server";
import { sendEmail, buildWelcomeHtml, buildWalletFundedHtml, buildTradeConfirmationHtml } from "@/lib/admin/email";

/**
 * Supabase Database Webhook receiver. Ports `api/webhooks.js`.
 * Secret-gated by SUPABASE_WEBHOOK_SECRET (NOT session-gated — Supabase calls
 * it server-to-server). Matches enabled email_webhook_triggers and dispatches.
 * trade_confirmation is parked until the orderbook email port lands.
 */

export const dynamic = "force-dynamic";

interface Trigger { name: string; email_type: string; user_id_field: string | null; condition_field: string | null; condition_value: string | null; }

export async function POST(req: Request) {
  const secret = process.env.SUPABASE_WEBHOOK_SECRET;
  if (secret) {
    const incoming = req.headers.get("x-webhook-secret") || req.headers.get("authorization")?.replace("Bearer ", "");
    if (incoming !== secret) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const payload = (await req.json().catch(() => null)) as { type?: string; table?: string; record?: Record<string, unknown>; old_record?: Record<string, unknown> } | null;
  if (!payload?.type || !payload?.table) return NextResponse.json({ error: "Missing type or table" }, { status: 400 });

  let db;
  try {
    db = createRetailServiceRoleClient();
  } catch {
    return NextResponse.json({ ok: true, notice: "RETAIL database not configured" });
  }

  let triggers: Trigger[] = [];
  try {
    const { data } = await db
      .from("email_webhook_triggers")
      .select("name, email_type, user_id_field, condition_field, condition_value")
      .eq("table_name", payload.table)
      .eq("event_type", payload.type)
      .eq("enabled", true);
    triggers = (data ?? []) as Trigger[];
  } catch {
    return NextResponse.json({ ok: true, message: "trigger table not configured" });
  }
  if (!triggers.length) return NextResponse.json({ ok: true, matched: 0 });

  const rec = payload.record || payload.old_record || {};
  const results: Array<Record<string, unknown>> = [];
  for (const t of triggers) {
    try {
      if (t.condition_field && t.condition_value != null) {
        if (String(rec[t.condition_field] ?? "") !== String(t.condition_value)) { results.push({ trigger: t.name, skipped: "condition not met" }); continue; }
      }
      if (t.email_type === "welcome") {
        const email = String(rec.email ?? "");
        if (!email) throw new Error("No email in record");
        await sendEmail({ to: email, subject: "Welcome to Mint", html: buildWelcomeHtml(String(rec.first_name || rec.full_name || "")), emailType: "welcome", source: "webhook", metadata: { profile_id: rec.id } });
      } else if (t.email_type === "wallet_funded") {
        const userId = rec[t.user_id_field || "user_id"] as string | undefined;
        if (!userId) throw new Error("No user_id in record");
        const { data: profs } = await db.from("profiles").select("email, first_name").eq("id", userId).limit(1);
        const profile = profs?.[0];
        if (!profile?.email) throw new Error("No profile/email for user");
        await sendEmail({ to: profile.email as string, subject: `Funds received — R ${Number(rec.amount || 0).toLocaleString("en-ZA", { minimumFractionDigits: 2 })}`, html: buildWalletFundedHtml({ firstName: profile.first_name as string, amount: Number(rec.amount) || 0 }), emailType: "wallet_funded", source: "webhook", metadata: { user_id: userId, amount: rec.amount } });
      } else if (t.email_type === "trade_confirmation") {
        const userId = rec[t.user_id_field || "user_id"] as string | undefined;
        if (!userId) throw new Error("No user_id in record");
        const { data: profs } = await db.from("profiles").select("email, first_name").eq("id", userId).limit(1);
        const profile = profs?.[0];
        if (!profile?.email) throw new Error("No profile/email for user");
        let symbol = "", name = "";
        if (rec.security_id) {
          const { data: secs } = await db.from("securities_c").select("symbol, name").eq("id", rec.security_id).limit(1);
          symbol = (secs?.[0]?.symbol as string) || "";
          name = (secs?.[0]?.name as string) || symbol;
        }
        const priceRands = rec.avg_fill ? Number(rec.avg_fill) / 100 : Number(rec.Expected_fill) || 0;
        await sendEmail({
          to: profile.email as string,
          subject: `Trade confirmed${symbol ? ` — ${symbol}` : ""}`,
          html: buildTradeConfirmationHtml({ firstName: profile.first_name as string, symbol, name, quantity: Number(rec.quantity) || 0, price: priceRands }),
          emailType: "trade_confirmation",
          source: "webhook",
          metadata: { holding_id: rec.id, user_id: userId },
        });
      } else {
        results.push({ trigger: t.name, error: `Unknown email_type: ${t.email_type}` });
        continue;
      }
      results.push({ trigger: t.name, ok: true });
    } catch (err) {
      results.push({ trigger: t.name, error: err instanceof Error ? err.message : "failed" });
    }
  }

  return NextResponse.json({ ok: true, matched: triggers.length, results });
}
