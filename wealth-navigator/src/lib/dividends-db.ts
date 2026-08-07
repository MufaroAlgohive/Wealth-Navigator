import { createInstitutionalServiceRoleClient } from "@/lib/supabase/server";

export async function saveRun(data: any, extractedRows: any[] = []) {
  const supabase = createInstitutionalServiceRoleClient();
  
  const { data: inserted, error: runError } = await supabase.from('dividend_runs').insert({
    file_name: data.file_name || 'unknown.xlsx',
    payment_date: data.payment_date || null,
    records: data.records || 0,
    total_net_cash: data.total_net_cash != null ? data.total_net_cash : null,
    unmatched_count: data.unmatched_count != null ? data.unmatched_count : null,
    net_cash_col: data.net_cash_col || null,
    sheet_names: data.sheet_names || null,
    headers: data.headers || null,
    status: data.status || 'success',
    error_message: data.error_message || null,
  }).select();

  if (runError) throw new Error(`saveRun failed: ${runError.message}`);
  
  const runRecord = Array.isArray(inserted) ? inserted[0] : inserted;

  if (data.status === 'success' && extractedRows.length > 0) {
    const rows = extractedRows.map((row) => ({
      run_id: runRecord.id,
      security_code: row.security_code || null,
      net_cash: row.net_cash,
      raw_row: row.raw_row,
    }));

    const chunk = 200;
    for (let i = 0; i < rows.length; i += chunk) {
      const { error: batchError } = await supabase.from('dividend_payouts_staging').insert(rows.slice(i, i + chunk));
      if (batchError) throw new Error(`saveRun batch failed: ${batchError.message}`);
    }
  }

  return runRecord;
}

export async function getRuns(limit = 50) {
  const supabase = createInstitutionalServiceRoleClient();
  const { data, error } = await supabase.from('dividend_runs').select('*').order('created_at', { ascending: false }).limit(limit);
  if (error) throw new Error(`getRuns failed: ${error.message}`);
  return data;
}

export async function getStats() {
  const supabase = createInstitutionalServiceRoleClient();
  const { data: rows, error } = await supabase.from('dividend_runs').select('records,total_net_cash,status,created_at');
  if (error) throw new Error(`getStats failed: ${error.message}`);

  let total_records = 0;
  let total_net_cash = 0;
  let successful_runs = 0;
  let last_run_at: string | null = null;

  for (const r of rows || []) {
    total_records += Number(r.records) || 0;
    total_net_cash += Number(r.total_net_cash) || 0;
    if (r.status === 'success') successful_runs++;
    if (!last_run_at || (r.created_at && r.created_at > last_run_at)) last_run_at = r.created_at;
  }

  return {
    total_runs: String((rows || []).length),
    total_records: String(total_records),
    total_net_cash: String(total_net_cash),
    successful_runs: String(successful_runs),
    last_run_at,
  };
}

export async function getPayouts(runId: number | string, limit = 2000) {
  const supabase = createInstitutionalServiceRoleClient();
  const { data, error } = await supabase.from('dividend_payouts_staging').select('id,security_code,net_cash,raw_row,created_at').eq('run_id', runId).order('id', { ascending: true }).limit(limit);
  if (error) throw new Error(`getPayouts failed: ${error.message}`);
  return data;
}
