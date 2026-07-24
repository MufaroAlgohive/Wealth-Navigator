# IC Committee — DB setup

The Investment Committee whitelist is split across the two Supabase DBs by
ownership — `admin_team` (user identity) lives on retail, while the
authoritative `committee_member_c` whitelist (used by the vote API to accept
or reject a ballot) lives on institutional alongside the vote tables.

## Run order

1. **Retail DB** (`mfxnghmuccehsxwcetej`) — open
   [ic_committee_retail.sql](./ic_committee_retail.sql) in the SQL editor:
   - STEP 1 discovers the three members by first name from `admin_team` /
     `auth.users`. Read-only.
   - STEP 2 backfills the granular permissions JSONB (`research.cast_vote`,
     `rebalance.approve_rebalance`, `research.approve_note`) on the matched
     rows.
   - Paste the three surfaced emails into the placeholder `WHERE lower(email)
     IN (...)` clause before running STEP 2.

2. **Institutional DB** (`nnwzhxfjpjbzujevwzlh`) — open
   [ic_committee_institutional.sql](./ic_committee_institutional.sql):
   - Creates `committee_member_c` (UNIQUE voter_email, role check, RLS).
   - Seeds Lonwabo (chair), Juan, Lethabo. UPSERT — re-running after fixing
     an email just overwrites the row.
   - Replace the `'lonwabo@CHANGE-ME'` etc. placeholders with the real
     addresses from STEP 1.

## Why two scripts

The previous combined file assumed `admin_team` was queryable on whichever
project the analyst pasted it into — running it against the institutional DB
produced `ERROR: 42P01: relation "admin_team" does not exist`. Splitting by
project makes the wrong-DB failure mode impossible.

## Soft fallback

The vote API (`src/lib/research-ic/committee-gate.ts`) falls back to the
static roster in `src/lib/research-ic/committee.ts` when `committee_member_c`
isn't migrated yet — so the IC keeps working during a soft rollout where the
SQL hasn't been seeded on institutional.
