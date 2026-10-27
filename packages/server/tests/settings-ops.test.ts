// M63 §B — the settings/credentials ops over the WS protocol: same
// first-frame auth gate as every op, round-trip against a scripted driver
// port, the protocol-boundary key strip (a handler echoing a key gets it
// removed before the wire), absent-handler degradation, and payload
// validation.
import { describe, it, expect, afterEach } from "vitest";
import WebSocket from "ws";
import { createUiServer, type UiDriverPort, type UiServer } from "../src/index.js";

const wait = (ms = 10) => new Promise((r) => setTimeout(r, ms));

async function until(cond: () => boolean | Promise<boolean>, what: string, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  await wait();
  while (!(await cond())) {
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${what}`);
    await wait();
  }
}

const servers: UiServer[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
});

/** The bare driver every op test extends (the M63 §B ops ride as overrides). */
function baseDriver(): UiDriverPort {
  const status = { live: { reasoning: "", answer: "", busyTools: [] }, busy: false, mode: "default" };
  const cbs = new Set<() => void>();
  return {
    subscribe: (cb) => (cbs.add(cb), () => cbs.delete(cb)),
    getStatus: () => status,
    getHistory: () => [],
    onHistory: () => () => {},
    onLoopEvent: () => () => {},
    submit: () => "notice",
    interrupt: () => {},
    setMode: () => {},
    answerPermission: () => false,
    listSlashCommands: () => [],
    sessions: async () => [],
    resume: async () => ({ ok: true }),
    rewind: async () => "",
    beginEdit: () => undefined,
    tree: async () => "",
    switchBranch: async () => "",
  };
}

interface Frame {
  t: string;
  id?: number;
  ok?: unknown;
  err?: string;
  state?: unknown;
}

function connect(port: number, token: string): { ws: WebSocket; frames: Frame[]; open: Promise<void>; closed: Promise<{ code: number }> } {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const frames: Frame[] = [];
  const open = new Promise<void>((resolve) => ws.once("open", resolve));
  const closed = new Promise<{ code: number }>((resolve) => ws.once("close", (code) => resolve({ code })));
  ws.on("message", (data) => frames.push(JSON.parse(String(data)) as Frame));
  return { ws, frames, open, closed };
}

function auth(ws: WebSocket, token: string): void {
  ws.send(JSON.stringify({ t: "auth", token }));
}

async function opRoundTrip(
  port: number,
  token: string,
  op: Record<string, unknown>,
): Promise<{ ok?: unknown; err?: string }> {
  const c = connect(port, token);
  await c.open;
  auth(c.ws, token);
  await until(() => c.frames.some((f) => f.t === "history"), "auth replay");
  c.ws.send(JSON.stringify({ t: "op", id: 41, op }));
  await until(() => c.frames.some((f) => f.t === "result" && f.id === 41), "op result");
  const r = c.frames.find((f) => f.t === "result" && f.id === 41);
  c.ws.close();
  return { ok: r?.ok, err: r?.err };
}

describe("settings ops over the protocol (M63 §B)", () => {
  it("settings ops are auth-gated like every op: an unauthenticated op frame closes 4401", async () => {
    const server = await createUiServer({ driver: baseDriver(), token: "t" });
    servers.push(server);
    const c = connect(server.port, "t");
    await c.open;
    c.ws.send(JSON.stringify({ t: "op", id: 1, op: { op: "settingsStatus" } }));
    const ev = await c.closed;
    expect(ev.code).toBe(4401);
  });

  it("settingsStatus round-trips the handler's payload", async () => {
    const driver = {
      ...baseDriver(),
      settingsStatus: async () => ({ providers: [{ provider: "deepseek", status: "ready" }], credentials: { path: "/x", keyCount: 2 } }),
    };
    const server = await createUiServer({ driver, token: "t" });
    servers.push(server);
    const r = await opRoundTrip(server.port, "t", { op: "settingsStatus" });
    expect(r.err).toBeUndefined();
    expect(r.ok).toEqual({ providers: [{ provider: "deepseek", status: "ready" }], credentials: { path: "/x", keyCount: 2 } });
  });

  it("settingsSaveKey: the reply's key fields are stripped at the protocol boundary", async () => {
    const driver = {
      ...baseDriver(),
      // A misbehaving handler echoing the secret — the server must strip it.
      settingsSaveKey: async (provider: string, key: string) => ({ provider, saved: true, keyCount: 1, key, apiKey: key, apiKeys: [key] }),
    };
    const server = await createUiServer({ driver, token: "t" });
    servers.push(server);
    const r = await opRoundTrip(server.port, "t", { op: "settingsSaveKey", provider: "deepseek", key: "sk-live" });
    expect(r.err).toBeUndefined();
    expect(r.ok).toEqual({ provider: "deepseek", saved: true, keyCount: 1 });
    expect(JSON.stringify(r.ok)).not.toContain("sk-live");
  });

  it("settingsTestConnection: same strip on the test reply", async () => {
    const driver = {
      ...baseDriver(),
      settingsTestConnection: async () => ({ ok: false, state: "auth", message: "Key 无效或无余额", key: "sk-leak" }),
    };
    const server = await createUiServer({ driver, token: "t" });
    servers.push(server);
    const r = await opRoundTrip(server.port, "t", { op: "settingsTestConnection", provider: "glm", key: "sk-leak" });
    expect(r.ok).toEqual({ ok: false, state: "auth", message: "Key 无效或无余额" });
    expect(JSON.stringify(r.ok)).not.toContain("sk-leak");
  });

  it("an absent handler degrades to a clean error (no crash, connection lives)", async () => {
    const server = await createUiServer({ driver: baseDriver(), token: "t" });
    servers.push(server);
    const r = await opRoundTrip(server.port, "t", { op: "settingsStatus" });
    expect(r.err).toContain("not supported");
  });

  it("payload validation: missing/blank fields error without touching the handler", async () => {
    let called = 0;
    const bump = async (): Promise<unknown> => {
      called += 1;
      return { saved: true };
    };
    const driver = {
      ...baseDriver(),
      settingsSaveKey: bump,
      settingsTestConnection: bump,
      settingsSet: bump,
    };
    const server = await createUiServer({ driver, token: "t" });
    servers.push(server);
    const noProvider = await opRoundTrip(server.port, "t", { op: "settingsSaveKey", key: "k" });
    expect(noProvider.err).toContain("provider");
    const blankKey = await opRoundTrip(server.port, "t", { op: "settingsSaveKey", provider: "deepseek", key: "  " });
    expect(blankKey.err).toContain("key");
    const badModel = await opRoundTrip(server.port, "t", { op: "settingsTestConnection", provider: "glm", model: 7 });
    expect(badModel.err).toContain("model");
    const noKey = await opRoundTrip(server.port, "t", { op: "settingsSet", value: true });
    expect(noKey.err).toContain("key");
    expect(called).toBe(0);
  });

  it("handler rejections map to op errors (never a close)", async () => {
    const driver = {
      ...baseDriver(),
      settingsSet: async (key: string) => {
        throw new Error(`unknown settings key "${key}"`);
      },
    };
    const server = await createUiServer({ driver, token: "t" });
    servers.push(server);
    const r = await opRoundTrip(server.port, "t", { op: "settingsSet", key: "nonsense", value: 1 });
    expect(r.err).toContain("unknown settings key");
  });

  it("setMode accepts the host-configured mode set (acceptEdits under wudao ui)", async () => {
    const seen: string[] = [];
    const driver = { ...baseDriver(), setMode: (m: string) => void seen.push(m) };
    const server = await createUiServer({ driver, token: "t", modes: ["default", "acceptEdits", "auto", "read-only"] });
    servers.push(server);
    const r = await opRoundTrip(server.port, "t", { op: "setMode", mode: "acceptEdits" });
    expect(r.err).toBeUndefined();
    expect(seen).toEqual(["acceptEdits"]);
  });
});

// Review L3/L4 — settingsStatus also rides the strip, and the strip is
// DEEP: a nested secret (providers[].apiKey / nested key / keys[]) must not
// reach the wire at any depth.
describe("deep stripSecrets (review L3/L4)", () => {
  it("settingsStatus replies strip nested key material, preserving the rest", async () => {
    const driver = {
      ...baseDriver(),
      settingsStatus: async () => ({
        providers: [{ provider: "deepseek", status: "ready", apiKey: "sk-nested" }],
        credentials: { path: "/x", keyCount: 1, keys: ["sk-array"] },
        nested: { deep: { key: "sk-deep", keep: "kept" } },
      }),
    };
    const server = await createUiServer({ driver, token: "t" });
    servers.push(server);
    const r = await opRoundTrip(server.port, "t", { op: "settingsStatus" });
    const wire = JSON.stringify(r.ok);
    expect(wire).not.toContain("sk-nested");
    expect(wire).not.toContain("sk-array");
    expect(wire).not.toContain("sk-deep");
    expect(r.ok).toEqual({
      providers: [{ provider: "deepseek", status: "ready" }],
      credentials: { path: "/x", keyCount: 1 },
      nested: { deep: { keep: "kept" } },
    });
  });

  it("secret-free payloads round-trip unchanged in shape", async () => {
    const payload = { providers: [{ provider: "glm", status: "ready" }], credentials: { path: "/x", keyCount: 0 } };
    const driver = { ...baseDriver(), settingsStatus: async () => payload };
    const server = await createUiServer({ driver, token: "t" });
    servers.push(server);
    const r = await opRoundTrip(server.port, "t", { op: "settingsStatus" });
    expect(r.ok).toEqual(payload); // nothing stripped, nothing reshaped
  });
});

// cc-plugins C1 — the plugin-management ops over the WS protocol: same
// first-frame auth gate, the nine routing cases, engine-error passthrough
// (the err string IS the marketplace engine's message), shape validation
// (install scope grammar), and absent-handler degradation.
describe("plugin ops over the protocol (cc-plugins C1)", () => {
  it("plugin ops are auth-gated like every op: an unauthenticated op frame closes 4401", async () => {
    const server = await createUiServer({ driver: baseDriver(), token: "t" });
    servers.push(server);
    const c = connect(server.port, "t");
    await c.open;
    c.ws.send(JSON.stringify({ t: "op", id: 1, op: { op: "pluginList" } }));
    const ev = await c.closed;
    expect(ev.code).toBe(4401);
  });

  it("all nine ops route to the handler with their arguments (scope defaults to user)", async () => {
    const calls: string[] = [];
    const driver = {
      ...baseDriver(),
      pluginList: async () => { calls.push("list"); return { installed: [] }; },
      pluginMarketList: async () => { calls.push("market-list"); return { marketplaces: [] }; },
      pluginMarketAdd: async (source: string, name?: string) => { calls.push(`add:${source}:${name ?? "-"}`); return { name: name ?? "m", source, addedAt: "2026-01-01T00:00:00Z" }; },
      pluginMarketUpdate: async (name: string) => { calls.push(`update:${name}`); return { name, source: "s", addedAt: "2026-01-01T00:00:00Z" }; },
      pluginMarketRemove: async (name: string) => { calls.push(`remove:${name}`); return { removedPlugins: [], warnings: [] }; },
      pluginInstall: async (name: string, market: string, scope: string) => { calls.push(`install:${name}:${market}:${scope}`); return { dir: "/p", detail: { skills: 1, commands: 0, agents: 0, hooks: 0, mcp: 0 } }; },
      pluginUninstall: async (id: string) => { calls.push(`uninstall:${id}`); return { id, warnings: [] }; },
      pluginEnable: async (id: string) => { calls.push(`enable:${id}`); return { id, enabled: true }; },
      pluginDisable: async (id: string) => { calls.push(`disable:${id}`); return { id, enabled: false }; },
    };
    const server = await createUiServer({ driver, token: "t" });
    servers.push(server);

    const list = await opRoundTrip(server.port, "t", { op: "pluginList" });
    expect(list.err).toBeUndefined();
    expect(list.ok).toEqual({ installed: [] });
    const markets = await opRoundTrip(server.port, "t", { op: "pluginMarketList" });
    expect(markets.ok).toEqual({ marketplaces: [] });
    const added = await opRoundTrip(server.port, "t", { op: "pluginMarketAdd", source: "/tmp/market", name: "m1" });
    expect(added.ok).toEqual({ name: "m1", source: "/tmp/market", addedAt: "2026-01-01T00:00:00Z" });
    const addedAnon = await opRoundTrip(server.port, "t", { op: "pluginMarketAdd", source: "owner/repo" });
    expect(addedAnon.ok).toEqual({ name: "m", source: "owner/repo", addedAt: "2026-01-01T00:00:00Z" });
    const updated = await opRoundTrip(server.port, "t", { op: "pluginMarketUpdate", name: "m1" });
    expect(updated.ok).toEqual({ name: "m1", source: "s", addedAt: "2026-01-01T00:00:00Z" });
    const removed = await opRoundTrip(server.port, "t", { op: "pluginMarketRemove", name: "m1" });
    expect(removed.ok).toEqual({ removedPlugins: [], warnings: [] });
    const installed = await opRoundTrip(server.port, "t", { op: "pluginInstall", name: "alpha", market: "m" }); // no scope → user
    expect(installed.ok).toEqual({ dir: "/p", detail: { skills: 1, commands: 0, agents: 0, hooks: 0, mcp: 0 } });
    const installedProject = await opRoundTrip(server.port, "t", { op: "pluginInstall", name: "alpha", market: "m", scope: "project" });
    expect(installedProject.err).toBeUndefined();
    const uninstalled = await opRoundTrip(server.port, "t", { op: "pluginUninstall", id: "alpha@m" });
    expect(uninstalled.ok).toEqual({ id: "alpha@m", warnings: [] });
    const enabled = await opRoundTrip(server.port, "t", { op: "pluginEnable", id: "alpha@m" });
    expect(enabled.ok).toEqual({ id: "alpha@m", enabled: true });
    const disabled = await opRoundTrip(server.port, "t", { op: "pluginDisable", id: "alpha@m" });
    expect(disabled.ok).toEqual({ id: "alpha@m", enabled: false });

    expect(calls).toEqual([
      "list",
      "market-list",
      "add:/tmp/market:m1",
      "add:owner/repo:-",
      "update:m1",
      "remove:m1",
      "install:alpha:m:user",
      "install:alpha:m:project",
      "uninstall:alpha@m",
      "enable:alpha@m",
      "disable:alpha@m",
    ]);
  });

  it("pluginMarketAdd: the engine's source-validation error passes through as the op err", async () => {
    const driver = {
      ...baseDriver(),
      pluginMarketAdd: async (source: string) => {
        throw new Error(`cannot parse marketplace source "${source}" — expected owner/repo, a git URL (optional #ref), an existing marketplace directory, or a marketplace.json path`);
      },
    };
    const server = await createUiServer({ driver, token: "t" });
    servers.push(server);
    const r = await opRoundTrip(server.port, "t", { op: "pluginMarketAdd", source: "bogus" });
    expect(r.err).toContain('cannot parse marketplace source "bogus"');
    expect(r.err).toContain("owner/repo");
  });

  it("pluginInstall scope validation: outside user|project errors without touching the handler", async () => {
    let called = 0;
    const driver = {
      ...baseDriver(),
      pluginInstall: async () => {
        called += 1;
        return { dir: "/p", detail: { skills: 0, commands: 0, agents: 0, hooks: 0, mcp: 0 } };
      },
    };
    const server = await createUiServer({ driver, token: "t" });
    servers.push(server);
    const bad = await opRoundTrip(server.port, "t", { op: "pluginInstall", name: "alpha", market: "m", scope: "global" });
    expect(bad.err).toContain("scope");
    const num = await opRoundTrip(server.port, "t", { op: "pluginInstall", name: "alpha", market: "m", scope: 1 });
    expect(num.err).toContain("scope");
    expect(called).toBe(0);
  });

  it("payload validation: missing/blank required fields error without touching the handler", async () => {
    let called = 0;
    const bump = async (): Promise<unknown> => {
      called += 1;
      return {};
    };
    const driver = {
      ...baseDriver(),
      pluginMarketAdd: bump,
      pluginMarketUpdate: bump,
      pluginMarketRemove: bump,
      pluginInstall: bump,
      pluginUninstall: bump,
      pluginEnable: bump,
      pluginDisable: bump,
    };
    const server = await createUiServer({ driver, token: "t" });
    servers.push(server);
    const noSource = await opRoundTrip(server.port, "t", { op: "pluginMarketAdd" });
    expect(noSource.err).toContain("source");
    const blankSource = await opRoundTrip(server.port, "t", { op: "pluginMarketAdd", source: "  " });
    expect(blankSource.err).toContain("source");
    const badName = await opRoundTrip(server.port, "t", { op: "pluginMarketAdd", source: "s", name: "  " });
    expect(badName.err).toContain("name");
    const noMarket = await opRoundTrip(server.port, "t", { op: "pluginMarketUpdate" });
    expect(noMarket.err).toContain("name");
    const noRemove = await opRoundTrip(server.port, "t", { op: "pluginMarketRemove", name: "" });
    expect(noRemove.err).toContain("name");
    const noPluginName = await opRoundTrip(server.port, "t", { op: "pluginInstall", name: "", market: "m" });
    expect(noPluginName.err).toContain("name");
    const noMarket2 = await opRoundTrip(server.port, "t", { op: "pluginInstall", name: "a" });
    expect(noMarket2.err).toContain("market");
    const noId = await opRoundTrip(server.port, "t", { op: "pluginUninstall", id: "" });
    expect(noId.err).toContain("id");
    const noEnableId = await opRoundTrip(server.port, "t", { op: "pluginEnable" });
    expect(noEnableId.err).toContain("id");
    const noDisableId = await opRoundTrip(server.port, "t", { op: "pluginDisable", id: " " });
    expect(noDisableId.err).toContain("id");
    expect(called).toBe(0);
  });

  it("an absent handler degrades to a clean error; handler rejections map to op errors", async () => {
    const bare = await createUiServer({ driver: baseDriver(), token: "t" });
    servers.push(bare);
    const absent = await opRoundTrip(bare.port, "t", { op: "pluginList" });
    expect(absent.err).toContain("plugin ops not supported");

    const driver = {
      ...baseDriver(),
      pluginUninstall: async () => {
        throw new Error("⚠️ 运行中无法卸载插件（任务进行中）");
      },
    };
    const server = await createUiServer({ driver, token: "t" });
    servers.push(server);
    const refused = await opRoundTrip(server.port, "t", { op: "pluginUninstall", id: "alpha@m" });
    expect(refused.err).toBe("⚠️ 运行中无法卸载插件（任务进行中）");
  });
});

// Provider management Task 3 — the three registry ops on the wire (design
// §5): shape-gated relay to the optional driver methods, key-field stripping
// on every reply (a handler echoing the request key — or a stray secret in
// the models payload — never reaches the client), and the
// absent-handler degradation.
describe("provider-registry ops over the protocol (provider management §5)", () => {
  it("settingsSaveProvider: id string + config object gate, verbatim relay, reply stripped of key fields", async () => {
    const seen: { id: unknown; config: unknown }[] = [];
    const driver = {
      ...baseDriver(),
      settingsSaveProvider: async (id: string, config: unknown) => {
        seen.push({ id, config });
        // A misbehaving handler echoing secret-looking fields — the server strips.
        return { ok: true, provider: id, key: "sk-live", apiKey: "sk-live" };
      },
    };
    const server = await createUiServer({ driver, token: "t" });
    servers.push(server);
    const cfg = { baseUrl: "https://gw.example.com/v1", defaultModel: "m-x" };
    const r = await opRoundTrip(server.port, "t", { op: "settingsSaveProvider", id: "my-gw", config: cfg });
    expect(r.err).toBeUndefined();
    expect(r.ok).toEqual({ ok: true, provider: "my-gw" });
    expect(JSON.stringify(r.ok)).not.toContain("sk-live");
    expect(seen).toEqual([{ id: "my-gw", config: cfg }]); // config relayed verbatim (unknown object — server re-validates)
  });

  it("settingsDeleteProvider round-trips the handler's outcome (refusals included)", async () => {
    const driver = {
      ...baseDriver(),
      settingsDeleteProvider: async (id: string) =>
        id === "deepseek" ? { ok: false, error: "内置 provider 不可删除" } : { ok: true },
    };
    const server = await createUiServer({ driver, token: "t" });
    servers.push(server);
    const ok = await opRoundTrip(server.port, "t", { op: "settingsDeleteProvider", id: "my-gw" });
    expect(ok.ok).toEqual({ ok: true });
    const refused = await opRoundTrip(server.port, "t", { op: "settingsDeleteProvider", id: "deepseek" });
    expect(refused.ok).toEqual({ ok: false, error: "内置 provider 不可删除" });
  });

  it("settingsListModels: provider string gate, optional string key, reply stripped", async () => {
    const seen: { provider: unknown; key: unknown }[] = [];
    const driver = {
      ...baseDriver(),
      settingsListModels: async (provider: string, opts?: { key?: string }) => {
        seen.push({ provider, key: opts?.key });
        return { ok: true, models: [{ name: "m-x" }], key: "sk-probe" };
      },
    };
    const server = await createUiServer({ driver, token: "t" });
    servers.push(server);
    const bare = await opRoundTrip(server.port, "t", { op: "settingsListModels", provider: "my-gw" });
    expect(bare.ok).toEqual({ ok: true, models: [{ name: "m-x" }] });
    expect(JSON.stringify(bare.ok)).not.toContain("sk-probe");
    const pasted = await opRoundTrip(server.port, "t", { op: "settingsListModels", provider: "my-gw", key: "sk-paste" });
    expect(pasted.err).toBeUndefined();
    expect(seen).toEqual([
      { provider: "my-gw", key: undefined },
      { provider: "my-gw", key: "sk-paste" },
    ]);
  });

  it("payload validation: blank id / non-object config / non-string key error without touching the handler", async () => {
    let called = 0;
    const bump = async (): Promise<unknown> => {
      called += 1;
      return { ok: true };
    };
    const driver = {
      ...baseDriver(),
      settingsSaveProvider: bump,
      settingsDeleteProvider: bump,
      settingsListModels: bump,
    };
    const server = await createUiServer({ driver, token: "t" });
    servers.push(server);
    const noId = await opRoundTrip(server.port, "t", { op: "settingsSaveProvider", config: {} });
    expect(noId.err).toContain("id");
    const blankId = await opRoundTrip(server.port, "t", { op: "settingsSaveProvider", id: "  ", config: {} });
    expect(blankId.err).toContain("id");
    const badConfig = await opRoundTrip(server.port, "t", { op: "settingsSaveProvider", id: "my-gw", config: "https://x/v1" });
    expect(badConfig.err).toContain("config");
    const noDeleteId = await opRoundTrip(server.port, "t", { op: "settingsDeleteProvider" });
    expect(noDeleteId.err).toContain("id");
    const noProvider = await opRoundTrip(server.port, "t", { op: "settingsListModels" });
    expect(noProvider.err).toContain("provider");
    const badKey = await opRoundTrip(server.port, "t", { op: "settingsListModels", provider: "my-gw", key: 7 });
    expect(badKey.err).toContain("key");
    expect(called).toBe(0);
  });

  it("absent handlers degrade to the settings-ops not-supported error", async () => {
    const server = await createUiServer({ driver: baseDriver(), token: "t" });
    servers.push(server);
    for (const op of [
      { op: "settingsSaveProvider", id: "my-gw", config: {} },
      { op: "settingsDeleteProvider", id: "my-gw" },
      { op: "settingsListModels", provider: "my-gw" },
    ]) {
      const r = await opRoundTrip(server.port, "t", op);
      expect(r.err, op.op).toContain("settings ops not supported");
    }
  });
});

describe("fileWrite op (高亮/编辑 spec §3)", () => {
  it("round-trips written:true from the driver handler", async () => {
    const server = await createUiServer({
      driver: { ...baseDriver(), fileWrite: async () => ({ written: true }) },
      token: "t",
    });
    servers.push(server);
    const r = await opRoundTrip(server.port, "t", { op: "fileWrite", path: "a.ts", content: "x", base: "" });
    expect(r.ok).toEqual({ written: true });
  });

  it("passes the conflict shape through untouched (current prefix)", async () => {
    const server = await createUiServer({
      driver: { ...baseDriver(), fileWrite: async () => ({ conflict: true, current: "disk" }) },
      token: "t",
    });
    servers.push(server);
    const r = await opRoundTrip(server.port, "t", { op: "fileWrite", path: "a.ts", content: "x", base: "old" });
    expect(r.ok).toEqual({ conflict: true, current: "disk" });
  });

  it("no driver method → the friendly not-supported error", async () => {
    const server = await createUiServer({ driver: baseDriver(), token: "t" });
    servers.push(server);
    const r = await opRoundTrip(server.port, "t", { op: "fileWrite", path: "a.ts", content: "x", base: "" });
    expect(r.ok).toBeUndefined();
    expect(r.err).toMatch(/not supported/);
  });

  it("non-string params → the validation error (even with the method present)", async () => {
    const server = await createUiServer({
      driver: { ...baseDriver(), fileWrite: async () => ({ written: true }) },
      token: "t",
    });
    servers.push(server);
    const r = await opRoundTrip(server.port, "t", { op: "fileWrite", path: 1, content: "x", base: "" });
    expect(r.err).toMatch(/path, content and base strings/);
  });

  it("driver rejection → the error text (guards live driver-side)", async () => {
    const server = await createUiServer({
      driver: {
        ...baseDriver(),
        fileWrite: async () => { throw new Error("sensitive path"); },
      },
      token: "t",
    });
    servers.push(server);
    const r = await opRoundTrip(server.port, "t", { op: "fileWrite", path: ".env", content: "x", base: "" });
    expect(r.err).toBe("sensitive path");
  });
});
