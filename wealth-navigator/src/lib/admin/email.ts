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

/**
 * Client-facing "Trade Confirmation" email — business-supplied template kept
 * verbatim (inline styles, MINT gold/purple branding, FSP/NCRCP footer).
 * Deliberately NOT passed through `shell()` like the other builders in this
 * file: this HTML is already a complete, self-contained email document with
 * its own `<!DOCTYPE html>`/`<head>`/`<body>`.
 */
export function buildTradeConfirmationHtml(opts: {
  firstName?: string;
  action: "Buy" | "Sell";
  symbol: string;
  orderId: string;
  quantity: number;
  avgPriceRands: number;
}): string {
  const fmt = (n: number) => Number(n).toLocaleString("en-ZA", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const clientName = opts.firstName || "there";
  const totalValue = opts.quantity * opts.avgPriceRands;
  return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Trade Confirmation</title>
</head>
<body style="margin: 0; padding: 0; background-color: #f4f4f7; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;">
    <div style="max-width: 600px; margin: 40px auto; background-color: #ffffff; border-radius: 8px; overflow: hidden; box-shadow: 0 4px 12px rgba(0,0,0,0.05);">
        <!-- HEADER -->
<div style="background: #31005E; padding: 44px 44px 38px;">
  <img src="https://auth.mymint.co.za/storage/v1/object/public/Mint%20Assets/myMINT%20Logo%20White.png" alt="MINT Logo" style="height: 48px; margin-bottom: 16px; display: block;" />
  <div style="font-size: 11px; letter-spacing: 4px; color: #DDC357; font-weight: 600; text-transform: uppercase; margin-bottom: 26px;">MINT Platforms</div>
  <h1 style="font-family: 'DM Serif Display', Georgia, serif; font-size: 33px; color: #ffffff; font-weight: 400; line-height: 1.15; letter-spacing: -0.3px; margin-bottom: 14px;">Trade Confirmation</h1>
  <p style="font-size: 14px; color: rgba(255,255,255,0.62); font-weight: 300;">We have successfully executed your recent market order.</p>
  <div style="margin-top: 24px; padding-top: 18px; border-top: 1px solid rgba(255,255,255,0.14); font-size: 11px; letter-spacing: 2px; color: #DDC357; text-transform: uppercase; font-weight: 500;">
    MINT BASKETS &middot; TRADE CONFIRMATION &middot; AUGUST 2026
  </div>
</div>

<!-- BODY -->
<div style="padding: 40px 44px 8px;">
  <p style="font-size: 16px; line-height: 1.7; color: #2C2738; font-weight: 300; margin-bottom: 36px;">
    Hi ${clientName},<br><br>
    Your <strong>${opts.action}</strong> order for <strong>${opts.symbol}</strong> has been fully filled on the market. Here are the details of your trade:
  </p>

  <!-- SECTION -->
  <div style="margin-bottom: 38px;">
    <div style="font-size: 10px; letter-spacing: 3px; text-transform: uppercase; color: #5C3BCF; font-weight: 600; margin-bottom: 10px;">EXECUTION DETAILS</div>
    <h2 style="font-family: 'DM Serif Display', Georgia, serif; font-size: 23px; font-weight: 400; color: #31005E; letter-spacing: -0.2px; margin-bottom: 16px;">Order #${opts.orderId}</h2>

    <!-- TABLE -->
    <table style="width: 100%; border-collapse: collapse; margin: 22px 0 4px;">
      <thead>
        <tr>
          <th style="text-align: left; font-size: 10px; letter-spacing: 1.5px; text-transform: uppercase; color: #8A8398; font-weight: 600; padding: 0 0 10px; border-bottom: 1px solid #E4E0EC;">METRIC</th>
          <th style="text-align: right; padding-right: 22px; font-size: 10px; letter-spacing: 1.5px; text-transform: uppercase; color: #8A8398; font-weight: 600; padding: 0 0 10px; border-bottom: 1px solid #E4E0EC;">VALUE</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td style="padding: 13px 0; border-bottom: 1px solid #F0EDF5; font-size: 14px; font-weight: 500; color: #1A1622; width: 32%;">Action</td>
          <td style="text-align: right; padding: 13px 22px 13px 0; border-bottom: 1px solid #F0EDF5; font-size: 14px; color: #2C2738;">${opts.action}</td>
        </tr>
        <tr>
          <td style="padding: 13px 0; border-bottom: 1px solid #F0EDF5; font-size: 14px; font-weight: 500; color: #1A1622; width: 32%;">Security</td>
          <td style="text-align: right; padding: 13px 22px 13px 0; border-bottom: 1px solid #F0EDF5; font-size: 14px; color: #2C2738;">${opts.symbol}</td>
        </tr>
        <tr>
          <td style="padding: 13px 0; border-bottom: 1px solid #F0EDF5; font-size: 14px; font-weight: 500; color: #1A1622; width: 32%;">Quantity Executed</td>
          <td style="text-align: right; padding: 13px 22px 13px 0; border-bottom: 1px solid #F0EDF5; font-family: 'JetBrains Mono', monospace; font-size: 13px; font-weight: 500;">${opts.quantity} shares</td>
        </tr>
        <tr>
          <td style="padding: 13px 0; border-bottom: 1px solid #F0EDF5; font-size: 14px; font-weight: 500; color: #1A1622; width: 32%;">Average Fill Price</td>
          <td style="text-align: right; padding: 13px 22px 13px 0; border-bottom: 1px solid #F0EDF5; font-family: 'JetBrains Mono', monospace; font-size: 13px; font-weight: 500;">R ${fmt(opts.avgPriceRands)}</td>
        </tr>
        <tr>
          <td style="padding: 20px 0 13px; font-weight: 700; color: #1A1622;">Total Value</td>
          <td style="text-align: right; padding: 20px 22px 13px 0; font-size: 16px; font-weight: 800; color: #31005E;">R ${fmt(totalValue)}</td>
        </tr>
      </tbody>
    </table>
  </div>
</div>

<!-- CLOSE -->
<div style="padding: 36px 44px 8px;">
  <p style="font-size: 15px; line-height: 1.7; color: #3A3448; margin-bottom: 14px; font-weight: 300;">
    Your portfolio and holdings have been automatically updated to reflect this execution. You can view your latest balances and portfolio performance by logging into your account.
  </p>
  <a href="https://app.mymint.co.za" style="color: #5C3BCF; text-decoration: none; font-weight: 500;">View my portfolio &rarr;</a>
</div>

<!-- FOOTER -->
<div style="padding: 30px 44px 36px; border-top: 1px solid #EEEBF3;">
  <div style="font-size: 13px; letter-spacing: 3px; color: #31005E; font-weight: 700; margin-bottom: 8px;">MINT PLATFORMS</div>
  <div style="font-size: 11px; color: #9A93A8; font-weight: 300; line-height: 1.7;">FSP 55118 &nbsp;|&nbsp; NCRCP22892 &nbsp;|&nbsp; Reg. 2024/644796/07</div>
  <div style="font-size: 11px; color: #9A93A8; font-weight: 300; line-height: 1.7;">3 Gwen Lane, Sandown, Sandton, Johannesburg</div>
  <div style="font-size: 11px; color: #9A93A8; font-weight: 300; line-height: 1.7;">support@mymint.co.za &nbsp;|&nbsp; www.mymint.co.za</div>
  <div style="font-size: 10.5px; color: #B4AEC0; margin-top: 16px; line-height: 1.6; font-weight: 300;">
    This communication is an automated notification and does not constitute investment advice.
  </div>
</div>
    </div>
</body>
</html>`;
}
