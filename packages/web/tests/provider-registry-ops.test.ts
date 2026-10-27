// Provider management Task 3 — the three registry wire ops (design §5) over
// the in-memory fake WebSocket: verbatim frame-shape pins (the config rides
// as an opaque object the server re-validates; the listModels key rides only
// when pasted), typed reply round-trips (save/delete outcomes, the /models
// probe's ok/false split), the mutation-vault classification (save is vaulted
// like settingsSet — a provider write is a side effect that must survive a
// mid-flap replay exactly once; delete converges and the probe is a read, so
// neither vaults), and the no-key-echo posture (no resolved reply for these
// ops ever carries key material).
import { describe, expect, it } from "vitest";
import { WudaoClient, isRetryableMutation } from "../src/protocol.js";
import type { SettingsStatus } from "../src/protocol.js";
import { authOk, fakeServer } from "./mock-ws.js";
import type { FakeServer } from "./mock-ws.js";

interface Harness {
  readonly client: WudaoClient;
  readonly server: FakeServer;
}

function connected(): Harness {
  const server = fakeServer();
  const client = new WudaoClient({
    url: "ws://127.0.0.1:9999",
    token: "sekrit",
    wsFactory: () => server.spawn(),
    reconnect: false,
  });
  client.connect();
  server.socket.serverOpen();
  authOk(server.socket);
  return { client, server };
}

/** The op frames the client sent, parsed (auth excluded). */
function opFrames(server: FakeServer): { id: number; op: Record<string, unknown> }[] {
  return server.clientFrames().filter(
    (f): f is { id: number; op: Record<string, unknown> } =>
      typeof f === "object" && f !== null && "op" in (f as Record<string, unknown>),
  );
}

/** Resolve every pending op promise with the scripted reply, in send order. */
async function settle(server: FakeServer, replies: unknown[]): Promise<unknown[]> {
  const frames = opFrames(server);
  const out = frames.map((f, i) => {
    const r = replies[Math.min(i, replies.length - 1)];
    server.socket.serverSend({ t: "result", id: f.id, ok: r });
    return r;
  });
  // Let the promise callbacks drain before the caller asserts.
  await new Promise((resolve) => setTimeout(resolve, 0));
  return out;
}

describe("provider-registry ops — wire shapes (design §5)", () => {
  it("settingsSaveProvider sends {op,id,config} verbatim and resolves the typed outcome", async () => {
    const h = connected();
    const config = { label: "My GW", baseUrl: "https://gw.example.com/v1", defaultModel: "m-x" };
    const p = h.client.settingsSaveProvider("my-gw", config);
    expect(opFrames(h.server).map((f) => f.op)).toEqual([{ op: "settingsSaveProvider", id: "my-gw", config }]);
    await settle(h.server, [{ ok: true, provider: "my-gw" }]);
    await expect(p).resolves.toEqual({ ok: true, provider: "my-gw" });
  });

  it("a refused save resolves the {ok:false,error} arm (the reason rides verbatim)", async () => {
    const h = connected();
    const p = h.client.settingsSaveProvider("1bad", { baseUrl: "https://gw.example.com/v1" });
    const reason = 'invalid provider id "1bad" (expected letter first, then [A-Za-z0-9_-])';
    await settle(h.server, [{ ok: false, error: reason }]);
    const r = await p;
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe(reason);
  });

  it("settingsDeleteProvider sends {op,id} and resolves both outcome arms", async () => {
    const h = connected();
    const ok = h.client.settingsDeleteProvider("my-gw");
    const builtin = h.client.settingsDeleteProvider("deepseek");
    expect(opFrames(h.server).map((f) => f.op)).toEqual([
      { op: "settingsDeleteProvider", id: "my-gw" },
      { op: "settingsDeleteProvider", id: "deepseek" },
    ]);
    await settle(h.server, [{ ok: true }, { ok: false, error: "内置 provider 不可删除" }]);
    await expect(ok).resolves.toEqual({ ok: true });
    const r = await builtin;
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("内置 provider 不可删除");
  });

  it("settingsListModels: key rides ONLY when pasted (the field is omitted otherwise)", async () => {
    const h = connected();
    const bare = h.client.settingsListModels("glm");
    const pasted = h.client.settingsListModels("my-gw", { key: "sk-paste" });
    expect(opFrames(h.server).map((f) => f.op)).toEqual([
      { op: "settingsListModels", provider: "glm" },
      { op: "settingsListModels", provider: "my-gw", key: "sk-paste" },
    ]);
    await settle(h.server, [
      { ok: true, models: [{ name: "glm-4.6" }] },
      { ok: false, state: "auth", message: "Key 无效或无余额" },
    ]);
    await expect(bare).resolves.toEqual({ ok: true, models: [{ name: "glm-4.6" }] });
    await expect(pasted).resolves.toEqual({ ok: false, state: "auth", message: "Key 无效或无余额" });
  });

  it("a listModels reply with contextLength rows resolves typed (the OpenRouter prefill shape)", async () => {
    const h = connected();
    const p = h.client.settingsListModels("my-gw");
    await settle(h.server, [
      { ok: true, models: [{ name: "m-a", contextLength: 123456 }, { name: "m-b" }] },
    ]);
    await expect(p).resolves.toEqual({
      ok: true,
      models: [{ name: "m-a", contextLength: 123456 }, { name: "m-b" }],
    });
  });

  it("settingsStatus resolves cards carrying the §5 extension fields", async () => {
    const h = connected();
    const p = h.client.settingsStatus();
    const status: SettingsStatus = {
      providers: [
        {
          provider: "my-gw",
          label: "My GW",
          status: "ready",
          keySource: "credentials",
          endpoint: "https://gw.example.com/v1",
          defaultModel: "m-x",
          baseUrl: "https://gw.example.com/v1",
          custom: true,
          models: [{ name: "m-x", contextLength: 200000 }],
          defaultContextLength: 200000,
        },
        {
          provider: "broken-entry",
          label: "broken-entry",
          status: "missing-key",
          keySource: null,
          endpoint: null,
          defaultModel: "",
          custom: true,
          models: [],
          invalidReason: "custom provider \"broken-entry\" needs a baseUrl",
        },
      ],
      credentials: { path: "/home/u/.wudao/.credentials.yaml", keyCount: 1 },
      settings: { memoryEnabled: true, uiDefaultMode: null, wizardCompletedVersion: 0, uiTheme: null, uiAccent: null },
      current: { provider: "deepseek", model: "deepseek-v4-flash" },
      envKey: false,
      readiness: true,
      efforts: ["low", "medium", "high", "max", "none"],
    };
    await settle(h.server, [status]);
    await expect(p).resolves.toEqual(status);
  });
});

describe("provider-registry ops — vault classification", () => {
  it("settingsSaveProvider is a vaulted mutation (like settingsSet); delete + the /models probe are reads", () => {
    expect(isRetryableMutation({ op: "settingsSaveProvider", id: "my-gw", config: { baseUrl: "https://x/v1" } })).toBe(true);
    expect(isRetryableMutation({ op: "settingsDeleteProvider", id: "my-gw" })).toBe(false);
    expect(isRetryableMutation({ op: "settingsListModels", provider: "glm" })).toBe(false);
    expect(isRetryableMutation({ op: "settingsListModels", provider: "glm", key: "sk" })).toBe(false);
  });
});

describe("provider-registry ops — no key echo", () => {
  it("no resolved reply for the three ops ever carries key material (the client passes replies through untouched)", async () => {
    const h = connected();
    const replies = [
      { ok: true, provider: "my-gw" },
      { ok: true },
      { ok: true, models: [{ name: "m-x" }] },
    ];
    const pending = [
      h.client.settingsSaveProvider("my-gw", { baseUrl: "https://x/v1" }),
      h.client.settingsDeleteProvider("my-gw"),
      h.client.settingsListModels("my-gw", { key: "sk-paste" }),
    ];
    await settle(h.server, replies);
    const results = await Promise.all(pending);
    for (const r of results) {
      expect(JSON.stringify(r)).not.toContain("sk-paste");
      expect(JSON.stringify(r)).not.toMatch(/"(key|apiKey|apiKeys|keys)"/);
    }
  });
});
