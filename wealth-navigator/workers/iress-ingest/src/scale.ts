/**
 * Reference-anchored price scaling for JSE quotes.
 *
 * The implementation now lives in the shared module `src/lib/iress/price-scale`
 * so the Vercel BFF chart routes and this worker use the SAME cents/Rand
 * disambiguation (single source of truth). This file re-exports it so the
 * worker's existing `./scale` imports (retail-ingest, quotes, tests, the
 * validate-scaling script) keep working unchanged.
 *
 * See `src/lib/iress/price-scale.ts` for the full rationale (the 2026-06-13/14
 * coverage probe found 121/128 symbols 100× off without anchoring).
 */

export { chooseDisplayCents, anchorHistoryToRands } from "../../../src/lib/iress/price-scale";
export type { CentsChoice, AnchoredSeries } from "../../../src/lib/iress/price-scale";
