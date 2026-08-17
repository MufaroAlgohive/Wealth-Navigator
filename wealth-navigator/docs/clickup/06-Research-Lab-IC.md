# Wealth Navigator — Research Lab, Research Library & Investment Committee

**Audience:** developers, new joiners, IC members, ops.
**Last reviewed:** 2026-08-15.
**Source of truth:** `wealth-navigator/src/app/oems/research/`, `wealth-navigator/src/components/research-ic/`, `wealth-navigator/src/lib/research-ic/`, `wealth-navigator/src/lib/research-lab/`, `wealth-navigator/src/app/api/research/`, `wealth-navigator/src/app/api/rebalance/`, `wealth-navigator/docs/README_ic_committee.md`, `wealth-navigator/supabase/seeds/ic_committee_institutional.sql`, `wealth-navigator/supabase/seeds/ic_committee_retail.sql`, `wealth-navigator/supabase/migrations/20260710000001_research_note_c.sql`, `…20260710000002_research_vote_c.sql`, `…20260710000003_ic_session_c.sql`, `…20260710000004_rebalance_request_c.sql`, `…20260713000001_rebalance_vote_c.sql`.

> **Correction vs older handoffs:** `/oems/research-lab` redirects to `/oems/research`; the v1 session-only editor is at `/oems/research-lab-legacy`. Rebalance `push` returns **HTTP 501 `deferred`** since 2026-07-27 — use `POST /api/admin/orderbook/send-to-market` instead. Investment Committee has **3 fixed members** (Lonwabo chair, Juan voting, Lethabo voting) — not configurable from the UI.

---

## 1. The shape of the research flow

The Research stack ties three surfaces together:

```
   /oems/research                      (Research Library)
   ──────────────
       │
       │ multi-step "New Note" wizard (6 steps)
       ▼
   research_note_c (institutional DB)
       │
       │ vote flow
       ▼
   /oems/committee                     (Investment Committee)
   ────────────────────
       │ tally + threshold + auto-promotion
       ▼
   rebalance_request_c (institutional DB)
       │
       │ rebalance builder
       ▼
   /oems/rebalance                     (Rebalance Builder)
   ───────────────────
       │
       │ impact + IC vote
       ▼
   POST /api/rebalance/impact          (server-side impact simulation)
   POST /api/rebalance/requests        (creates the request)
   POST /api/rebalance/requests/[id]/vote
   POST /api/rebalance/requests/[id]/push  ← 501 deferred
       │
       │ approved → manual order path
       ▼
   POST /api/admin/orderbook/send-to-market  (real basket path)
```

The **desk rhythm** narrative at `/oems/rhythm` ties this together as the daily operating cadence.

---

## 2. Research Library (`/oems/research`)

### Server entry
- `wealth-navigator/src/app/oems/research/page.tsx:1-14` — calls `resolveResearchSession()` then renders `<ResearchLibraryPage perms={s.perms} …>`.
- Components in `wealth-navigator/src/components/research-ic/`:
  - `research-library-page.tsx`
  - `note-editor.tsx` (6-step wizard)
  - `note-detail.tsx`
  - `investment-committee-page.tsx`
  - `rebalance-builder-page.tsx`
  - `desk-rhythm-page.tsx`
  - `ic-agenda.ts`
  - `server.ts`
  - `types.ts`
  - `ui.tsx`

### Library page
- Tabs: Notes, IC pending, Approved, Archived.
- Filter chips by status + author.
- Sort by recency, ticker, IC vote tally.
- Per-note card surfaces ticker, target price, current price, signed upside %, status pill, vote tally.

### New Note wizard — `note-editor.tsx` (6 steps)

The multi-step wizard creates a `research_note_c` row in the institutional DB. Steps:

1. **Ticker** — search via `/api/securities/search` → pick symbol. Live IRESS mark badge with signed upside % vs target (when Step 1 has Target Price).
2. **Thesis** — long-form rationale.
3. **Targets & Recommendation** — target price, current price, recommendation (Buy/Hold/Sell), time horizon.
4. **Risks** — bull case + bear case + key risks.
5. **Tags & References** — tags + URL references.
6. **Review** — renders `Target R{price} · now R{price} · upside {±n%}`. Final submission → POST `/api/research/notes`.

### Live IRESS mark badge
- Step 1 (Ticker) shows a pulsing live-IRESS mark badge with signed upside % vs target.
- Polls `/api/company-analysis/[sym]` every 60s (30s staleTime).
- IRESS overlay or stored price.
- Renders upside ±n% in green/red.

### Status transitions
- `research_note_c.status`:
  - `draft` — in-editor (not yet submitted).
  - `ic_pending` — submitted, awaiting IC vote.
  - `ic_approved` — 2/3 majority.
  - `ic_rejected` — fails majority (or explicit reject).
  - `archived` — superseded by another note.

### Voting affordance
- `/oems/committee` shows voting UI per note.
- Top-level `/oems` banner widget: "you have a pending vote" for the 3 committee members when `research_note_c.status = 'ic_pending'` (open gap — not yet shipped).

---

## 3. Investment Committee (`/oems/committee`)

### Server entry
- `wealth-navigator/src/app/oems/committee/page.tsx` — server entry that resolves session, then renders `<InvestmentCommitteePage perms={s.perms} …>`.

### Page
- Renders IC agenda from `research-ic/ic-agenda.ts`.
- Sections:
  - **Pending notes** — `research_note_c.status = 'ic_pending'` with member pills (LN/JN/LT) + tally + threshold.
  - **Pending rebalance requests** — `rebalance_request_c.status = 'pending'` with vote row.
  - **Approved items** — `research_note_c.status = 'ic_approved'` + `rebalance_request_c.status = 'ic_approved'`.
  - **Recent decisions** — last 30 days of votes.

### Committee membership (3 fixed members)
Per `wealth-navigator/src/lib/research-ic/committee.ts:42-57`:
- **Lonwabo** (chair, voting).
- **Juan** (voting).
- **Lethabo** (voting).

Server-side whitelist lives at `wealth-navigator/src/lib/research-ic/committee-gate.ts`. Reads `committee_member_c` on the **institutional DB** with a soft fallback to the static roster if the table isn't migrated yet.

### Voting
- `POST /api/research/notes/[id]/vote` — body `{ vote: "yes" | "no" | "abstain" }`.
- `POST /api/rebalance/requests/[id]/vote` — body `{ vote: "yes" | "no" | "abstain" }`.
- Both update `research_vote_c` / `rebalance_vote_c` rows.
- Tally recomputed server-side per request: `passes iff (yes_count / total_votes) >= 0.5`.
- Auto-promotes research note `ic_pending → ic_approved` when YES ≥ 2.
- Auto-promotes rebalance `pending → ic_approved` when YES ≥ 2.

### Membership UI
- Per-member pill bar (LN/JN/LT) at lines 800-870.
- Vote row at lines 920-941 (single-click approve/reject).
- Tally bar at lines 943-973 (horizontal bar with YES/NO/ABSTAIN).

### Soft-fallback behaviour
- If `committee_member_c` not yet migrated, falls back to static roster.
- Comment at `committee-gate.ts:1-50`: "Always allow the 3 fixed members; never allow anyone else."

---

## 4. Rebalance Builder (`/oems/rebalance`)

### Server entry
- `wealth-navigator/src/app/oems/rebalance/page.tsx:1-21` — resolves strategy, then renders `<RebalanceBuilderPage perms={s.perms} … initialStrategyId={sp.strategy} initialStrategyName={sp.name} />`.
- Loads strategy catalogue from `/api/strategies` and baseline composition from `/api/strategies/[id]/composition`.

### Page
- Step 1: Pick strategy.
- Step 2: View baseline composition (current holdings).
- Step 3: Propose changes (add / trim / grow / hold). Required `rationale` per change.
- Step 4: Impact simulation (`POST /api/rebalance/impact`).
- Step 5: Submit to IC (`POST /api/rebalance/requests`).

### Components
- `wealth-navigator/src/components/research-ic/rebalance-builder-page.tsx` — main page component (500+ lines).
- `submitToIc()` (lines 324-375) — POST `/api/rebalance/requests`.
- `impactQ` pre-flight per proposed change (`POST /api/rebalance/impact`).

### Status transitions
- `rebalance_request_c.status`:
  - `draft` — local-only changes (not yet submitted).
  - `pending` — submitted, awaiting IC vote.
  - `ic_approved` — 2/3 majority.
  - `ic_rejected` — fails majority.
  - `cancelled` — withdrawn by author.
  - `pushed` — order sent to market (post-cutover).

### Rebalance Approved (`/oems/rebalance/approved`)
- Displays latest approved request by `request_id` deep-link.
- Read-only.
- `wealth-navigator/src/app/oems/rebalance/approved/page.tsx`.

### Push-to-market (`POST /api/rebalance/requests/[id]/push`)
- Returns **HTTP 501 `deferred`** since 2026-07-27.
- Comment at `src/app/api/rebalance/requests/[id]/push/route.ts:97-123`: would emit unattributable orders (strategy name in place of client, no user_id, no dispatcher).
- **Real basket path** — `POST /api/admin/orderbook/send-to-market`.

---

## 5. Legacy Research Lab (`/oems/research-lab`, `/oems/research-lab-legacy`)

### `/oems/research-lab`
- Server entry redirects to `/oems/research` (legacy alias).

### `/oems/research-lab-legacy`
- Server entry `wealth-navigator/src/app/oems/research-lab-legacy/page.tsx`.
- Renders the v1 session-only editor.
- Thesis add/remove is **session-only** (no DB persistence).
- Used for ad-hoc research composition outside the IC workflow.

---

## 6. Desk Rhythm (`/oems/rhythm`)

- Static narrative of the daily operating rhythm tying Research → IC → Rebalance.
- `wealth-navigator/src/components/research-ic/desk-rhythm-page.tsx`.
- Operator-facing "what to do today" guide.

---

## 7. Investment Committee governance

### Threshold
- **3 fixed members** (Lonwabo chair, Juan voting, Lethabo voting).
- **2/3 majority** passes (≥ 2 yes of 3).
- Threshold logic in `wealth-navigator/src/lib/research-ic/committee.ts`.

### Server-side gate (cannot be bypassed)
- `wealth-navigator/src/lib/research-ic/committee-gate.ts` reads `committee_member_c` on the institutional DB.
- Soft fallback to static roster if the table isn't migrated.
- Always allow the 3 fixed members; never allow anyone else.

### Vote types
- `research_vote_c` — for research notes (`research_note_c`).
- `rebalance_vote_c` — for rebalance requests (`rebalance_request_c`).

### Vote lifecycle
- A vote can be `yes`, `no`, or `abstain`.
- Voting twice replaces the prior vote.
- Voting on a request that is not `pending` / `ic_pending` returns 4xx.
- Abstain counts toward `total_votes` but not toward YES count.

---

## 8. AI Research cache (`src/lib/research-ai/`)

- `wealth-navigator/src/lib/research-ai/cache.ts:23-32` — Materiality baseline frozen at cache generation (by design).
- `wealth-navigator/src/lib/research-ai/provider.ts` — M3 (MINT's own model) provider.
- AI cache stores company analysis summaries keyed by symbol.
- Used by `/api/company-analysis/[sym]` (60s poll, 30s staleTime).

---

## 9. Supabase tables (institutional DB)

### `research_note_c`
- `id` UUID PK.
- `symbol` text.
- `target_price` numeric (Rands).
- `recommendation` enum (`buy`, `hold`, `sell`).
- `time_horizon` enum (`3m`, `6m`, `12m`, `24m`).
- `thesis` text.
- `bull_case` text.
- `bear_case` text.
- `key_risks` text.
- `tags` text[].
- `references` text[].
- `author` text (committee member).
- `status` enum (`draft`, `ic_pending`, `ic_approved`, `ic_rejected`, `archived`).
- `created_at`, `updated_at`, `submitted_at`, `decided_at`.

### `research_vote_c`
- `id` UUID PK.
- `note_id` UUID FK → `research_note_c.id`.
- `member` enum (`lonwabo`, `juan`, `lethabo`).
- `vote` enum (`yes`, `no`, `abstain`).
- `voted_at`.

### `ic_session_c`
- `id` UUID PK.
- `kind` enum (`research`, `rebalance`).
- `target_id` UUID (note or request id).
- `opened_at`, `closed_at`.

### `rebalance_request_c`
- `id` UUID PK.
- `strategy_id` UUID → `strategies_c.id` (RETAIL).
- `author` text.
- `proposed_changes` jsonb (add/trim/grow/hold per holding).
- `rationale` text.
- `status` enum (`draft`, `pending`, `ic_approved`, `ic_rejected`, `cancelled`, `pushed`).
- `created_at`, `updated_at`, `submitted_at`, `decided_at`.

### `rebalance_vote_c`
- `id` UUID PK.
- `request_id` UUID FK → `rebalance_request_c.id`.
- `member` enum.
- `vote` enum.
- `voted_at`.

### `committee_member_c`
- `id` UUID PK.
- `name` text (`lonwabo`, `juan`, `lethabo`).
- `role` text (`chair`, `voting`).
- `active` boolean.
- `joined_at`.

### Migration history
- `wealth-navigator/supabase/migrations/20260710000001_research_note_c.sql`.
- `wealth-navigator/supabase/migrations/20260710000002_research_vote_c.sql`.
- `wealth-navigator/supabase/migrations/20260710000003_ic_session_c.sql`.
- `wealth-navigator/supabase/migrations/20260710000004_rebalance_request_c.sql`.
- `wealth-navigator/supabase/migrations/20260713000001_rebalance_vote_c.sql`.

### Seeds
- `wealth-navigator/supabase/seeds/ic_committee_institutional.sql` — `committee_member_c` seed on institutional.
- `wealth-navigator/supabase/seeds/ic_committee_retail.sql` — `admin_team` seed on retail (legacy).

---

## 10. Server-side enforcement

### Research-note vote (`/api/research/notes/[id]/vote/route.ts`)
- Validates member against `committee_member_c` (server-side).
- Validates note status `ic_pending`.
- Writes `research_vote_c` row.
- Recomputes tally; auto-promotes `ic_pending → ic_approved` if YES ≥ 2.
- Hard rule at top of file: votes are server-side; UI cannot bypass.

### Rebalance vote (`/api/rebalance/requests/[id]/vote/route.ts`)
- Same pattern. Validates member against `committee_member_c`.
- Validates request status `pending`.
- Writes `rebalance_vote_c` row.
- Recomputes tally; auto-promotes `pending → ic_approved` if YES ≥ 2.

### Rebalance impact (`/api/rebalance/impact/route.ts:44-288`)
- Hard rule at lines 16-25: "HARD CLIENT-DATA BOUNDARY — This reads the RETAIL/LIVE database, so it is scoped to TEST CLIENTS ONLY… A real client (is_test=false) is never read."
- Computes per-change impact: weight delta, cash delta, drift vs target.
- Returns server-side summary.

### Rebalance create (`/api/rebalance/requests/route.ts`)
- Validates author is committee member or strategy lead.
- Validates `proposed_changes` schema.
- Writes `rebalance_request_c` row with `status='pending'`.

### Rebalance push (`/api/rebalance/requests/[id]/push/route.ts`)
- **HTTP 501 `deferred`** since 2026-07-27.
- Comment at lines 97-123: would emit unattributable orders.
- **Real basket path** — `POST /api/admin/orderbook/send-to-market`.

---

## 11. UI components (research-ic/)

### `research-library-page.tsx`
- Tabs + filter chips + per-note card.

### `note-editor.tsx`
- 6-step wizard.
- Step 1 live IRESS mark badge with signed upside % vs target.
- Step 6 Review tab renders `Target R{price} · now R{price} · upside {±n%}`.

### `note-detail.tsx`
- Read-only view of a note with vote tally + member pills.

### `investment-committee-page.tsx`
- IC agenda surface.
- Pending notes + pending rebalance + approved + recent decisions.
- Per-member pill bar (lines 800-870).
- Vote row (lines 920-941).
- Tally bar (lines 943-973).

### `rebalance-builder-page.tsx`
- Rebalance builder surface.
- `submitToIc()` (lines 324-375).
- `impactQ` pre-flight.

### `desk-rhythm-page.tsx`
- Static narrative.

### `ic-agenda.ts`
- Server-side IC agenda builder.
- Aggregates pending notes + pending rebalance + approved + recent.

### `server.ts`
- `resolveResearchSession()` — server-side perms for `/oems/research`, `/oems/committee`, `/oems/rebalance`.

### `types.ts`
- Shared types for notes, votes, requests, members.

### `ui.tsx`
- Shared primitives (cards, pills, tally bar).

---

## 12. Server-side helpers (`wealth-navigator/src/lib/research-ic/`)

### `committee.ts`
- `COMMITTEE` constant — 3 fixed members.
- `THRESHOLD = 0.5` (≥50% YES passes).

### `committee-gate.ts`
- `isCommitteeMember(member: string)` — server-side whitelist check.
- Reads `committee_member_c` on institutional DB.
- Soft fallback to static roster.

### `tally.ts`
- `tallyVotes(votes)` — server-side tally computation.

### `promotion.ts`
- `autoPromoteIfPassed(noteId|requestId)` — auto-promotes `pending → ic_approved` when YES ≥ 2.

---

## 13. Open gaps

### Functional gaps
- **Rebalance push returns 501** — use `POST /api/admin/orderbook/send-to-market` instead.
- **Research Lab thesis add/remove is session-only** — `/oems/research-lab-legacy` doesn't persist proposals to the DB.
- **IC voting UI not yet shipped to all personas** — only `/oems/committee` shows it; no top-level banner for the 3 committee members.
- **No IC voting affordance widget on `/oems`** — should surface "you have a pending vote" for the 3 committee members when `research_note_c.status = 'ic_pending'`.
- **`oems_strategy_c` institutional rollup table is empty** — RETAIL `strategies_c` is still the source.
- **Per-user `page_access` RBAC wiring still in flight** — `nav.ts:160-165` uses a stop-gap `visibleFor()` until RBAC lands.
- **Materiality baseline in `src/lib/research-ai/cache.ts:23-32`** is frozen at cache generation (by design).

### Server-side enforcement gaps
- **No audit log for IC vote changes** — write to `cc_audit_log` (admin audit) when a vote is replaced.
- **No notification when a vote reaches threshold** — auto-promotion happens silently. Add operator notification.

### Membership gaps
- **Static roster fallback** — if `committee_member_c` is missing, fallback to the 3 fixed members. Once migrated, drop the fallback.
- **No dead-man's switch** — if a member doesn't vote, no escalation.

---

*This doc is the Research + IC deep-dive. Pair with Doc 9 (API surface) for the BFF contracts and Doc 10 (risk/compliance) for the audit posture.*
