// M39 unit tests: extension loader + ExtensionAPI v1. The loader
// dynamic-imports real .mjs fixtures from temp dirs (the actual loading
// path), while the API/event semantics drive the runtime pieces directly.
// Pinned: loading + failure isolation, the seven event payloads and
// interceptor semantics, config-before-extension hook composition,
// registerTool validation + fail-closed defaults + execute isolation,
// registerCommand precedence rules, and the appendEntry/readEntries channel.
import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJsonlSessionStore } from "@wudao-org/core";
import type { AgentState, Tool } from "@wudao-org/core";
import { loadExtensions } from "../src/extensions/loader.js";
import {
  createExtensionState,
  createExtensionApi,
  finalizeExtensionRuntime,
  buildExtensionHooks,
  resolveExtensionTimeoutMs,
  type EventHandlers,
} from "../src/extensions/api.js";
import { runExtensionCommand } from "../src/extensions/dispatch.js";
import type { ExtensionRuntime, PreToolUsePayload, PromptSubmitPayload, RunStartPayload } from "../src/extensions/api.js";
import { composeAgentHooks } from "../src/hooks-config.js";

async function tempWorkspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "wudao-ext-"));
  await mkdir(join(dir, ".wudao", "extensions"), { recursive: true });
  return dir;
}

/** Fresh extension name per test — Node caches .mjs modules by URL, so two
 *  fixtures with the same path would share module state across tests. */
let fixtureSeq = 0;
async function writeExtension(ws: string, body: string): Promise<string> {
  fixtureSeq += 1;
  const name = `ext-${fixtureSeq}-${Math.random().toString(36).slice(2, 8)}`;
  await writeFile(join(ws, ".wudao", "extensions", `${name}.mjs`), body, "utf8");
  return name;
}

function stateFactory() {
  return createExtensionState({ version: "test-v", workspaceRoot: "/ws" });
}

function testState(): AgentState {
  return {
    systemPrompt: "sys",
    messages: [
      { role: "user", content: "hello" },
      { role: "assistant", content: "the last assistant line" },
    ],
    tools: [],
    status: "idle",
  };
}

/** In-process api runtime (no fs): register handlers via a factory the test
 *  controls. */
function inProcessRuntime(
  register: (api: ReturnType<typeof createExtensionApi>) => void,
  opts: { pluginCommandNames?: readonly string[]; timeoutMs?: number } = {},
): { runtime: ExtensionRuntime; warn: (m: string) => void; warns: string[] } {
  const warns: string[] = [];
  const warn = (m: string) => void warns.push(m);
  const { state, binding, collector } = stateFactory();
  register(createExtensionApi("test-ext", collector, state, { warn, pluginCommandNames: opts.pluginCommandNames ?? [] }));
  return {
    runtime: finalizeExtensionRuntime(["test-ext"], collector, state, binding, {
      warn,
      ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    }),
    warn,
    warns,
  };
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

describe("extension loader", () => {
  it("a missing extensions dir is silent and yields an empty runtime", async () => {
    const ws = await mkdtemp(join(tmpdir(), "wudao-ext-empty-"));
    const warns: string[] = [];
    const rt = await loadExtensions(ws, { warn: (m) => void warns.push(m) });
    expect(rt.names).toEqual([]);
    expect(rt.tools).toEqual([]);
    expect(rt.commands).toEqual([]);
    expect(rt.hooks).toBeUndefined();
    expect(warns).toEqual([]);
  });

  it("loads .mjs default-export factories in filename order and collects registrations", async () => {
    const ws = await tempWorkspace();
    await writeFile(join(ws, ".wudao", "extensions", "a-first.mjs"), `
      export default function (api) {
        api.registerTool({
          name: "ext_alpha",
          description: "alpha",
          parameters: { type: "object", properties: { x: { type: "string" } } },
          execute: async () => ({ content: "alpha done" }),
        });
      }
    `, "utf8");
    await writeFile(join(ws, ".wudao", "extensions", "b-second.mjs"), `
      export default async function (api) {
        api.registerCommand("beta", async (args, ctx) => { ctx.notice("beta " + args); });
      }
    `, "utf8");
    const rt = await loadExtensions(ws);
    expect(rt.names).toEqual(["a-first", "b-second"]);
    expect(rt.tools.map((t) => t.name)).toEqual(["ext_alpha"]);
    expect(rt.commands.map((c) => c.name)).toEqual(["beta"]);
    expect(rt.hooks).toBeUndefined(); // no on() registrations
    await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it("a throwing factory warns and only that extension is skipped", async () => {
    const ws = await tempWorkspace();
    await writeExtension(ws, `export default function () { throw new Error("boom at load"); }`);
    const good = await writeExtension(ws, `
      export default function (api) {
        api.registerCommand("survivor", () => {});
      }
    `);
    const warns: string[] = [];
    const rt = await loadExtensions(ws, { warn: (m) => void warns.push(m) });
    expect(rt.names).toEqual([good]);
    expect(rt.commands.map((c) => c.name)).toEqual(["survivor"]);
    expect(warns.some((w) => w.includes("factory threw") && w.includes("boom at load"))).toBe(true);
    await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it("a module that fails to import, or lacks a function default export, warns and skips", async () => {
    const ws = await tempWorkspace();
    await writeExtension(ws, `this is not valid javascript {{{`);
    await writeExtension(ws, `export const notDefault = 1;`);
    await writeExtension(ws, `export default "a string, not a factory";`);
    const warns: string[] = [];
    const rt = await loadExtensions(ws, { warn: (m) => void warns.push(m) });
    expect(rt.names).toEqual([]);
    expect(warns.some((w) => w.includes("failed to import"))).toBe(true);
    expect(warns.filter((w) => w.includes("must default-export a factory")).length).toBe(2);
    await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it("non-.mjs siblings are ignored (with a nudge for near-miss extensions)", async () => {
    const ws = await tempWorkspace();
    await writeFile(join(ws, ".wudao", "extensions", "readme.md"), "notes", "utf8");
    await writeFile(join(ws, ".wudao", "extensions", "oops.js"), "export default function () {}", "utf8");
    const warns: string[] = [];
    const rt = await loadExtensions(ws, { warn: (m) => void warns.push(m) });
    expect(rt.names).toEqual([]);
    expect(warns.some((w) => w.includes("oops.js is not .mjs"))).toBe(true);
    expect(warns.some((w) => w.includes("readme.md"))).toBe(false);
    await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
});

// ---------------------------------------------------------------------------
// Events: payloads + interceptor semantics + isolation
// ---------------------------------------------------------------------------

describe("extension events", () => {
  it("delivers the seven payloads with JSON-serializable shapes", async () => {
    const seen: Record<string, unknown> = {};
    const { runtime } = inProcessRuntime((api) => {
      api.on("run_start", (p) => { seen.run_start = { ...p }; });
      api.on("run_stop", (p) => { seen.run_stop = { ...p }; });
      api.on("prompt_submit", (p) => { seen.prompt_submit = { ...p }; });
      api.on("pre_tool_use", (p) => { seen.pre_tool_use = { ...p }; });
      api.on("post_tool_use", (p) => { seen.post_tool_use = { ...p }; });
      api.on("pre_compact", (p) => { seen.pre_compact = { ...p }; });
      api.on("post_compact", (p) => { seen.post_compact = { ...p }; });
    });
    const hooks = runtime.hooks;
    expect(hooks).toBeDefined();
    // Bind a session first so payloads carry the id.
    const store = createJsonlSessionStore(join(await mkdtemp(join(tmpdir(), "wudao-ext-store-")), "s"));
    runtime.bindSession(store, "sess-1");
    const st = testState();
    await hooks!.onRunStart?.(st);
    await hooks!.onRunStop?.(st);
    await hooks!.onPromptSubmit?.("the prompt");
    await hooks!.onPreToolUse?.("shell", { command: "ls" });
    await hooks!.onPostToolUse?.("shell", { command: "ls" }, "out");
    await hooks!.onPreCompact?.(st.messages);
    await hooks!.onPostCompact?.(st.messages);
    expect(seen.run_start).toEqual({ event: "run_start", sessionId: "sess-1", messageCount: 2, toolCount: 0 });
    expect(seen.run_stop).toEqual({ event: "run_stop", sessionId: "sess-1", messageCount: 2, lastAssistant: "the last assistant line" });
    expect(seen.prompt_submit).toEqual({ event: "prompt_submit", sessionId: "sess-1", prompt: "the prompt" });
    expect(seen.pre_tool_use).toEqual({ event: "pre_tool_use", sessionId: "sess-1", tool: "shell", input: { command: "ls" } });
    expect(seen.post_tool_use).toEqual({ event: "post_tool_use", sessionId: "sess-1", tool: "shell", input: { command: "ls" }, result: "out" });
    expect(seen.pre_compact).toEqual({ event: "pre_compact", sessionId: "sess-1", messageCount: 2 });
    expect(seen.post_compact).toEqual({ event: "post_compact", sessionId: "sess-1", messageCount: 2 });
    // JSON-serializable end to end (the documented payload contract).
    expect(() => JSON.stringify(seen)).not.toThrow();
  });

  it("pre_tool_use blocks with a reason; prompt_submit rewrites or blocks; run_stop blocks", async () => {
    const { runtime } = inProcessRuntime((api) => {
      api.on("pre_tool_use", () => ({ block: true, reason: "not tonight" }));
      api.on("prompt_submit", (p) => (p.prompt.includes("secret") ? { block: true, reason: "redacted" } : `echo: ${p.prompt}`));
      api.on("run_stop", () => ({ block: true, reason: "tests not run" }));
    });
    const hooks = runtime.hooks!;
    await expect(hooks.onPreToolUse!("read_file", {})).resolves.toEqual({ block: true, reason: "not tonight" });
    await expect(hooks.onPromptSubmit!("hello")).resolves.toBe("echo: hello");
    await expect(hooks.onPromptSubmit!("my secret")).resolves.toEqual({ block: true, reason: "redacted" });
    await expect(hooks.onRunStop!(testState())).resolves.toEqual({ block: true, reason: "tests not run" });
  });

  it("prompt rewrites chain across handlers; later handlers see the rewritten prompt", async () => {
    const prompts: string[] = [];
    const { runtime } = inProcessRuntime((api) => {
      api.on("prompt_submit", (p) => { prompts.push(p.prompt); return `${p.prompt}+a`; });
      api.on("prompt_submit", (p) => { prompts.push(p.prompt); return `${p.prompt}+b`; });
    });
    await expect(runtime.hooks!.onPromptSubmit!("go")).resolves.toBe("go+a+b");
    expect(prompts).toEqual(["go", "go+a"]);
  });

  it("a block short-circuits: later handlers never run", async () => {
    let ran = false;
    const { runtime } = inProcessRuntime((api) => {
      api.on("pre_tool_use", () => ({ block: true, reason: "first" }));
      api.on("pre_tool_use", () => { ran = true; });
    });
    await expect(runtime.hooks!.onPreToolUse!("t", {})).resolves.toEqual({ block: true, reason: "first" });
    expect(ran).toBe(false);
  });

  it("observer failures warn and never throw; interceptor failures degrade to allow/original", async () => {
    const { runtime, warns } = inProcessRuntime((api) => {
      api.on("run_start", () => { throw new Error("obs boom"); });
      api.on("post_tool_use", () => Promise.reject(new Error("obs boom 2")));
      api.on("pre_tool_use", () => { throw new Error("inter boom"); });
      api.on("prompt_submit", () => { throw new Error("inter boom 2"); });
      api.on("run_stop", () => { throw new Error("inter boom 3"); });
    });
    const hooks = runtime.hooks!;
    await expect(hooks.onRunStart!(testState())).resolves.toBeUndefined();
    await expect(hooks.onPostToolUse!("t", {}, "r")).resolves.toBeUndefined();
    await expect(hooks.onPreToolUse!("t", {})).resolves.toBeUndefined();
    await expect(hooks.onPromptSubmit!("keep me")).resolves.toBe("keep me");
    await expect(hooks.onRunStop!(testState())).resolves.toBe("allow");
    expect(warns.filter((w) => w.includes("obs boom")).length).toBe(2);
    expect(warns.filter((w) => w.includes("inter boom")).length).toBe(3);
    expect(warns.some((w) => w.includes("degrading to allow"))).toBe(true);
  });

  it("unknown events and non-function handlers are rejected with a warning", async () => {
    const { runtime, warns } = inProcessRuntime((api) => {
      (api.on as unknown as (e: string, h: unknown) => void)("bogus_event", () => {});
      (api.on as unknown as (e: string, h: unknown) => void)("run_start", "not a function");
    });
    expect(runtime.hooks).toBeUndefined();
    expect(warns.some((w) => w.includes('unknown event') && w.includes("bogus_event"))).toBe(true);
    expect(warns.some((w) => w.includes("handler must be a function"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// M40 §1 — handler timeouts. Default 10s, WUDAO_EXTENSION_TIMEOUT_MS override
// (0 = off). Observer timeout → warn + skip; interceptor timeout → degrade to
// allow/original — the SAME path a throw takes.
// ---------------------------------------------------------------------------

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe("extension handler timeouts (M40)", () => {
  it("resolveExtensionTimeoutMs: unset → 10s default, positive → value, 0/negative/garbage → off", () => {
    expect(resolveExtensionTimeoutMs({})).toBe(10_000);
    expect(resolveExtensionTimeoutMs({ WUDAO_EXTENSION_TIMEOUT_MS: "" })).toBe(10_000);
    expect(resolveExtensionTimeoutMs({ WUDAO_EXTENSION_TIMEOUT_MS: "250" })).toBe(250);
    expect(resolveExtensionTimeoutMs({ WUDAO_EXTENSION_TIMEOUT_MS: "0" })).toBe(0);
    expect(resolveExtensionTimeoutMs({ WUDAO_EXTENSION_TIMEOUT_MS: "-5" })).toBe(0);
    expect(resolveExtensionTimeoutMs({ WUDAO_EXTENSION_TIMEOUT_MS: "soon" })).toBe(0);
  });

  it("an observer handler that exceeds the timeout warns and is skipped; later handlers still run", async () => {
    const seen: string[] = [];
    const { runtime, warns } = inProcessRuntime((api) => {
      api.on("run_start", async () => {
        await sleep(2_000);
        seen.push("slow-observer");
      });
      api.on("run_start", () => {
        seen.push("fast-observer");
      });
    }, { timeoutMs: 40 });
    await runtime.hooks!.onRunStart!(testState());
    expect(seen).toEqual(["fast-observer"]); // the slow one never landed
    expect(warns.some((w) => w.includes("run_start handler timed out after 40ms"))).toBe(true);
    expect(warns.some((w) => w.includes("test-ext"))).toBe(true);
  });

  it("an interceptor timeout degrades to allow/original on every interceptor event", async () => {
    const { runtime, warns } = inProcessRuntime((api) => {
      api.on("pre_tool_use", () => sleep(2_000).then(() => ({ block: true as const, reason: "never lands" })));
      api.on("prompt_submit", () => sleep(2_000).then(() => "rewritten-never-lands"));
      api.on("run_stop", () => sleep(2_000).then(() => ({ block: true as const, reason: "never lands" })));
    }, { timeoutMs: 40 });
    const hooks = runtime.hooks!;
    // pre_tool_use: degraded to no-block (undefined), NOT the late block.
    await expect(hooks.onPreToolUse!("shell", {})).resolves.toBeUndefined();
    // prompt_submit: the ORIGINAL prompt survives.
    await expect(hooks.onPromptSubmit!("keep me")).resolves.toBe("keep me");
    // run_stop: degraded to allow.
    await expect(hooks.onRunStop!(testState())).resolves.toBe("allow");
    for (const event of ["pre_tool_use", "prompt_submit", "run_stop"]) {
      expect(warns.some((w) => w.includes(`${event} handler timed out after 40ms`))).toBe(true);
    }
    expect(warns.some((w) => w.includes("degrading to allow") || w.includes("keeping the current prompt"))).toBe(true);
  });

  it("a block that arrives within the timeout is honored (timeout must not eat real decisions)", async () => {
    const { runtime, warns } = inProcessRuntime((api) => {
      api.on("pre_tool_use", () => sleep(10).then(() => ({ block: true as const, reason: "fast enough" })));
    }, { timeoutMs: 5_000 });
    await expect(runtime.hooks!.onPreToolUse!("shell", { command: "x" })).resolves.toEqual({ block: true, reason: "fast enough" });
    expect(warns).toEqual([]);
  });

  it("timeoutMs 0 disables the race — a slow handler is still awaited to completion", async () => {
    const { runtime, warns } = inProcessRuntime((api) => {
      api.on("prompt_submit", () => sleep(60).then(() => "slow-but-counted"));
    }, { timeoutMs: 0 });
    await expect(runtime.hooks!.onPromptSubmit!("original")).resolves.toBe("slow-but-counted");
    expect(warns).toEqual([]);
  });

  it("buildExtensionHooks defaults the timeout from WUDAO_EXTENSION_TIMEOUT_MS", async () => {
    const prev = process.env.WUDAO_EXTENSION_TIMEOUT_MS;
    process.env.WUDAO_EXTENSION_TIMEOUT_MS = "30";
    try {
      const warns: string[] = [];
      const { state, binding, collector } = stateFactory();
      createExtensionApi("env-ext", collector, state, { warn: (m) => void warns.push(m), pluginCommandNames: [] }).on(
        "run_start",
        () => sleep(2_000),
      );
      const runtime = finalizeExtensionRuntime(["env-ext"], collector, state, binding, { warn: (m) => void warns.push(m) });
      await runtime.hooks!.onRunStart!(testState());
      expect(warns.some((w) => w.includes("timed out after 30ms"))).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.WUDAO_EXTENSION_TIMEOUT_MS;
      else process.env.WUDAO_EXTENSION_TIMEOUT_MS = prev;
    }
  });

  it("loadExtensions threads its timeoutMs opt into the built hooks (loader → finalize)", async () => {
    const ws = await tempWorkspace();
    const name = await writeExtension(ws, `
export default function (api) {
  api.on("run_stop", () => new Promise(() => {})); // never settles
}
`);
    const warns: string[] = [];
    const rt = await loadExtensions(ws, { warn: (m) => void warns.push(m), timeoutMs: 40 });
    await expect(rt.hooks!.onRunStop!(testState())).resolves.toBe("allow");
    expect(warns.some((w) => w.includes(`${name}: run_stop handler timed out after 40ms`))).toBe(true);
    await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
});

// ---------------------------------------------------------------------------
// Config-before-extension composition
// ---------------------------------------------------------------------------

describe("composeAgentHooks (config first, extensions after)", () => {
  it("config rewrites feed the extension layer; extension rewrites win last", async () => {
    const calls: string[] = [];
    const config = {
      onPromptSubmit: async (p: string) => { calls.push(`config:${p}`); return `${p}-cfg`; },
    };
    const ext = {
      onPromptSubmit: async (p: string) => { calls.push(`ext:${p}`); return `${p}-ext`; },
    };
    const composed = composeAgentHooks(config, ext)!;
    await expect(composed.onPromptSubmit!("go")).resolves.toBe("go-cfg-ext");
    expect(calls).toEqual(["config:go", "ext:go-cfg"]);
  });

  it("a config block short-circuits the extension layer entirely", async () => {
    let extRan = false;
    const composed = composeAgentHooks(
      { onPromptSubmit: async () => ({ block: true as const, reason: "cfg says no" }) },
      { onPromptSubmit: async () => { extRan = true; return "x"; } },
    )!;
    await expect(composed.onPromptSubmit!("go")).resolves.toEqual({ block: true, reason: "cfg says no" });
    expect(extRan).toBe(false);
  });

  it("an extension block wins when the config layer allowed; run_stop and pre_tool_use compose the same way", async () => {
    const stop = composeAgentHooks(
      { onRunStop: async () => "allow" as const },
      { onRunStop: async () => ({ block: true as const, reason: "ext insists" }) },
    )!;
    await expect(stop.onRunStop!(testState())).resolves.toEqual({ block: true, reason: "ext insists" });

    const pre = composeAgentHooks(
      { onPreToolUse: async () => undefined },
      { onPreToolUse: async () => ({ block: true as const, reason: "nope" }) },
    )!;
    await expect(pre.onPreToolUse!("t", {})).resolves.toEqual({ block: true, reason: "nope" });

    const preCfg = composeAgentHooks(
      { onPreToolUse: async () => ({ block: true as const, reason: "cfg first" }) },
      { onPreToolUse: async () => ({ block: true as const, reason: "ext second" }) },
    )!;
    await expect(preCfg.onPreToolUse!("t", {})).resolves.toEqual({ block: true, reason: "cfg first" });
  });

  it("undefined layers compose to the other side (or undefined)", () => {
    const h = { onRunStart: () => {} };
    expect(composeAgentHooks(undefined, h)).toBe(h);
    expect(composeAgentHooks(h, undefined)).toBe(h);
    expect(composeAgentHooks(undefined, undefined)).toBeUndefined();
  });

  it("observer events run config then extension", async () => {
    const calls: string[] = [];
    const composed = composeAgentHooks(
      { onPostToolUse: async () => void calls.push("cfg") },
      { onPostToolUse: async () => void calls.push("ext") },
    )!;
    await composed.onPostToolUse!("t", {}, "r");
    expect(calls).toEqual(["cfg", "ext"]);
  });
});

// ---------------------------------------------------------------------------
// registerTool
// ---------------------------------------------------------------------------

describe("registerTool", () => {
  const valid = (name: string) => ({
    name,
    description: "d",
    parameters: { type: "object" as const, properties: {} },
    execute: async () => ({ content: "ok" }),
  });

  it("accepts an ext_-prefixed tool with buildTool's fail-closed defaults", () => {
    const { runtime } = inProcessRuntime((api) => {
      api.registerTool(valid("ext_good"));
    });
    expect(runtime.tools.length).toBe(1);
    const tool = runtime.tools[0] as Tool;
    expect(tool.name).toBe("ext_good");
    expect(tool.isReadOnly?.({})).toBe(false);
    expect(tool.isConcurrencySafe?.({})).toBe(false);
    expect(tool.shouldDefer?.()).toBe(false);
  });

  it("rejects a missing ext_ prefix, bad shapes, and duplicates — each with a warning", () => {
    const { runtime, warns } = inProcessRuntime((api) => {
      api.registerTool(valid("no_prefix"));
      api.registerTool({ ...valid("ext_x"), description: "" });
      api.registerTool({ ...valid("ext_x"), parameters: { type: "object" as const, properties: null as never } });
      api.registerTool({ ...valid("ext_x"), execute: "nope" as never });
      api.registerTool(valid("ext_dup"));
      api.registerTool(valid("ext_dup"));
    });
    expect(runtime.tools.map((t) => t.name)).toEqual(["ext_dup"]);
    expect(warns.some((w) => w.includes('must start with "ext_"'))).toBe(true);
    expect(warns.some((w) => w.includes('"description" must be a non-empty string'))).toBe(true);
    expect(warns.some((w) => w.includes('"parameters" must be'))).toBe(true);
    expect(warns.some((w) => w.includes('"execute" must be a function'))).toBe(true);
    expect(warns.some((w) => w.includes("already registered by an earlier extension"))).toBe(true);
  });

  it("a throwing execute() becomes an error tool result, never a thrown loop", async () => {
    const { runtime } = inProcessRuntime((api) => {
      api.registerTool({
        name: "ext_boom",
        description: "throws",
        parameters: { type: "object", properties: {} },
        execute: async () => { throw new Error("kaboom"); },
      });
    });
    const out = await (runtime.tools[0] as Tool).execute({});
    expect(out.isError).toBe(true);
    expect(out.content).toContain("kaboom");
    expect(out.content).toContain("ext_boom");
  });

  it("string results are coerced; invalid results become error results", async () => {
    const { runtime } = inProcessRuntime((api) => {
      api.registerTool({
        name: "ext_str",
        description: "returns a string",
        parameters: { type: "object", properties: {} },
        execute: async () => "plain text" as unknown as { content: string },
      });
      api.registerTool({
        name: "ext_badres",
        description: "returns junk",
        parameters: { type: "object", properties: {} },
        execute: async () => 42 as never,
      });
    });
    const a = await (runtime.tools[0] as Tool).execute({});
    expect(a).toEqual({ content: "plain text" });
    const b = await (runtime.tools[1] as Tool).execute({});
    expect(b.isError).toBe(true);
    expect(b.content).toContain("invalid result");
  });
});

// ---------------------------------------------------------------------------
// registerCommand
// ---------------------------------------------------------------------------

describe("registerCommand", () => {
  it("registers a command; builtin names, the skill: prefix, plugin collisions and duplicates are rejected", () => {
    const { runtime, warns } = inProcessRuntime(
      (api) => {
        for (const builtin of ["exit", "quit", "clear", "help", "resume", "plan", "rewind", "skill", "?"]) {
          api.registerCommand(builtin, () => {});
        }
        api.registerCommand("skill:steal", () => {});
        api.registerCommand("owned-by-plugin", () => {});
        api.registerCommand("hello", () => {});
        api.registerCommand("hello", () => {});
        api.registerCommand("has space", () => {});
      },
      { pluginCommandNames: ["owned-by-plugin"] },
    );
    expect(runtime.commands.map((c) => c.name)).toEqual(["hello"]);
    expect(runtime.commands[0]?.extension).toBe("test-ext");
    expect(warns.some((w) => w.includes("builtin command names"))).toBe(true);
    expect(warns.some((w) => w.includes('skill:steal') && w.includes("reserved"))).toBe(true);
    expect(warns.some((w) => w.includes("owned-by-plugin") && w.includes("plugin command already owns"))).toBe(true);
    expect(warns.some((w) => w.includes('"/hello" already registered'))).toBe(true);
    expect(warns.some((w) => w.includes("without whitespace"))).toBe(true);
  });

  it("the handler receives (args, ctx) with submit/notice", async () => {
    let seen: { args?: string; submitted?: string; noticed?: string } = {};
    const { runtime } = inProcessRuntime((api) => {
      api.registerCommand("greet", (args, ctx) => {
        seen.args = args;
        ctx.notice("working…");
        ctx.submit(`do something with ${args}`);
      });
    });
    const handler = runtime.commands[0]!.handler;
    await handler("world", {
      submit: (t) => { seen.submitted = t; },
      notice: (t) => { seen.noticed = t; },
    });
    expect(seen).toEqual({ args: "world", submitted: "do something with world", noticed: "working…" });
  });
});

// ---------------------------------------------------------------------------
// Slash-command dispatch contract (shared by the REPL and the TUI)
// ---------------------------------------------------------------------------

describe("runExtensionCommand", () => {
  const makeIo = () => {
    const notices: string[] = [];
    const warns: string[] = [];
    return {
      notices,
      warns,
      io: {
        notice: (t: string) => void notices.push(t),
        warn: (m: string) => void warns.push(m),
      },
    };
  };

  it("passes args through, surfaces notices, and resolves the submitted text", async () => {
    const { io, notices } = makeIo();
    const out = await runExtensionCommand(
      { name: "greet", extension: "e", handler: (args, ctx) => { ctx.notice(`hi ${args}`); ctx.submit(`run ${args}`); } },
      "world",
      io,
    );
    expect(out).toBe("run world");
    expect(notices).toEqual(["hi world"]);
  });

  it("a handler that never submits resolves undefined; empty/duplicate submits warn", async () => {
    const { io, warns } = makeIo();
    const out = await runExtensionCommand(
      { name: "quiet", extension: "e", handler: (_args, ctx) => { ctx.submit(""); ctx.submit("first"); ctx.submit("second"); } },
      "",
      io,
    );
    expect(out).toBe("first");
    expect(warns.some((w) => w.includes("non-empty string"))).toBe(true);
    expect(warns.some((w) => w.includes("submit() called twice"))).toBe(true);
  });

  it("a throwing handler warns and submits nothing (isolation)", async () => {
    const { io, warns } = makeIo();
    const out = await runExtensionCommand(
      { name: "boom", extension: "e", handler: (_args, ctx) => { ctx.submit("half-done"); throw new Error("nope"); } },
      "x",
      io,
    );
    expect(out).toBeUndefined();
    expect(warns.some((w) => w.includes("/boom failed") && w.includes("nope"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// appendEntry / readEntries / meta
// ---------------------------------------------------------------------------

describe("entries channel + meta", () => {
  it("appendEntry/readEntries round-trip through a bound session store", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wudao-ext-entries-"));
    const store = createJsonlSessionStore(join(dir, "sessions"));
    await store.append("s1", { role: "user", content: "hello" });

    const { state, binding, collector } = stateFactory();
    const api = createExtensionApi("e", collector, state, { warn: () => {} });
    const runtime = finalizeExtensionRuntime(["e"], collector, state, binding, { warn: () => {} });
    runtime.bindSession(store, "s1");

    await api.appendEntry("ext_counter", { hits: 1 });
    await api.appendEntry("", { nope: true }); // bad type → warn + drop
    const entries = await api.readEntries();
    const generic = entries.filter((e) => !("role" in e) && e.type === "ext_counter");
    expect(generic.length).toBe(1);
    expect((generic[0] as { data: unknown }).data).toEqual({ hits: 1 });
    // readEntries sees the whole session (messages + entries), in file order.
    expect(entries[0]).toMatchObject({ role: "user", content: "hello" });
    expect(api.meta.sessionId).toBe("s1");
    expect(api.meta.version).toBe("test-v");
    expect(api.meta.workspaceRoot).toBe("/ws");
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it("before a session binds: appendEntry warns and drops, readEntries warns and returns []", async () => {
    const warns: string[] = [];
    const { state, binding, collector } = stateFactory();
    const api = createExtensionApi("e", collector, state, { warn: (m) => void warns.push(m) });
    await api.appendEntry("t", {});
    await expect(api.readEntries()).resolves.toEqual([]);
    expect(warns.filter((w) => w.includes("no session bound")).length).toBe(2);
    expect(api.meta.sessionId).toBeUndefined();
  });

  it("store failures are isolated (warn, no throw)", async () => {
    const { state, binding, collector } = stateFactory();
    const api = createExtensionApi("e", collector, state, { warn: () => {} });
    const runtime = finalizeExtensionRuntime(["e"], collector, state, binding, { warn: () => {} });
    runtime.bindSession(
      {
        appendEntry: async () => { throw new Error("disk full"); },
        loadSessionEntries: async () => { throw new Error("unreadable"); },
      },
      "s2",
    );
    await expect(api.appendEntry("t", {})).resolves.toBeUndefined();
    await expect(api.readEntries()).resolves.toEqual([]);
  });
});

it("extension payloads carry a COPY — mutation cannot rewrite the executed call", async () => {
  const seen: unknown[] = [];
  const empty = { run_start: [], run_stop: [], prompt_submit: [], pre_tool_use: [], post_tool_use: [], pre_compact: [], post_compact: [] } as unknown as EventHandlers;
  const events: EventHandlers = {
    ...empty,
    pre_tool_use: [{ extension: "mut", handler: (p: { input: Record<string, unknown> }) => { p.input.path = "/etc/pwned"; seen.push(p.input); } } as never],
  };
  const hooks = buildExtensionHooks(events, { getSessionId: () => "s", warn: () => {} });
  const input = { path: "ok.ts" };
  const out = await hooks!.onPreToolUse!("write_file", input, () => undefined as never);
  expect(out).toBeUndefined(); // no block, no crash
  expect(input).toEqual({ path: "ok.ts" }); // caller's object untouched — the COPY absorbed the mutation
  expect(seen.length).toBe(1);
});
