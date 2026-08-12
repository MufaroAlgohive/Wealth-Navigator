import { NextResponse } from 'next/server';
import { getPayouts } from '@/lib/dividends-db';
import { createSupabaseServerClient, createRetailServiceRoleClient } from '@/lib/supabase/server';

const writeAudit = async (supabase: any, entry: any) => {
  try {
    await supabase.from('admin_team_audit').insert([entry]);
  } catch (err) { }
};

async function sendViaResend({ to, subject, html }: { to: string, subject: string, html: string }) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) throw new Error('Email service not configured (RESEND_API_KEY)');

  const fromEmail = 'Investors at myMINT <Investors@mymint.co.za>';

  const resp = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: fromEmail, to: [to], subject, html })
  });
  const payload = await resp.json().catch(() => ({}));
  const ok = resp.ok && !payload.error;

  if (!ok) throw new Error(payload.message || payload.error || `Resend error ${resp.status}`);
  return payload;
}

function findClientCode(raw_row: any) {
  const keys = Object.keys(raw_row || {});
  const codeKey = keys.find(k => /client.*code/i.test(k) || /client/i.test(k) || /cliet/i.test(k));
  return codeKey ? String(raw_row[codeKey]).trim() : null;
}

function formatMoney(amount: any) {
  const num = Number(amount);
  if (isNaN(num)) return 'R 0.00';
  return 'R ' + num.toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

async function getSecuritiesData(supabase: any) {
  const { data: secs } = await supabase.from('securities_c').select('symbol,name,logo_url').limit(1000);
  const map: Record<string, any> = {};
  (secs || []).forEach((s: any) => {
    if (s.symbol) {
      map[s.symbol.toUpperCase()] = s;
      map[s.symbol.toUpperCase().replace(/\.JO$/, '')] = s;
    }
  });
  return map;
}

function findPaymentDate(payouts: any[], explicitDate: string | null) {
  if (explicitDate) return explicitDate;
  if (!payouts || !payouts.length) return null;
  for (const p of payouts) {
    const row = p.raw_row || {};
    for (const key of Object.keys(row)) {
      if (/payment\s*date|pay\s*date|date/i.test(key)) {
        const val = row[key];
        if (val != null && String(val).trim() !== '') return val;
      }
    }
  }
  return null;
}

function parsePaymentDate(val: any) {
  if (!val || val === '') return null;
  try {
    const num = Number(val);
    if (!isNaN(num) && num > 20000 && num < 100000) {
      const date = new Date(Math.round((num - 25569) * 86400 * 1000));
      if (!isNaN(date.getTime())) return new Date(date.getFullYear(), date.getMonth(), date.getDate());
    }
    const str = String(val).trim().split('T')[0] ?? '';
    const parts = str.split(/[/\-\.]/);
    if (parts.length === 3) {
      let y: number | undefined, m: number | undefined, d: number | undefined;
      if (parts[0]!.length === 4) {
        y = Number(parts[0]); m = Number(parts[1]) - 1; d = Number(parts[2] ?? '');
      } else if ((parts[2] ?? '').length === 4) {
        y = Number(parts[2] ?? ''); m = Number(parts[1]) - 1; d = Number(parts[0]);
      } else {
        const fallback = new Date(val);
        if (!isNaN(fallback.getTime())) return fallback;
      }
      if (y != null && !isNaN(y) && m != null && !isNaN(m) && d != null && !isNaN(d)) {
        const parsed = new Date(y, m, d);
        if (!isNaN(parsed.getTime())) return parsed;
      }
    }
    const nat = new Date(val);
    if (!isNaN(nat.getTime())) return nat;
  } catch (e) { }
  return null;
}

function getDividendMeta(paymentDateStr: any) {
  let isFuture = false;
  let formattedDate = '';
  const pDate = parsePaymentDate(paymentDateStr);
  if (pDate && !isNaN(pDate.getTime())) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    isFuture = pDate > today;
    formattedDate = pDate.toLocaleDateString('en-ZA', { day: 'numeric', month: 'long', year: 'numeric' });
  }
  const subject = isFuture ? "You've got dividends coming up" : "Your investments are paying you";
  return { isFuture, formattedDate, subject, parsedDate: pDate };
}

function buildEmailHtml(profile: any, payouts: any[], securitiesMap: any, paymentDate: string | null) {
  const name = profile.is_child ? (profile.parent_name || 'Valued Client') : (profile.first_name || 'Valued Client');
  const effectiveDate = findPaymentDate(payouts, paymentDate);
  const { isFuture, formattedDate, subject } = getDividendMeta(effectiveDate);
  let rowsHtml = '';
  let totalCash = 0;

  payouts.forEach(p => {
    let symbol = (p.security_code || '').toUpperCase();
    const sec = securitiesMap[symbol] || securitiesMap[symbol.replace(/\.JO$/, '')] || {};
    const logo = sec.logo_url || 'https://app.mymint.co.za/icon.png';
    const secName = sec.name ? `${sec.name} (${symbol.replace(/\.JO$/, '')})` : symbol.replace(/\.JO$/, '');
    const amount = Number(p.net_cash) || 0;
    totalCash += amount;

    rowsHtml += `
          <tr>
            <td class="label">
              <div style="display:flex;align-items:center;">
                <img src="${logo}" alt="${symbol}" style="width:20px;height:20px;border-radius:50%;margin-right:8px;vertical-align:middle;">
                ${secName}
              </div>
            </td>
            <td class="num r pos">${formatMoney(amount)}</td>
          </tr>
    `;
  });

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>myMINT Baskets | Dividend Payout</title>
<link href="https://fonts.googleapis.com/css2?family=DM+Serif+Display&family=Outfit:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: 'Outfit', -apple-system, BlinkMacSystemFont, sans-serif;
    background-color: #ECEAF2;
    color: #1A1622;
    -webkit-font-smoothing: antialiased;
    line-height: 1.6;
  }
  .wrapper { max-width: 620px; margin: 0 auto; background: #ffffff; }

  /* HEADER */
  .header { background: #31005E; padding: 44px 44px 38px; }
  .header-logo {
    font-size: 11px; letter-spacing: 4px; color: #DDC357;
    font-weight: 600; text-transform: uppercase; margin-bottom: 26px;
  }
  .header h1 {
    font-family: 'DM Serif Display', Georgia, serif;
    font-size: 33px; color: #ffffff; font-weight: 400;
    line-height: 1.15; letter-spacing: -0.3px; margin-bottom: 14px;
  }
  .header-sub { font-size: 14px; color: rgba(255,255,255,0.62); font-weight: 300; }
  .header-meta {
    margin-top: 24px; padding-top: 18px;
    border-top: 1px solid rgba(255,255,255,0.14);
    font-size: 11px; letter-spacing: 2px; color: #DDC357;
    text-transform: uppercase; font-weight: 500;
  }

  /* BODY */
  .body { padding: 40px 44px 8px; }
  .lead {
    font-size: 16px; line-height: 1.7; color: #2C2738;
    font-weight: 300; margin-bottom: 36px;
  }
  .lead strong { font-weight: 600; color: #1A1622; }

  /* SECTION */
  .section { margin-bottom: 38px; }
  .eyebrow {
    font-size: 10px; letter-spacing: 3px; text-transform: uppercase;
    color: #5C3BCF; font-weight: 600; margin-bottom: 10px;
  }
  .section h2 {
    font-family: 'DM Serif Display', Georgia, serif;
    font-size: 23px; font-weight: 400; color: #31005E;
    letter-spacing: -0.2px; margin-bottom: 16px;
  }
  .section p { font-size: 15px; line-height: 1.72; color: #3A3448; margin-bottom: 14px; font-weight: 300; }
  .section p strong { font-weight: 600; color: #1A1622; }

  /* SNAPSHOT TABLE */
  .snap { width: 100%; border-collapse: collapse; margin: 22px 0 4px; }
  .snap th {
    text-align: left; font-size: 10px; letter-spacing: 1.5px;
    text-transform: uppercase; color: #8A8398; font-weight: 600;
    padding: 0 0 10px; border-bottom: 1px solid #E4E0EC;
  }
  .snap th.r, .snap td.r { text-align: right; padding-right: 22px; }
  .snap td {
    padding: 13px 0; border-bottom: 1px solid #F0EDF5;
    font-size: 14px; color: #2C2738; font-weight: 400;
  }
  .snap td.label { font-weight: 500; color: #1A1622; width: 32%; }
  .snap td.num { font-family: 'JetBrains Mono', monospace; font-size: 13px; font-weight: 500; white-space: nowrap; }
  .snap td.neg { color: #B0506A; }
  .snap td.pos { color: #2F7D63; }
  .snap td.ctx { font-size: 12px; color: #8A8398; font-weight: 300; }

  /* CLOSE */
  .close { padding: 36px 44px 8px; }
  .close p { font-size: 15px; line-height: 1.7; color: #3A3448; margin-bottom: 14px; font-weight: 300; }
  .close a { color: #5C3BCF; text-decoration: none; font-weight: 500; }
  .sign { margin-top: 22px; font-size: 15px; }
  .sign .name { font-weight: 600; color: #1A1622; }
  .sign .meta { font-size: 13px; color: #8A8398; font-weight: 300; }

  /* FOOTER */
  .footer { padding: 30px 44px 36px; border-top: 1px solid #EEEBF3; }
  .footer-brand { font-size: 13px; letter-spacing: 3px; color: #31005E; font-weight: 700; margin-bottom: 8px; }
  .footer-line { font-size: 11px; color: #9A93A8; font-weight: 300; line-height: 1.7; }
  .disclaimer { font-size: 10.5px; color: #B4AEC0; margin-top: 16px; line-height: 1.6; font-weight: 300; }
</style>
</head>
<body>
<div class="wrapper">

  <!-- HEADER -->
  <div class="header">
    <div class="header-logo">MINT Platforms</div>
    <h1>${subject}</h1>
    <p class="header-sub">${isFuture
      ? `We have processed upcoming dividend payouts for your portfolio, scheduled for ${formattedDate || 'soon'}.`
      : 'We have successfully processed dividend payouts for your portfolio.'
    }</p>
    <div class="header-meta">myMINT BASKETS &middot; INVESTOR STATEMENT &middot; ${new Date().toLocaleString('en-US', { month: 'long', year: 'numeric' }).toUpperCase()}${profile.is_child ? ' <span style="background: #DDC357; color: #31005E; padding: 2px 6px; border-radius: 4px; margin-left: 8px; font-weight: 700;">CHILD ACCOUNT</span>' : ''}</div>
  </div>

  <!-- BODY -->
  <div class="body">

    <p class="lead">Hi ${name},<br><br>${profile.is_child
      ? `When you started investing in ${profile.first_name}'s future with myMINT, you became a part-owner of real assets. And owners get paid.`
      : "When you started investing with myMINT, you became a part-owner of real assets. And owners get paid."
    }<br><br>${isFuture
      ? `The companies in your basket have declared upcoming dividends. Here is what you will be earning${formattedDate ? ` on <strong>${formattedDate}</strong>` : ''}:`
      : "Since you started investing, here is what has been earned:"
    }</p>

    <!-- TABLE -->
    <div class="section">
      <h2>${isFuture ? 'UPCOMING DIVIDENDS' : 'COMPANY DIVIDENDS EARNED'}</h2>
      <table class="snap">
        <thead>
          <tr>
            <th>COMPANY</th>
            <th class="r">Amount</th>
          </tr>
        </thead>
        <tbody>
          ${rowsHtml}
          <tr>
            <td class="label" style="padding-top:20px; font-weight:700;">${isFuture ? 'Total upcoming payout' : 'Total earned since investing'}</td>
            <td class="num r pos" style="padding-top:20px; font-size: 16px; font-weight:800; color:#31005E;">${formatMoney(totalCash)}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>

  <!-- CLOSE -->
  <div class="close">
    <p>${isFuture
      ? `Every cent will be automatically credited to ${profile.is_child ? `${profile.first_name}'s` : 'your'} myMINT account on the payment date. No forms, no waiting, no admin. That is what ownership looks like: money working quietly in the background while you get on with life.<br><br>And this is just the beginning. The more ${profile.is_child ? profile.first_name : 'you'} own${profile.is_child ? 's' : ''}, the larger the share of any future distributions these holdings pay out.`
      : `Every cent has been credited to ${profile.is_child ? `${profile.first_name}'s` : 'your'} myMINT account, automatically. No forms, no waiting, no admin. That is what ownership looks like: money working quietly in the background while you get on with life.<br><br>And this is just the beginning. The more ${profile.is_child ? profile.first_name : 'you'} own${profile.is_child ? 's' : ''}, the larger the share of any future distributions these holdings pay out.`
    }</p>
    <a href="https://app.mymint.co.za">Grow my portfolio &rarr;</a>
  </div>

  <!-- FOOTER -->
  <div class="footer">
    <div class="footer-brand">MINT PLATFORMS</div>
    <div class="footer-line">FSP 55118 &nbsp;|&nbsp; NCRCP22892 &nbsp;|&nbsp; Reg. 2024/644796/07</div>
    <div class="footer-line">3 Gwen Lane, Sandown, Sandton, Johannesburg</div>
    <div class="footer-line">support@mymint.co.za &nbsp;|&nbsp; www.mymint.co.za</div>
    <div class="disclaimer">
      <p>myMINT is a product of MINT Platforms (Pty) Ltd, an authorised financial services provider (FSP 55118). Distributions depend on the performance of the underlying holdings and are not guaranteed, and the value of investments can go down as well as up.</p>
      <p>This communication is an automated notification and does not constitute investment advice.</p>
    </div>
  </div>

</div>
</body>
</html>`;
}

export async function GET(req: Request) {
  return handleEmailRequest(req, 'GET');
}

export async function POST(req: Request) {
  return handleEmailRequest(req, 'POST');
}

async function handleEmailRequest(req: Request, method: string) {
  try {
    const authClient = await createSupabaseServerClient();
    const { data: { user } } = await authClient.auth.getUser();

    if (!user) {
      return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
    }

    const url = new URL(req.url);
    const searchParams = url.searchParams;
    let body: any = {};
    if (method === 'POST') {
      try { body = await req.json(); } catch (e) { }
    }

    const runId = searchParams.get('run_id') || body?.run_id;
    const clientCode = searchParams.get('client_code') || body?.client_code;

    if (!runId) return NextResponse.json({ ok: false, error: 'run_id is required' }, { status: 400 });

    const supabase = createRetailServiceRoleClient();

    const payouts = await getPayouts(Number(runId), 5000);
    if (!payouts || !payouts.length) {
      return NextResponse.json({ ok: false, error: 'No payouts found for this run' }, { status: 404 });
    }

    const grouped: Record<string, any[]> = {};
    payouts.forEach(p => {
      const code = findClientCode(p.raw_row);
      if (code) {
        if (!grouped[code]) grouped[code] = [];
        grouped[code].push(p);
      }
    });

    const clientCodes = Object.keys(grouped);
    if (clientCodes.length === 0) {
      return NextResponse.json({ ok: false, error: 'Could not find Client Code in any row' }, { status: 400 });
    }

    // 3. Fetch profiles and family members
    const { data: profilesData } = await supabase.from('profiles').select('id,computershare_number,email,first_name').in('computershare_number', clientCodes);
    const { data: fmData } = await supabase.from('family_members').select('id,computershare_number,first_name,primary_user_id').in('computershare_number', clientCodes);

    const parentIds = (fmData || []).map(fm => fm.primary_user_id).filter(Boolean);
    let parentProfiles: any[] = [];
    if (parentIds.length > 0) {
      const { data: pp } = await supabase.from('profiles').select('id,email,first_name').in('id', parentIds);
      parentProfiles = pp || [];
    }

    const profileMap: Record<string, any> = {};
    (profilesData || []).forEach(p => {
      if (p.computershare_number) {
        profileMap[p.computershare_number] = { ...p, is_child: false };
      }
    });

    const parentProfileMap: Record<string, any> = {};
    (parentProfiles || []).forEach(p => {
      parentProfileMap[p.id] = p;
    });

    (fmData || []).forEach(fm => {
      if (fm.computershare_number && fm.primary_user_id) {
        const parent = parentProfileMap[fm.primary_user_id];
        if (parent) {
          profileMap[fm.computershare_number] = {
            first_name: fm.first_name,
            email: parent.email,
            is_child: true,
            parent_name: parent.first_name
          };
        }
      }
    });

    const securitiesMap = await getSecuritiesData(supabase);

    let sentCodes: string[] = [];
    let currentRunSentCodes: string[] = [];
    let paymentDate: string | null = null;
    let runFileName: string | null = null;

    try {
      const { data: runData } = await supabase.from('dividend_runs').select('file_name,sent_client_codes,payment_date').eq('id', Number(runId));
      if (runData && runData[0]) {
        if (runData[0].sent_client_codes) {
          currentRunSentCodes = Array.isArray(runData[0].sent_client_codes) ? runData[0].sent_client_codes : [];
          sentCodes = [...currentRunSentCodes];
        }
        if (runData[0].payment_date) paymentDate = runData[0].payment_date;
        if (runData[0].file_name) runFileName = runData[0].file_name;
      }
    } catch (e) { }

    if (!paymentDate) {
      paymentDate = findPaymentDate(payouts, null);
    }

    if (paymentDate) {
      let dateStrForQuery = paymentDate;
      const parsed = parsePaymentDate(paymentDate);
      if (parsed && !isNaN(parsed.getTime())) {
        const y = parsed.getFullYear();
        const m = String(parsed.getMonth() + 1).padStart(2, '0');
        const d = String(parsed.getDate()).padStart(2, '0');
        dateStrForQuery = `${y}-${m}-${d}`;
      }
      try {
        const { data: dateRuns } = await supabase.from('dividend_runs').select('sent_client_codes').eq('payment_date', dateStrForQuery).neq('id', Number(runId));
        (dateRuns || []).forEach((r: any) => {
          if (r.sent_client_codes && Array.isArray(r.sent_client_codes)) {
            sentCodes.push(...r.sent_client_codes);
          }
        });
      } catch (subErr) { }
    }

    if (runFileName && runFileName.trim() !== '' && runFileName !== 'unknown') {
      try {
        const { data: fileRuns } = await supabase.from('dividend_runs').select('sent_client_codes').eq('file_name', runFileName).neq('id', Number(runId));
        (fileRuns || []).forEach((r: any) => {
          if (r.sent_client_codes && Array.isArray(r.sent_client_codes)) {
            sentCodes.push(...r.sent_client_codes);
          }
        });
      } catch (subErr) { }
    }
    sentCodes = Array.from(new Set(sentCodes));

    async function appendSentClientCodes(codesArray: string[]) {
      if (!codesArray || !codesArray.length) return;
      currentRunSentCodes = Array.from(new Set([...currentRunSentCodes, ...codesArray]));
      sentCodes = Array.from(new Set([...sentCodes, ...codesArray]));
      try {
        await supabase.from('dividend_runs').update({ sent_client_codes: currentRunSentCodes }).eq('id', Number(runId));
      } catch (e: any) {
        console.error('Failed to update sent_client_codes', e.message);
      }
    }

    // ── GET: Preview Email ──────────────────────────────────────────────
    if (method === 'GET') {
      const allClients = clientCodes.map(c => {
        const p = profileMap[c];
        return {
          client_code: c,
          first_name: p ? p.first_name : 'Unknown',
          email: p ? p.email : null,
          has_profile: !!p,
          has_sent: sentCodes.includes(c)
        };
      });

      const { subject } = getDividendMeta(paymentDate);

      if (clientCode) {
        if (!profileMap[clientCode]) {
          return NextResponse.json({ ok: false, error: 'Profile not found for this code' }, { status: 400 });
        }
        const profile = profileMap[clientCode];
        const userPayouts = grouped[clientCode];
        const html = buildEmailHtml(profile, userPayouts ?? [], securitiesMap, paymentDate);
        return NextResponse.json({ ok: true, html, subject, profile, count: (userPayouts ?? []).length, allClients });
      }

      const previewCode = clientCodes.find(c => profileMap[c]);
      if (!previewCode) {
        return NextResponse.json({ ok: false, error: 'Could not match any Client Code to a profile. Ensure client codes exist in the Mint database.', allClients }, { status: 400 });
      }

      const profile = profileMap[previewCode];
      const userPayouts = grouped[previewCode];
      const html = buildEmailHtml(profile, userPayouts ?? [], securitiesMap, paymentDate);

      return NextResponse.json({ ok: true, html, subject, profile, count: (userPayouts ?? []).length, allClients, previewCode });
    }

    // ── POST: Send Emails ─────────────────────────────────────────────
    if (method === 'POST') {
      let { testEmail, sendAll } = body || {};

      const { subject } = getDividendMeta(paymentDate);

      if (testEmail) {
        const targetCode = clientCode || clientCodes.find(c => profileMap[c]);
        const profile = targetCode ? profileMap[targetCode] : { first_name: 'Test', email: testEmail };
        const userPayouts = targetCode ? grouped[targetCode] : payouts.slice(0, 3);

        const html = buildEmailHtml(profile, userPayouts ?? [], securitiesMap, paymentDate);
        await sendViaResend({ to: testEmail, subject, html });
        return NextResponse.json({ ok: true, message: 'Test email sent successfully' });
      }

      if (clientCode && !sendAll) {
        const profile = profileMap[clientCode];
        if (!profile || !profile.email) return NextResponse.json({ ok: false, error: 'No email found for this client code' }, { status: 400 });
        if (sentCodes.includes(clientCode)) return NextResponse.json({ ok: false, error: 'Email already sent to this user for this run' }, { status: 400 });

        const userPayouts = grouped[clientCode];
        const html = buildEmailHtml(profile, userPayouts ?? [], securitiesMap, paymentDate);
        try {
          await sendViaResend({ to: profile.email, subject, html });
          await appendSentClientCodes([clientCode]);
          await writeAudit(supabase, {
            action: 'send_dividend_emails_single',
            target_email: profile.email,
            target_member_id: clientCode,
            actor_email: user.email,
            actor_user_id: user.id,
            details: { run_id: runId, client_code: clientCode }
          });
          return NextResponse.json({ ok: true, message: 'Email sent successfully' });
        } catch (e: any) {
          return NextResponse.json({ ok: false, error: e.message }, { status: 500 });
        }
      }

      if (sendAll) {
        let sent = 0;
        let failed = 0;
        let newlySentCodes: string[] = [];

        for (const code of clientCodes) {
          if (sentCodes.includes(code)) continue;

          const profile = profileMap[code];
          if (!profile || !profile.email) {
            failed++;
            continue;
          }

          const userPayouts = grouped[code];
          const html = buildEmailHtml(profile, userPayouts ?? [], securitiesMap, paymentDate);

          try {
            await sendViaResend({ to: profile.email, subject, html });
            sent++;
            newlySentCodes.push(code);
          } catch (e) {
            failed++;
          }
        }

        if (newlySentCodes.length > 0) {
          await appendSentClientCodes(newlySentCodes);
        }

        await writeAudit(supabase, {
          action: 'send_dividend_emails_bulk',
          target_email: user.email,
          target_member_id: null,
          actor_email: user.email,
          actor_user_id: user.id,
          details: { run_id: runId, sent, failed, newlySentCodes }
        });

        return NextResponse.json({ ok: true, sent, failed, newlySentCodes });
      }

      return NextResponse.json({ ok: false, error: 'Invalid payload' }, { status: 400 });
    }

    return NextResponse.json({ ok: false, error: 'Method not allowed' }, { status: 405 });
  } catch (err: any) {
    console.error('[dividends-email]', err.message);
    return NextResponse.json({ ok: false, error: err.message }, { status: 500 });
  }
}
