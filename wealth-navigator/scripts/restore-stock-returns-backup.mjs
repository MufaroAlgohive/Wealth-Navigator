import { readFile } from "node:fs/promises";

import { createClient } from "@supabase/supabase-js";

const url = process.env.RETAIL_SUPABASE_URL ?? process.env.SUPABASE_URL;
const key = process.env.RETAIL_SUPABASE_SERVICE_ROLE_KEY
  ?? process.env.SUPABASE_SERVICE_ROLE_KEY
  ?? process.env.service_role_key;
const backupPath = process.env.STOCK_RETURNS_BACKUP_PATH;
const targetTicker = String(process.env.RESTORE_STOCK_RETURNS_TICKER ?? "").trim().toUpperCase().replace(/\.(JO|JSE)$/i, "");
const apply = process.env.APPLY_STOCK_RETURNS_RESTORE === "1";
if (!url || !key) throw new Error("Retail Supabase service configuration is missing");
if (!backupPath || !targetTicker) throw new Error("STOCK_RETURNS_BACKUP_PATH and RESTORE_STOCK_RETURNS_TICKER are required");

const payload = JSON.parse(await readFile(backupPath, "utf8"));
const rows = (Array.isArray(payload?.rows) ? payload.rows : []).filter(
  (row) => String(row.symbol ?? "").toUpperCase().replace(/\.(JO|JSE)$/i, "") === targetTicker,
);
if (!rows.length) throw new Error(`Backup contains no ${targetTicker} rows`);

const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
const dates = rows.map((row) => row.as_of_date).sort();
const { data: repairRows, error: repairError } = await db
  .from("stock_returns_c")
  .select("id,symbol,as_of_date,fetched_at,current_price")
  .in("symbol", [targetTicker, `${targetTicker}.JO`])
  .gte("fetched_at", payload.manifest.generatedAt)
  .lte("as_of_date", payload.manifest.scope.lastDate);
if (repairError) throw new Error(`Repair-row lookup failed: ${repairError.message}`);
const backupDates = new Set(dates);
const insertedRows = (repairRows ?? []).filter((row) => !backupDates.has(row.as_of_date));

console.log(JSON.stringify({
  apply,
  targetTicker,
  restoreCount: rows.length,
  firstDate: dates[0],
  lastDate: dates.at(-1),
  insertedRepairRowsToDelete: insertedRows.map((row) => ({ id: row.id, date: row.as_of_date, price: row.current_price })),
}, null, 2));

if (apply) {
  const { error: upsertError } = await db.from("stock_returns_c").upsert(rows, { onConflict: "symbol,as_of_date" });
  if (upsertError) throw new Error(`Backup restore failed: ${upsertError.message}`);
  if (insertedRows.length) {
    const { error: deleteError } = await db.from("stock_returns_c").delete().in("id", insertedRows.map((row) => row.id));
    if (deleteError) throw new Error(`Inserted-row cleanup failed: ${deleteError.message}`);
  }
}
