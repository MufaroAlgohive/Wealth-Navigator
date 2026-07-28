// Tiny Mock Supabase client.
//
// This intentionally supports only the chain shapes the settlement
// extension produces:
//   .from(t).select().eq(c,v).maybeSingle()  → return single matching row
//   .from(t).update(p).eq(c,v).eq(c,v).select().maybeSingle() → update matching row, return it
//   .from(t).update(p).eq(c,v).lt(c,v).in(c,vals)  → update matching rows
//   .from(t).insert(row).select().maybeSingle()    → insert and return row
//   .from(t).upsert(row, { onConflict })          → upsert store
//   .from(t).select().order().limit()             → list matching rows
//
// Anything else throws so missing coverage is loud, not silent.

type Row = Record<string, unknown>;
type Pred = (row: Row) => boolean;

export interface MockSupabase {
  from: (table: string) => MockTable;
  _stored: Record<string, Row[]>;
  _logging: { table: string; op: string; payload?: Row | Row[] }[];
}

export interface MockTable {
  select: (cols?: string) => MockTable;
  insert: (row: Row | Row[]) => MockTable;
  update: (patch: Row) => MockTable;
  upsert: (row: Row, opts?: { onConflict?: string }) => MockTable;
  eq: (col: string, val: unknown) => MockTable;
  in: (col: string, vals: unknown[]) => MockTable;
  lt: (col: string, val: unknown) => MockTable;
  maybeSingle: () => Promise<{ data: Row | null; error: null }>;
  order: (col: string, opts?: { ascending?: boolean }) => MockTable;
  limit: (n: number) => MockTable;
}

export function makeMockSupabase(): MockSupabase {
  const stored: Record<string, Row[]> = {};
  const logging: MockSupabase["_logging"] = [];

  const client: MockSupabase = {
    _stored: stored,
    _logging: logging,
    from: (table: string) => createChain(stored, logging, table),
  };
  return client;
}

function createChain(
  stored: Record<string, Row[]>,
  logging: MockSupabase["_logging"],
  table: string,
): MockTable {
  const ensure = (t: string) => (stored[t] ??= []);
  const state = { predicates: [] as Pred[], patch: undefined as Row | undefined, op: "select" as "select" | "update" | "insert" | "upsert" };

  const rebuild = (): MockTable => {
    /**
     * Eagerly apply an in-flight UPDATE-or-DELETE (no further filter) to
     * the store. Returns a thenable that resolves like a real Supabase
     * query promise. Used for `update(p).eq(c,v)` (no .select()) which
     * is the canonical "fire and forget" form.
     */
    const flushUpdate = (): Promise<{ data: Row[] | null; error: null }> => {
      const rows = ensure(table);
      const matched = rows.filter((r) => state.predicates.every((p) => p(r)));
      if (state.op === "update" && state.patch) {
        for (const r of matched) Object.assign(r, state.patch);
      }
      // For .select() chains (or bare awaited chains), return the matched
      // rows. For .update() chains, also return the matched rows so the
      // caller can inspect which rows were touched.
      return Promise.resolve({ data: matched, error: null });
    };

    const chain: MockTable = {
      _predicates: state.predicates,
      select: (_cols?: string) => {
        // Calling .select() at the end of a chain and then awaiting the
        // chain (without .maybeSingle() or .single()) is the canonical
        // "list rows" form. Make it a thenable so `await ...select().in().lt()`
        // resolves to the matched rows.
        return {
          ...rebuild(),
          then: (onFulfilled: any, onRejected: any) => {
            const rows = ensure(table);
            const matched = rows.filter((r) => state.predicates.every((p) => p(r)));
            return Promise.resolve({ data: matched, error: null }).then(onFulfilled, onRejected);
          },
        };
      },
      insert: (row: Row | Row[]) => {
        const rows = Array.isArray(row) ? row : [row];
        ensure(table).push(...rows);
        logging.push({ table, op: "insert", payload: rows });
        return rebuild();
      },
      update: (patch: Row) => {
        state.op = "update";
        state.patch = patch;
        return rebuild();
      },
      upsert: (row: Row, _opts?: { onConflict?: string }) => {
        const arr = ensure(table);
        const idx = arr.findIndex((r) => {
          for (const k of Object.keys(row)) {
            if (r[k] === row[k]) return true;
          }
          return false;
        });
        if (idx >= 0) arr[idx] = row;
        else arr.push(row);
        logging.push({ table, op: "upsert", payload: row });
        return rebuild();
      },
      eq: (col: string, val: unknown) => {
        state.predicates.push((r) => r[col] === val);
        return {
          ...rebuild(),
          // Thenable: `await update().eq()` resolves to the Supabase
          // query result, so callers using `await ... .update().eq()`
          // (no further chain) get the side effect applied.
          then: (onFulfilled: any, onRejected: any) => flushUpdate().then(onFulfilled, onRejected),
        };
      },
      in: (col: string, vals: unknown[]) => {
        state.predicates.push((r) => vals.includes(r[col]));
        return {
          ...rebuild(),
          then: (onFulfilled: any, onRejected: any) => flushUpdate().then(onFulfilled, onRejected),
        };
      },
      lt: (col: string, val: unknown) => {
        state.predicates.push((r) => {
          const v = r[col];
          if (typeof v === "string" && typeof val === "string") return v < val;
          if (typeof v === "number" && typeof val === "number") return v < val;
          return false;
        });
        return {
          ...rebuild(),
          then: (onFulfilled: any, onRejected: any) => flushUpdate().then(onFulfilled, onRejected),
        };
      },
      order: (_col: string, _opts?: { ascending?: boolean }) => rebuild(),
      limit: (_n: number) => rebuild(),
      maybeSingle: async () => {
        if (state.op === "update" && state.patch) {
          const rows = ensure(table);
          const matched = rows.filter((r) => state.predicates.every((p) => p(r)));
          for (const r of matched) Object.assign(r, state.patch);
          return { data: (matched[0] as Row) ?? null, error: null };
        }
        const rows = ensure(table);
        const matched = rows.filter((r) => state.predicates.every((p) => p(r)));
        return { data: (matched[0] as Row) ?? null, error: null };
      },
    };
    return chain;
  };

  return rebuild();
}