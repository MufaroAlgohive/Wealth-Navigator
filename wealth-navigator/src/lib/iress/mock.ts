// Mock implementation of the IRESS V4 client.
// Returns deterministic, realistic data shaped exactly like the live V4
// responses. UI code never imports this directly — it uses `lib/iress/index.ts`.

import {
  bonds,
  endpoints,
  endpointHealth,
  fxQuotes,
  globalIndices,
  initialQuotes,
  jibarFixings,
  jseEquities,
  macroCalendar,
  macroIndicators,
  macroReleases,
  mmInstruments,
  newsFeed,
  oemsStrategies,
  orders,
  sectorHeatmap,
  sensFeed,
  strategyHoldings,
  zarBreakeven,
  zarGoviCurve,
  zarRealCurve,
  zarSwapCurve,
  zaronia,
} from "@/lib/iress/seed";
import { IressError } from "@/lib/iress/errors";
import type {
  IressClient,
  IressResponse,
  IressSessionStartRequest,
  IressSessionStartResponse,
  NewOrder,
  OrderCreate3Request,
  OrderCreate3Response,
  PricingQuoteGetRequest,
  ServiceSessionStartRequest,
  ServiceSessionStartResponse,
} from "@/lib/iress/client";
import type {
  Bond,
  Holding,
  MacroIndicator,
  MacroRelease,
  NewsItem,
  Order,
  Quote,
  SensItem,
  Strategy,
} from "@/types/iress";
import type { IndexQuote, SectorPerf } from "@/lib/iress/seed";

// In-memory store of orders so creates/amends/cancels mutate the same surface
// the UI reads. (Server actions / API routes would replicate this on the
// server in production.)
const liveOrders: Order[] = orders.map((o) => ({ ...o }));
const liveQuotes: Record<string, Quote> = initialQuotes();

function rid(prefix: string) {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}-${Date.now().toString(36)}`;
}

function ok<T>(rows: T[], statusCode: 1 | 2 | 3 = 2): IressResponse<T> {
  return {
    Header: { StatusCode: statusCode, ErrorNumber: 0 },
    DataRows: rows,
  };
}

function quoteForSecurity(code: string, exchange: string): Quote {
  const codeUpper = code.toUpperCase();
  // FX cross-currency rates (USDZAR, EURZAR, etc.).
  // The IRESS reference-data maps a "USD/ZAR" symbol to its `fxQuotes`
  // entry under the same key (the "/" stripped); the worker watchlist
  // uses the unslashed form (`USDZAR`) which is the canonical code
  // PricingQuoteGet accepts.
  if (exchange === "FX" || codeUpper.startsWith("USD") || codeUpper.includes("ZAR") || codeUpper.startsWith("EUR") || codeUpper.startsWith("GBP") || codeUpper.startsWith("AUD") || codeUpper.startsWith("JPY")) {
    const pair = codeUpper.includes("/") ? codeUpper : `${codeUpper.slice(0, 3)}/${codeUpper.slice(3)}`;
    const fx = fxQuotes.find((f) => f.pair.toUpperCase() === pair);
    if (fx) {
      return {
        symbol: codeUpper,
        last: fx.last,
        prevClose: +(fx.last - fx.change).toFixed(4),
        change: fx.change,
        changePct: fx.changePct,
        bid: fx.last - 0.0008,
        ask: fx.last + 0.0008,
        bidSize: 0,
        askSize: 0,
        open: fx.last,
        high: fx.last,
        low: fx.last,
        close: fx.last,
        volume: 0,
        vwap: fx.last,
        currency: pair.endsWith("ZAR") ? "ZAR" : "USD",
        marketState: "OPEN",
        ts: Date.now(),
      };
    }
  }
  // Money-market rate codes (JIBAR_3M, etc.).
  if (exchange === "MM" || codeUpper.startsWith("JIBAR") || codeUpper === "ZARONIA" || codeUpper === "SARB_REPO") {
    let rate: number | undefined;
    let prev: number | undefined;
    if (codeUpper.startsWith("JIBAR_")) {
      const tenor = codeUpper.replace("JIBAR_", "");
      const fix = jibarFixings.find((f) => f.tenor.replace(/\/.*/, "").toUpperCase() === tenor || f.tenor.toUpperCase() === tenor);
      if (fix) { rate = fix.rate; prev = fix.prev; }
    } else if (codeUpper === "ZARONIA") {
      rate = zaronia.value;
      prev = zaronia.prev;
    }
    if (rate != null && prev != null) {
      return {
        symbol: codeUpper,
        last: rate,
        prevClose: prev,
        change: +(rate - prev).toFixed(4),
        changePct: prev > 0 ? +(((rate - prev) / prev) * 100).toFixed(4) : 0,
        bid: rate,
        ask: rate,
        bidSize: 0,
        askSize: 0,
        open: rate,
        high: rate,
        low: rate,
        close: prev,
        volume: 0,
        vwap: rate,
        currency: "ZAR",
        marketState: "OPEN",
        ts: Date.now(),
      };
    }
  }
  // JSE equities — `liveQuotes` is seeded; if missing, fabricate.
  const direct = liveQuotes[code];
  if (direct) return { ...direct, marketState: "OPEN" };
  // Try to map codes like NPN.JSE to NPN
  const stripped = code.replace(/\.JSE$/i, "").replace(/^JSE:+/i, "");
  return liveQuotes[stripped] ?? {
    symbol: stripped || code,
    last: 0, bid: 0, ask: 0, bidSize: 0, askSize: 0,
    open: 0, high: 0, low: 0, close: 0, prevClose: 0,
    change: 0, changePct: 0, volume: 0, vwap: 0,
    currency: exchange === "JSE" ? "ZAR" : "USD",
    marketState: "HALT",
    ts: Date.now(),
  };
}

export const mockIressClient: IressClient = {
  // ── session ────────────────────────────────────────────────────
  async iressSessionStart(req: IressSessionStartRequest): Promise<IressSessionStartResponse> {
    if (!req.UserName || !req.Password) {
      throw new IressError(25001, "IRESSSessionStart", "Missing credentials");
    }
    if (req.SessionNumberToKick === -1) {
      // Force-close: always allowed in the mock
    }
    return {
      IRESSSessionKey: `MOCK-${rid("K")}@WebServicesCT.iress.co.za`,
      SessionNumber: 1 + Math.floor(Math.random() * 8),
      SessionTimeout: req.SessionTimeout ?? 120,
      ApplicationID: req.ApplicationID,
    };
  },

  async iressSessionEnd() { /* noop */ },

  async serviceSessionStart(req: ServiceSessionStartRequest): Promise<ServiceSessionStartResponse> {
    return {
      ServiceSessionKey: `MOCK-${rid("S")}`,
      Service: req.Service,
      Server: req.Server,
    };
  },

  async serviceSessionEnd() { /* noop */ },

  // ── market data ────────────────────────────────────────────────
  async pricingQuoteGet(req: PricingQuoteGetRequest) {
    const q = quoteForSecurity(req.SecurityCode, req.Exchange);
    return ok<Quote>([q], req.Updates ? 3 : 2);
  },

  async pricingQuoteGetUpdates({ RequestID }) {
    return ok<Quote>([], 3);
  },

  async timeSeriesGet2(req) {
    // Map known codes → curves
    if (req.Code === "ZAR_NSS" || req.Code === "ZAR_GOVI") {
      return ok(zarGoviCurve.map((p, i) => ({ t: Date.now() - (zarGoviCurve.length - 1 - i) * 30 * 86400_000, v: p.yield })));
    }
    if (req.Code === "ZAR_SWAP") {
      return ok(zarSwapCurve.map((p, i) => ({ t: Date.now() - (zarSwapCurve.length - 1 - i) * 30 * 86400_000, v: p.yield })));
    }
    if (req.Code === "ZAR_REAL" || req.Code === "ZAR_ILB") {
      return ok(zarRealCurve.map((p, i) => ({ t: Date.now() - (zarRealCurve.length - 1 - i) * 30 * 86400_000, v: p.yield })));
    }
    if (req.Code === "ZARONIA") {
      return ok([
        { t: Date.now() - 86_400_000, v: zaronia.prev },
        { t: Date.now(), v: zaronia.value },
      ]);
    }
    if (req.Code.startsWith("JIBAR_") || req.Code === "JIBAR") {
      return ok(jibarFixings.map((f) => ({ t: Date.now(), v: f.rate })));
    }
    // ALSI intraday-ish
    if (req.Code === "J203" || req.Code === "ALSI") {
      const base = globalIndices.find((i) => i.code === "J203")?.last ?? 87412;
      return ok(Array.from({ length: 78 }, (_, i) => ({
        t: Date.now() - (78 - i) * 60_000,
        v: +(base * (1 + (Math.sin(i / 4) * 0.0025) + (i / 78) * 0.0048)).toFixed(2),
      })));
    }
    return ok([]);
  },

  async timeSeriesGet2Updates() { return ok([], 3); },

  // Reference-data search — mock returns no rows (the live worker is the only
  // caller; the UI never searches in mock mode).
  async securitySearchGet() { return ok([]); },

  // ── trading ────────────────────────────────────────────────────
  async orderCreate3(req: OrderCreate3Request): Promise<OrderCreate3Response> {
    // Idempotency: if a live order with the same OrderTag already exists, return it
    const existing = liveOrders.find((o) => o.orderTag === req.OrderTag);
    if (existing) {
      return { OrderNumber: existing.id, Status: "WORKING" };
    }
    const o: Order = {
      id: `ORD-${44_300 + liveOrders.length}`,
      account: req.Order.AccountCode,
      strategy: "(unspecified)",
      side: req.Order.BuySell === 1 ? "BUY" : "SELL",
      symbol: req.Order.SecurityCode,
      isin: jseEquities.find((e) => e.symbol === req.Order.SecurityCode)?.isin ?? "ZZZ",
      type: req.Order.OrderType,
      tif: req.Order.TimeInForce,
      destination: (req.Order.Destination as Order["destination"]) ?? "JSE",
      qty: req.Order.Volume,
      filled: 0,
      limit: req.Order.Price ?? null,
      stop: req.Order.TriggerPrice ?? null,
      avgPx: 0,
      vwap: req.Order.Price ?? 0,
      trader: "(current user)",
      ts: Date.now(),
      state: "WORKING",
      slippageBps: 0,
      arrivalMid: req.Order.Price ?? 0,
      orderTag: req.OrderTag,
    };
    liveOrders.unshift(o);
    return { OrderNumber: o.id, Status: "WORKING" };
  },

  async orderAmend2({ OrderNumber, Volume, Price }) {
    const o = liveOrders.find((x) => x.id === OrderNumber);
    if (!o) throw new IressError(25029, "OrderAmend2");
    if (o.state === "FILLED" || o.state === "CANCELLED") {
      throw new IressError(25030, "OrderAmend2", `Cannot amend order in state ${o.state}`);
    }
    if (Volume !== undefined) o.qty = Volume;
    if (Price !== undefined) o.limit = Price;
    return { OrderNumber };
  },

  async orderDelete({ OrderNumber }) {
    const o = liveOrders.find((x) => x.id === OrderNumber);
    if (!o) throw new IressError(25029, "OrderDelete");
    if (o.state === "FILLED") throw new IressError(25031, "OrderDelete");
    o.state = "CANCELLED";
  },

  async orderNoGetByOrderTag({ OrderTag }) {
    const o = liveOrders.find((x) => x.orderTag === OrderTag);
    if (!o) return { OrderNumber: "", OrderTag };
    return { OrderNumber: o.id, OrderTag };
  },

  async orderPadGetByAccount({ AccountCode, OrderFilter, Updates: _u, RequestID: _r }) {
    let rows = liveOrders.filter((o) => o.account === AccountCode);
    if (OrderFilter === 1) rows = rows.filter((o) => o.state === "WORKING" || o.state === "PARTIAL");
    if (OrderFilter === 2) rows = rows.filter((o) => o.state === "FILLED" || o.state === "PARTIAL");
    if (OrderFilter === 4) rows = rows.filter((o) => o.state === "CANCELLED" || o.state === "REJECTED");
    return ok<Order>(rows, 2);
  },

  async orderPadGetByAccountUpdates() {
    return ok<Order>([], 3);
  },

  async bookingGetByOrganisation2({ From, To }) {
    const rows = liveOrders
      .filter((o) => o.state === "FILLED" || o.state === "PARTIAL")
      .filter((o) => o.ts >= new Date(From).getTime() && o.ts <= new Date(To).getTime())
      .map((o) => ({
        BookingNumber: `BK-${o.id}`,
        TradeNumber: `TR-${o.id}`,
        Symbol: o.symbol,
        BuySell: o.side,
        Volume: o.filled,
        Price: o.avgPx,
        MiscFees: [
          { Code: "STAMP", Amount: +(o.avgPx * o.filled * 0.0002).toFixed(2), Currency: "ZAR" },
          { Code: "BROKERAGE", Amount: +(o.avgPx * o.filled * 0.005).toFixed(2), Currency: "ZAR" },
        ],
      }));
    return ok(rows);
  },

  // ── portfolio ──────────────────────────────────────────────────
  async ipsTransactionGetByAccount5({ AccountCode, DateFrom, DateTo }) {
    const rows = liveOrders
      .filter((o) => o.account === AccountCode)
      .filter((o) => o.state === "FILLED" || o.state === "PARTIAL")
      .filter((o) => o.ts >= new Date(DateFrom).getTime() && o.ts <= new Date(DateTo).getTime())
      .map((o) => ({
        TransactionNumber: `TX-${o.id}`,
        Date: new Date(o.ts).toISOString().slice(0, 10),
        Type: o.side === "BUY" ? "BUY" : "SELL",
        Symbol: o.symbol,
        Quantity: o.filled,
        Price: o.avgPx,
        Amount: +(o.avgPx * o.filled * (o.side === "BUY" ? 1 : -1)).toFixed(2),
        Currency: "ZAR",
      }));
    return ok(rows);
  },

  // Deterministic seed accounts used by the mock. Two of these are
  // referenced from the order book so the UI / API line up.
  async ipsAccountGetAll1({ PreviousAccountCode }: { ServiceSessionKey: string; PageSize?: number; PreviousAccountCode?: string }) {
    const all = [
      {
        AccountCode: "Z12345",
        AccountName: "MINT Wealth Navigator Trading Account",
        AccountType: "MARGIN",
        Currency: "ZAR",
        BaseCurrency: "ZAR",
        Beneficiary: "MINT Wealth (Pty) Ltd",
        AccountStatus: "ACTIVE",
        OpenDate: "2024-01-15",
        NetAssetValue: 18_475_322.40,
        CashBalance: 2_108_554.20,
      },
      {
        AccountCode: "Z12346",
        AccountName: "MINT Wealth Navigator Income Account",
        AccountType: "SETTLEMENT",
        Currency: "ZAR",
        BaseCurrency: "ZAR",
        Beneficiary: "MINT Wealth (Pty) Ltd",
        AccountStatus: "ACTIVE",
        OpenDate: "2024-01-15",
        NetAssetValue: 5_211_700.10,
        CashBalance: 1_402_200.00,
      },
      {
        AccountCode: "Z12347",
        AccountName: "MINT Wealth Navigator Bond Account",
        AccountType: "CUSTODY",
        Currency: "ZAR",
        BaseCurrency: "ZAR",
        Beneficiary: "MINT Wealth (Pty) Ltd",
        AccountStatus: "ACTIVE",
        OpenDate: "2024-02-01",
        NetAssetValue: 9_044_188.55,
        CashBalance: 388_120.00,
      },
    ];
    // Honor the legacy cursor (page-through, no full flatten in mock).
    const start = PreviousAccountCode
      ? all.findIndex((a) => a.AccountCode === PreviousAccountCode) + 1
      : 0;
    return ok(all.slice(start));
  },

  async ipsPositionGetAll1({ AccountCode, PreviousSecurityCode }: { ServiceSessionKey: string; PageSize?: number; PreviousSecurityCode?: string; AccountCode?: string }) {
    // Build a flat position list from the strategy-holdings seed, attributing
    // every holding to the trading account (Z12345) — the mock simulates a
    // single-portfolio view. `initialQuotes` is a function returning a
    // `Record<symbol, Quote>`; `strategyHoldings` is a
    // `Record<strategyId, Holding[]>`.
    const quotes = initialQuotes();
    const flatHoldings = Object.values(strategyHoldings).flat();
    const all = flatHoldings.map((h) => {
      const last = quotes[h.symbol]?.last ?? 0;
      return {
        AccountCode: AccountCode ?? "Z12345",
        SecurityCode: h.symbol,
        Exchange: "JSE",
        Quantity: h.qty,
        OpenAveragePrice: h.mv / Math.max(h.qty, 1), // cost basis derived from market value
        MarketValue: h.mv,
        OpenPL: +(h.mv * 0.08).toFixed(2), // seed an indicative open P&L (8% gain)
        Currency: "ZAR",
        OpenDate: "2025-08-15",
      };
    });
    const start = PreviousSecurityCode
      ? all.findIndex((p) => p.SecurityCode === PreviousSecurityCode) + 1
      : 0;
    return ok(all.slice(start));
  },

  // ── FIX+ ───────────────────────────────────────────────────────
  async targetIdGet() {
    return [{ TargetID: "MINT-DROPCOPY-01" }];
  },
  async targetIdStatusGet({ TargetID }) {
    return { TargetID, Status: "CONNECTED", LastSeq: 12_412_004 };
  },
};

// Convenience: typed query helpers that wrap the client + return plain data
// (not the full response envelope). UI code uses these.

export const iressQueries = {
  sectors: async (): Promise<SectorPerf[]> => sectorHeatmap,
  indices: async (): Promise<IndexQuote[]> => globalIndices,
  fx: async () => fxQuotes,
  commodities: async () => liveQuotes,
  jseEquities: async () => jseEquities,
  bonds: async (): Promise<Bond[]> => bonds,
  zarGoviCurve: async () => zarGoviCurve,
  zarSwapCurve: async () => zarSwapCurve,
  zarRealCurve: async () => zarRealCurve,
  zarBreakeven: async () => zarBreakeven,
  jibarFixings: async () => jibarFixings,
  zaronia: async () => zaronia,
  mmInstruments: async (): Promise<typeof mmInstruments> => mmInstruments,
  macroCalendar: async (): Promise<MacroRelease[]> => macroCalendar,
  macroReleases: async () => macroReleases,
  macroIndicators: async (): Promise<MacroIndicator[]> => macroIndicators,
  strategies: async (): Promise<Strategy[]> => oemsStrategies,
  strategyHoldings: async (strategyId: string): Promise<Holding[]> => strategyHoldings[strategyId] ?? [],
  orders: async (): Promise<Order[]> => liveOrders,
  news: async (): Promise<NewsItem[]> => newsFeed,
  sens: async (): Promise<SensItem[]> => sensFeed,
  endpointHealth: async () => endpointHealth,
  endpoints: async () => endpoints,
  quote: quoteForSecurity,
};

// Re-export NewOrder so app code doesn't need to import from /client.
export type { NewOrder };
