import type { SupabaseClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";

import { getAdminContext } from "@/lib/admin/rbac";
import { isSupabaseSchemaMissing } from "@/lib/bff-reasons";
import { createInstitutionalServiceRoleClient, createRetailServiceRoleClient } from "@/lib/supabase/server";

/**
 * GET /api/admin/orderbook/order-books
 *
 * Lists CRM-style "order books" — one per "Send to Market" release batch
 * (see release-to-market/route.ts, which stamps `payload.order_book_seq`
 * onto every released row and inserts one `oems_order_book` row per
 * batch). `fully_filled` is computed HERE at read time (no cron/poller):
 * true iff the book has at least one member row and every member's
 * current `oems_order_audit.status` is exactly "filled" — a cancelled /
 * rejected / expired / failed member means the book never promotes.
 *
 * Returns: { ok, books: [{ sequence, released_at, released_by,
 *   total_count, filled_count, fully_filled }], notice? }, newest-first.
 */

export const dynamic = "force-dynamic";

export interface MemberAuditRow {
  id: string;
  order_id: string | null;
  client_account: string | null;
  symbol: string | null;
  side: string | null;
  quantity: number | null;
  price_cents: number | null;
  status: string;
  source: string | null;
  payload: Record<string, unknown> | null;
  result_payload: Record<string, unknown> | null;
  updated_at: string | null;
}

export interface BookMember {
  id: string;
  order_id: string | null;
  client_account: string | null;
  symbol: string | null;
  side: string;
  qty: number;
  filled: number;
  status: string;
  order_type: "limit" | "market";
  limit_price_rands: number | null;
  /** Volume-weighted average fill, in RANDS. */
  avg_fill_price_rands: number | null;
  /** filled x avg fill, in RANDS — what the client actually paid/received. */
  value_rands: number | null;
  venue: string | null;
  broker: string | null;
  last_action: string | null;
  filled_at: string | null;
  iress_error: string | null;
}

function num(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v !== "" ? v : null;
}

export function toMember(r: MemberAuditRow): BookMember {
  const p = r.payload ?? {};
  const rp = r.result_payload ?? {};
  const qty = num(r.quantity) ?? 0;
  const filled = num(p.filled) ?? 0;
  // `payload.avgPx` and `result_payload.avgFillPrice` are CENTS (IRESS quotes
  // the JSE in cents; the poller stores the raw value in the DB-canonical
  // unit). `limitPrice` and `arrivalMid` are RANDS. Convert once, here.
  const avgFillCents = num(p.avgPx) ?? num(rp.avgFillPrice);
  const avgFillRands = avgFillCents != null && avgFillCents > 0 ? avgFillCents / 100 : null;
  const limitRands = num(p.limitPrice) ?? (r.price_cents != null ? Number(r.price_cents) / 100 : null);
  const errNo = num(rp.uatErrorNumber) ?? num(rp.errorNumber) ?? num(p.iressErrorNumber);
  const errDesc = str(rp.uatErrorDescription) ?? str(rp.errorDescription) ?? str(p.iressErrorDescription);
  return {
    id: r.id,
    order_id: r.order_id,
    client_account: r.client_account,
    side: (r.side ?? "buy").toUpperCase(),
    symbol: r.symbol,
    qty,
    filled,
    status: r.status,
    order_type: p.order_type === "limit" || limitRands != null ? "limit" : "market",
    limit_price_rands: limitRands,
    avg_fill_price_rands: avgFillRands,
    // Prefer what IRESS reported for the whole order; fall back to qty x price.
    value_rands:
      num(p.orderValueCents) != null
        ? (num(p.orderValueCents) as number) / 100
        : avgFillRands != null
          ? avgFillRands * filled
          : null,
    venue: str(p.destination) ?? str(rp.venue) ?? "JSE",
    broker: str(p.broker) ?? str(rp.broker),
    last_action: str(p.lastAction) ?? str(rp.lastAction),
    filled_at: str(p.lastFillAt) ?? str(rp.lastActionAt) ?? r.updated_at,
    iress_error: errNo != null || errDesc ? `${errNo ?? "?"}: ${errDesc ?? "no detail"}` : null,
  };
}

function openInstitutional(): SupabaseClient | null {
  try {
    return createInstitutionalServiceRoleClient();
  } catch {
    return null;
  }
}

function crmMoney(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const raw = String(v ?? "").replace(/[^\d,.-]/g, "").trim();
  if (!raw) return null;
  const normalized = raw.includes(",") ? raw.replace(/\./g, "").replace(",", ".") : raw;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function crmMember(row: Record<string, unknown>, index: number, bookId: string): BookMember {
  const qty = num(row.totalQuantity) ?? num(row.quantityValue) ?? num(row.quantity) ?? 0;
  const avgFill = num(row.avgFillNumber) ?? crmMoney(row.avgFill);
  const expected = crmMoney(row.actualFill);
  const sourceId = str(row.sourceId) ?? `${bookId}-${index + 1}`;
  return {
    id: `crm-${sourceId}`,
    order_id: str(row.bndReference) ?? sourceId,
    client_account: str(row.clientAccountId) ?? str(row.clientName) ?? null,
    symbol: str(row.ticker) ?? str(row.instrumentName),
    side: (str(row.side) ?? "BUY").toUpperCase(),
    qty,
    filled: avgFill != null && avgFill > 0 ? qty : 0,
    status: avgFill != null && avgFill > 0 ? "filled" : "pending",
    order_type: String(row.orderType ?? "").toLowerCase().includes("limit") ? "limit" : "market",
    limit_price_rands: expected,
    avg_fill_price_rands: avgFill,
    value_rands: avgFill != null ? avgFill * qty : null,
    venue: "CRM",
    broker: str(row.brokerRef),
    last_action: str(row.notificationStatus),
    filled_at: str(row.fillDate) ?? null,
    iress_error: null,
  };
}

function crmOwnerIds(row: Record<string, unknown>): string[] {
  const ids: string[] = [];
  const add = (value: unknown) => {
    const id = str(value);
    if (id) ids.push(id);
  };
  add(row.userId);
  for (const value of Array.isArray(row.strategyUsers) ? row.strategyUsers : []) {
    if (!value || typeof value !== "object") continue;
    const owner = value as Record<string, unknown>;
    add(owner.userId ?? owner.user_id ?? owner.id);
  }
  for (const value of Array.isArray(row.strategyHoldings) ? row.strategyHoldings : []) {
    if (!value || typeof value !== "object") continue;
    const owner = value as Record<string, unknown>;
    add(owner.userId ?? owner.user_id);
  }
  for (const value of Array.isArray(row.bndRows) ? row.bndRows : []) {
    if (!value || typeof value !== "object") continue;
    const owner = value as Record<string, unknown>;
    add(owner.userId ?? owner.user_id);
  }
  return ids;
}

export async function GET(req?: Request) {
  const auth = await getAdminContext();
  if (auth.status === "no-session") {
    return NextResponse.json({ ok: false, error: "no-session" }, { status: 401 });
  }
  if (auth.status !== "ok") {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }

  // Optional ?source=A,B — return only books whose members include one of these
  // sources, so the Active tab shows app-order books and the Manual tab shows
  // desk/UAT-order books, from the same archive.
  const sourceParam = req ? (new URL(req.url).searchParams.get("source") ?? "").trim() : "";
  const sourceFilter = sourceParam
    ? new Set(sourceParam.split(",").map((s) => s.trim()).filter(Boolean))
    : null;

  const db = openInstitutional();
  if (!db) {
    return NextResponse.json({ ok: true, books: [], notice: "INSTITUTIONAL database not configured." });
  }

  let bookRows: Array<Record<string, unknown>> | null;
  let bookErr: { code?: string; message: string } | null;
  {
    const res = await db
      .from("oems_order_book")
      .select("sequence, released_at, released_by, member_count, closed_at, closed_by, email_status, email_error, email_sent_at")
      .order("sequence", { ascending: false });
    bookRows = res.data;
    bookErr = res.error;
  }
  // Closed-books columns not migrated yet (20260728000001) — fall back to the
  // base column set so the archive still renders (just without close/email
  // state) instead of erroring the whole panel on an undefined_column.
  if (bookErr && String(bookErr.code) === "42703") {
    const fallback = await db
      .from("oems_order_book")
      .select("sequence, released_at, released_by, member_count")
      .order("sequence", { ascending: false });
    bookRows = fallback.data;
    bookErr = fallback.error;
  }
  if (bookErr) {
    if (isSupabaseSchemaMissing(bookErr)) {
      return NextResponse.json({
        ok: true,
        books: [],
        notice: "oems_order_book table not migrated yet — apply 20260723000001_oems_order_book.sql.",
      });
    }
    return NextResponse.json({ ok: false, error: bookErr.message }, { status: 500 });
  }
  const { data: memberRows, error: memberErr } = await db
    .from("oems_order_audit")
    .select(
      "id, order_id, client_account, symbol, side, quantity, price_cents, status, source, payload, result_payload, updated_at",
    )
    .not("payload->>order_book_seq", "is", null);
  if (memberErr) {
    return NextResponse.json({ ok: false, error: memberErr.message }, { status: 500 });
  }

  const bySeq = new Map<number, { total: number; filled: number; members: BookMember[]; sources: Set<string> }>();
  for (const r of (memberRows ?? []) as MemberAuditRow[]) {
    const rawSeq = r.payload?.order_book_seq;
    const seq = typeof rawSeq === "number" ? rawSeq : Number(rawSeq);
    if (!Number.isFinite(seq)) continue;
    const agg = bySeq.get(seq) ?? { total: 0, filled: 0, members: [], sources: new Set<string>() };
    agg.total += 1;
    if (r.status === "filled") agg.filled += 1;
    if (r.source) agg.sources.add(r.source);
    agg.members.push(toMember(r));
    bySeq.set(seq, agg);
  }

  const books = ((bookRows ?? []) as Array<{
    sequence: number; released_at: string; released_by: string | null; member_count: number;
    closed_at?: string | null; closed_by?: string | null;
    email_status?: "sent" | "failed" | null; email_error?: string | null; email_sent_at?: string | null;
  }>)
    .filter((b) => {
      if (!sourceFilter) return true;
      const agg = bySeq.get(b.sequence);
      if (!agg) return false;
      for (const s of agg.sources) if (sourceFilter.has(s)) return true;
      return false;
    })
    .map(
    (b) => {
      const agg = bySeq.get(b.sequence) ?? { total: 0, filled: 0, members: [], sources: new Set<string>() };
      return {
        sequence: b.sequence,
        released_at: b.released_at,
        released_by: b.released_by,
        closed_at: b.closed_at ?? null,
        closed_by: b.closed_by ?? null,
        email_status: b.email_status ?? null,
        email_error: b.email_error ?? null,
        email_sent_at: b.email_sent_at ?? null,
        total_count: agg.total,
        filled_count: agg.filled,
        fully_filled: agg.total > 0 && agg.filled === agg.total,
        sources: [...agg.sources],
        // Members are returned so the archive row can be expanded to show what
        // actually executed. Without this a fully-filled book rendered as
        // "Order Book 2: <date> · 1/1 filled" and nothing else — the fill price,
        // the client and the symbol were all unreachable from the UI, because
        // `filterOutPromotedBooks` had already removed the order from the live
        // execution table. A filled order was strictly LESS visible than a
        // cancelled one.
        members: agg.members.sort((x, y) => (x.symbol ?? "").localeCompare(y.symbol ?? "")),
        // Book-level totals, so the collapsed row can carry the money figure.
        filled_value_rands: agg.members.reduce(
          (s, m) => s + (m.avg_fill_price_rands != null ? m.avg_fill_price_rands * m.filled : 0),
          0,
        ),
      };
    },
  );

  // CRM order-book snapshots live in RETAIL, not in the institutional OEMS
  // tables. Merge them into the same read model so the OEM archive is the
  // operational view of both systems. This is read-only and never enters an
  // IRESS/worker dispatch path.
  let crmBooks: Array<Record<string, unknown>> = [];
  let crmNotice: string | undefined;
  try {
    const wantsCrm =
      !sourceFilter ||
      sourceFilter.has("CRM") ||
      sourceFilter.has("CRM_LIVE") ||
      sourceFilter.has("CRM_UAT");
    if (!wantsCrm) {
      return NextResponse.json({ ok: true, books: books.map((book) => ({
        ...book,
        archive_id: `oem-${book.sequence}`,
        origin: "oem",
      })) });
    }
    const retail = createRetailServiceRoleClient();
    const [{ data: testProfiles }, { data: testWallets }] = await Promise.all([
      retail.from("profiles").select("id").eq("is_test", true),
      retail.from("wallets").select("user_id").eq("status", "test"),
    ]);
    const testUserIds = new Set<string>([
      ...(testProfiles ?? []).map((row) => String((row as { id: string }).id)).filter(Boolean),
      ...(testWallets ?? []).map((row) => String((row as { user_id: string }).user_id)).filter(Boolean),
    ]);
    const crmResult = await retail
      .from("orderbook_email_runs")
      .select("run_date,status,sent_at,error_message,created_at,updated_at,sequence_number,title,date_label,snapshot_rows,closed_at,closed_by")
      .order("run_date", { ascending: false })
      .order("sequence_number", { ascending: false });
    let crmData: Array<Record<string, unknown>> | null = crmResult.data as Array<Record<string, unknown>> | null;
    let crmError = crmResult.error;
    if (crmResult.error && String(crmResult.error.code) === "42703") {
      const fallback = await retail
        .from("orderbook_email_runs")
        .select("run_date,status,sent_at,error_message,created_at,updated_at,sequence_number,title,date_label,snapshot_rows")
        .order("run_date", { ascending: false })
        .order("sequence_number", { ascending: false });
      crmData = fallback.data as Array<Record<string, unknown>> | null;
      crmError = fallback.error;
    }
    if (crmError) {
      crmNotice = `CRM archive unavailable: ${crmError.message}`;
    } else {
      crmBooks = (crmData ?? []).map((raw) => {
        const row = raw as Record<string, unknown>;
        const sequence = num(row.sequence_number) ?? 1;
        const runDate = str(row.run_date) ?? "unknown-date";
        const archiveId = `${runDate}-${sequence}`;
        const snapshotRows = Array.isArray(row.snapshot_rows)
          ? row.snapshot_rows.filter((item): item is Record<string, unknown> => !!item && typeof item === "object")
          : [];
        const owners = snapshotRows.flatMap(crmOwnerIds);
        const isUat = owners.length > 0 && owners.every((ownerId) => testUserIds.has(ownerId));
        const crmSource = isUat ? "CRM_UAT" : "CRM_LIVE";
        const members = snapshotRows.map((item, index) => crmMember(item, index, archiveId));
        const filledCount = members.filter((member) => member.status === "filled").length;
        return {
          archive_id: archiveId,
          origin: "crm",
          sequence,
          title: str(row.title) ?? `Order Book ${sequence}`,
          released_at: str(row.sent_at) ?? str(row.updated_at) ?? str(row.created_at) ?? `${runDate}T00:00:00Z`,
          released_by: null,
          closed_at: str(row.closed_at),
          closed_by: str(row.closed_by),
          email_status: row.status === "sent" ? "sent" : row.status === "failed" ? "failed" : null,
          email_error: str(row.error_message),
          email_sent_at: str(row.sent_at),
          total_count: members.length,
          filled_count: filledCount,
          fully_filled: members.length > 0 && filledCount === members.length,
          sources: [crmSource],
          members,
          filled_value_rands: members.reduce((sum, member) => sum + (member.value_rands ?? 0), 0),
        };
      }).filter((book) => !sourceFilter || book.sources.some((source) => sourceFilter.has(source) || sourceFilter.has("CRM")));
    }
  } catch (error) {
    crmNotice = `CRM archive unavailable: ${error instanceof Error ? error.message : String(error)}`;
  }

  const oemBooks = books.map((book) => ({
    ...book,
    archive_id: `oem-${book.sequence}`,
    origin: "oem",
  }));
  const merged = [...crmBooks, ...oemBooks].sort(
    (a, b) => Date.parse(String(b.released_at ?? 0)) - Date.parse(String(a.released_at ?? 0)),
  );

  return NextResponse.json({ ok: true, books: merged, ...(crmNotice ? { notice: crmNotice } : {}) });
}
