import { createHash } from "node:crypto";
import { NextResponse } from "next/server";

import { getAdminContext } from "@/lib/admin/rbac";
import { createRetailServiceRoleClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

type ProofRow = { ticker?: unknown; date?: unknown; closeCents?: unknown; sourceFile?: unknown };

const bare = (value: unknown) =>
  String(value ?? "")
    .trim()
    .toUpperCase()
    .replace(/\.(JO|JSE)$/i, "");

export async function POST(request: Request) {
  const auth = await getAdminContext();
  if (auth.status === "no-session")
    return NextResponse.json({ ok: false, error: "no-session" }, { status: 401 });
  if (auth.status !== "ok") return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });

  const body = (await request.json().catch(() => null)) as { rows?: ProofRow[] } | null;
  if (!Array.isArray(body?.rows) || body.rows.length === 0 || body.rows.length > 20_000) {
    return NextResponse.json(
      { ok: false, error: "Provide between 1 and 20,000 provider close rows" },
      { status: 400 },
    );
  }
  const rows = body.rows.map((row) => ({
    ticker: bare(row.ticker),
    date: String(row.date ?? "").slice(0, 10),
    closeCents: Number(row.closeCents),
    sourceFile: String(row.sourceFile ?? "provider-export"),
  }));
  const invalid = rows.filter(
    (row) => !row.ticker || !/^\d{4}-\d{2}-\d{2}$/.test(row.date) || !(row.closeCents > 0),
  );
  if (invalid.length) {
    return NextResponse.json(
      { ok: false, error: `${invalid.length} provider row(s) have an invalid ticker, date or close` },
      { status: 400 },
    );
  }

  const db = createRetailServiceRoleClient();
  const symbols = [...new Set(rows.flatMap((row) => [row.ticker, `${row.ticker}.JO`]))];
  const dates = rows.map((row) => row.date).sort();
  const firstDate = dates[0];
  const lastDate = dates.at(-1);
  if (!firstDate || !lastDate)
    return NextResponse.json({ ok: false, error: "No dated rows" }, { status: 400 });
  const { data, error } = await db
    .from("stock_returns_c")
    .select("symbol,as_of_date,current_price,fetched_at")
    .in("symbol", symbols)
    .gte("as_of_date", firstDate)
    .lte("as_of_date", lastDate);
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });

  const stored = new Map<string, { closeCents: number; fetchedAt: string }>();
  for (const row of data ?? []) {
    const key = `${String(row.as_of_date).slice(0, 10)}:${bare(row.symbol)}`;
    const candidate = { closeCents: Number(row.current_price), fetchedAt: String(row.fetched_at ?? "") };
    const existing = stored.get(key);
    if (!existing || candidate.fetchedAt > existing.fetchedAt) stored.set(key, candidate);
  }
  const comparisons = rows.map((row) => {
    const match = stored.get(`${row.date}:${row.ticker}`);
    const differenceCents = match ? match.closeCents - row.closeCents : null;
    return {
      ...row,
      storedCloseCents: match?.closeCents ?? null,
      storedFetchedAt: match?.fetchedAt ?? null,
      differenceCents,
      status:
        match == null
          ? "MISSING_STORED_CLOSE"
          : Math.abs(Number(differenceCents)) <= 1
            ? "MATCH"
            : "MISMATCH",
    };
  });
  const matched = comparisons.filter((row) => row.status === "MATCH").length;
  const mismatched = comparisons.filter((row) => row.status === "MISMATCH").length;
  const missing = comparisons.filter((row) => row.status === "MISSING_STORED_CLOSE").length;
  const evidence = rows
    .map(({ ticker, date, closeCents, sourceFile }) => ({ ticker, date, closeCents, sourceFile }))
    .sort((a, b) => `${a.date}:${a.ticker}`.localeCompare(`${b.date}:${b.ticker}`));
  return NextResponse.json({
    ok: true,
    readOnly: true,
    toleranceCents: 1,
    evidenceSha256: createHash("sha256").update(JSON.stringify(evidence)).digest("hex"),
    summary: {
      total: comparisons.length,
      matched,
      mismatched,
      missing,
      pass: mismatched === 0 && missing === 0,
    },
    comparisons,
  });
}
