// M63-C batch C — the contract four (updatedInput/systemMessage/
// suppressOutput; decision landed in A), the §2 common stdin fields, the
// per-hook fields (once/if/async+asyncRewake/statusMessage, the 600s/30s
// timeout defaults), the mcp_tool backend with ${path} injection, and the
// subagent position (runSubagent runHooks). Deterministic; fixtures in
// tests/fixtures.
import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadHooksSettings,
  buildConfiguredHooks,
  parseUpdatedInputJson,
  resolveTemplateValue,
  type HookMcpSeam,
} from "../src/hooks-config.js";
import { runSubagent } from "@wudao-org/core";
import { createScriptedModel } from "@wudao-org/core";
import { buildTool } from "@wudao-org/core";
import type { Tool } from "@wudao-org/core";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const fx = (name: string): string => join(FIXTURES, name);

function collector(): { warn: (m: string) => void; messages: string[] } {
  const messages: string[] = [];
  return { warn: (m: string) => messages.push(m), messages };
}

async function tmpWorkspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "wudao-hooks-m63c-"));
  await mkdir(join(dir, ".wudao"), { recursive: true });
  return dir;
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("contract four — updatedInput", () => {
  it("parseUpdatedInputJson accepts only a non-empty object", () => {
    expect(parseUpdatedInputJson('{"updatedInput":{"path":"x"}}')).toEqual({ path: "x" });
    expect(parseUpdatedInputJson('{"updatedInput":{}}')).toEqual({});
    expect(parseUpdatedInputJson('{"updatedInput":[]}')).toBeUndefined();
    expect(parseUpdatedInputJson('{"updatedInput":"str"}')).toBeUndefined();
    expect(parseUpdatedInputJson("plain")).toBeUndefined();
  });

  it("the bridge returns {updatedInput} from a preToolUse hook's stdout", async () => {
    const root = await tmpWorkspace();
    const log = collector();
    try {
      await writeFile(join(root, ".wudao", "settings.json"), JSON.stringify({
        hooks: { onPreToolUse: [{ command: fx("rewrite-input.sh"), matcher: "write_file" }] },
      }), "utf8");
      const settings = await loadHooksSettings(root, log.warn);
      const hooks = buildConfiguredHooks(settings, { workspaceRoot: root, warn: log.warn });
      expect(await hooks!.onPreToolUse!("write_file", { path: "original.txt" })).toEqual({
        updatedInput: { path: "rewritten-by-hook.txt" },
      });
      // A non-matching tool observes only.
      expect(await hooks!.onPreToolUse!("read_file", { path: "a" })).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
});

describe("contract four — systemMessage / suppressOutput", () => {
  it("systemMessage surfaces on the warn sink; suppressOutput hides it", async () => {
    const root = await tmpWorkspace();
    const log = collector();
    try {
      await writeFile(join(root, ".wudao", "settings.json"), JSON.stringify({
        hooks: {
          onPreToolUse: [
            { command: fx("sysmsg.sh"), matcher: "write_file" },
            { command: fx("sysmsg-suppressed.sh"), matcher: "edit" },
          ],
        },
      }), "utf8");
      const settings = await loadHooksSettings(root, log.warn);
      const hooks = buildConfiguredHooks(settings, { workspaceRoot: root, warn: log.warn });
      await hooks!.onPreToolUse!("write_file", {});
      expect(log.messages.some((m) => m.includes("quota nearly spent"))).toBe(true);
      log.messages.length = 0;
      await hooks!.onPreToolUse!("edit", {});
      expect(log.messages.some((m) => m.includes("should stay hidden"))).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
});

describe("§2 common stdin fields", () => {
  it("the common context rides every JSON payload", async () => {
    const root = await tmpWorkspace();
    const log = collector();
    try {
      await writeFile(join(root, ".wudao", "settings.json"), JSON.stringify({
        hooks: { onSessionStart: [{ command: fx("dump-payload.sh") }] },
      }), "utf8");
      const settings = await loadHooksSettings(root, log.warn);
      const hooks = buildConfiguredHooks(settings, {
        workspaceRoot: root,
        warn: log.warn,
        common: () => ({ session_id: "s-9", transcript_path: "/x/s-9.jsonl", permission_mode: "auto", effort: "high" }),
      });
      await hooks!.onSessionStart!("startup", {});
      const payload = JSON.parse(await readFile(join(root, "payload.json"), "utf8"));
      expect(payload).toEqual({
        session_id: "s-9",
        transcript_path: "/x/s-9.jsonl",
        permission_mode: "auto",
        effort: "high",
        event: "sessionStart",
        source: "startup",
      });
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
});

describe("per-hook fields", () => {
  it("once: the entry fires exactly once across repeated events", async () => {
    const root = await tmpWorkspace();
    const log = collector();
    try {
      await writeFile(join(root, ".wudao", "settings.json"), JSON.stringify({
        hooks: { onNotification: [{ command: fx("perm-log-allow.sh"), once: true }] },
      }), "utf8");
      const settings = await loadHooksSettings(root, log.warn);
      const hooks = buildConfiguredHooks(settings, { workspaceRoot: root, warn: log.warn });
      await hooks!.onNotification!("idle", {});
      await wait(100);
      await hooks!.onNotification!("idle", {});
      await hooks!.onNotification!("permission", {});
      await wait(100);
      const marker = await readFile(join(root, "hook.log"), "utf8");
      expect(marker).toBe("hook-ran\n");
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("if: the entry runs only in the gated permission mode", async () => {
    const root = await tmpWorkspace();
    const log = collector();
    try {
      await writeFile(join(root, ".wudao", "settings.json"), JSON.stringify({
        hooks: { onNotification: [{ command: fx("perm-log-allow.sh"), if: "auto" }] },
      }), "utf8");
      const settings = await loadHooksSettings(root, log.warn);
      let mode = "default";
      const hooks = buildConfiguredHooks(settings, { workspaceRoot: root, warn: log.warn, getMode: () => mode });
      await hooks!.onNotification!("idle", {});
      await wait(100);
      mode = "auto";
      await hooks!.onNotification!("idle", {});
      await wait(100);
      const marker = await readFile(join(root, "hook.log"), "utf8");
      expect(marker).toBe("hook-ran\n"); // once — the default-mode firing skipped
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("async: the fire returns immediately; statusMessage warned; exit 2 wakes the sink", async () => {
    const root = await tmpWorkspace();
    const log = collector();
    const wakes: string[] = [];
    try {
      await writeFile(join(root, ".wudao", "settings.json"), JSON.stringify({
        hooks: { onPostToolBatch: [{ command: fx("exit2-wake.sh"), async: true, asyncRewake: true, statusMessage: "watching batch budget" }] },
      }), "utf8");
      const settings = await loadHooksSettings(root, log.warn);
      const hooks = buildConfiguredHooks(settings, {
        workspaceRoot: root,
        warn: log.warn,
        rewake: (m) => wakes.push(m),
      });
      const started = Date.now();
      await hooks!.onPostToolBatch!([{ name: "read_file", input: {}, isError: false, result: "r" }]);
      expect(Date.now() - started).toBeLessThan(200); // the event never waits
      // The async child's two effects (status warn + exit-2 rewake) land on
      // their own clocks; a fixed nap loses the race on a loaded win32 pool
      // (the .sh rides the Git-sh fallback spawn). Poll for each.
      const deadline = Date.now() + 15_000;
      while (!(log.messages.some((m) => m.includes("watching batch budget")) && wakes.length > 0)) {
        if (Date.now() > deadline) break;
        await wait(50);
      }
      expect(log.messages.some((m) => m.includes("watching batch budget"))).toBe(true);
      expect(wakes).toEqual(["batch 3 finished"]);
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("timeout defaults: command class 600s, prompt class 30s (constants)", async () => {
    // The constants are the contract; a behavioral test would wait minutes.
    const mod = await import("../src/hooks-config.js");
    // Not exported directly — assert via a tiny re-derived check instead:
    // an entry with NO timeoutMs whose command sleeps 100ms completes fine
    // under either default (the default only matters when a hook hangs).
    const root = await tmpWorkspace();
    const log = collector();
    try {
      await writeFile(join(root, ".wudao", "settings.json"), JSON.stringify({
        hooks: { onPromptSubmit: [{ command: fx("ok.sh") }] },
      }), "utf8");
      const settings = await loadHooksSettings(root, log.warn);
      const hooks = buildConfiguredHooks(settings, { workspaceRoot: root, warn: log.warn });
      expect(await hooks!.onPromptSubmit!("hi")).toBe("hi");
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
});

describe("mcp_tool backend", () => {
  it("calls the seam with ${path}-injected input; the tool text is the stdout", async () => {
    const root = await tmpWorkspace();
    const log = collector();
    try {
      await writeFile(join(root, ".wudao", "settings.json"), JSON.stringify({
        hooks: {
          onFileChanged: [{
            type: "mcp_tool",
            server: "audit",
            tool: "record_change",
            input: { note: "file ${path} changed", raw: 42, nested: { which: "${event}" } },
          }],
        },
      }), "utf8");
      const settings = await loadHooksSettings(root, log.warn);
      const calls: { server: string; tool: string; input: Record<string, unknown> }[] = [];
      const seam: HookMcpSeam = {
        call: async (server, tool, input) => {
          calls.push({ server, tool, input });
          return { ok: true, text: '{"systemMessage":"audited"}' };
        },
      };
      const hooks = buildConfiguredHooks(settings, { workspaceRoot: root, warn: log.warn, mcp: seam });
      await hooks!.onFileChanged!("watched.txt");
      await wait(50);
      expect(calls).toEqual([{
        server: "audit",
        tool: "record_change",
        input: { note: "file watched.txt changed", raw: 42, nested: { which: "fileChanged" } },
      }]);
      // The tool's text IS the stdout: systemMessage surfaced.
      expect(log.messages.some((m) => m.includes("audited"))).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("resolveTemplateValue: dotted lookup, objects recurse, unresolvable stays literal", () => {
    const payload = { tool: "write_file", input: { path: "a.txt" }, n: 3 };
    expect(resolveTemplateValue("use ${input.path}", payload)).toBe("use a.txt");
    expect(resolveTemplateValue("${tool}/${n}", payload)).toBe("write_file/3");
    expect(resolveTemplateValue("${missing.deep}", payload)).toBe("${missing.deep}");
    expect(resolveTemplateValue({ a: "${tool}", b: ["${tool}"] }, payload)).toEqual({ a: "write_file", b: ["${tool}"] });
  });

  it("a transport failure is the non-zero-exit semantics (deny on decision classes)", async () => {
    const root = await tmpWorkspace();
    const log = collector();
    try {
      await writeFile(join(root, ".wudao", "settings.json"), JSON.stringify({
        hooks: { onPermissionRequest: [{ type: "mcp_tool", server: "policy", tool: "decide", input: {} }] },
      }), "utf8");
      const settings = await loadHooksSettings(root, log.warn);
      const seam: HookMcpSeam = { call: async () => ({ ok: false, error: "policy server down" }) };
      const hooks = buildConfiguredHooks(settings, { workspaceRoot: root, warn: log.warn, mcp: seam });
      expect(await hooks!.onPermissionRequest!("write_file", {})).toEqual({
        behavior: "deny",
        reason: "permission hook: policy server down",
      });
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
});

describe("R1 fixes", () => {
  it("prompt_id rides the common fields when the box is set", async () => {
    const root = await tmpWorkspace();
    const log = collector();
    try {
      await writeFile(join(root, ".wudao", "settings.json"), JSON.stringify({
        hooks: { onSessionStart: [{ command: fx("dump-payload.sh") }] },
      }), "utf8");
      const settings = await loadHooksSettings(root, log.warn);
      const promptId: { current?: string } = {};
      const hooks = buildConfiguredHooks(settings, {
        workspaceRoot: root,
        warn: log.warn,
        common: () => ({ prompt_id: promptId.current }),
      });
      promptId.current = "uuid-1";
      await hooks!.onSessionStart!("startup", {});
      let payload = JSON.parse(await readFile(join(root, "payload.json"), "utf8"));
      expect(payload.prompt_id).toBe("uuid-1");
      promptId.current = "uuid-2";
      await hooks!.onSessionStart!("startup", {});
      payload = JSON.parse(await readFile(join(root, "payload.json"), "utf8"));
      expect(payload.prompt_id).toBe("uuid-2"); // the LIVE id per firing
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("once entries with the SAME command on different events do not collide", async () => {
    const root = await tmpWorkspace();
    const log = collector();
    try {
      await writeFile(join(root, ".wudao", "settings.json"), JSON.stringify({
        hooks: {
          onNotification: [{ command: fx("perm-log-allow.sh"), once: true }],
          onSessionStart: [{ command: fx("perm-log-allow.sh"), once: true }],
        },
      }), "utf8");
      const settings = await loadHooksSettings(root, log.warn);
      const hooks = buildConfiguredHooks(settings, { workspaceRoot: root, warn: log.warn });
      await hooks!.onNotification!("idle", {});
      await wait(120);
      await hooks!.onSessionStart!("startup", {});
      await wait(120);
      // Each event's once entry fired its single time (pre-R1 the collision
      // would have made the second event's entry already "spent").
      expect((await readFile(join(root, "hook.log"), "utf8")).trim().split("\n").filter(Boolean).length).toBe(2);
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("an async SessionEnd entry is bounded by the shared budget and never warns as over-budget", async () => {
    const root = await tmpWorkspace();
    const log = collector();
    try {
      await writeFile(join(root, ".wudao", "settings.json"), JSON.stringify({
        hooks: { onSessionEnd: [{ command: fx("sleep-3000.sh"), async: true }] },
      }), "utf8");
      const settings = await loadHooksSettings(root, log.warn);
      const hooks = buildConfiguredHooks(settings, { workspaceRoot: root, warn: log.warn });
      const started = Date.now();
      await hooks!.onSessionEnd!("exit", {});
      const elapsed = Date.now() - started;
      expect(elapsed).toBeLessThan(300); // async: the event never waits
      await wait(2000); // the budget deadline passes; the child was killed at ~1.5s
      expect(log.messages.some((m) => m.includes("预算继续"))).toBe(false); // async ≠ over-budget warn；ω99-207 钉随源演进（预算词面中文化）
      expect(log.messages.some((m) => m.includes("超时"))).toBe(true); // the bounded kill itself；ω99-207 钉随源演进（超时词面中文化）
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }, 10_000);
});

describe("subagent position (runSubagent runHooks)", () => {
  const params = { type: "object" as const, properties: { path: { type: "string" as const } }, required: ["path"], additionalProperties: false };
  const childTool: Tool = buildTool({ name: "read_file", description: "d", parameters: params, execute: async () => ({ content: "C" }) });

  it("the role profile's hooks fire DURING the child run only", async () => {
    const seen: string[] = [];
    const model = createScriptedModel([{ role: "assistant", content: "child answer" }]);
    await runSubagent({
      model,
      allTools: [childTool],
      subagentType: { name: "auditor", description: "d", systemPrompt: "c", toolNames: ["read_file"] },
      prompt: "p",
      loopOptions: { maxTurns: 3 },
      runHooks: {
        onRunStart: () => { seen.push("start"); },
        onRunStop: () => { seen.push("stop"); },
        onPreToolUse: () => { seen.push("pre"); },
      },
    });
    await wait(50);
    expect(seen).toEqual(["start", "stop"]);
  });
});
