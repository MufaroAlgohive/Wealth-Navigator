#!/usr/bin/env node
/**
 * diag_jse_model.mjs
 *
 * One-shot diagnostic for the JSE Alpha / Qentari Bravo JSE model page.
 * Hits the same Supabase tables the BFF reads so we can prove why the UI shows
 * "—" for Starting Capital / Current Value / Total Return / Max DD and why the
 * benchmark panel says "Benchmark bundle unavailable / model not found".
 *
 * Usage:
 *   # 1) Drop your INSTITUTIONAL service-role key + URL in the env below (or
 *   #    export them). The values are read from process.env first, then from
 *   #    live/.env.supabase in the model repo, then from these hard-coded
 *   #    placeholders as a last resort.
 *   # 2) node scripts/diag/diag_jse_model.mjs
 *
 *   # or with explicit env:
 *   $env:SUPABASE_URL="https://nnwzhxfjpjbzujevwzlh.supabase.co"
 *   $env:SUPABASE_KEY="<service-role key>"
 *   node scripts/diag/diag_jse_model.mjs
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SLUG = process.env.MODEL_SLUG || "qentari_bravo_jse";

// ── env loading (process.env → live/.env.supabase → hard-coded defaults) ─────
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MODEL_REPO = path.resolve(
  __dirname,
  "..",
  "..",
  "..",
  "..",
  "E:\\Autonama\\Active Projects\\Algos\\Autonama_Algo\\Qentari Models\\Qentari_Bravo_JSE",
);
const ENV_PATHS = [
  path.join(MODEL_REPO, "live", ".env.supabase"),
  path.join(MODEL_REPO, "live", ".env.qentari_bravo_jse"),
];

function loadEnvFile(p) {
  if (!fs.existsSync(p)) return;
  for (const raw of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const k = line.slice(0, eq).trim();
    let v = line.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (!(k in process.env)) process.env[k] = v;
  }
}
ENV_PATHS.forEach(loadEnvFile);

const URL =
  process.env.SUPABASE_URL ||
  process.env.INSTITUTIONAL_SUPABASE_URL ||
  "https://nnwzhxfjpjbzujevwzlh.supabase.co";
const KEY =
  process.env.SUPABASE_KEY ||
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.INSTITUTIONAL_SUPABASE_SERVICE_ROLE_KEY ||
  "<PASTE INSTITUTIONAL SERVICE-ROLE KEY HERE>";

if (!URL || !KEY || KEY.startsWith("<")) {
  console.error("✗ Missing SUPABASE_URL or SUPABASE_KEY.");
  console.error("  Set them in env, in live/.env.supabase, or paste below.");
  process.exit(1);
}

const REST = `${URL.replace(/\/$/, "")}/rest/v1`;
const HEADERS = {
  apikey: KEY,
  Authorization: `Bearer ${KEY}`,
  "Content-Type": "application/json",
};

// ── tiny REST helper (matches what supabase_pusher.py does) ──────────────────
async function get(table, query = "") {
  const u = `${REST}/${table}${query ? `?${query}` : ""}`;
  const r = await fetch(u, { headers: HEADERS });
  const text = await r.text();
  if (!r.ok) throw new Error(`GET ${table} → ${r.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

async function getMaybeSingle(table, query) {
  const rows = await get(table, `${query}&limit=1`);
  return rows[0] ?? null;
}

function pick(row, keys) {
  if (!row) return undefined;
  const out = {};
  for (const k of keys) out[k] = row[k];
  return out;
}

const fmt = (v) => (v === null || v === undefined ? "—" : String(v));
const num = (v) =>
  typeof v === "number" && Number.isFinite(v)
    ? v.toFixed(4).replace(/\.?0+$/, "")
    : "—";
const pct = (v) =>
  typeof v === "number" && Number.isFinite(v) ? `${(v * 100).toFixed(2)}%` : "—";

// ── 1. registry ─────────────────────────────────────────────────────────────
console.log(`\n═══ JSE model diagnostic · slug='${SLUG}' · URL=${URL} ═══\n`);

const reg = await getMaybeSingle(
  "model_registry_c",
  `select=*&slug=eq.${encodeURIComponent(SLUG)}`,
);
if (!reg) {
  console.error(`✗ No row in model_registry_c for slug='${SLUG}'.`);
  console.error("  → run: python -m scripts.push_to_supabase register");
  process.exit(2);
}

console.log("1) model_registry_c");
console.table(
  pick(reg, [
    "slug",
    "name",
    "strategy_name",
    "market",
    "universe",
    "data_source",
    "currency",
    "mode",
    "status",
    "budget",
    "last_heartbeat_at",
    "last_run_at",
  ]),
);

// ── 2. metrics ──────────────────────────────────────────────────────────────
const metrics = await get(
  "model_metric_c",
  `select=model_slug,kind,label,as_of,budget,final_equity,total_return,max_drawdown,start_date,end_date&model_slug=eq.${encodeURIComponent(SLUG)}&order=as_of.desc&limit=20`,
);
console.log(`\n2) model_metric_c (${metrics.length} rows)`);
if (metrics.length === 0) {
  console.log("  (none) — UI shows '—' for everything in Demo Account KPIs.");
} else {
  for (const m of metrics) {
    console.log(
      `  • kind=${m.kind.padEnd(8)} label=${(m.label ?? "").padEnd(24)} as_of=${m.as_of}  budget=${fmt(m.budget)}  equity=${fmt(m.final_equity)}  total_return=${pct(m.total_return)}  max_dd=${pct(m.max_drawdown)}`,
    );
  }
}

// ── 3. equity curve (this is what feeds Paper Equity + benchmark) ───────────
const eqAll = await get(
  "model_equity_point_c",
  `select=kind,label,ts,equity,cash,day_pnl,day_pnl_pct&model_slug=eq.${encodeURIComponent(SLUG)}&order=ts.asc&limit=5000`,
);
const byKind = {};
for (const p of eqAll) (byKind[p.kind] ??= []).push(p);

console.log(`\n3) model_equity_point_c (${eqAll.length} total rows)`);
console.log("  by kind:", Object.fromEntries(Object.entries(byKind).map(([k, v]) => [k, v.length])));

for (const [kind, rows] of Object.entries(byKind)) {
  if (rows.length === 0) continue;
  const first = rows[0];
  const last = rows[rows.length - 1];
  console.log(
    `  • kind=${kind.padEnd(8)} label=${(first.label ?? "").padEnd(20)} count=${String(rows.length).padStart(4)}  first=${first.ts}  last=${last.ts}  first_eq=${fmt(first.equity)}  last_eq=${fmt(last.equity)}`,
  );
}

const paperish = byKind.paper ?? byKind.live ?? [];
if (paperish.length < 2) {
  console.log(
    "\n  ⚠ No 'paper' or 'live' equity points → /api/models/[id]/benchmark returns",
  );
  console.log("    404 'model not found' is the registry check failing on a DIFFERENT");
  console.log("    reason (see §6) and the page's Paper Equity chart is empty.");
}

// ── 4. positions ────────────────────────────────────────────────────────────
const pos = await get(
  "model_position_c",
  `select=model_slug,snapshot_at,symbol,qty,avg_entry_price,market_value,unrealized_pl,unrealized_plpc,side&model_slug=eq.${encodeURIComponent(SLUG)}&order=snapshot_at.desc&limit=200`,
);
console.log(`\n4) model_position_c (${pos.length} rows)`);
if (pos.length) {
  const latest = pos[0];
  const same = pos.filter((p) => p.snapshot_at === latest.snapshot_at);
  console.log(`  latest snapshot_at=${latest.snapshot_at} (${same.length} positions)`);
  for (const p of same) {
    console.log(
      `    ${p.symbol.padEnd(8)} qty=${fmt(p.qty)} entry=${fmt(p.avg_entry_price)} mkt=${fmt(p.market_value)} upnl=${fmt(p.unrealized_pl)} side=${p.side ?? "—"}`,
    );
  }
} else {
  console.log("  (none) — UI shows 'No open positions'.");
}

// ── 5. trades + recent runs ─────────────────────────────────────────────────
const trades = await get(
  "model_trade_c",
  `select=model_slug,kind,label,trade_id,symbol,side,qty,entry_price,exit_price,entry_at,exit_at,realized_pnl,fees,trade_date,pnl,price,reason&model_slug=eq.${encodeURIComponent(SLUG)}&order=exit_at.desc&limit=20`,
);
console.log(`\n5) model_trade_c (${trades.length} recent rows)`);
if (trades.length) {
  const byKindT = {};
  for (const t of trades) (byKindT[t.kind] ??= []).push(t);
  console.log("  by kind:", Object.fromEntries(Object.entries(byKindT).map(([k, v]) => [k, v.length])));
  for (const t of trades.slice(0, 5)) {
    console.log(
      `  • kind=${t.kind}  ${t.symbol ?? "—"}  ${t.side ?? "—"}  qty=${fmt(t.qty)}  px=${fmt(t.exit_price ?? t.price ?? t.entry_price)}  pnl=${fmt(t.realized_pnl ?? t.pnl)}  exit_at=${t.exit_at ?? t.trade_date ?? "—"}`,
    );
  }
} else {
  console.log("  (none).");
}

const runs = await get(
  "model_run_c",
  `select=model_slug,kind,status,rows_pushed,created_at,message&model_slug=eq.${encodeURIComponent(SLUG)}&order=created_at.desc&limit=10`,
);
console.log(`\n6) model_run_c (${runs.length} recent rows)`);
for (const r of runs) {
  console.log(
    `  • ${r.created_at}  kind=${r.kind}  status=${r.status}  rows=${fmt(r.rows_pushed)}  msg=${(r.message ?? "").slice(0, 80)}`,
  );
}

// ── 6. exactly what /api/models/[id]/benchmark does (404 check) ────────────
// The benchmark route fetches: select=slug,currency,benchmark
const benchSel = await getMaybeSingle(
  "model_registry_c",
  `select=slug,currency,benchmark&slug=eq.${encodeURIComponent(SLUG)}`,
);
console.log(`\n7) benchmark route registry check (select=slug,currency,benchmark)`);
console.log(`   ${benchSel ? "✓ row found" : "✗ NO ROW → returns 'model not found' (404)"}`);
if (benchSel) console.table(benchSel);

// ── 7. verdict ──────────────────────────────────────────────────────────────
console.log("\n═══ VERDICT ═══");
const issues = [];

if (!reg.budget) issues.push(`registry.budget is null (UI 'Starting Capital = —')`);
if (!metrics.find((m) => m.kind === "live" || m.kind === "paper")) {
  issues.push(`no 'live' or 'paper' row in model_metric_c (UI 'Current Value / Total Return / Max DD = —')`);
}
if (paperish.length < 2) {
  issues.push(`<2 paper-equity points (Paper Equity chart empty + benchmark route falls back to 'unavailable')`);
}
if (!benchSel) {
  issues.push(`/api/models/[id]/benchmark: select=slug,currency,benchmark returns 0 rows → 404 'model not found'`);
}
if (pos.length === 0) {
  issues.push(`no model_position_c rows (Current Holdings empty)`);
}
if (!metrics.find((m) => m.kind === "backtest")) {
  issues.push(`no backtest metric row (Backtest KPIs empty)`);
}

if (issues.length === 0) {
  console.log("✓ All rows look healthy. The dashboard should be populated.");
} else {
  console.log("Likely root causes:\n");
  for (const i of issues) console.log(`  • ${i}`);
}
console.log("");