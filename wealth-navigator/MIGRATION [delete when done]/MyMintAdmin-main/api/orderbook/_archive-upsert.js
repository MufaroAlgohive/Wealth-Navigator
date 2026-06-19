const { sendJson, fetchSupabaseJson, requestSupabaseJson } = require('../_orderbook');

const toRunDate = (value) => {
  const text = String(value || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) return null;
  return `${parsed.getFullYear()}-${String(parsed.getMonth() + 1).padStart(2, '0')}-${String(parsed.getDate()).padStart(2, '0')}`;
};

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return sendJson(res, 405, { error: 'Method not allowed' });
  }

  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : null;
  if (!token) {
    return sendJson(res, 401, { error: 'Missing Authorization bearer token' });
  }

  try {
    await fetchSupabaseJson('/auth/v1/user', token, false);

    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const snapshot = body?.snapshot && typeof body.snapshot === 'object' ? body.snapshot : null;
    if (!snapshot) {
      return sendJson(res, 400, { error: 'Missing snapshot payload' });
    }

    const runDate = toRunDate(snapshot.dateKey || snapshot.runDate || snapshot.createdAt);
    if (!runDate) {
      return sendJson(res, 400, { error: 'Invalid snapshot date' });
    }

    const sequence = Number(snapshot.sequence || 0) || 1;
    const rows = Array.isArray(snapshot.rows) ? snapshot.rows : [];
    const status = snapshot.emailStatus === 'sent'
      ? 'sent'
      : (snapshot.emailStatus === 'failed' ? 'failed' : 'pending');

    const upsertBody = {
      run_date: runDate,
      status,
      row_count: rows.length,
      sequence_number: sequence,
      title: snapshot.title || `Order Book ${sequence}`,
      date_label: snapshot.dateLabel || null,
      snapshot_rows: rows,
      error_message: snapshot.emailError || null,
      last_attempt_at: new Date().toISOString(),
      ...(status === 'sent' ? { sent_at: new Date().toISOString() } : {})
    };

    await requestSupabaseJson(
      '/rest/v1/orderbook_email_runs?on_conflict=run_date,sequence_number',
      {
        method: 'POST',
        body: upsertBody,
        extraHeaders: {
          'Prefer': 'resolution=merge-duplicates,return=representation'
        }
      }
    );

    return sendJson(res, 200, { ok: true });
  } catch (error) {
    return sendJson(res, 500, {
      error: 'Could not upsert orderbook archive',
      details: error?.message || 'Unknown error'
    });
  }
};
