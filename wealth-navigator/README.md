# Mint Wealth Navigator · v2.0

The production rebuild of the Mint OEMS (Order & Execution Management System) trading desk + wealth platform. Built on **Next.js 15 (App Router) + React 19 + Bun + TypeScript strict + Tailwind 3 + shadcn/ui**.

> See [`PLANNING.md`](../PLANNING.md) for the full rebuild plan, IRESS V4 integration shape, and design language.

## Quick start

```bash
bun install
bun run dev          # http://localhost:3000
```

Other commands:

```bash
bun run build        # production build
bun run start        # serve the production build
bun run typecheck    # tsc --noEmit
bun run lint         # biome check
bun run format       # biome format --write
bun run test         # vitest (unit)
bun run test:e2e     # playwright (smoke)
```

## What's in the box

- **OEMS trading desk** (Cockpit, Blotter, Strategies, Equities, Fixed Income, Money Market, Curves, Macro, News, Security Lookup, Integration Health)
- **IRESS V4 client adapter** with a typed mock implementation, ready to swap to a live SOAP connection the day creds land.
- **Real-time tick stream** via SSE (no IRESS connection required for the demo).
- **Role switcher** that previews all personas (the v2.0 build lights up `oems`; other roles are placeholders).

## Repo layout

```
src/
├── app/                # Next.js App Router
│   ├── oems/           # trading desk
│   ├── (personas)/     # wm, strategist, business, admin, fc
│   └── api/            # /api/ticks SSE endpoint
├── components/
│   ├── ui/             # shadcn primitives
│   ├── oems/           # trading-desk components
│   └── shared/
├── lib/
│   ├── iress/          # IRESS V4 client (interface + mock)
│   ├── store/          # zustand stores
│   └── format.ts
├── hooks/              # use-tick, use-iress, use-keyboard-shortcut
└── types/
```

## IRESS integration

`src/lib/iress/index.ts` exposes a single `iress` object. The implementation is selected by `IRESS_MODE`:

- `mock` — in-process, deterministic. Default for dev.
- `live` — real IRESS SOAP. Needs `IRESS_*` env vars and creds.
- `wsdl-stub` — for tests that hit a saved WSDL.

Every UI panel that fetches data shows its IRESS V4 method on hover (see the `endpoint` prop on `<Panel />`).
