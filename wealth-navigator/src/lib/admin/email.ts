/**
 * Admin email layer — Resend send + email_logs audit. Ports the legacy
 * `_email-logger.js` + the email builders in `webhooks.js`. Server-only.
 *
 * Sends only when RESEND_API_KEY + ORDERBOOK_EMAIL_FROM are configured; logs
 * every attempt (sent/failed) to email_logs (RETAIL).
 */
import { createRetailServiceRoleClient } from "@/lib/supabase/server";

const KYC_URL = "https://app.mymint.co.za/kyc";
const WELCOME_BANNER = "https://mfxnghmuccevsxwcetej.supabase.co/storage/v1/object/public/Emailer%20Ads/welcome-banner.jpg";

export async function logEmail(entry: {
  emailType: string; recipient: string; subject?: string | null; resendId?: string | null;
  status: "sent" | "failed"; triggerSource?: string; metadata?: Record<string, unknown> | null; errorMessage?: string | null;
}): Promise<void> {
  try {
    const db = createRetailServiceRoleClient();
    await db.from("email_logs").insert({
      email_type: entry.emailType,
      recipient: entry.recipient,
      subject: entry.subject ?? null,
      resend_id: entry.resendId ?? null,
      status: entry.status,
      trigger_source: entry.triggerSource ?? "manual",
      metadata: entry.metadata ?? null,
      error_message: entry.errorMessage ?? null,
    });
  } catch {
    /* email_logs optional / unconfigured */
  }
}

export async function sendEmail(opts: {
  to: string | string[]; subject: string; html: string; emailType: string; source?: string; metadata?: Record<string, unknown> | null;
  /** Optional file attachments (e.g. a CSV export). content is base64. */
  attachments?: Array<{ filename: string; content: string }>;
}): Promise<{ id?: string }> {
  const key = process.env.RESEND_API_KEY;
  const from = process.env.ORDERBOOK_EMAIL_FROM || "noreply@mymint.co.za";
  const recipients = Array.isArray(opts.to) ? opts.to : [opts.to];
  const recipientLabel = recipients.join(", ");
  if (!key) {
    await logEmail({ emailType: opts.emailType, recipient: recipientLabel, subject: opts.subject, status: "failed", triggerSource: opts.source, metadata: opts.metadata, errorMessage: "RESEND_API_KEY not configured" });
    throw new Error("RESEND_API_KEY not configured");
  }
  const resp = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from, to: recipients, subject: opts.subject, html: opts.html,
      ...(opts.attachments?.length ? { attachments: opts.attachments } : {}),
    }),
  });
  const payload = (await resp.json().catch(() => ({}))) as { id?: string; message?: string; error?: string };
  const ok = resp.ok && !payload.error;
  await logEmail({
    emailType: opts.emailType, recipient: recipientLabel, subject: opts.subject, resendId: payload.id ?? null,
    status: ok ? "sent" : "failed", triggerSource: opts.source, metadata: opts.metadata,
    errorMessage: ok ? null : payload.message || payload.error || `HTTP ${resp.status}`,
  });
  if (!ok) throw new Error(payload.message || payload.error || `Resend error ${resp.status}`);
  return payload;
}

const shell = (inner: string) => `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f4f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" bgcolor="#f4f4f7"><tr><td align="center" style="padding:40px 16px;">
<table role="presentation" width="600" cellspacing="0" cellpadding="0" border="0" style="max-width:600px;width:100%;background:#fff;border-radius:24px;overflow:hidden;box-shadow:0 12px 40px rgba(15,23,42,0.08);">
${inner}
</table>
<p style="font-size:10px;color:#94a3b8;margin:16px 0 0;">&copy; ${new Date().getFullYear()} MINT (Pty) Ltd · FSP 55118 · NCRCP22892</p>
</td></tr></table></body></html>`;

export function buildWelcomeHtml(firstName?: string): string {
  return shell(`
  <tr><td style="padding:0;line-height:0;"><img src="${WELCOME_BANNER}" alt="Welcome to MINT" width="600" style="display:block;width:100%;max-width:600px;height:auto;border:0;" /></td></tr>
  <tr><td style="padding:40px 36px;">
    <p style="font-size:18px;color:#0f172a;font-weight:500;margin:0 0 8px;">Hi ${firstName || "there"},</p>
    <p style="font-size:15px;color:#475569;line-height:1.6;margin:0 0 28px;font-weight:300;">Thank you for creating an account with MINT. We build advanced wealth infrastructure to help you deploy capital, fund strategies, and track asset performance with institutional-grade clarity.</p>
    <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="background:#fff;border:1px solid #ede5ff;border-radius:20px;overflow:hidden;margin-bottom:32px;">
      <tr><td style="height:4px;background:linear-gradient(90deg,#5b21b6 0%,#7c3aed 100%);font-size:1px;line-height:0;">&nbsp;</td></tr>
      <tr><td style="padding:28px 24px;">
        <div style="font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.1em;color:#7c3aed;margin-bottom:6px;">Action Required</div>
        <div style="font-size:18px;font-weight:500;color:#0f172a;margin-bottom:10px;">Verify your identity</div>
        <p style="font-size:14px;color:#475569;line-height:1.6;margin:0 0 20px;font-weight:300;">To comply with financial regulations and secure your investment vault, please complete a swift identity check.</p>
        <table role="presentation" cellspacing="0" cellpadding="0" border="0"><tr><td align="center" bgcolor="#5c3bcf" style="border-radius:12px;">
          <a href="${KYC_URL}" target="_blank" style="display:block;padding:14px 24px;font-size:14px;font-weight:500;color:#fff;text-decoration:none;border-radius:12px;">Complete Verification &rarr;</a>
        </td></tr></table>
      </td></tr>
    </table>
    <p style="font-size:14px;color:#475569;text-align:center;margin:0;font-weight:300;">Questions? Contact <a href="mailto:support@mymint.co.za" style="color:#7c3aed;font-weight:500;text-decoration:none;">support@mymint.co.za</a></p>
  </td></tr>`);
}

export function buildWalletFundedHtml(opts: { firstName?: string; amount: number }): string {
  const fmt = (n: number) => "R " + Number(n).toLocaleString("en-ZA", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return shell(`
  <tr><td style="background:linear-gradient(135deg,#31005e 0%,#5b21b6 50%,#7c3aed 100%);padding:36px;">
    <div style="display:inline-block;width:36px;height:36px;background:#fff;border-radius:10px;text-align:center;line-height:36px;font-weight:700;color:#7c3aed;font-size:18px;">M</div>
    <h1 style="margin:20px 0 0;color:#fff;font-size:26px;font-weight:800;">Funds Received</h1>
  </td></tr>
  <tr><td style="padding:32px 36px;">
    <p style="margin:0 0 8px;font-size:16px;font-weight:600;color:#1e293b;">Hi ${opts.firstName || "there"},</p>
    <p style="margin:0 0 24px;font-size:14px;color:#475569;line-height:1.6;">Your Mint wallet has been funded. The amount is ready to invest.</p>
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#faf7ff;border:1px solid #ede5ff;border-radius:12px;margin-bottom:24px;"><tr><td style="padding:20px;text-align:center;">
      <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;color:#7c3aed;margin-bottom:6px;">Amount Added</div>
      <div style="font-size:28px;font-weight:800;color:#0f172a;">${fmt(opts.amount)}</div>
    </td></tr></table>
    <table role="presentation" cellspacing="0" cellpadding="0" border="0"><tr><td style="border-radius:999px;background:#5c3bcf;">
      <a href="https://app.mymint.co.za" style="display:inline-block;padding:14px 32px;font-size:14px;font-weight:700;color:#fff;text-decoration:none;border-radius:999px;">View Portfolio</a>
    </td></tr></table>
  </td></tr>`);
}

export function buildInviteHtml(opts: { link: string; role: string }): string {
  return shell(`
  <tr><td style="background:linear-gradient(135deg,#31005e,#7c3aed);padding:36px;"><h1 style="margin:0;color:#fff;font-size:24px;font-weight:800;">Mint Admin Invitation</h1></td></tr>
  <tr><td style="padding:32px 36px;">
    <p style="font-size:15px;color:#475569;line-height:1.6;margin:0 0 20px;">You've been invited to join the Mint Admin team as <strong style="color:#0f172a;text-transform:capitalize;">${opts.role}</strong>. Click below to set your password and activate your account. This link expires in 7 days.</p>
    <table role="presentation" cellspacing="0" cellpadding="0" border="0"><tr><td style="border-radius:12px;background:#5c3bcf;">
      <a href="${opts.link}" style="display:inline-block;padding:14px 28px;font-size:14px;font-weight:600;color:#fff;text-decoration:none;border-radius:12px;">Accept invitation &rarr;</a>
    </td></tr></table>
  </td></tr>`);
}

export function buildTradeConfirmationHtml(opts: { firstName?: string; symbol: string; name: string; quantity: number; price: number }): string {
  const fmt = (n: number) => "R " + Number(n).toLocaleString("en-ZA", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return shell(`
  <tr><td style="background:linear-gradient(135deg,#31005e,#7c3aed);padding:36px;"><h1 style="margin:0;color:#fff;font-size:24px;font-weight:800;">Trade Confirmed</h1></td></tr>
  <tr><td style="padding:32px 36px;">
    <p style="margin:0 0 8px;font-size:16px;font-weight:600;color:#1e293b;">Hi ${opts.firstName || "there"},</p>
    <p style="margin:0 0 24px;font-size:14px;color:#475569;line-height:1.6;">Your order has been executed. Here are the details:</p>
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#faf7ff;border:1px solid #ede5ff;border-radius:12px;margin-bottom:24px;">
      <tr><td style="padding:8px 20px;font-size:13px;color:#94a3b8;">Instrument</td><td style="padding:8px 20px;font-size:13px;font-weight:600;color:#1e293b;text-align:right;">${opts.name} (${opts.symbol})</td></tr>
      <tr><td style="padding:8px 20px;font-size:13px;color:#94a3b8;">Quantity</td><td style="padding:8px 20px;font-size:13px;font-weight:600;color:#1e293b;text-align:right;">${opts.quantity}</td></tr>
      <tr><td style="padding:8px 20px;font-size:13px;color:#94a3b8;">Fill price</td><td style="padding:8px 20px;font-size:13px;font-weight:600;color:#1e293b;text-align:right;">${fmt(opts.price)}</td></tr>
      <tr><td style="padding:8px 20px;font-size:13px;color:#94a3b8;">Value</td><td style="padding:8px 20px;font-size:15px;font-weight:800;color:#5c3bcf;text-align:right;">${fmt(opts.quantity * opts.price)}</td></tr>
    </table>
    <table role="presentation" cellspacing="0" cellpadding="0" border="0"><tr><td style="border-radius:999px;background:#5c3bcf;"><a href="https://app.mymint.co.za" style="display:inline-block;padding:14px 32px;font-size:14px;font-weight:700;color:#fff;text-decoration:none;border-radius:999px;">View Portfolio</a></td></tr></table>
  </td></tr>`);
}
