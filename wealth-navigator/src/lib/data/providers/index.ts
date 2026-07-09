/**
 * Provider registry + selector.
 *
 * The active provider is controlled by `ACTIVE_MARKET_DATA_PROVIDER` (see
 * `data-policy.ts` for the default-resolution order). Tests can swap the
 * active provider with `setActiveProviderForTesting()` in `data-policy`
 * without touching `process.env`. The registry is process-local; reset
 * between test cases.
 */

import { IressProvider } from "./iress";
import { IrisProvider } from "./iris";
import { MockProvider } from "./mock";
import type { MarketDataProvider, ProviderName } from "./types";
import { YahooProvider } from "./yahoo";

const REGISTRY = new Map<ProviderName, MarketDataProvider>();
let cachedActive: { name: ProviderName; provider: MarketDataProvider } | null = null;

function ensureRegistered(): void {
  if (REGISTRY.size === 0) {
    REGISTRY.set("iress", new IressProvider());
    REGISTRY.set("yahoo", new YahooProvider());
    REGISTRY.set("mock", new MockProvider());
    REGISTRY.set("iris", new IrisProvider());
  }
}

/**
 * Resolve the provider name the BFFs should call. Reads
 * `ACTIVE_MARKET_DATA_PROVIDER` (with a safe `mock` default) and respects
 * the test override in `data-policy`. `mock` is the safe default — the
 * original behaviour of the app before the provider abstraction was added.
 */
export function getActiveProviderName(): ProviderName {
  const explicit = (process.env.ACTIVE_MARKET_DATA_PROVIDER ?? "").toLowerCase();
  if (explicit === "iress" || explicit === "yahoo" || explicit === "mock" || explicit === "iris") {
    return explicit;
  }
  return "mock";
}

/**
 * Singleton selector — caches the provider instance per name so the
 * underlying HTTP clients / IRESS sessions are reused across calls.
 */
export function getActiveProvider(): MarketDataProvider {
  ensureRegistered();
  const name = getActiveProviderName();
  if (cachedActive && cachedActive.name === name) return cachedActive.provider;
  const provider = REGISTRY.get(name) ?? REGISTRY.get("mock");
  if (!provider) {
    throw new Error(`No providers registered (active=${name})`);
  }
  cachedActive = { name, provider };
  return provider;
}

/** Look up a provider by name (e.g. for per-route overrides in tests). */
export function getProvider(name: ProviderName): MarketDataProvider {
  ensureRegistered();
  const provider = REGISTRY.get(name) ?? REGISTRY.get("mock");
  if (!provider) {
    throw new Error(`No providers registered (requested=${name})`);
  }
  return provider;
}

/** Register a custom provider under `name` (used by tests and overrides). */
export function registerProvider(name: ProviderName, provider: MarketDataProvider): void {
  ensureRegistered();
  REGISTRY.set(name, provider);
  cachedActive = null;
}

export type { MarketDataProvider, ProviderName, ProviderQuote, Bar, ProviderHealth } from "./types";
