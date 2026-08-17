# Wealth Navigator — Canvas (beta) — Fynca-style multi-persona workspace

**Audience:** developers, new joiners, designers, stakeholders.
**Last reviewed:** 2026-08-15.
**Source of truth:** `wealth-navigator/src/app/canvas/`, `wealth-navigator/src/components/canvas/`, `wealth-navigator/src/lib/canvas/`, `wealth-navigator/src/components/chatsight/`.

> **Correction vs older handoffs:** Canvas is at `/canvas` (not `/oems/canvas`). Real data only — no fake nodes. 15 open gaps logged (covered in §10).

---

## 1. What is Canvas?

Canvas is a **Fynca-inspired visual workspace** built on a pan/zoom board where the user drags and drops **engines** (panels) onto a grid. It is the platform's **multi-persona** surface — a single workspace that can show data for any persona (OEMS, WM, admin, strategist, etc.) without persona routing.

Three pillars:

1. **Engine grid** — pan/zoom board with engines positioned in grid cells.
2. **Chatsight Ask + Build** — natural-language + structured prompt interface.
3. **Live presence** — see other operators viewing the same canvas in real time.

**Real data only.** No fake nodes (per root `AGENTS.md:14`). Every engine reads from real data sources (M3 / IRESS / Yahoo / Supabase) — never synthetic placeholders.

### URL
- Direct: `/canvas`.
- Reachable from `/oems` nav → "Canvas" item under RESEARCH & IC.

### Server entry
- `wealth-navigator/src/app/canvas/page.tsx`.
- Components in `wealth-navigator/src/components/canvas/`.
- Server-side helpers in `wealth-navigator/src/lib/canvas/`.
- Chatsight primitives in `wealth-navigator/src/components/chatsight/`.

---

## 2. Engine grid

### The grid
- Grid cells in a 12-column layout.
- Pan + zoom (CSS transforms).
- Engines occupy 1-12 cells each.
- Engines can be repositioned via drag-and-drop.

### Engines
Engines are pluggable panels that consume data + render visualisations. Each engine has:

- `id` — engine type identifier.
- `title` — display name.
- `source` — data-source kind (`iress | yahoo | supabase | external | mock`).
- `size` — grid span (1-12 cells).
- `position` — `{ x, y }` grid coordinates.
- `props` — engine-specific props (symbol, timeframe, etc.).

### Built-in engines
- **Quote ticker** — single-symbol live quote.
- **Mini chart** — sparkline + price.
- **Watchlist** — multi-symbol live quotes.
- **Order pad** — blotter-lite.
- **News feed** — ticker-tagged news.
- **Strategy card** — strategy P&L + drift.
- **Note card** — research library note preview.
- **Calendar** — economic calendar.
- **Chatsight panel** — inline Ask/Build.
- **Macro tile** — SARB / StatsSA tile.
- **Custom engine** — user-defined `code-gap` engine (placeholder for future V4 methods).

### Persistence
- Engine grid layout persisted in `canvas_layout_c` on the institutional DB (per-user).
- Default layout on first visit is auto-generated from persona (`oems` persona → engines pinned to OEMS surfaces).

---

## 3. Chatsight Ask + Build

### Components
- `wealth-navigator/src/components/chatsight/ask.tsx` — Ask panel (natural-language Q&A).
- `wealth-navigator/src/components/chatsight/build.tsx` — Build panel (structured prompt → engine).
- `wealth-navigator/src/components/chatsight/runtime.ts` — runtime dispatch.
- `wealth-navigator/src/components/chatsight/types.ts` — shared types.

### Ask
- User types a natural-language question.
- Routed to M3 (MINT's own model) via `wealth-navigator/src/lib/research-ai/provider.ts`.
- Returns structured answer + optional engine preview.
- Inline on Canvas grid; can be expanded to a side panel.

### Build
- User specifies `{ engine_id, props }` via structured prompt.
- Routed to M3 for prop inference + validation.
- Returns an engine that can be dropped onto the grid.
- Replaces manual "drag engine → set props" flow.

### Provider
- M3 (MINT's own model) via `wealth-navigator/src/lib/research-ai/provider.ts`.
- Falls back to OpenAI / Anthropic / Google GenAI if M3 unavailable (provider chain at `provider.ts:20-65`).

---

## 4. Live presence

### Server-side
- Presence tracked via Supabase Realtime channels on `canvas_presence_c` (institutional DB).
- Channel name `canvas:<canvas_id>`.
- Per-user row: `{ user_id, persona, current_engine, ts }`.

### Client-side
- `wealth-navigator/src/components/canvas/presence.tsx` — overlays other operators' cursors + active engines.
- Avatar bubbles on the top-right of each engine the operator is viewing.
- "N people viewing this canvas" counter.

### TTL
- Presence rows expire after 30s of no heartbeat.
- Heartbeat every 10s.

---

## 5. Real data sources

Per the real-data-only constraint, every engine consumes real data:

| Source | Engines | Auth | Notes |
|---|---|---|---|
| **M3** (MINT model) | Chatsight Ask/Build | Server-side | Used for prop inference + answer generation. |
| **IRESS** | Quote ticker, Mini chart, Watchlist, Order pad | Worker passthrough | Live SOAP via worker; Path B. |
| **Yahoo Finance** | Macro tile (fallback), Fundamentals | Cron shadow | Default shadow; opt-in writes via `YAHOO_FUNDAMENTALS_WRITE=1`. |
| **Supabase** | Strategy card, Note card, News feed | Service-role clients | Reads from RETAIL + INSTITUTIONAL depending on kind. |

**No fake nodes.** If a data source is unavailable, the engine renders an honest empty state with the data-source badge.

---

## 6. Engine API surface

### `wealth-navigator/src/lib/canvas/engine.ts`
- `Engine` type definition.
- `runEngine(engine, props)` — server-side engine execution.
- `validateEngine(engine)` — prop schema validation.

### `wealth-navigator/src/lib/canvas/registry.ts`
- `ENGINE_REGISTRY` — array of registered engine types.
- `getEngine(id)` — lookup.
- `registerEngine(engine)` — runtime registration (used by Build).

### `wealth-navigator/src/lib/canvas/layout.ts`
- `saveLayout(canvasId, layout)` — persists `canvas_layout_c`.
- `loadLayout(canvasId, userId)` — loads user's default layout.
- `resetLayout(canvasId, userId)` — resets to persona default.

### `wealth-navigator/src/lib/canvas/presence.ts`
- `trackPresence(canvasId, userId, persona, engineId)` — Realtime upsert.
- `untrackPresence(canvasId, userId)` — Realtime delete.

---

## 7. Canvas server routes

### `/api/canvas/layout/route.ts`
- `GET` — load user's default layout (per `user_id`).
- `POST` — save layout.

### `/api/canvas/engines/route.ts`
- `GET` — list registered engines.
- `POST` — register a new engine (admin-only).

### `/api/canvas/presence/route.ts`
- `POST` — heartbeat presence.
- `DELETE` — untrack presence.

### `/api/chatsight/ask/route.ts`
- `POST` — natural-language Q&A.
- Body: `{ question, context? }`.
- Response: `{ answer, engine_preview? }`.

### `/api/chatsight/build/route.ts`
- `POST` — structured prompt → engine.
- Body: `{ prompt }`.
- Response: `{ engine }`.

---

## 8. Canvas UI primitives

### `wealth-navigator/src/components/canvas/`
- `board.tsx` — pan/zoom board.
- `engine-card.tsx` — single engine card wrapper.
- `engine-grid.tsx` — grid layout.
- `engine-palette.tsx` — drag source.
- `presence.tsx` — live presence overlay.
- `chatsight-panel.tsx` — inline Ask/Build panel.
- `engine-types.ts` — shared types.
- `engine-renderers.tsx` — per-engine renderers (quote, chart, watchlist, …).
- `lib.ts` — utility functions.

### Visual primitives
- Reuses OEMS glass primitives (`wealth-navigator/src/components/oems/primitives/glass.tsx`).
- `GlassSection`, `GlassKpi`, `GlassSegment`.
- Theme: purple accent on white / dark slate-purple.

---

## 9. Persona integration

### Persona routing
- Canvas is **not persona-gated** — a single workspace for all operators.
- Default engines per persona:
  - `oems` → quote ticker, mini chart, watchlist, order pad, news feed.
  - `admin` → strategy card, calendar, audit log preview.
  - `wealth_manager` → strategy card, note card, news feed.
  - `strategist` → mini chart, note card, macro tile.
  - `business` → calendar, macro tile.
  - `funeral_cover` → calendar (placeholder).
- Default layout switches when the persona changes.

### Persona real-data gate
- Canvas renders real data only (no mock).
- The persona real-data gate (`wealth-navigator/src/components/oems/persona-real-data-gate.tsx`) does NOT apply to Canvas.

---

## 10. Open gaps (15)

1. **No engine export** — engines cannot be exported as JSON for sharing.
2. **No engine marketplace** — custom engines must be registered via `registerEngine()` admin API.
3. **No collaboration annotations** — operators cannot leave comments on engines.
4. **No engine alerts** — when an engine value crosses a threshold, no notification.
5. **No canvas templates** — only persona defaults; no curated templates (e.g., "Rate cycle", "Tech selloff").
6. **Chatsight Build is single-step** — no multi-turn engine refinement.
7. **No AI memory** — Chatsight Ask forgets context between sessions.
8. **Engine props not validated client-side** — server validates but client allows any input.
9. **Presence UI is overlay-only** — no minimap of where operators are.
10. **No keyboard shortcuts** — drag-and-drop is mouse-only.
11. **No canvas-level search** — finding an engine in a 50-engine canvas is hard.
12. **No engine telemetry** — operators can't see "this engine hasn't updated in 30s".
13. **No canvas history** — once an engine is deleted, it can't be recovered.
14. **No canvas sharing** — a layout is per-user; no way to share with another operator.
15. **No offline mode** — Canvas requires a live connection.

---

## 11. Build vs Ask — when to use which

| Use case | Surface |
|---|---|
| "What's NPN's last price?" | Ask |
| "Compare NPN vs MTN over 30 days" | Ask |
| "Add NPN to my watchlist" | Build |
| "Build me an engine that flags when VIX > 30" | Build |
| "Show me my open orders" | Engine (existing) |
| "Where are we on the SARB calendar?" | Engine (existing) |

---

## 12. Future work

- **Engine marketplace** — operators publish engines, others install.
- **Canvas templates** — curated layouts per workflow (rate cycle, selloff, earnings).
- **Multi-turn Chatsight** — refine engines iteratively.
- **Collaboration annotations** — comments pinned to engines.
- **Engine alerts** — threshold notifications.
- **Canvas sharing** — share layouts with team members.
- **Canvas-level search** — find engines by title / props.
- **Canvas history** — undo/redo.

---

*This doc is the Canvas deep-dive. Pair with Doc 8 (Models) for the quant-model engines and Doc 9 (API surface) for the BFF contracts.*
