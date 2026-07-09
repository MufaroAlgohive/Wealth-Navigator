/**
 * `IrisProvider` — stub for the planned IRIS (Indices/Rates/IRIS-S) feed
 * that the Research Lab will eventually pivot to for ALSI/J203/sector
 * curves and the SENS/news panels.
 *
 * Today it reports `unconfigured` everywhere so the BFFs degrade to
 * honest empty states and the UI badge renders `IRIS · UNCONFIGURED`
 * instead of fabricating data.
 */

import type { Bar, MarketDataProvider, ProviderHealth, ProviderQuote } from "./types";

export class IrisProvider implements MarketDataProvider {
  readonly name = "iris" as const;

  async fetchQuotes(_symbols: string[]): Promise<ProviderQuote[]> {
    return [];
  }

  async fetchIntraday(_symbol: string): Promise<Bar[]> {
    return [];
  }

  async fetchHistory(
    _symbol: string,
    _range: "1D" | "5D" | "1M" | "3M" | "6M" | "1Y" | "5Y",
  ): Promise<Bar[]> {
    return [];
  }

  async fetchSnapshot(_symbol: string): Promise<ProviderQuote | null> {
    return null;
  }

  async health(): Promise<ProviderHealth> {
    return {
      status: "unconfigured",
      message: "IRIS provider not configured (planned for Research Lab follow-up)",
      lastChecked: new Date().toISOString(),
    };
  }
}
