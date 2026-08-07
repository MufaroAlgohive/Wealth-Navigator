import { NextResponse } from 'next/server';
import * as XLSX from 'xlsx';
import { OfficeFile, DecryptionError } from 'office-crypto';
import { saveRun } from '@/lib/dividends-db';

export async function POST(req: Request) {
  try {
    const formData = await req.formData();
    const file = formData.get('file') as File | null;
    const password = formData.get('password') as string || '';
    let paymentDate = formData.get('date') as string || '';

    if (!file) {
      return NextResponse.json({ ok: false, error: 'No file received' }, { status: 400 });
    }

    const arrayBuffer = await file.arrayBuffer();
    const fileBuffer = Buffer.from(arrayBuffer);
    const fileName = file.name || 'upload.xlsx';

    // 1. Decrypt if password-protected
    let parseBuffer = fileBuffer;
    if (password) {
      try {
        const officeFile = OfficeFile(new Uint8Array(fileBuffer));
        officeFile.loadKey({ password });
        const decrypted = officeFile.decrypt();
        parseBuffer = Buffer.from(decrypted);
      } catch (err: any) {
        const isWrongPwd = err instanceof DecryptionError || /password|key|verify|invalid/i.test(err.message || '');
        const userMsg = isWrongPwd
          ? 'Decryption failed. Please verify the password.'
          : `Could not decrypt file: ${err.message}`;
        try { await saveRun({ file_name: fileName, payment_date: paymentDate || null, records: 0, status: 'error', error_message: userMsg }, []); } catch (_) {}
        return NextResponse.json({ ok: false, error: userMsg }, { status: 422 });
      }
    }

    // 2. Parse Workbook
    let workbook;
    try {
      workbook = XLSX.read(parseBuffer, { type: 'buffer' });
    } catch (err: any) {
      const userMsg = `File could not be parsed: ${err.message}`;
      try { await saveRun({ file_name: fileName, payment_date: paymentDate || null, records: 0, status: 'error', error_message: userMsg }, []); } catch (_) {}
      return NextResponse.json({ ok: false, error: userMsg }, { status: 422 });
    }

    const sheetNames = workbook.SheetNames;
    if (!sheetNames.length) {
      return NextResponse.json({ ok: false, error: 'Workbook contains no sheets' }, { status: 422 });
    }
    const sheet = workbook.Sheets[sheetNames[0]!]!;

    // 3. Hunt for the real header row
    const rawData = XLSX.utils.sheet_to_json(sheet!, { header: 1, defval: '' }) as string[][];
    let headerRowIndex = 0;
    for (let i = 0; i < Math.min(rawData.length, 20); i++) {
      const rowStr = (rawData[i] ?? []).join(' ').toUpperCase();
      if ((rowStr.includes('CLIENT') || rowStr.includes('CLIET')) && (rowStr.includes('CODE') || rowStr.includes('CASH') || rowStr.includes('AMOUNT') || rowStr.includes('NETT'))) {
        headerRowIndex = i;
        break;
      }
    }

    const rows = XLSX.utils.sheet_to_json(sheet!, { range: headerRowIndex, defval: '' }) as Record<string, any>[];

    if (!rows.length) {
      return NextResponse.json({ ok: false, error: 'Sheet is empty or has no data rows' }, { status: 422 });
    }

    const headers = rows[0] ? Object.keys(rows[0]) : [];

    // 4. Detect columns
    const NET_PATTERNS = [/net\s*cash/i, /net_cash/i, /nett\s*cash/i, /amount/i, /payout/i, /dividend/i];
    const netCashCol = headers.find((h) => NET_PATTERNS.some((p) => p.test(h))) || null;

    const SEC_PATTERNS = [/security\s*code/i, /isin/i, /ticker/i, /symbol/i, /code/i, /jse/i];
    const secCol = headers.find((h) => SEC_PATTERNS.some((p) => p.test(h))) || null;

    // 5. Extract & sanitize rows
    function parseSaAmount(raw: any) {
      if (typeof raw === 'number') return raw;
      if (raw == null || raw === '') return NaN;
      let s = String(raw).replace(/R|\s/gi, ''); 
      if (s.includes(',') && !s.includes('.')) {
        s = s.replace(',', '.');          
      } else if (s.includes(',') && s.includes('.')) {
        s = s.replace(/,/g, '');          
      }
      return parseFloat(s);
    }

    let totalNetCash = 0;
    let unmatchedCount = 0;
    const extractedRows = [];

    for (const row of rows) {
      const firstVal = String(row[headers[0] ?? ''] ?? '').toUpperCase().trim();
      if (firstVal === '' || firstVal.includes('TOTAL') || firstVal.includes('CONFIDENTIAL')) continue;
      if (firstVal === String(headers[0]).toUpperCase().trim()) continue;

      const clientValKey = Object.keys(row).find(k => /client.*code/i.test(k) || /client/i.test(k) || /cliet/i.test(k));
      const clientVal = clientValKey ? String(row[clientValKey]).toUpperCase().trim() : '';
      if (clientVal === 'CLIENT' || clientVal === 'CLIET' || clientVal === 'CLIENT CODE') continue;

      const n = netCashCol ? parseSaAmount(row[netCashCol]) : NaN;
      if (!isNaN(n)) totalNetCash += n;

      const secCode = secCol ? String(row[secCol]).trim() : '';
      if (!secCode || !/^[A-Z0-9]{3,12}$/i.test(secCode)) unmatchedCount++;

      extractedRows.push({
        security_code: secCode,
        net_cash: isNaN(n) ? 0 : n,
        raw_row: row,
      });
    }

    totalNetCash = Math.round(totalNetCash * 100) / 100;
    const previewRows = extractedRows.map(r => r.raw_row).slice(0, 20);

    // Attempt to detect and parse payment date
    if (!paymentDate && extractedRows.length > 0) {
      for (const item of extractedRows) {
        const row = item.raw_row || {};
        for (const key of Object.keys(row)) {
          if (/payment\s*date|pay\s*date|date/i.test(key)) {
            const val = row[key];
            if (val != null && String(val).trim() !== '') {
              try {
                let pDate: Date | null = null;
                const num = Number(val);
                if (!isNaN(num) && num > 20000 && num < 100000) {
                  const d = new Date(Math.round((num - 25569) * 86400 * 1000));
                  if (!isNaN(d.getTime())) pDate = d;
                } else {
                  const str = String(val).trim().split('T')[0] ?? '';
                  const parts = str.split(/[/\-\.]/);
                  if (parts.length === 3) {
                    let y = Number(parts[0]!.length === 4 ? parts[0] : (parts[2] ?? ''));
                    let m = Number(parts[1]) - 1;
                    let d = Number(parts[0]!.length === 4 ? (parts[2] ?? '') : parts[0]);
                    if (!isNaN(y) && !isNaN(m) && !isNaN(d)) {
                      const parsed = new Date(Date.UTC(y, m, d));
                      if (!isNaN(parsed.getTime())) pDate = parsed;
                    }
                  }
                  if (!pDate) {
                    const nat = new Date(val);
                    if (!isNaN(nat.getTime())) pDate = nat;
                  }
                }
                if (pDate) {
                  const yy = pDate.getUTCFullYear() || pDate.getFullYear();
                  const mm = String((pDate.getUTCMonth() >= 0 ? pDate.getUTCMonth() : pDate.getMonth()) + 1).padStart(2, '0');
                  const dd = String(pDate.getUTCDate() || pDate.getDate()).padStart(2, '0');
                  paymentDate = `${yy}-${mm}-${dd}`;
                  break;
                }
              } catch (e) {
                // ignore
              }
            }
          }
        }
        if (paymentDate) break;
      }
    }

    // 4. Save metadata + staging rows
    let savedRun = null;
    try {
      savedRun = await saveRun({
        file_name: fileName,
        payment_date: paymentDate || null,
        records: extractedRows.length,
        total_net_cash: totalNetCash,
        unmatched_count: unmatchedCount,
        net_cash_col: netCashCol,
        sheet_names: sheetNames,
        headers,
        status: 'success',
      }, extractedRows);
    } catch (dbErr: any) {
      console.error('[dividends-extract] DB save failed:', dbErr.message);
    }

    return NextResponse.json({
      ok: true,
      records: extractedRows.length,
      totalNetCash,
      unmatchedCount,
      sheetNames,
      headers,
      netCashCol,
      paymentDate: paymentDate || null,
      previewRows,
      runId: savedRun?.id || null,
    });

  } catch (err: any) {
    console.error('[dividends-extract] Error:', err.message);
    return NextResponse.json({ ok: false, error: err.message }, { status: 500 });
  }
}
