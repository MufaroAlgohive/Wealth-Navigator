# Mint Admin — Supabase email templates

Paste these into **Supabase Dashboard → Authentication → Email Templates**.
They use Supabase's built-in template variables (`{{ .ConfirmationURL }}`, `{{ .Email }}`, `{{ .SiteURL }}`).

---

## 1) Invite User template

**Subject:**

```
You're invited to Mint Admin
```

**Message body (HTML):**

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="color-scheme" content="light only">
</head>
<body style="margin:0;padding:0;background:#f4f4f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <span style="display:none!important;visibility:hidden;mso-hide:all;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;">You've been invited to the Mint Admin Portal — set your password to get started.</span>
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" bgcolor="#f4f4f7" style="background:#f4f4f7;">
    <tr>
      <td align="center" style="padding:32px 16px;">
        <table role="presentation" width="600" cellspacing="0" cellpadding="0" border="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:18px;overflow:hidden;box-shadow:0 8px 32px rgba(15,23,42,0.06);">
          <tr>
            <td style="background:linear-gradient(135deg,#5b21b6 0%,#7c3aed 100%);padding:36px 36px 28px 36px;text-align:left;">
              <table role="presentation" cellspacing="0" cellpadding="0" border="0">
                <tr>
                  <td style="vertical-align:middle;">
                    <div style="display:inline-block;width:36px;height:36px;background:#ffffff;border-radius:10px;text-align:center;line-height:36px;font-weight:700;color:#7c3aed;font-size:18px;">M</div>
                  </td>
                  <td style="vertical-align:middle;padding-left:12px;">
                    <div style="color:#ffffff;font-weight:600;font-size:15px;">Mint CRM</div>
                    <div style="color:rgba(255,255,255,0.75);font-size:12px;font-weight:500;">Admin Portal</div>
                  </td>
                </tr>
              </table>
              <h1 style="margin:24px 0 0 0;color:#ffffff;font-size:24px;line-height:1.25;font-weight:700;">You're invited to Mint Admin</h1>
            </td>
          </tr>
          <tr>
            <td style="padding:32px 36px 24px 36px;color:#1c1c1e;font-size:15px;line-height:1.6;">
              <p style="margin:0 0 20px 0;color:#3c3c43;">You've been invited to join the Mint Admin Portal. Click the button below to <strong>create your password</strong> and finish setting up your account.</p>
              <div style="background:#faf7ff;border:1px solid #ede5ff;border-radius:12px;padding:16px 18px;margin:8px 0 4px 0;">
                <div style="font-size:12px;font-weight:600;color:#5b21b6;text-transform:uppercase;letter-spacing:0.6px;margin-bottom:6px;">What happens next</div>
                <ol style="margin:0;padding-left:20px;color:#3c3c43;font-size:14px;line-height:1.7;">
                  <li>Open the secure signup page</li>
                  <li>Choose a password (at least 8 characters)</li>
                  <li>Sign in and start using the portal</li>
                </ol>
              </div>
              <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:28px 0 8px 0;">
                <tr>
                  <td align="center" bgcolor="#0f172a" style="border-radius:12px;">
                    <a href="{{ .ConfirmationURL }}" target="_blank" style="display:inline-block;padding:14px 28px;color:#ffffff;text-decoration:none;font-weight:600;font-size:15px;border-radius:12px;background:#0f172a;">Create your password</a>
                  </td>
                </tr>
              </table>
              <p style="margin:18px 0 0 0;font-size:12px;color:#8e8e93;line-height:1.55;">If the button doesn't work, copy and paste this link into your browser:<br>
                <a href="{{ .ConfirmationURL }}" target="_blank" style="color:#5b21b6;word-break:break-all;text-decoration:underline;">{{ .ConfirmationURL }}</a>
              </p>
              <p style="margin:24px 0 0 0;font-size:12px;color:#8e8e93;line-height:1.55;">For your security, only the email address this was sent to ({{ .Email }}) can complete signup.</p>
            </td>
          </tr>
          <tr>
            <td style="padding:18px 36px 28px 36px;border-top:1px solid #f0f0f3;color:#8e8e93;font-size:11px;line-height:1.55;">
              You're receiving this because someone with admin access at Mint added your email to the team.
              <br>If this wasn't expected, you can safely ignore this email.
            </td>
          </tr>
        </table>
        <div style="max-width:600px;margin:14px auto 0;color:#a1a1aa;font-size:11px;text-align:center;">
          © Mint Investments &middot; Admin Portal
        </div>
      </td>
    </tr>
  </table>
</body>
</html>
```

---

## 2) Reset Password template

**Subject:**

```
Reset your Mint Admin password
```

**Message body (HTML):**

```html
<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f4f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <span style="display:none!important;visibility:hidden;mso-hide:all;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;">Use this link to choose a new password for your Mint Admin account.</span>
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" bgcolor="#f4f4f7">
    <tr>
      <td align="center" style="padding:32px 16px;">
        <table role="presentation" width="600" cellspacing="0" cellpadding="0" border="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:18px;overflow:hidden;box-shadow:0 8px 32px rgba(15,23,42,0.06);">
          <tr>
            <td style="background:linear-gradient(135deg,#5b21b6 0%,#7c3aed 100%);padding:36px;text-align:left;">
              <table role="presentation" cellspacing="0" cellpadding="0" border="0">
                <tr>
                  <td style="vertical-align:middle;">
                    <div style="display:inline-block;width:36px;height:36px;background:#ffffff;border-radius:10px;text-align:center;line-height:36px;font-weight:700;color:#7c3aed;font-size:18px;">M</div>
                  </td>
                  <td style="vertical-align:middle;padding-left:12px;">
                    <div style="color:#ffffff;font-weight:600;font-size:15px;">Mint CRM</div>
                    <div style="color:rgba(255,255,255,0.75);font-size:12px;font-weight:500;">Admin Portal</div>
                  </td>
                </tr>
              </table>
              <h1 style="margin:24px 0 0 0;color:#ffffff;font-size:24px;line-height:1.25;font-weight:700;">Reset your password</h1>
            </td>
          </tr>
          <tr>
            <td style="padding:32px 36px;color:#1c1c1e;font-size:15px;line-height:1.6;">
              <p style="margin:0 0 16px 0;color:#3c3c43;">Click the button below to choose a new password for your Mint Admin account.</p>
              <p style="margin:0;color:#3c3c43;">For your security, this link is valid for <strong>1 hour</strong>.</p>
              <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:28px 0 8px 0;">
                <tr>
                  <td align="center" bgcolor="#0f172a" style="border-radius:12px;">
                    <a href="{{ .ConfirmationURL }}" target="_blank" style="display:inline-block;padding:14px 28px;color:#ffffff;text-decoration:none;font-weight:600;font-size:15px;border-radius:12px;background:#0f172a;">Reset password</a>
                  </td>
                </tr>
              </table>
              <p style="margin:18px 0 0 0;font-size:12px;color:#8e8e93;line-height:1.55;">If the button doesn't work, copy and paste this link into your browser:<br>
                <a href="{{ .ConfirmationURL }}" target="_blank" style="color:#5b21b6;word-break:break-all;text-decoration:underline;">{{ .ConfirmationURL }}</a>
              </p>
              <p style="margin:24px 0 0 0;font-size:12px;color:#8e8e93;line-height:1.55;">If you didn't ask to reset your password, you can safely ignore this email — your current password will keep working.</p>
            </td>
          </tr>
          <tr>
            <td style="padding:18px 36px 28px 36px;border-top:1px solid #f0f0f3;color:#8e8e93;font-size:11px;line-height:1.55;">
              © Mint Investments &middot; Admin Portal
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
```
