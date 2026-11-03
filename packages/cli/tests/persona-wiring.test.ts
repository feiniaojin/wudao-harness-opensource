// SDD 2026-08-23 persona Task 3 — the construction-seam wiring pins.
//
// Task 1 landed the pure chain (resolveActivePersona) and Task 2 the driver's
// /persona handler over DriverPersonaContext; THIS file pins what Task 3
// adds: the two production construction seams actually sink the persona
// runtime —
//   • TUI (app.tsx): the boot client AND the onProviderSwitch rebuild are
//     withPersona(createProvider(..., { personaRuntime }), runtime) INSIDE
//     the cache tracker; the registry loads at mount; a provider switch
//     follows the chain (manual layer cleared → env > binding > default →
//     runtime.current swap — a FIELD swap, no client rebuild) with notice +
//     persona_change(reason "provider-switch");
//   • web (session-engine.ts): the same, with the runtime owned PER SESSION.
// The behavioral probe is byte-level: a local OpenAI-compatible SSE endpoint
// captures every request, and persona layers are asserted on the WIRE
// (x-persona header from the headers layer, the system prefix from the
// prompt layer) — a withPersona-less construction cannot produce them.
// The boot-time null-current identity (bare bytes before any persona) is
// pinned at the providers layer (persona-openai-wire.test.ts, Task 3 pin).
import { describe, it, expect, afterEach } from "vitest";
import React, { createElement } from "react";
import { render, type Instance } from "ink-testing-library";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { ProviderConfig, PersonaDefinition, PersonaRegistry } from "@wudao-org/providers";
import { createPersonaRuntime, resolvePersona } from "@wudao-org/providers";
import { applyPersonaChainAfterProviderSwitch } from "../src/commands/persona.js";
import { resetProviderRegistryCacheForTests } from "../src/provider-registry.js";
import { createDriverSession } from "../src/driver/session-engine.js";
import type { DriverSession } from "../src/driver/session-engine.js";
import { WudaoApp } from "../src/tui/app.js";
import { TITLE_SYSTEM_FIRST_LINE } from "../src/session-title.js";

const wait = (ms = 10) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean | Promise<boolean>, what: string, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  await wait();
  while (!(await cond())) {
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${what}`);
    await wait();
  }
}

// ink-testing-library delivers a multi-char stdin.write as ONE input chunk —
// text must be fed character by character with an await between writes
// (React 19 batching), "\r" alone parses as the return key.
async function type(stdin: { write(s: string): void }, text: string): Promise<void> {
  for (const ch of text) {
    stdin.write(ch);
    await wait(15);
  }
}

/** A minimal OpenAI-compatible streaming endpoint that captures EVERY request
 *  byte (url, method, headers, body) and answers one content delta + usage. */
interface CapturedRequest {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: string;
}
function startFakeProvider(): Promise<{ server: Server; url: string; requests: CapturedRequest[]; allRequests: CapturedRequest[] }> {
  const requests: CapturedRequest[] = [];
  const allRequests: CapturedRequest[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => { body += c.toString("utf8"); });
    req.on("end", () => {
      const captured: CapturedRequest = { url: req.url ?? "", method: req.method ?? "", headers: req.headers as Record<string, string>, body };
      allRequests.push(captured);
      // 夜移 005: the session's auto-title side-call shares this endpoint —
      // keep it out of `requests` so index-based assertions see only the
      // main-loop wire traffic (raw copy: allRequests).
      if (!body.includes(TITLE_SYSTEM_FIRST_LINE)) requests.push(captured);
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(
        [
          `data: ${JSON.stringify({ choices: [{ delta: { content: "ok" }, finish_reason: null }] })}`,
          `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}`,
          `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 } })}`,
          "data: [DONE]",
          "",
        ].join("\n\n"),
      );
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, url: `http://127.0.0.1:${port}/v1`, requests, allRequests });
    });
  });
}

// ——— persona fixtures (workspace tier): headers layer = x-persona marker,
// prompt layer = a recognizable system prefix, prompt ON by defaultLayers. ———
const personaFile = (id: string, marker: string): string => JSON.stringify({
  id,
  displayName: `${id[0]?.toUpperCase()}${id.slice(1)}`,
  source: { kind: "workspace-source", provenance: "test", pinnedVersion: "1" },
  defaultLayers: { prompt: true },
  headers: { "openai-chat": { "x-persona": marker } },
  prompt: { system: { mode: "prefix", text: `[${marker.toUpperCase()}] ` } },
});
function writeWorkspacePersonas(ws: string): void {
  mkdirSync(join(ws, ".wudao", "personas"), { recursive: true });
  for (const [id, marker] of [["alpha", "alpha"], ["beta", "beta"], ["gamma", "gamma"]] as const) {
    writeFileSync(join(ws, ".wudao", "personas", `${id}.json`), personaFile(id, marker));
  }
}

/** 0.3.31b: at a mid-session switch the TARGET profile's endpoint outranks
 *  WUDAO_BASE_URL (the env-first order was the kimi-404 bug), so these
 *  switch tests pin the fake endpoint the way the new rule reads it — a
 *  REGISTRY overlay on glm whose baseUrl IS the fake server. */
function pinGlmEndpoint(url: string): void {
  writeFileSync(
    join(process.env.WUDAO_GLOBAL_HOME as string, "providers.json"),
    JSON.stringify({ version: 1, providers: { glm: { baseUrl: url } } }, null, 2),
    "utf8",
  );
  resetProviderRegistryCacheForTests();
}

const systemOf = (req: CapturedRequest): string => {
  const parsed = JSON.parse(req.body) as { messages: { role: string; content: string }[] };
  const sys = parsed.messages.find((m) => m.role === "system");
  if (sys === undefined) throw new Error("no system message on the wire");
  return sys.content;
};

interface PersonaChangeLine { readonly type: string; readonly data: { readonly id: string | null; readonly reason?: string; readonly from?: string | null } }
const personaChanges = (ws: string, sessionId: string): PersonaChangeLine[] => {
  const file = join(ws, ".wudao", "sessions", `${sessionId}.jsonl`);
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as PersonaChangeLine)
    .filter((e) => e.type === "persona_change");
};

const noticesOf = (d: { getHistory(): readonly { kind: string; text?: string }[] }): string =>
  d.getHistory().map((e) => (e.kind === "notice" ? (e.text ?? "") : "")).join("\n");

// ——— suite-wide cleanup ————————————————————————————————————————————————————
const sessions: DriverSession[] = [];
const roots: string[] = [];
const servers: Server[] = [];
const tuis: Instance[] = [];
afterEach(async () => {
  for (const t of tuis.splice(0)) t.unmount();
  for (const s of sessions.splice(0)) await s.close();
  // win32: a just-closed session's child/watcher handle can linger a few ms —
  // the rmdir races EPERM. Retry briefly before surfacing.
  for (const r of roots.splice(0)) {
    for (let i = 0; i < 10; i += 1) {
      try {
        rmSync(r, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
        break;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EPERM") throw e;
        await new Promise((res) => setTimeout(res, 50));
      }
    }
  }
  for (const s of servers.splice(0)) await new Promise<void>((resolve) => s.close(() => resolve()));
});

// ---------------------------------------------------------------------------
// Pure layer — applyPersonaChainAfterProviderSwitch (commands/persona.ts)
// ---------------------------------------------------------------------------
const alphaDef: PersonaDefinition = {
  id: "alpha", displayName: "Alpha",
  source: { kind: "workspace-source", provenance: "test", pinnedVersion: "1" },
  defaultLayers: { prompt: true },
  headers: { "openai-chat": { "x-persona": "alpha" } },
  prompt: { system: { mode: "prefix", text: "[ALPHA] " } },
};
const betaDef: PersonaDefinition = {
  id: "beta", displayName: "Beta",
  source: { kind: "workspace-source", provenance: "test", pinnedVersion: "1" },
  defaultLayers: { prompt: true },
  headers: { "openai-chat": { "x-persona": "beta" } },
  prompt: { system: { mode: "prefix", text: "[BETA] " } },
};
const registry: PersonaRegistry = { personas: [alphaDef, betaDef], errors: [] };

describe("applyPersonaChainAfterProviderSwitch (pure)", () => {
  it("swaps runtime.current to the binding persona and reports changed/provenance/previous", () => {
    const rt = createPersonaRuntime(null);
    const f = applyPersonaChainAfterProviderSwitch(rt, registry, { envPersona: null, bindingId: "beta", defaultId: undefined });
    expect(f.changed).toBe(true);
    expect(f.provenance).toBe("binding");
    expect(f.previous).toBeNull();
    expect(rt.current?.definition.id).toBe("beta"); // the FIELD swap happened
    expect(f.breaksCache).toBe(true); // beta's prompt layer is on → cold next turn
  });
  it("a no-op follow (same resolved persona) reports changed=false — no record", () => {
    const rt = createPersonaRuntime(resolvePersona(betaDef));
    const f = applyPersonaChainAfterProviderSwitch(rt, registry, { envPersona: null, bindingId: "beta", defaultId: undefined });
    expect(f.changed).toBe(false);
    expect(f.resolved?.definition.id).toBe("beta");
  });
  it("env beats binding — the env layer is never re-resolved away", () => {
    const rt = createPersonaRuntime(null);
    const f = applyPersonaChainAfterProviderSwitch(rt, registry, {
      envPersona: resolvePersona(alphaDef), bindingId: "beta", defaultId: undefined,
    });
    expect(f.provenance).toBe("env");
    expect(f.resolved?.definition.id).toBe("alpha");
  });
  it("explicitly-null binding (provider card says unbound) → none, changed", () => {
    const rt = createPersonaRuntime(resolvePersona(betaDef));
    const f = applyPersonaChainAfterProviderSwitch(rt, registry, { envPersona: null, bindingId: null, defaultId: undefined });
    expect(f.provenance).toBe("none");
    expect(f.resolved).toBeNull();
    expect(rt.current).toBeNull();
    expect(f.changed).toBe(true);
  });
  it("same id but different layers → changed (the follow is not name-only)", () => {
    const rt = createPersonaRuntime(resolvePersona(alphaDef)); // prompt ON (defaultLayers)
    const f = applyPersonaChainAfterProviderSwitch(rt, registry, {
      envPersona: resolvePersona(alphaDef, { prompt: false }), bindingId: "beta", defaultId: undefined,
    });
    expect(f.resolved?.definition.id).toBe("alpha");
    expect(f.changed).toBe(true); // layers moved — a real switch
  });
});

// ---------------------------------------------------------------------------
// Web seam — session-engine.ts (runtime owned PER SESSION)
// ---------------------------------------------------------------------------
describe("persona runtime sink — session-engine (web) seam", () => {
  it("boot client carries no persona; /provider follows the binding chain on the wire + records reason provider-switch", async () => {
    const fake = await startFakeProvider();
    servers.push(fake.server);
    pinGlmEndpoint(fake.url);

    const ws = mkdtempSync(join(tmpdir(), "persona-web-"));
    roots.push(ws);
    writeWorkspacePersonas(ws);
    const sessionId = "wudao-persona-web-01";
    const session = await createDriverSession({
      config: { apiKey: "test-key", apiKeys: ["test-key"], baseURL: fake.url, model: "boot-model", provider: "deepseek" },
      workspaceRoot: ws,
      contextWindowTokens: 64_000,
      tools: [],
      sessionId,
      noPeer: true,
      readProviderPersonaBinding: (p) => (p === "glm" ? "beta" : undefined),
    });
    sessions.push(session);

    session.driver.submit("hi");
    await until(() => fake.requests.length >= 1, "boot request");
    await until(() => session.driver.getStatus().busy === false, "boot run settles");
    expect(fake.requests[0]?.headers["x-persona"]).toBeUndefined(); // bare boot bytes
    expect(systemOf(fake.requests[0])).not.toContain("[BETA]");

    session.driver.submit("/provider glm");
    await until(() => session.driver.getStatus().model?.provider === "glm", "provider switched");
    await until(() => noticesOf(session.driver).includes("persona → beta（供应商绑定）"), "chain-follow notice"); // ω99-166f-ii: 钉随源演进
    session.driver.submit("hi");
    await until(() => fake.requests.length >= 2, "post-switch request");
    await until(() => session.driver.getStatus().busy === false, "post-switch run settles");

    // The rebuilt client carries the re-resolved persona on the wire — both layers.
    expect(fake.requests[1]?.headers["x-persona"]).toBe("beta");
    expect(systemOf(fake.requests[1])).toContain("[BETA] ");

    await until(() => personaChanges(ws, sessionId).some((e) => e.data.reason === "provider-switch"), "provider-switch record");
    const rec = personaChanges(ws, sessionId).find((e) => e.data.reason === "provider-switch");
    expect(rec?.data.id).toBe("beta");
    expect(rec?.data.from).toBeUndefined(); // from bare — no from field
  }, 20_000);

  it("a manual /persona selection does NOT survive a provider switch (manual layer cleared)", async () => {
    const fake = await startFakeProvider();
    servers.push(fake.server);
    pinGlmEndpoint(fake.url);

    const ws = mkdtempSync(join(tmpdir(), "persona-web-"));
    roots.push(ws);
    writeWorkspacePersonas(ws);
    const sessionId = "wudao-persona-web-02";
    const session = await createDriverSession({
      config: { apiKey: "test-key", apiKeys: ["test-key"], baseURL: fake.url, model: "boot-model", provider: "deepseek" },
      workspaceRoot: ws,
      contextWindowTokens: 64_000,
      tools: [],
      sessionId,
      noPeer: true,
      readProviderPersonaBinding: (p) => (p === "glm" ? "beta" : undefined),
    });
    sessions.push(session);

    session.driver.submit("/persona alpha --with-prompt");
    await until(() => noticesOf(session.driver).includes("persona → alpha"), "manual switch notice");
    session.driver.submit("hi");
    await until(() => fake.requests.length >= 1, "manual-persona request");
    await until(() => session.driver.getStatus().busy === false, "manual run settles");
    expect(fake.requests[0]?.headers["x-persona"]).toBe("alpha");

    session.driver.submit("/provider glm");
    await until(() => session.driver.getStatus().model?.provider === "glm", "provider switched");
    session.driver.submit("hi");
    await until(() => fake.requests.length >= 2, "post-switch request");
    await until(() => session.driver.getStatus().busy === false, "post-switch run settles");
    // Manual layer was cleared → the chain re-resolved to the TARGET binding.
    expect(fake.requests[1]?.headers["x-persona"]).toBe("beta");
    expect(systemOf(fake.requests[1])).toContain("[BETA] ");
  }, 20_000);

  it("per-session runtimes: one session's switch never leaks into another (and each resolves its own env layer)", async () => {
    const fakeA = await startFakeProvider();
    const fakeB = await startFakeProvider();
    servers.push(fakeA.server, fakeB.server);

    const wsA = mkdtempSync(join(tmpdir(), "persona-isol-a-"));
    const wsB = mkdtempSync(join(tmpdir(), "persona-isol-b-"));
    roots.push(wsA, wsB);
    writeWorkspacePersonas(wsA);
    writeWorkspacePersonas(wsB);

    const a = await createDriverSession({
      config: { apiKey: "test-key", apiKeys: ["test-key"], baseURL: fakeA.url, model: "boot-model", provider: "deepseek" },
      workspaceRoot: wsA, contextWindowTokens: 64_000, tools: [], sessionId: "wudao-persona-iso-a", noPeer: true,
    });
    sessions.push(a);
    const b = await createDriverSession({
      config: {
        apiKey: "test-key", apiKeys: ["test-key"], baseURL: fakeB.url, model: "boot-model", provider: "deepseek",
        // env 限定 = 完整启用集（spec §10.1 mask）——headers 必须点名（历史
        // overlay 语义下 {prompt:true} 会连带 headers；mask 下未列出即关）。
        persona: { id: "gamma", layers: { headers: true, prompt: true } }, // session B's env layer
      },
      workspaceRoot: wsB, contextWindowTokens: 64_000, tools: [], sessionId: "wudao-persona-iso-b", noPeer: true,
    });
    sessions.push(b);

    // A switches manually to alpha; B stays untouched.
    a.driver.submit("/persona alpha --with-prompt");
    await until(() => noticesOf(a.driver).includes("persona → alpha"), "A manual switch");
    a.driver.submit("hi");
    await until(() => fakeA.requests.length >= 1, "A request");
    await until(() => a.driver.getStatus().busy === false, "A run settles");
    expect(fakeA.requests[0]?.headers["x-persona"]).toBe("alpha");

    // B's own env layer resolved at ITS construction; A's manual alpha never leaked.
    b.driver.submit("hi");
    await until(() => fakeB.requests.length >= 1, "B request");
    await until(() => b.driver.getStatus().busy === false, "B run settles");
    expect(fakeB.requests[0]?.headers["x-persona"]).toBe("gamma");
    expect(systemOf(fakeB.requests[0])).toContain("[GAMMA] ");
  }, 20_000);
});

// ---------------------------------------------------------------------------
// TUI seam — app.tsx (registry at mount; single runtime for the session)
// ---------------------------------------------------------------------------
/** Deterministic sync point: repeatedly list /persona until the workspace
 *  persona appears — the driver lists from the injected registry, which the
 *  mount effect fills after loadPersonaRegistry resolves. */
async function untilPersonaListed(inst: Instance, id: string): Promise<void> {
  for (let i = 0; i < 40; i++) {
    await type(inst.stdin, "/persona\r");
    await wait(40);
    if ((inst.lastFrame() ?? "").includes(id)) return;
  }
  throw new Error(`persona "${id}" never listed — registry not sunk into the driver`);
}

describe("persona runtime sink — TUI (app.tsx) seam", () => {
  it("(a) withPersona probe: /persona switches the fingerprint ON THE WIRE of the boot client (no rebuild)", async () => {
    const fake = await startFakeProvider();
    servers.push(fake.server);
    const ws = mkdtempSync(join(tmpdir(), "persona-tui-a-"));
    roots.push(ws);
    writeWorkspacePersonas(ws);

    const inst = render(createElement(WudaoApp, {
      config: { apiKey: "test-key", apiKeys: ["test-key"], baseURL: fake.url, model: "boot-model", provider: "deepseek" },
      workspaceRoot: ws,
      contextWindowTokens: 64_000,
      tools: [],
      sessionId: "wudao-persona-tui-a",
    }));
    tuis.push(inst);
    await untilPersonaListed(inst, "alpha");

    await type(inst.stdin, "hi\r");
    await until(() => fake.requests.length >= 1, "boot request");
    await until(() => (inst.lastFrame() ?? "").includes("ok"), "boot run renders");
    expect(fake.requests[0]?.headers["x-persona"]).toBeUndefined(); // bare boot
    expect(systemOf(fake.requests[0] as CapturedRequest)).not.toContain("[ALPHA]");

    // Manual switch → the SAME client's next request carries the persona
    // (headers via options.personaRuntime, prompt prefix via withPersona).
    await type(inst.stdin, "/persona alpha --with-prompt\r");
    await until(() => (inst.lastFrame() ?? "").includes("persona → alpha"), "manual switch notice");
    await type(inst.stdin, "hi\r");
    await until(() => fake.requests.length >= 2, "persona'd request");
    expect(fake.requests[1]?.headers["x-persona"]).toBe("alpha");
    expect(systemOf(fake.requests[1])).toContain("[ALPHA] ");
  }, 30_000);

  it("(b) onProviderSwitch follows the chain: binding resolves, notice lands, persona_change reason provider-switch", async () => {
    const fake = await startFakeProvider();
    servers.push(fake.server);
    pinGlmEndpoint(fake.url);
    const ws = mkdtempSync(join(tmpdir(), "persona-tui-b-"));
    roots.push(ws);
    writeWorkspacePersonas(ws);

    const inst = render(createElement(WudaoApp, {
      config: { apiKey: "test-key", apiKeys: ["test-key"], baseURL: fake.url, model: "boot-model", provider: "deepseek" },
      workspaceRoot: ws,
      contextWindowTokens: 64_000,
      tools: [],
      sessionId: "wudao-persona-tui-b",
      readProviderPersonaBinding: (p) => (p === "glm" ? "beta" : undefined),
    }));
    tuis.push(inst);
    await untilPersonaListed(inst, "beta");

    await type(inst.stdin, "/provider glm\r");
    await until(() => (inst.lastFrame() ?? "").includes("供应商 → glm"), "provider switch notice");
    await until(() => (inst.lastFrame() ?? "").includes("persona → beta（供应商绑定）"), "chain-follow notice"); // ω99-166f-ii: 钉随源演进
    await type(inst.stdin, "hi\r");
    await until(() => fake.requests.length >= 1, "post-switch request");
    await until(() => (inst.lastFrame() ?? "").includes("ok"), "run renders");
    expect(fake.requests[0]?.headers["x-persona"]).toBe("beta");
    expect(systemOf(fake.requests[0])).toContain("[BETA] ");

    await until(() =>
      personaChanges(ws, "wudao-persona-tui-b").some((e) => e.data.reason === "provider-switch"),
      "provider-switch record");
    const rec = personaChanges(ws, "wudao-persona-tui-b").find((e) => e.data.reason === "provider-switch");
    expect(rec?.data.id).toBe("beta");
  }, 30_000);

  it("(c) env layer never clears + manual layer does: env gamma beats the new binding after a switch", async () => {
    const fake = await startFakeProvider();
    servers.push(fake.server);
    pinGlmEndpoint(fake.url);
    const ws = mkdtempSync(join(tmpdir(), "persona-tui-c-"));
    roots.push(ws);
    writeWorkspacePersonas(ws);

    const config: ProviderConfig = {
      apiKey: "test-key", apiKeys: ["test-key"], baseURL: fake.url, model: "boot-model", provider: "deepseek",
      // env 限定 = 完整启用集（spec §10.1 mask）：headers+prompt 都要列出。
      persona: { id: "gamma", layers: { headers: true, prompt: true } }, // the env layer (WUDAO_PERSONA's config leg)
    };
    const inst = render(createElement(WudaoApp, {
      config,
      workspaceRoot: ws,
      contextWindowTokens: 64_000,
      tools: [],
      sessionId: "wudao-persona-tui-c",
      readProviderPersonaBinding: (p) => (p === "glm" ? "alpha" : undefined),
    }));
    tuis.push(inst);
    await untilPersonaListed(inst, "gamma");

    await type(inst.stdin, "hi\r");
    await until(() => fake.requests.length >= 1, "env boot request");
    await until(() => (inst.lastFrame() ?? "").includes("ok"), "boot run renders");
    expect(fake.requests[0]?.headers["x-persona"]).toBe("gamma"); // env layer live from boot
    expect(systemOf(fake.requests[0])).toContain("[GAMMA] ");

    // Manual override (top layer)…
    await type(inst.stdin, "/persona alpha --with-prompt\r");
    await until(() => (inst.lastFrame() ?? "").includes("persona → alpha"), "manual switch notice");
    await type(inst.stdin, "hi\r");
    await until(() => fake.requests.length >= 2, "manual request");
    expect(fake.requests[1]?.headers["x-persona"]).toBe("alpha");

    // …then the provider switch clears the manual layer and re-walks the
    // chain: env (gamma) STILL beats the target binding (alpha).
    await type(inst.stdin, "/provider glm\r");
    await until(() => (inst.lastFrame() ?? "").includes("供应商 → glm"), "provider switch notice");
    await type(inst.stdin, "hi\r");
    await until(() => fake.requests.length >= 3, "post-switch request");
    expect(fake.requests[2]?.headers["x-persona"]).toBe("gamma");
    expect(systemOf(fake.requests[2])).toContain("[GAMMA] ");

    // The manual→env follow recorded with reason provider-switch (from alpha).
    await until(() =>
      personaChanges(ws, "wudao-persona-tui-c").some((e) => e.data.reason === "provider-switch"),
      "provider-switch record");
    const rec = personaChanges(ws, "wudao-persona-tui-c").find((e) => e.data.reason === "provider-switch");
    expect(rec?.data.id).toBe("gamma");
    expect(rec?.data.from).toBe("alpha");
  }, 30_000);
});
