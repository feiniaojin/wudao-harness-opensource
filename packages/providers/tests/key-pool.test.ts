// M56 §1 — the multi-key pool (the upstream project llm/key_pool.py paradigm). Domestic
// providers rate-limit PER KEY; a pool rotates round-robin and puts a key
// that just took a 429 into a 60s cooldown, skipping it until the cooldown
// lapses. When every key is cooling, selection returns the key whose
// cooldown expires SOONEST (minimal delay, no sleep required — the caller
// proceeds and the retry ladder absorbs the wait).
import { describe, it, expect } from "vitest";
import { createKeyPool, createLiveKeyPool, DEFAULT_KEY_COOLDOWN_MS, DEFAULT_AUTH_COOLDOWN_MS, cooldownClassForStatus, parseApiKeyPool, createOpenAICompatibleProvider, createAnthropicProvider, resolveProviderConfigResult } from "../src/index.js";
import type { ProviderConfig } from "../src/index.js";

describe("createKeyPool — rotation", () => {
  it("round-robins across keys in order", () => {
    const pool = createKeyPool(["a", "b", "c"]);
    expect([pool.select(), pool.select(), pool.select(), pool.select()]).toEqual(["a", "b", "c", "a"]);
  });

  it("dedupes and throws on an empty pool", () => {
    const pool = createKeyPool(["a", "a", "b"]);
    expect(pool.size).toBe(2);
    expect(pool.select()).toBe("a");
    expect(pool.select()).toBe("b");
    expect(() => createKeyPool([])).toThrow();
    expect(() => createKeyPool(["", "  "])).toThrow();
  });

  it("a one-key pool always returns that key (single-key configs unchanged)", () => {
    const pool = createKeyPool(["only"]);
    pool.markCooldown("only");
    expect(pool.select()).toBe("only");
  });
});

describe("createKeyPool — cooldown", () => {
  it("skips cooling keys (rotation continues over the rest)", () => {
    let t = 1_000;
    const pool = createKeyPool(["a", "b", "c"], { now: () => t });
    expect(pool.select()).toBe("a");
    pool.markCooldown("a");
    expect(pool.snapshot()).toEqual({ total: 3, available: 2, cooling: 1 });
    expect([pool.select(), pool.select(), pool.select()]).toEqual(["b", "c", "b"]);
  });

  it("a key becomes available again once its cooldown lapses", () => {
    let t = 1_000;
    const pool = createKeyPool(["a", "b"], { now: () => t, cooldownMs: 60_000 });
    pool.markCooldown("a");
    t += 60_001;
    expect(pool.snapshot()).toEqual({ total: 2, available: 2, cooling: 0 });
    expect(pool.select()).toBe("a");
  });

  it("all cooling → the soonest-expiring key wins", () => {
    let t = 1_000;
    const pool = createKeyPool(["a", "b", "c"], { now: () => t, cooldownMs: 60_000 });
    pool.markCooldown("a"); // expires t+60k
    t += 10_000;
    pool.markCooldown("b"); // expires t'+60k = t+70k
    t += 10_000;
    pool.markCooldown("c"); // expires t''+60k = t+80k
    expect(pool.snapshot().available).toBe(0);
    // a expires first → a is the minimal-delay pick, twice in a row.
    expect(pool.select()).toBe("a");
    expect(pool.select()).toBe("a");
  });

  it("markCooldown on an unknown key is a no-op", () => {
    const pool = createKeyPool(["a"]);
    expect(() => pool.markCooldown("zzz")).not.toThrow();
    expect(pool.snapshot()).toEqual({ total: 1, available: 1, cooling: 0 });
  });

  it("default cooldown is 60s (WUDAO key cooldown contract)", () => {
    expect(DEFAULT_KEY_COOLDOWN_MS).toBe(60_000);
  });
});

describe("parseApiKeyPool — env shape", () => {
  it("WUDAO_API_KEYS (comma-separated) + WUDAO_API_KEY = one deduped pool, primary first", () => {
    expect(parseApiKeyPool({ WUDAO_API_KEYS: "k1, k2,,k1", WUDAO_API_KEY: "k0" })).toEqual(["k0", "k1", "k2"]);
  });

  it("WUDAO_API_KEYS alone is a pool; OPENAI_API_KEY is the fallback primary", () => {
    expect(parseApiKeyPool({ WUDAO_API_KEYS: "k1,k2" })).toEqual(["k1", "k2"]);
    expect(parseApiKeyPool({ OPENAI_API_KEY: "ok" })).toEqual(["ok"]);
    expect(parseApiKeyPool({ WUDAO_API_KEY: "w", OPENAI_API_KEY: "o" })).toEqual(["w"]);
  });

  it("empty env → empty pool (resolution keeps failing with NO_KEY_REASON)", () => {
    expect(parseApiKeyPool({})).toEqual([]);
    expect(parseApiKeyPool({ WUDAO_API_KEYS: " ,," })).toEqual([]);
  });

  it("resolveProviderConfigResult exposes the pool as apiKeys with apiKey = the primary", () => {
    const r = resolveWithKeys();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.config.apiKeys).toEqual(["k0", "k1", "k2"]);
    expect(r.config.apiKey).toBe("k0");
  });

  it("single-key env keeps the historical one-element shape", () => {
    const r = resolveProviderConfigSingle();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.config.apiKeys).toEqual(["solo"]);
  });
});

function resolveWithKeys() {
  return resolveProviderConfigResult({ WUDAO_API_KEYS: "k1,k2", WUDAO_API_KEY: "k0" });
}

function resolveProviderConfigSingle() {
  return resolveProviderConfigResult({ WUDAO_API_KEY: "solo" });
}

// ---------------------------------------------------------------------------
// Provider integration: the pool rides the request boundary. A 429 (rate
// limit OR fleet overload) cools the used key down and the retry ladder's
// next attempt rides a DIFFERENT key — the auth header changes, the request
// body bytes do not (prefix cache unaffected).
// ---------------------------------------------------------------------------

const CFG: ProviderConfig = { apiKey: "a", baseURL: "https://x/v1", model: "m" };

function res(status: number, body: unknown): Response {
  return {
    ok: status === 200,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

describe("provider key rotation on 429", () => {
  it("a 429 on key A cools it; the retry succeeds on key B", async () => {
    const auths: string[] = [];
    let n = 0;
    const doFetch = (async (_url: string, init: RequestInit) => {
      auths.push(String(init.headers && (init.headers as Record<string, string>)["authorization"]));
      n += 1;
      return n === 1
        ? res(429, { error: { message: "rate limited" } })
        : res(200, { choices: [{ message: { role: "assistant", content: "ok" } }], usage: { prompt_tokens: 5, completion_tokens: 1 } });
    }) as typeof fetch;
    const pool = createKeyPool(["a", "b"]);
    const model = createOpenAICompatibleProvider({ ...CFG, apiKeys: ["a", "b"] }, {
      fetch: doFetch,
      keyPool: pool,
      retry: { maxRetries: 2, baseDelayMs: 1, sleep: async () => {} },
    });
    const msg = await model.generate({ systemPrompt: "s", messages: [{ role: "user", content: "u" }], tools: [] });
    expect(msg.content).toBe("ok");
    expect(auths).toEqual(["Bearer a", "Bearer b"]);
    expect(pool.snapshot()).toEqual({ total: 2, available: 1, cooling: 1 });
  });

  it("an overload-signature 429 also cools the key (fleet busy still rotates the pool)", async () => {
    const auths: string[] = [];
    let n = 0;
    const doFetch = (async (_url: string, init: RequestInit) => {
      auths.push(String((init.headers as Record<string, string>)["authorization"]));
      n += 1;
      return n === 1
        ? res(429, { error: { code: "1301", message: "当前集团内部忙" } })
        : res(200, { choices: [{ message: { role: "assistant", content: "ok" } }] });
    }) as typeof fetch;
    const pool = createKeyPool(["a", "b"]);
    const model = createOpenAICompatibleProvider({ ...CFG, apiKeys: ["a", "b"] }, {
      fetch: doFetch,
      keyPool: pool,
      retry: { maxRetries: 2, overloadBaseDelayMs: 1, baseDelayMs: 1, sleep: async () => {} },
    });
    await model.generate({ systemPrompt: "s", messages: [{ role: "user", content: "u" }], tools: [] });
    expect(auths).toEqual(["Bearer a", "Bearer b"]);
    expect(pool.snapshot().cooling).toBe(1);
  });

  it("a single-key config retries the SAME key (status quo preserved)", async () => {
    const auths: string[] = [];
    let n = 0;
    const doFetch = (async (_url: string, init: RequestInit) => {
      auths.push(String((init.headers as Record<string, string>)["authorization"]));
      n += 1;
      return n === 1
        ? res(429, { error: { message: "rate limited" } })
        : res(200, { choices: [{ message: { role: "assistant", content: "ok" } }] });
    }) as typeof fetch;
    const model = createOpenAICompatibleProvider(CFG, {
      fetch: doFetch,
      retry: { maxRetries: 2, baseDelayMs: 1, sleep: async () => {} },
    });
    await model.generate({ systemPrompt: "s", messages: [{ role: "user", content: "u" }], tools: [] });
    expect(auths).toEqual(["Bearer a", "Bearer a"]);
  });

  it("the streaming path rotates keys the same way", async () => {
    const auths: string[] = [];
    let n = 0;
    const enc = new TextEncoder();
    const doFetch = (async (_url: string, init: RequestInit) => {
      auths.push(String((init.headers as Record<string, string>)["authorization"]));
      n += 1;
      if (n === 1) return res(429, { error: { message: "rate limited" } });
      const events = [
        `data: ${JSON.stringify({ choices: [{ delta: { content: "hi" } }] })}\n\n`,
        `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 9, completion_tokens: 2 } })}\n\n`,
        "data: [DONE]\n\n",
      ].join("");
      return {
        ok: true,
        status: 200,
        body: new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(enc.encode(events));
            c.close();
          },
        }),
      } as unknown as Response;
    }) as typeof fetch;
    const pool = createKeyPool(["a", "b"]);
    const model = createOpenAICompatibleProvider({ ...CFG, apiKeys: ["a", "b"] }, {
      fetch: doFetch,
      keyPool: pool,
      retry: { maxRetries: 2, baseDelayMs: 1, sleep: async () => {} },
    });
    const out: string[] = [];
    for await (const ev of model.stream!({ systemPrompt: "s", messages: [{ role: "user", content: "u" }], tools: [] })) {
      if (ev.type === "text_delta") out.push(ev.text);
    }
    expect(out.join("")).toBe("hi");
    expect(auths).toEqual(["Bearer a", "Bearer b"]);
  });
});

// ---------------------------------------------------------------------------
// 夜移 007 (the upstream credential-pool port, hardened) — STATUS-CLASSED cooldowns.
// the upstream keys cooldowns by HTTP status class; wudao's M56 pool only cooled on
// 429 — a dead key (401/403) kept re-entering rotation, burning a full
// round-trip + fail per request until its turn cycled away. Classes:
//   auth (401/403) — credential dead/revoked → LONG cooldown (15min default);
//                     deliberately NOT made ladder-retryable (fail fast: a
//                     wrong key is a config problem, not a transient — the
//                     divergence from the upstream's rotate-on-auth is intentional);
//                     the cooldown exists so the NEXT request skips it.
//   rate (429)     — existing 60s semantics, byte-for-byte unchanged.
//   null (5xx/…)   — provider-side: never penalize the key (cooling every key
//                     over a provider outage starves the pool for no gain).
// Cross-class on one key: max-wins (the existing never-shorten rule).
// ---------------------------------------------------------------------------

describe("夜移 007 — status-classed cooldowns", () => {
  it("cooldownClassForStatus maps the three classes", () => {
    expect(cooldownClassForStatus(401)).toBe("auth");
    expect(cooldownClassForStatus(403)).toBe("auth");
    expect(cooldownClassForStatus(429)).toBe("rate");
    expect(cooldownClassForStatus(500)).toBeNull();
    expect(cooldownClassForStatus(502)).toBeNull();
    expect(cooldownClassForStatus(503)).toBeNull();
    expect(cooldownClassForStatus(529)).toBeNull();
    expect(cooldownClassForStatus(400)).toBeNull();
    expect(cooldownClassForStatus(404)).toBeNull();
  });

  it("auth cooldown outlasts rate (15min default vs 60s)", () => {
    let t = 1_000;
    const pool = createKeyPool(["a", "b"], { now: () => t });
    pool.markCooldown("a", "auth");
    t += DEFAULT_KEY_COOLDOWN_MS + 1; // a RATE cooldown would have lapsed here
    expect(pool.snapshot()).toEqual({ total: 2, available: 1, cooling: 1 });
    t += DEFAULT_AUTH_COOLDOWN_MS; // the auth window lapses
    expect(pool.snapshot()).toEqual({ total: 2, available: 2, cooling: 0 });
  });

  it("markCooldown without a class keeps the rate contract (existing call sites)", () => {
    let t = 1_000;
    const pool = createKeyPool(["a", "b"], { now: () => t });
    pool.markCooldown("a");
    t += DEFAULT_KEY_COOLDOWN_MS + 1;
    expect(pool.snapshot().cooling).toBe(0);
  });

  it("cross-class max-wins: a later rate hit never shortens an auth cooldown", () => {
    let t = 1_000;
    const pool = createKeyPool(["a", "b"], { now: () => t });
    pool.markCooldown("a", "auth");
    t += 1_000;
    pool.markCooldown("a", "rate"); // reachable via the all-cooling fallback
    t += DEFAULT_KEY_COOLDOWN_MS + 1; // past the rate window, inside the auth one
    expect(pool.snapshot().cooling).toBe(1);
  });

  it("authCooldownMs is injectable", () => {
    let t = 1_000;
    const pool = createKeyPool(["a", "b"], { now: () => t, authCooldownMs: 5_000 });
    pool.markCooldown("a", "auth");
    t += 5_001;
    expect(pool.snapshot().cooling).toBe(0);
  });

  it("provider: a 401 puts key A in the LONG cooldown; the next request rides key B", async () => {
    const auths: string[] = [];
    let n = 0;
    const doFetch = (async (_url: string, init: RequestInit) => {
      auths.push(String((init.headers as Record<string, string>)["authorization"]));
      n += 1;
      return n === 1
        ? res(401, { error: { message: "invalid api key" } })
        : res(200, { choices: [{ message: { role: "assistant", content: "ok" } }] });
    }) as typeof fetch;
    const pool = createKeyPool(["a", "b"]);
    const model = createOpenAICompatibleProvider({ ...CFG, apiKeys: ["a", "b"] }, {
      fetch: doFetch,
      keyPool: pool,
      retry: { maxRetries: 2, baseDelayMs: 1, sleep: async () => {} },
    });
    // 401 is NOT ladder-retryable — the first generate fails fast…
    await expect(
      model.generate({ systemPrompt: "s", messages: [{ role: "user", content: "u" }], tools: [] }),
    ).rejects.toThrow();
    // …but key A is now auth-cooling, so the second generate never selects it.
    const msg = await model.generate({ systemPrompt: "s", messages: [{ role: "user", content: "u" }], tools: [] });
    expect(msg.content).toBe("ok");
    expect(auths).toEqual(["Bearer a", "Bearer b"]);
    expect(pool.snapshot()).toEqual({ total: 2, available: 1, cooling: 1 });
  });

  it("provider: a 500 does NOT cool the key (provider-side failures never starve the pool)", async () => {
    let n = 0;
    const doFetch = (async () => {
      n += 1;
      return n === 1
        ? res(500, { error: { message: "boom" } })
        : res(200, { choices: [{ message: { role: "assistant", content: "ok" } }] });
    }) as typeof fetch;
    const pool = createKeyPool(["a", "b"]);
    const model = createOpenAICompatibleProvider({ ...CFG, apiKeys: ["a", "b"] }, {
      fetch: doFetch,
      keyPool: pool,
      retry: { maxRetries: 2, baseDelayMs: 1, sleep: async () => {} },
    });
    await model.generate({ systemPrompt: "s", messages: [{ role: "user", content: "u" }], tools: [] });
    expect(pool.snapshot()).toEqual({ total: 2, available: 2, cooling: 0 });
  });
});

// ---------------------------------------------------------------------------
// createLiveKeyPool — the config-deriving pool (2026-08-31 minimax-401 弧).
//
// The session engine used to build ONE createKeyPool at boot and hand that
// same object to every rebuilt client at a /provider switch. The adapter
// treats an explicit pool as authoritative (options.keyPool ?? own-config
// pool), so after kimi→minimax the minimax request still authenticated with
// the BOOT provider's key → `401 login fail` on every retry. The class of
// the bug: key state derived ONCE from the boot config and surviving config
// changes — a second key store that can silently disagree with the config
// that built the client.
//
// The design fix is not "remember to reseed" (a discipline every future
// build path must keep) but "no second store": the live pool READS the key
// list from a getter on every select/snapshot — in the engine that getter
// is the ONE mutable config holder the switch seam already syncs in place
// (the S2b doctrine), so the pool structurally cannot serve a key the
// current config does not carry. Cooldowns stay keyed by key VALUE: a key
// that survives a config change keeps its cooldown; a key that leaves the
// config is gone, and its cooldown dies with it.
// ---------------------------------------------------------------------------

describe("createLiveKeyPool — rotation follows the live list", () => {
  it("selects round-robin over the CURRENT list; flipping the getter flips the selection", () => {
    let live = ["a1", "a2"];
    const pool = createLiveKeyPool(() => live);
    expect([pool.select(), pool.select(), pool.select()]).toEqual(["a1", "a2", "a1"]);
    live = ["b1"];
    expect([pool.select(), pool.select()]).toEqual(["b1", "b1"]);
    live = ["c1", "c2", "c3"];
    // cursor keeps advancing over whatever the list is now (no stale index).
    expect([pool.select(), pool.select(), pool.select()]).toEqual(["c1", "c2", "c3"]);
  });

  it("snapshot()/size track the live list, not the boot list", () => {
    let live = ["a1", "a2"];
    const pool = createLiveKeyPool(() => live);
    expect(pool.size).toBe(2);
    expect(pool.snapshot()).toEqual({ total: 2, available: 2, cooling: 0 });
    live = ["b1"];
    expect(pool.size).toBe(1);
    expect(pool.snapshot()).toEqual({ total: 1, available: 1, cooling: 0 });
  });

  it("dedupes/trims per read and throws when the getter starts empty", () => {
    let live = [" a1 ", "a1", "", "  "];
    const pool = createLiveKeyPool(() => live);
    expect(pool.size).toBe(1);
    live = [];
    expect(() => pool.select()).toThrow(/at least one API key/);
    // recovers when the config gains a key again (a key save mid-session).
    live = ["b1"];
    expect(pool.select()).toBe("b1");
  });

  it("constructor validates the initial list (blank/empty getters are config errors)", () => {
    expect(() => createLiveKeyPool(() => [])).toThrow(/at least one API key/);
    expect(() => createLiveKeyPool(() => ["  ", ""])).toThrow(/at least one API key/);
  });
});

describe("createLiveKeyPool — cooldown across config changes", () => {
  it("a key that survives the change keeps its cooldown; a key that leaves takes it away", () => {
    let t = 1_000;
    let live = ["a1", "a2"];
    const pool = createLiveKeyPool(() => live, { now: () => t });
    pool.markCooldown("a1", "auth"); // 15min — a dead credential
    expect(pool.snapshot()).toEqual({ total: 2, available: 1, cooling: 1 });
    expect(pool.select()).toBe("a2");
    // config change keeps a1 (still cooling) and drops a2 for b1.
    live = ["a1", "b1"];
    expect(pool.select()).toBe("b1");
    expect(pool.snapshot()).toEqual({ total: 2, available: 1, cooling: 1 });
    // cooldown lapses → a1 returns.
    t += DEFAULT_AUTH_COOLDOWN_MS + 1;
    expect(pool.select()).toBe("a1");
  });

  it("markCooldown on a key outside the current list is a no-op (a re-added key is fresh)", () => {
    let live = ["a1"];
    const pool = createLiveKeyPool(() => live);
    live = ["b1"];
    pool.markCooldown("a1"); // a1 is no longer configured — ignored
    live = ["a1", "b1"];
    expect(pool.snapshot()).toEqual({ total: 2, available: 2, cooling: 0 });
    expect(pool.select()).toBe("a1");
  });

  it("the all-cooling fallback still returns the soonest-expiring CURRENT key", () => {
    let t = 5_000;
    let live = ["a1", "a2"];
    const pool = createLiveKeyPool(() => live, { now: () => t });
    pool.markCooldown("a1"); // rate, 60s → lapses at t=65_000
    t += 1;
    pool.markCooldown("a2", "auth"); // auth, 15min → lapses at t=906_001
    live = ["a2", "a3", "a1"]; // reorder + add a3 — the map is keyed by value
    expect(pool.select()).toBe("a3");
    // a3 cools too → all cooling → soonest-expiring is a1 (60s class).
    pool.markCooldown("a3");
    expect(pool.select()).toBe("a1");
  });
});

describe("createLiveKeyPool — wire pin: the explicit pool follows the config across a switch", () => {
  // The 2026-08-31 minimax 401, in miniature: an engine-style explicit pool
  // whose backing config changes between requests. The OLD snapshot pool
  // kept putting the boot key on the wire; the live pool must put the key
  // the CURRENT config carries. Anthropic wire (kimi/minimax's shape) —
  // the x-api-key header is the authenticator the gateway rejected.
  it("anthropic x-api-key flips with the config (stream path)", async () => {
    const seen: string[] = [];
    const sseFetch = (async (_url: unknown, init?: { headers?: Record<string, string> }) => {
      const h = init?.headers ?? {};
      const lookup = (name: string): string => {
        const hit = Object.entries(h).find(([k]) => k.toLowerCase() === name);
        return hit ? String(hit[1]) : "";
      };
      seen.push(lookup("x-api-key"));
      const enc = new TextEncoder();
      const stop = JSON.stringify({ type: "message_stop" });
      return {
        ok: true,
        status: 200,
        body: new ReadableStream({ start(c) { c.enqueue(enc.encode(`data: ${stop}\n\n`)); c.close(); } }),
      } as unknown as Response;
    }) as typeof fetch;

    let live = ["sk-boot-provider-a"];
    const pool = createLiveKeyPool(() => live);
    const model = createAnthropicProvider(
      { apiKey: "config-key-unused", baseURL: "http://wire.test/v1", model: "m" },
      { fetch: sseFetch, keyPool: pool },
    );
    const drain = async (): Promise<void> => {
      for await (const _ev of model.stream({ systemPrompt: "s", messages: [{ role: "user", content: "hi" }], tools: [] })) {
        /* drain */
      }
    };
    await drain(); // boot request — boot config's key
    live = ["sk-switched-provider-b"]; // the switch seam synced the holder
    await drain(); // post-switch request — TARGET's key, never the boot one
    expect(seen).toEqual(["sk-boot-provider-a", "sk-switched-provider-b"]);
  });
});
