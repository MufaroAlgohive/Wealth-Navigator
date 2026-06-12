import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ORIGINAL_ENV = { ...process.env };
const WORKER_KEYS = [
  "IRESS_WORKER_URL",
  "RAILWAY_SERVICE_URL",
  "USE_SUPABASE_QUOTES",
  "NEXT_PUBLIC_USE_SUPABASE_QUOTES",
];

function clearEnv() {
  for (const key of WORKER_KEYS) delete process.env[key];
}

afterEach(() => {
  clearEnv();
  process.env = { ...ORIGINAL_ENV };
  vi.restoreAllMocks();
});

describe("isIressWorkerConfigured / getIressWorkerUrl", () => {
  it("is false when neither IRESS_WORKER_URL nor RAILWAY_SERVICE_URL is set", async () => {
    clearEnv();
    const { isIressWorkerConfigured, getIressWorkerUrl } = await import(
      "@/lib/data-policy"
    );
    expect(isIressWorkerConfigured()).toBe(false);
    expect(getIressWorkerUrl()).toBe("");
  });

  it("prefers IRESS_WORKER_URL when both are set", async () => {
    clearEnv();
    process.env.IRESS_WORKER_URL = "https://worker-staging.example.com";
    process.env.RAILWAY_SERVICE_URL = "https://worker-prod.example.com";
    const { isIressWorkerConfigured, getIressWorkerUrl } = await import(
      "@/lib/data-policy"
    );
    expect(isIressWorkerConfigured()).toBe(true);
    expect(getIressWorkerUrl()).toBe("https://worker-staging.example.com");
  });

  it("falls back to RAILWAY_SERVICE_URL when IRESS_WORKER_URL is missing", async () => {
    clearEnv();
    process.env.RAILWAY_SERVICE_URL = "https://worker-prod.example.com";
    const { isIressWorkerConfigured, getIressWorkerUrl } = await import(
      "@/lib/data-policy"
    );
    expect(isIressWorkerConfigured()).toBe(true);
    expect(getIressWorkerUrl()).toBe("https://worker-prod.example.com");
  });

  it("trims trailing slashes", async () => {
    clearEnv();
    process.env.IRESS_WORKER_URL = "https://worker.example.com///";
    const { getIressWorkerUrl } = await import("@/lib/data-policy");
    expect(getIressWorkerUrl()).toBe("https://worker.example.com");
  });

  it("treats an empty IRESS_WORKER_URL as not configured", async () => {
    clearEnv();
    process.env.IRESS_WORKER_URL = "   ";
    const { isIressWorkerConfigured, getIressWorkerUrl } = await import(
      "@/lib/data-policy"
    );
    expect(isIressWorkerConfigured()).toBe(false);
    expect(getIressWorkerUrl()).toBe("");
  });
});

describe("isWorkerLiveMode vs isProductionRealDataMode", () => {
  it("isWorkerLiveMode is false when USE_SUPABASE_QUOTES is unset", async () => {
    clearEnv();
    const { isWorkerLiveMode, isProductionRealDataMode } = await import(
      "@/lib/data-policy"
    );
    expect(isWorkerLiveMode()).toBe(false);
    expect(isProductionRealDataMode()).toBe(false);
  });

  it("isWorkerLiveMode flips to true when USE_SUPABASE_QUOTES=1 (server-side check)", async () => {
    clearEnv();
    process.env.USE_SUPABASE_QUOTES = "1";
    const { isWorkerLiveMode, isProductionRealDataMode } = await import(
      "@/lib/data-policy"
    );
    expect(isWorkerLiveMode()).toBe(true);
    // Client mirror (NEXT_PUBLIC_USE_SUPABASE_QUOTES) is separate — when only
    // the server flag is set, the client mirror stays false.
    expect(isProductionRealDataMode()).toBe(false);
  });

  it("both flags flip together when both env vars are set", async () => {
    clearEnv();
    process.env.USE_SUPABASE_QUOTES = "true";
    process.env.NEXT_PUBLIC_USE_SUPABASE_QUOTES = "true";
    const { isWorkerLiveMode, isProductionRealDataMode } = await import(
      "@/lib/data-policy"
    );
    expect(isWorkerLiveMode()).toBe(true);
    expect(isProductionRealDataMode()).toBe(true);
  });

  it("accepts 'true' as well as '1'", async () => {
    clearEnv();
    process.env.USE_SUPABASE_QUOTES = "true";
    const { isWorkerLiveMode } = await import("@/lib/data-policy");
    expect(isWorkerLiveMode()).toBe(true);
  });
});

describe("callWorker", () => {
  beforeEach(() => {
    clearEnv();
    process.env.IRESS_WORKER_URL = "https://worker.example.com";
  });

  it("returns 503 not_configured when the worker URL is missing", async () => {
    clearEnv();
    const { callWorker } = await import("@/lib/iress/worker-api");
    const result = await callWorker<{ ok: boolean }>({ path: "/orders" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(503);
      expect(result.code).toBe("not_configured");
    }
  });

  it("returns ok=true with the parsed JSON body on a 200", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true, orders: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { callWorker } = await import("@/lib/iress/worker-api");
    const result = await callWorker<{ ok: boolean; orders: unknown[] }>({
      path: "/orders?account=ACC1",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.body.orders).toEqual([]);
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const calledUrl = fetchMock.mock.calls[0]?.[0] as string;
    expect(calledUrl).toBe("https://worker.example.com/orders?account=ACC1");
  });

  it("strips the trailing slash from the worker URL when building paths", async () => {
    process.env.IRESS_WORKER_URL = "https://worker.example.com/";
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { callWorker } = await import("@/lib/iress/worker-api");
    await callWorker({ path: "/orders" });
    const calledUrl = fetchMock.mock.calls[0]?.[0] as string;
    expect(calledUrl).toBe("https://worker.example.com/orders");
  });

  it("returns upstream_error with the parsed JSON body when the worker 4xx/5xx", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ ok: false, error: "Order account code not configured" }),
        { status: 503, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { callWorker } = await import("@/lib/iress/worker-api");
    const result = await callWorker<{ ok: boolean }>({ path: "/orders?account=ACC1" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(503);
      expect(result.code).toBe("upstream_error");
      expect(result.upstreamStatus).toBe(503);
      expect(result.errorBody).toEqual({ ok: false, error: "Order account code not configured" });
    }
  });

  it("returns unreachable when fetch throws", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    vi.stubGlobal("fetch", fetchMock);
    const { callWorker } = await import("@/lib/iress/worker-api");
    const result = await callWorker({ path: "/health" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("unreachable");
      expect(result.status).toBe(503);
      expect(result.error).toContain("ECONNREFUSED");
    }
  });

  it("returns timeout when the worker does not respond in time", async () => {
    // fetch that never resolves until the AbortController fires
    const fetchMock = vi.fn().mockImplementation(
      (_url: string, init?: RequestInit) =>
        new Promise((_, reject) => {
          const signal = init?.signal as AbortSignal | undefined;
          if (signal) {
            signal.addEventListener("abort", () => {
              const err = new Error("aborted");
              err.name = "AbortError";
              reject(err);
            });
          }
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { callWorker } = await import("@/lib/iress/worker-api");
    const result = await callWorker({ path: "/orders", timeoutMs: 10 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("timeout");
      expect(result.status).toBe(504);
    }
  });

  it("sends Accept: application/json and sets cache: no-store", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { callWorker } = await import("@/lib/iress/worker-api");
    await callWorker({ path: "/health" });
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect((init.headers as Record<string, string>).Accept).toBe("application/json");
    expect(init.cache).toBe("no-store");
  });
});

describe("streamWorkerSse", () => {
  beforeEach(() => {
    clearEnv();
    process.env.IRESS_WORKER_URL = "https://worker.example.com";
  });

  it("returns null when the worker URL is missing", async () => {
    clearEnv();
    const { streamWorkerSse } = await import("@/lib/iress/worker-api");
    expect(streamWorkerSse({ path: "/orders/stream" })).toBeNull();
  });

  it("builds the upstream URL with the right Accept header when configured", async () => {
    const { streamWorkerSse } = await import("@/lib/iress/worker-api");
    const target = streamWorkerSse({ path: "/orders/stream?account=ACC1" });
    expect(target).not.toBeNull();
    expect(target?.url).toBe("https://worker.example.com/orders/stream?account=ACC1");
    expect(target?.headers.Accept).toBe("text/event-stream");
  });
});
