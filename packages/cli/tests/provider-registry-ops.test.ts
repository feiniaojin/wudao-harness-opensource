// Provider management Task 3 — the registry write ops + the /models probe,
// red-first over the handler seam (createProviderRegistryOps):
//
//   settingsSaveProvider   validate → read-modify-write providers.json
//                          (atomic, sibling rows preserved — including INVALID
//                          ones: repair targets ONE id) → invalidate the
//                          process memo (I2: the SAME `wudao ui` session's
//                          settingsStatus sees the new registry — no restart,
//                          no TTL). API keys NEVER enter the file.
//   settingsDeleteProvider builtin ids refuse (the spec error); customs leave
//                          the file + the memo; a stored model.defaultModel
//                          pointing at the deleted id falls back (the pick is
//                          dropped; unrelated picks untouched).
//   settingsListModels     GET ${endpoint}/models through the injected fetch —
//                          testConnection's key ladder + failure states; the
//                          three body shapes (OpenAI / OpenRouter
//                          context_length / malformed); reply has no key.
//
// One tmp WUDAO_GLOBAL_HOME for the whole file (deps.env AND process.env —
// the memo keys on the process-resolved default path, so the invalidation pin
// is honest only when both agree).
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProviderRegistryOps, readProviderPersonaBinding } from "../src/driver/provider-registry-ops.js";
import { createSettingsOps } from "../src/driver/settings-ops.js";
import { resetProviderRegistryCacheForTests } from "../src/provider-registry.js";
import { readGlobalSettingsSync, saveGlobalSettings } from "../src/settings-layer.js";
import { credentialsFilePath, saveProviderKey } from "../src/credentials.js";

let home: string;
let savedHome: string | undefined;

beforeAll(() => {
  savedHome = process.env.WUDAO_GLOBAL_HOME;
  home = mkdtempSync(join(tmpdir(), "wudao-provops-"));
  process.env.WUDAO_GLOBAL_HOME = home;
});

afterAll(() => {
  if (savedHome === undefined) delete process.env.WUDAO_GLOBAL_HOME;
  else process.env.WUDAO_GLOBAL_HOME = savedHome;
  rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const env = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({ WUDAO_GLOBAL_HOME: home, ...extra });
const registryPath = (): string => join(home, "providers.json");

/** Write a fresh registry and drop the memo — each test starts from its own file. */
function seedRegistry(providers: Record<string, unknown>): void {
  writeFileSync(registryPath(), JSON.stringify({ version: 1, providers }, null, 2), "utf8");
  resetProviderRegistryCacheForTests();
}

/** Start from NO registry file (the absent-registry paths). */
function seedNothing(): void {
  rmSync(registryPath(), { force: true });
  resetProviderRegistryCacheForTests();
}

beforeEach(seedNothing);

interface RecordedCall {
  readonly url: string;
  readonly method: string;
  readonly authorization: string;
  readonly signal: unknown;
  readonly headers: Record<string, string>;
}

/** A fetch double that records every call and scripts replies in order. */
function fakeFetch(script: { status?: number; body?: string; reject?: Error }[]): {
  readonly fn: typeof fetch;
  readonly calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  let i = 0;
  const fn = (async (url: unknown, init?: RequestInit): Promise<Response> => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({
      url: String(url),
      method: String(init?.method ?? "GET"),
      authorization: String(headers["authorization"] ?? ""),
      signal: init?.signal,
      headers,
    });
    const s = script[Math.min(i++, script.length - 1)];
    if (s === undefined) throw new Error("no more scripted responses");
    if (s.reject !== undefined) throw s.reject;
    return new Response(s.body ?? "", { status: s.status ?? 200 });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

const makeOps = (deps: { readonly fetchImpl?: typeof fetch; readonly extraEnv?: Record<string, string> } = {}) =>
  createProviderRegistryOps({
    env: env(deps.extraEnv ?? {}),
    workspaceRoot: process.cwd(),
    ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
  });

describe("settingsSaveProvider", () => {
  it("writes a validated custom entry (sanitized: unknown fields dropped) and returns ok", async () => {
    const ops = makeOps();
    const r = await ops.settingsSaveProvider("my-gw", {
      label: "My GW",
      baseUrl: "https://gw.example.com/v1",
      defaultModel: "m-x",
      defaultContextLength: 200000,
      models: [{ name: "m-x", contextLength: 200000 }, { name: "m-lite" }],
      futureField: true,
    });
    expect(r).toEqual({ ok: true, provider: "my-gw" });
    const file = JSON.parse(readFileSync(registryPath(), "utf8")) as { version: number; providers: Record<string, unknown> };
    expect(file.version).toBe(1);
    expect(file.providers["my-gw"]).toEqual({
      label: "My GW",
      baseUrl: "https://gw.example.com/v1",
      defaultModel: "m-x",
      defaultContextLength: 200000,
      models: [{ name: "m-x", contextLength: 200000 }, { name: "m-lite" }],
    }); // futureField dropped — the registry never persists unknown surfaces
  });

  it("REFUSES key-bearing config — keys never enter providers.json (settingsSaveKey owns them)", async () => {
    seedRegistry({});
    const ops = makeOps();
    for (const keyField of ["key", "apiKey", "apiKeys", "keys"]) {
      const r = await ops.settingsSaveProvider("my-gw", { baseUrl: "https://gw.example.com/v1", [keyField]: "sk-live" });
      expect(r.ok, keyField).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/settingsSaveKey/);
    }
    expect((JSON.parse(readFileSync(registryPath(), "utf8")) as { providers: Record<string, unknown> }).providers).toEqual({});
  });

  it("an invalid entry refuses with the validator's reason and writes nothing", async () => {
    seedRegistry({});
    const ops = makeOps();
    // custom without a baseUrl
    const noBase = await ops.settingsSaveProvider("my-gw", { defaultModel: "m-x" });
    expect(noBase.ok).toBe(false);
    if (!noBase.ok) expect(noBase.error).toMatch(/baseUrl/);
    // bad URL
    const badUrl = await ops.settingsSaveProvider("my-gw", { baseUrl: "not a url" });
    expect(badUrl.ok).toBe(false);
    // ID_RE violation (digit first)
    const badId = await ops.settingsSaveProvider("1bad", { baseUrl: "https://gw.example.com/v1" });
    expect(badId.ok).toBe(false);
    if (!badId.ok) expect(badId.error).toMatch(/invalid provider id/);
    // non-object config
    const notObject = await ops.settingsSaveProvider("my-gw", "https://gw.example.com/v1");
    expect(notObject.ok).toBe(false);
    if (!notObject.ok) expect(notObject.error).toMatch(/entry must be an object/);
    expect((JSON.parse(readFileSync(registryPath(), "utf8")) as { providers: Record<string, unknown> }).providers).toEqual({});
  });

  // ω99-50 §2.3 保存期即红：坏 header（fetch 无法表示的名字/值）在卡片写盘前拒。
  // registry 行的 headers 列是用户输入面（wire 接线是后续批次），坏值落盘只会
  // 把失败推迟到将来第一次真实请求。好 header 正常落盘（正控）。
  it("ω99-50: unrepresentable headers refuse the save with a named error; disk untouched — representable ones persist", async () => {
    seedRegistry({});
    const ops = makeOps();
    // newline value — undici would die mid-request; here it reds before the write
    const nl = await ops.settingsSaveProvider("my-gw", { baseUrl: "https://gw.example.com/v1", defaultModel: "m-x", headers: { "x-relay": `a${"\n"}b` } });
    expect(nl.ok).toBe(false);
    if (!nl.ok) {
      expect(nl.error).toMatch(/provider card "my-gw".*headers\.x-relay cannot be sent[\s\S]*invalid header value/);
    }
    // illegal field name
    const badName = await ops.settingsSaveProvider("my-gw", { baseUrl: "https://gw.example.com/v1", headers: { "x bad": "v" } });
    expect(badName.ok).toBe(false);
    if (!badName.ok) expect(badName.error).toMatch(/provider card "my-gw".*headers\.x bad cannot be sent.*invalid header name/);
    // 盘上文件不变（两个拒写都没有落盘）
    expect((JSON.parse(readFileSync(registryPath(), "utf8")) as { providers: Record<string, unknown> }).providers).toEqual({});
    // 正控：合法 header 正常保存
    const good = await ops.settingsSaveProvider("my-gw", { baseUrl: "https://gw.example.com/v1", defaultModel: "m-x", headers: { "x-gateway-token": "t0", "user-agent": "wudao/0.3" } });
    expect(good).toEqual({ ok: true, provider: "my-gw" });
    const file = JSON.parse(readFileSync(registryPath(), "utf8")) as { providers: Record<string, { headers?: Record<string, string> }> };
    expect(file.providers["my-gw"]?.headers).toEqual({ "x-gateway-token": "t0", "user-agent": "wudao/0.3" });
  });

  it("read-modify-write PRESERVES sibling rows — including invalid ones (repair targets one id)", async () => {
    seedRegistry({
      keep: { baseUrl: "https://keep.example/v1", defaultModel: "k-x" },
      "broken-entry": { defaultModel: "no-base" },
    });
    const ops = makeOps();
    // repairing the broken id with a valid config replaces just that row
    const repaired = await ops.settingsSaveProvider("broken-entry", { baseUrl: "https://fixed.example/v1", defaultModel: "f-x" });
    expect(repaired).toEqual({ ok: true, provider: "broken-entry" });
    // saving a NEW id keeps the (still-invalid) sibling verbatim — fail-visible
    // rows are the user's data, a save of another provider must not eat them
    seedRegistry({
      keep: { baseUrl: "https://keep.example/v1", defaultModel: "k-x" },
      "broken-entry": { defaultModel: "no-base" },
    });
    const r = await ops.settingsSaveProvider("other-gw", { baseUrl: "https://other.example/v1" });
    expect(r).toEqual({ ok: true, provider: "other-gw" });
    const file = JSON.parse(readFileSync(registryPath(), "utf8")) as { providers: Record<string, unknown> };
    expect(file.providers["keep"]).toEqual({ baseUrl: "https://keep.example/v1", defaultModel: "k-x" });
    expect(file.providers["broken-entry"]).toEqual({ defaultModel: "no-base" });
  });

  it("a builtin overlay saves without a baseUrl (the compiled profile stays the base)", async () => {
    const ops = makeOps();
    const r = await ops.settingsSaveProvider("deepseek", { models: [{ name: "deepseek-chat", contextLength: 128000 }] });
    expect(r).toEqual({ ok: true, provider: "deepseek" });
    const file = JSON.parse(readFileSync(registryPath(), "utf8")) as { providers: Record<string, unknown> };
    expect(file.providers["deepseek"]).toEqual({ models: [{ name: "deepseek-chat", contextLength: 128000 }] });
  });

  it("a save over a MALFORMED registry repairs the structure (the file was wholly unusable; the builtins cover everything meanwhile)", async () => {
    writeFileSync(registryPath(), "{ not json", "utf8");
    resetProviderRegistryCacheForTests();
    const ops = makeOps();
    const r = await ops.settingsSaveProvider("my-gw", { baseUrl: "https://gw.example.com/v1" });
    expect(r).toEqual({ ok: true, provider: "my-gw" });
    const file = JSON.parse(readFileSync(registryPath(), "utf8")) as { version: number; providers: Record<string, unknown> };
    expect(file.version).toBe(1);
    expect(Object.keys(file.providers)).toEqual(["my-gw"]);
  });

  it("I2 pin: a successful save invalidates the process memo — the SAME session's settingsStatus sees the new provider (no restart)", async () => {
    const settings = createSettingsOps({ env: env(), workspaceRoot: process.cwd() });
    const before = await settings.settingsStatus(); // primes the memoized read
    expect(before.providers.some((c) => c.provider === "my-gw")).toBe(false);
    const ops = makeOps();
    const r = await ops.settingsSaveProvider("my-gw", { baseUrl: "https://gw.example.com/v1", defaultModel: "m-x", defaultContextLength: 200000 });
    expect(r).toEqual({ ok: true, provider: "my-gw" });
    const after = await settings.settingsStatus(); // NO cache reset between these two calls
    const gw = after.providers.find((c) => c.provider === "my-gw");
    expect(gw).toMatchObject({
      custom: true,
      endpoint: "https://gw.example.com/v1",
      baseUrl: "https://gw.example.com/v1",
      defaultModel: "m-x",
      models: [],
      defaultContextLength: 200000,
    });
  });

  it("I2 pin: a FAILED save does not disturb the memoized view", async () => {
    const settings = createSettingsOps({ env: env(), workspaceRoot: process.cwd() });
    await settings.settingsStatus(); // primes the memo (builtins only, no file)
    const ops = makeOps();
    const r = await ops.settingsSaveProvider("my-gw", { defaultModel: "no-base" }); // refused
    expect(r.ok).toBe(false);
    const after = await settings.settingsStatus();
    expect(after.providers.some((c) => c.provider === "my-gw")).toBe(false);
    expect(existsSync(registryPath())).toBe(false); // and nothing was written
  });
});

describe("settingsDeleteProvider", () => {
  it("REFUSES a builtin id with the spec error and touches nothing", async () => {
    seedRegistry({ deepseek: { models: [{ name: "deepseek-chat" }] } });
    const ops = makeOps();
    for (const builtin of ["deepseek", "glm", "qwen", "wudao"]) {
      const r = await ops.settingsDeleteProvider(builtin);
      expect(r, builtin).toEqual({ ok: false, error: "内置 provider 不可删除" });
    }
    expect(JSON.parse(readFileSync(registryPath(), "utf8")) as unknown).toEqual({
      version: 1,
      providers: { deepseek: { models: [{ name: "deepseek-chat" }] } },
    });
  });

  it("deletes a custom: gone from the file AND from the same session's matrix (memo invalidation)", async () => {
    seedRegistry({ "my-gw": { baseUrl: "https://gw.example.com/v1", defaultModel: "m-x" } });
    const settings = createSettingsOps({ env: env(), workspaceRoot: process.cwd() });
    expect((await settings.settingsStatus()).providers.some((c) => c.provider === "my-gw")).toBe(true); // primes the memo
    const ops = makeOps();
    const r = await ops.settingsDeleteProvider("my-gw");
    expect(r).toEqual({ ok: true });
    const file = JSON.parse(readFileSync(registryPath(), "utf8")) as { providers: Record<string, unknown> };
    expect(file.providers["my-gw"]).toBeUndefined();
    const after = await settings.settingsStatus(); // no cache reset
    expect(after.providers.some((c) => c.provider === "my-gw")).toBe(false);
  });

  it("falls back a stored model.defaultModel that pointed at the deleted id (unrelated picks untouched)", async () => {
    seedRegistry({
      "my-gw": { baseUrl: "https://gw.example.com/v1", defaultModel: "m-x" },
      "other-gw": { baseUrl: "https://other.example/v1", defaultModel: "o-x" },
    });
    await saveGlobalSettings(
      { model: { defaultModel: { provider: "my-gw", model: "m-x" }, defaultEffort: "high" }, memoryEnabled: true },
      env(),
    );
    const ops = makeOps();
    expect(await ops.settingsDeleteProvider("my-gw")).toEqual({ ok: true });
    const record = readGlobalSettingsSync(env());
    expect((record["model"] as Record<string, unknown>)["defaultModel"]).toBeUndefined(); // the pick fell back
    expect((record["model"] as Record<string, unknown>)["defaultEffort"]).toBe("high"); // the sibling key survives
    expect(record["memoryEnabled"]).toBe(true); // the rest of the record survives
    // and a default pointing elsewhere is untouched by a later delete
    await saveGlobalSettings({ model: { defaultModel: { provider: "other-gw", model: "o-x" } } }, env());
    expect(await ops.settingsDeleteProvider("my-gw")).toEqual({ ok: true }); // idempotent re-delete
    const kept = readGlobalSettingsSync(env());
    expect((kept["model"] as Record<string, unknown>)["defaultModel"]).toEqual({ provider: "other-gw", model: "o-x" });
  });

  it("deleting an unknown custom id is idempotent ok (converges; the default fallback still runs)", async () => {
    await saveGlobalSettings({ model: { defaultModel: { provider: "ghost-gw", model: "g-x" } } }, env());
    const ops = makeOps();
    const r = await ops.settingsDeleteProvider("ghost-gw");
    expect(r).toEqual({ ok: true });
    expect(existsSync(registryPath())).toBe(false); // no file was created for a no-op delete
    const record = readGlobalSettingsSync(env());
    expect((record["model"] as Record<string, unknown>)["defaultModel"]).toBeUndefined();
  });

  // R-M5 (T3 review Minor 1) — the delete path's memo invalidation must run
  // IMMEDIATELY after the registry write lands, BEFORE the post-delete
  // settings fallback: a throwing fallback used to reject the op before the
  // invalidation, leaving disk without the row but the process memo (and the
  // live settings matrix) still showing it — a stale-matrix window until the
  // next successful registry write or a restart.
  it("R-M5 pin: a THROWING settings fallback still leaves the memo invalidated (no stale-matrix window)", async () => {
    seedRegistry({ "my-gw": { baseUrl: "https://gw.example.com/v1", defaultModel: "m-x" } });
    await saveGlobalSettings({ model: { defaultModel: { provider: "my-gw", model: "m-x" } } }, env());
    const settings = createSettingsOps({ env: env(), workspaceRoot: process.cwd() });
    expect((await settings.settingsStatus()).providers.some((c) => c.provider === "my-gw")).toBe(true); // primes the memo
    // Force the fallback's saveGlobalSettings to throw: the writer stages its
    // atomic write at `${settings.json}.tmp-<pid>` — a DIRECTORY at exactly
    // that path fails the staging writeFile (EISDIR) while the registry write
    // (its own tmp name, same dir) stays unaffected.
    mkdirSync(join(home, `settings.json.tmp-${process.pid}`));
    const ops = makeOps();
    await expect(ops.settingsDeleteProvider("my-gw")).rejects.toThrow();
    // The registry write LANDED …
    expect(JSON.parse(readFileSync(registryPath(), "utf8")) as { providers: Record<string, unknown> }).toEqual({
      version: 1,
      providers: {},
    });
    // … and the memo is ALREADY invalidated: the same session's next matrix
    // read (no restart, no cache reset) no longer shows the deleted provider.
    const after = await settings.settingsStatus();
    expect(after.providers.some((c) => c.provider === "my-gw")).toBe(false);
  });
});

describe("settingsListModels", () => {
  beforeEach(() => {
    seedRegistry({
      "my-gw": { baseUrl: "https://gw.example.com/v1", defaultModel: "m-x" },
      "other-gw": { baseUrl: "https://other.example/v1", defaultModel: "o-x" },
    });
    rmSync(credentialsFilePath(env()), { force: true }); // the key ladder starts from a clean file
  });

  it("OpenAI shape: {data:[{id}]} → models, via GET ${baseUrl}/models with the file key", async () => {
    await saveProviderKey("my-gw", "file-key", env());
    const fetch = fakeFetch([{ status: 200, body: JSON.stringify({ object: "list", data: [{ id: "m-a" }, { id: "m-b" }] }) }]);
    const ops = makeOps({ fetchImpl: fetch.fn });
    const r = await ops.settingsListModels("my-gw");
    expect(r).toEqual({ ok: true, models: [{ name: "m-a" }, { name: "m-b" }] });
    expect(fetch.calls.length).toBe(1);
    expect(fetch.calls[0]?.url).toBe("https://gw.example.com/v1/models");
    expect(fetch.calls[0]?.method).toBe("GET");
    expect(fetch.calls[0]?.authorization).toBe("Bearer file-key");
    expect(fetch.calls[0]?.signal).toBeInstanceOf(AbortSignal); // the 10s abort budget
    expect(JSON.stringify(r)).not.toContain("file-key"); // the key never echoes
    // 红线2: the openai wire stays byte-identical — no x-api-key, no
    // anthropic-version, just the historical Bearer.
    expect(fetch.calls[0]?.headers["x-api-key"]).toBeUndefined();
    expect(fetch.calls[0]?.headers["anthropic-version"]).toBeUndefined();
  });

  it("anthropic wire (glm-code): GET ${base}/v1/models with x-api-key + anthropic-version + Bearer (bearerAuth dual-send)", async () => {
    const fetch = fakeFetch([{ status: 200, body: JSON.stringify({ data: [{ id: "glm-5.3" }, { id: "glm-5.3-flash" }] }) }]);
    const ops = makeOps({ fetchImpl: fetch.fn });
    const r = await ops.settingsListModels("glm-code", { key: "pasted" });
    expect(r).toEqual({ ok: true, models: [{ name: "glm-5.3" }, { name: "glm-5.3-flash" }] });
    expect(fetch.calls[0]?.url).toBe("https://open.bigmodel.cn/api/anthropic/v1/models");
    expect(fetch.calls[0]?.headers["x-api-key"]).toBe("pasted");
    expect(fetch.calls[0]?.headers["anthropic-version"]).toBe("2023-06-01");
    expect(fetch.calls[0]?.authorization).toBe("Bearer pasted");
  });

  it("anthropic wire (real anthropic builtin, no bearerAuth): x-api-key + version, NO authorization header", async () => {
    const fetch = fakeFetch([{ status: 200, body: JSON.stringify({ data: [{ id: "claude-sonnet-5" }] }) }]);
    const ops = makeOps({ fetchImpl: fetch.fn });
    const r = await ops.settingsListModels("anthropic", { key: "sk-ant" });
    expect(r).toEqual({ ok: true, models: [{ name: "claude-sonnet-5" }] });
    expect(fetch.calls[0]?.url).toBe("https://api.anthropic.com/v1/models");
    expect(fetch.calls[0]?.headers["x-api-key"]).toBe("sk-ant");
    expect(fetch.calls[0]?.headers["anthropic-version"]).toBe("2023-06-01");
    expect(fetch.calls[0]?.authorization).toBe("");
  });

  it("OpenRouter shape: context_length prefills ONLY as a positive integer (junk lengths omitted)", async () => {
    const fetch = fakeFetch([
      {
        status: 200,
        body: JSON.stringify({
          data: [
            { id: "m-a", context_length: 123456 },
            { id: "m-zero", context_length: 0 },
            { id: "m-neg", context_length: -5 },
            { id: "m-frac", context_length: 1.5 },
            { id: "m-str", context_length: "128k" },
            { id: "m-none" },
          ],
        }),
      },
    ]);
    const ops = makeOps({ fetchImpl: fetch.fn });
    await saveProviderKey("my-gw", "file-key", env());
    const r = await ops.settingsListModels("my-gw");
    expect(r).toEqual({
      ok: true,
      models: [
        { name: "m-a", contextLength: 123456 },
        { name: "m-zero" },
        { name: "m-neg" },
        { name: "m-frac" },
        { name: "m-str" },
        { name: "m-none" },
      ],
    });
  });

  it("malformed shapes → {ok:false, state:'http'}: data absent, data non-array, non-JSON body", async () => {
    await saveProviderKey("my-gw", "file-key", env());
    const fetch = fakeFetch([
      { status: 200, body: JSON.stringify({ object: "list" }) }, // no data
      { status: 200, body: JSON.stringify({ data: { id: "x" } }) }, // data not an array
      { status: 200, body: "<html>gateway error</html>" }, // not JSON
    ]);
    const ops = makeOps({ fetchImpl: fetch.fn });
    for (let i = 0; i < 3; i++) {
      const r = await ops.settingsListModels("my-gw");
      expect(r.ok, `case ${i}`).toBe(false);
      if (!r.ok) {
        expect(r.state).toBe("http");
        expect(r.message).toContain("服务返回异常");
      }
    }
  });

  it("failure states reuse the testConnection machine: 401 → auth, transport → network", async () => {
    await saveProviderKey("my-gw", "file-key", env());
    const fetch = fakeFetch([
      { status: 401, body: JSON.stringify({ error: { message: "bad key" } }) },
      { reject: new Error("fetch failed") },
    ]);
    const ops = makeOps({ fetchImpl: fetch.fn });
    const auth = await ops.settingsListModels("my-gw");
    expect(auth).toEqual({ ok: false, state: "auth", message: expect.stringContaining("Key 无效") });
    const net = await ops.settingsListModels("my-gw");
    expect(net).toEqual({ ok: false, state: "network", message: expect.any(String) });
  });

  it("no key anywhere → no-key; wudao (no endpoint) → no-endpoint", async () => {
    const fetch = fakeFetch([]);
    const ops = makeOps({ fetchImpl: fetch.fn });
    const noKey = await ops.settingsListModels("my-gw"); // no paste, no env, no file
    expect(noKey).toEqual({ ok: false, state: "no-key", message: expect.any(String) });
    await saveProviderKey("wudao", "wudao-key", env());
    const noEndpoint = await ops.settingsListModels("wudao"); // key resolves, endpoint never
    expect(noEndpoint).toEqual({ ok: false, state: "no-endpoint", message: expect.any(String) });
    expect(fetch.calls.length).toBe(0); // neither state probes the network
  });

  it("key ladder: pasted beats env beats file; the env pool keys ONLY the selected provider", async () => {
    const fetch = fakeFetch([
      { status: 200, body: JSON.stringify({ data: [{ id: "m" }] }) },
      { status: 200, body: JSON.stringify({ data: [{ id: "m" }] }) },
      { status: 200, body: JSON.stringify({ data: [{ id: "m" }] }) },
      { status: 200, body: JSON.stringify({ data: [{ id: "m" }] }) },
    ]);
    const ops = makeOps({ fetchImpl: fetch.fn, extraEnv: { WUDAO_API_KEY: "env-key", WUDAO_PROVIDER: "other-gw" } });
    // pasted wins even with env + file set for the selected provider
    await saveProviderKey("other-gw", "file-key", env());
    await ops.settingsListModels("other-gw", { key: "pasted-key" });
    expect(fetch.calls[0]?.authorization).toBe("Bearer pasted-key");
    // the env pool keys the SELECTED provider (other-gw)
    await ops.settingsListModels("other-gw");
    expect(fetch.calls[1]?.authorization).toBe("Bearer env-key");
    // ...and NOT an unselected one (my-gw falls to its file key)
    await saveProviderKey("my-gw", "my-file-key", env());
    await ops.settingsListModels("my-gw");
    expect(fetch.calls[2]?.authorization).toBe("Bearer my-file-key");
    // an unselected provider with no file key → no-key (the env pool is not shared)
    await ops.settingsSaveProvider("bare-gw", { baseUrl: "https://bare.example/v1" });
    const bare = await ops.settingsListModels("bare-gw");
    expect(bare).toEqual({ ok: false, state: "no-key", message: expect.any(String) });
  });

  it("the env base override applies ONLY to the selected provider; others use their registry baseUrl", async () => {
    await saveProviderKey("my-gw", "file-key", env());
    await saveProviderKey("other-gw", "other-key", env());
    const fetch = fakeFetch([
      { status: 200, body: JSON.stringify({ data: [] }) },
      { status: 200, body: JSON.stringify({ data: [] }) },
    ]);
    const ops = makeOps({
      fetchImpl: fetch.fn,
      extraEnv: { WUDAO_PROVIDER: "other-gw", WUDAO_BASE_URL: "https://override.example/v1" },
    });
    await ops.settingsListModels("other-gw"); // selected → the override rides
    expect(fetch.calls[0]?.url).toBe("https://override.example/v1/models");
    await ops.settingsListModels("my-gw"); // unselected → the registry baseUrl
    expect(fetch.calls[1]?.url).toBe("https://gw.example.com/v1/models");
  });

  it("an unknown provider rejects with the testConnection gate shape", async () => {
    const ops = makeOps();
    await expect(ops.settingsListModels("grok")).rejects.toThrow(/unknown provider "grok"/);
  });

  it("a just-saved provider is immediately listable — the I2 invalidation covers the probe's registry read", async () => {
    const fetch = fakeFetch([{ status: 200, body: JSON.stringify({ data: [{ id: "fresh-m" }] }) }]);
    const ops = makeOps({ fetchImpl: fetch.fn });
    await ops.settingsSaveProvider("fresh-gw", { baseUrl: "https://fresh.example/v1" });
    await saveProviderKey("fresh-gw", "fresh-key", env());
    const r = await ops.settingsListModels("fresh-gw");
    expect(r).toEqual({ ok: true, models: [{ name: "fresh-m" }] });
    expect(fetch.calls[0]?.url).toBe("https://fresh.example/v1/models");
  });
});

// SDD 2026-08-23 persona Task 4 — the provider card's `persona` field: a
// THREE-STATE binding column (key absent = follow the global default, string =
// bound persona id, explicit null = forced none). The read helper feeds the
// persona resolution chain (env > binding > default > none, spec §1); the save
// op must round-trip every state — the explicit null is the one a naive
// optional-field sanitizer would lose (T4b reasoningFormat precedent: the
// validator owns the sanitize, the save op just writes validated.value).
describe("card persona field (three-state) + readProviderPersonaBinding", () => {
  const rawCard = (id: string): Record<string, unknown> =>
    (JSON.parse(readFileSync(registryPath(), "utf8")) as { providers: Record<string, Record<string, unknown>> }).providers[id] ?? {};

  it("absent field: the key is never written and the helper reads undefined (follow-global)", async () => {
    const ops = makeOps();
    await ops.settingsSaveProvider("my-gw", { baseUrl: "https://gw.example.com/v1", defaultModel: "m-x" });
    expect("persona" in rawCard("my-gw")).toBe(false); // undefined ≠ null — no key on disk
    expect(readProviderPersonaBinding("my-gw", env())).toBeUndefined();
  });

  it("string persona: saved, echoed in the file, and read back by the helper", async () => {
    const ops = makeOps();
    await ops.settingsSaveProvider("my-gw", { baseUrl: "https://gw.example.com/v1", defaultModel: "m-x", persona: "alpha" });
    expect(rawCard("my-gw")["persona"]).toBe("alpha");
    expect(readProviderPersonaBinding("my-gw", env())).toBe("alpha");
  });

  it("explicit null persona SURVIVES the save round-trip (forced-none ≠ follow-global)", async () => {
    const ops = makeOps();
    await ops.settingsSaveProvider("my-gw", { baseUrl: "https://gw.example.com/v1", defaultModel: "m-x", persona: null });
    expect(rawCard("my-gw")["persona"]).toBeNull(); // the key is PRESENT with null
    expect(readProviderPersonaBinding("my-gw", env())).toBeNull();
  });

  it("the read side's own contract over a hand-written registry: three states + no-card + builtin overlay", () => {
    seedRegistry({
      bound: { baseUrl: "https://bound.example/v1", persona: "alpha" },
      unbound: { baseUrl: "https://unbound.example/v1", persona: null },
      bare: { baseUrl: "https://bare.example/v1" },
      deepseek: { persona: "beta" }, // a builtin overlay may carry the binding without a baseUrl
    });
    expect(readProviderPersonaBinding("bound", env())).toBe("alpha");
    expect(readProviderPersonaBinding("unbound", env())).toBeNull();
    expect(readProviderPersonaBinding("bare", env())).toBeUndefined();
    expect(readProviderPersonaBinding("missing-gw", env())).toBeUndefined(); // no card at all → undefined, not null
    expect(readProviderPersonaBinding("deepseek", env())).toBe("beta");
  });

  it("a junk persona value (number) refuses the row — fail-visible, never a silent drop to another state", async () => {
    seedRegistry({ "bad-persona": { baseUrl: "https://bad.example/v1", persona: 42 } });
    // read side: the invalid row does not surface entries (the settings matrix badges it instead)
    expect(readProviderPersonaBinding("bad-persona", env())).toBeUndefined();
    // save side: the validator refuses loudly
    const r = await makeOps().settingsSaveProvider("my-gw", { baseUrl: "https://gw.example.com/v1", persona: 42 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/persona/);
  });
});
