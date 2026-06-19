/**
 * api/_email-logger.js
 * Shared helper to insert a row into the email_logs table.
 * Fails silently if the table doesn't exist yet.
 */

const logEmail = async ({
  emailType,
  recipient,
  subject = null,
  resendId = null,
  status = 'sent',
  triggerSource = 'manual',
  metadata = null,
  errorMessage = null
}) => {
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey  = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) return;

  try {
    const body = {
      email_type:     emailType,
      recipient,
      subject,
      resend_id:      resendId,
      status,
      trigger_source: triggerSource,
      metadata:       metadata || null,
      error_message:  errorMessage || null
    };

    const res = await fetch(`${supabaseUrl}/rest/v1/email_logs`, {
      method: 'POST',
      headers: {
        'apikey':          serviceKey,
        'Authorization':   `Bearer ${serviceKey}`,
        'Content-Type':    'application/json',
        'Prefer':          'return=minimal'
      },
      body: JSON.stringify(body)
    });

    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      if (txt.includes('42P01') || txt.includes('does not exist')) {
        return;
      }
      console.warn('[EmailLogger] Insert failed:', res.status, txt.slice(0, 200));
    }
  } catch (err) {
    console.warn('[EmailLogger] Error:', err.message);
  }
};

module.exports = { logEmail };
