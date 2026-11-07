import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { AssistantMessage, ModelClient, ModelInput, PermissionDecision, Tool } from "@wudao-org/core";
import { buildToolSet, deferToolsEnabled, markDeferCandidates } from "../src/tools.js";

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "ws-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });

// Never invoked in these tests (task tool only USES the model when called).
const model: ModelClient = {
  async generate(_input: ModelInput): Promise<AssistantMessage> {
    return { role: "assistant", content: "" };
  },
};
const allowAll = async (): Promise<PermissionDecision> => ({ behavior: "allow" });

// win32: a bare .mjs cannot be exec'd — two-word `node <entry>` form (splitJsBin).
const FAKE_DOCKER = process.platform === "win32"
  ? `${process.execPath} ${join(dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-docker.mjs")}`
  : join(dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-docker.mjs");

async function buildTools(sandbox?: { image?: string; dockerPath?: string }): Promise<Tool[]> {
  return buildToolSet({
    workspaceRoot: root,
    model,
    canUseTool: allowAll,
    contextWindowTokens: 64_000,
    ...(sandbox ? { sandbox } : {}),
  });
}

const toolByName = (tools: readonly Tool[], name: string): Tool => {
  const t = tools.find((x) => x.name === name);
  if (!t) throw new Error(`tool ${name} not in set`);
  return t;
};

describe("buildToolSet sandbox wiring", () => {
  // 0.3.81 实机回执（Invalid 'tools[N].function.name'，tools[54]）：OpenAI
  // 兼容端按 ^[a-zA-Z0-9_-]+$ 校验每个 function name——一个非法字符
  // （当年 computer.click 的点号）拒绝整个请求。全组名字在此一次钉死：
  // 任何未来工具带着集合外字符进来，本行先红。
  it("every builtin tool name matches the provider function-name pattern", async () => {
    const tools = await buildTools();
    for (const t of tools) {
      expect(t.name, `tool name "${t.name}"`).toMatch(/^[a-zA-Z0-9_-]+$/);
    }
  });

  it("without sandbox: shell executes on the host (no docker involved)", async () => {
    const tools = await buildTools();
    const res = await toolByName(tools, "shell").execute({ command: "node -e \"process.stdout.write('host-side')\"" });
    expect(res.isError).toBeFalsy();
    expect(res.content).toContain("host-side");
  });

  it("with sandbox: shell goes through docker; read_file stays host-side", async () => {
    const log = join(root, "docker.log");
    await writeFile(log, "");
    const prevEnv = { ...process.env };
    process.env.FAKE_DOCKER_LOG = log;
    process.env.FAKE_DOCKER_OUT = "container-side";
    try {
      const tools = await buildTools({ dockerPath: FAKE_DOCKER, image: "node:20-alpine" });
      // shell → sandboxed (fake docker echoes; argv recorded).
      const res = await toolByName(tools, "shell").execute({ command: "node -v" });
      expect(res.isError).toBeFalsy();
      expect(res.content).toContain("container-side");
      const run = (await readFile(log, "utf8")).trim().split("\n").map((l) => JSON.parse(l) as string[]).at(-1);
      expect(run?.[15]).toBe("node:20-alpine");
      // File tools are NOT sandboxed (v1 boundary): read_file serves the host fs.
      await writeFile(join(root, "note.txt"), "host-file-content");
      const read = await toolByName(tools, "read_file").execute({ path: "note.txt" });
      expect(read.isError).toBeFalsy();
      expect(read.content).toContain("host-file-content");
    } finally {
      process.env = prevEnv;
    }
  });
});

const stubModel: ModelClient = { stream: async function* () { /* never called — only used for the task tool handle */ } } as unknown as ModelClient;
const gate = async (): Promise<{ behavior: "allow" }> => ({ behavior: "allow" });

const fakeMcpTool: Tool = {
  name: "mcp__fake__echo",
  description: "echo",
  parameters: { type: "object", properties: {} },
  execute: async () => ({ content: "ok" }),
};

describe("buildToolSet extraTools (MCP wiring)", () => {
  it("appends MCP tools AFTER the builtin set", () => {
    const builtin = buildToolSet({ workspaceRoot: "/tmp/ws", model: stubModel, canUseTool: gate, contextWindowTokens: 64000 });
    const withMcp = buildToolSet({ workspaceRoot: "/tmp/ws", model: stubModel, canUseTool: gate, contextWindowTokens: 64000, extraTools: [fakeMcpTool] });
    expect(withMcp.length).toBe(builtin.length + 1);
    // Same builtin surface (by name; closures differ per build) + the MCP tool last.
    expect(withMcp.slice(0, builtin.length).map((t) => t.name)).toEqual(builtin.map((t) => t.name));
    expect(withMcp[withMcp.length - 1]?.name).toBe("mcp__fake__echo");
  });

  it("builtin set unchanged without extraTools", () => {
    const tools = buildToolSet({ workspaceRoot: "/tmp/ws", model: stubModel, canUseTool: gate, contextWindowTokens: 64000 });
    expect(tools.some((t) => t.name.startsWith("mcp__"))).toBe(false);
    expect(tools.map((t) => t.name)).toContain("task");
  });
});

describe("buildToolSet M24 wiring (probe / spill / fork)", () => {
  it("contextProbe reaches read_file (repeat read elides)", async () => {
    await writeFile(join(root, "note.txt"), "PROBE-SENTINEL-7\n", "utf8");
    const seen: import("@wudao-org/core").AgentMessage[] = [
      { role: "tool", toolCallId: "c0", name: "read_file", content: "PROBE-SENTINEL-7\n" },
    ];
    const tools = buildToolSet({
      workspaceRoot: root,
      model,
      canUseTool: allowAll,
      contextWindowTokens: 64000,
      contextProbe: () => seen,
    });
    const res = await toolByName(tools, "read_file").execute({ path: "note.txt" });
    expect(res.isError).toBeFalsy();
    expect(res.content.startsWith("[elided] note.txt")).toBe(true);
    // force bypasses the elision through the same wiring.
    const forced = await toolByName(tools, "read_file").execute({ path: "note.txt", force: true });
    expect(forced.content).toBe("PROBE-SENTINEL-7\n");
  });

  it("spillDir reaches shell (truncated output spills to disk)", async () => {
    const spillDir = join(root, ".wudao", "spill", "sess-x");
    const tools = buildToolSet({
      workspaceRoot: root,
      model,
      canUseTool: allowAll,
      contextWindowTokens: 64000,
      spillDir,
    });
    const res = await toolByName(tools, "shell").execute({ command: "node -e \"process.stdout.write('w'.repeat(200000))\"" });
    expect(res.content).toContain("(full output: ");
    const path = /\(full output: (.+)\)/.exec(res.content)?.[1];
    expect(path).toBeDefined();
    const spilled = await readFile(path!, "utf8");
    expect(spilled.length).toBe(200000);
  });

  it("getForkContext reaches the task tool (fork shares the parent state)", async () => {
    const inputs: ModelInput[] = [];
    let i = 0;
    const scripted: AssistantMessage[] = [
      { role: "assistant", content: "", toolCalls: [{ id: "t1", name: "task", arguments: { description: "d", prompt: "fork brief", shareContext: true } }] },
      { role: "assistant", content: "fork child answer" },
      { role: "assistant", content: "parent done" },
    ];
    const forkModel: ModelClient = {
      async generate(input: ModelInput): Promise<AssistantMessage> {
        inputs.push({ ...input, messages: [...input.messages], tools: [...input.tools] });
        const r = scripted[i];
        i += 1;
        if (!r) throw new Error("scripted exhausted");
        return r;
      },
    };
    const parentState: import("@wudao-org/core").AgentState = {
      systemPrompt: "PARENT-SYS",
      messages: [{ role: "user", content: "parent prompt" }],
      tools: [],
      status: "idle",
    };
    const tools = buildToolSet({
      workspaceRoot: root,
      model: forkModel,
      canUseTool: allowAll,
      contextWindowTokens: 64000,
      getForkContext: () => parentState,
    });
    // The fork must see the loop's REAL tool array — assign after building.
    parentState.tools = tools;
    const { runAgentLoop } = await import("@wudao-org/core");
    const events: unknown[] = [];
    const gen = runAgentLoop(parentState, forkModel, { maxTurns: 5 });
    for (;;) {
      const r = await gen.next();
      if (r.done) break;
      events.push(r.value);
    }
    // parent request → fork child request → parent continuation.
    expect(inputs).toHaveLength(3);
    const { serializePrompt } = await import("@wudao-org/providers");
    expect(serializePrompt(inputs[1]!).startsWith(serializePrompt(inputs[0]!))).toBe(true);
    // The parent state object mutated by the loop is the SAME one the fork saw.
    expect(inputs[1]!.systemPrompt).toBe("PARENT-SYS");
  });

  it("without getForkContext, shareContext task calls fail with a clear error", async () => {
    const tools = buildToolSet({ workspaceRoot: root, model, canUseTool: allowAll, contextWindowTokens: 64000 });
    const res = await toolByName(tools, "task").execute({ description: "d", prompt: "p", shareContext: true });
    expect(res.isError).toBe(true);
    expect(res.content).toContain("requires the caller to expose the parent conversation");
  });
});

// ---------------------------------------------------------------------------
// M35 §1 — defer marking: orchestration tools carry shouldDefer (behind
// WUDAO_DEFER_TOOLS, default on); coding tools and MCP extraTools never do.
// ---------------------------------------------------------------------------

describe("buildToolSet defer marking (M35)", () => {
  // 2026-11-06 用户定调：延后集收窄为 docs 家族——task/agents 等编排工具
  // 回到常驻面（模型看得见才知道能用）。
  const ORCHESTRATION = ["make_docx", "read_xlsx", "append_pptx", "set_pptx_notes"];

  it("default: exactly the orchestration tools defer; coding tools stay eager; MCP tools stay eager", async () => {
    const mcpLike: Tool = {
      name: "mcp__srv__probe",
      description: "An MCP-shaped extra tool.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      async execute() {
        return { content: "ok" };
      },
    };
    const prev = process.env.WUDAO_DEFER_TOOLS;
    delete process.env.WUDAO_DEFER_TOOLS;
    try {
      const tools = await buildTools();
      tools.push(mcpLike);
      for (const name of ORCHESTRATION) {
        expect(toolByName(tools, name).shouldDefer?.(), name).toBe(true);
      }
      for (const name of ["read_file", "write_file", "edit", "shell", "glob", "grep", "todo_write"]) {
        // Coding tools are plain Tool objects (shouldDefer undefined = eager).
        expect(toolByName(tools, name).shouldDefer?.() !== true, name).toBe(true);
      }
      expect(toolByName(tools, "mcp__srv__probe").shouldDefer?.() !== true).toBe(true);
    } finally {
      if (prev !== undefined) process.env.WUDAO_DEFER_TOOLS = prev;
    }
  });

  it("WUDAO_DEFER_TOOLS=off: nothing defers (full load)", async () => {
    const prev = process.env.WUDAO_DEFER_TOOLS;
    process.env.WUDAO_DEFER_TOOLS = "off";
    try {
      const tools = await buildTools();
      expect(tools.every((t) => t.shouldDefer?.() !== true)).toBe(true);
    } finally {
      if (prev !== undefined) process.env.WUDAO_DEFER_TOOLS = prev;
      else delete process.env.WUDAO_DEFER_TOOLS;
    }
  });

  it("deferToolsEnabled: only the exact (case-insensitive) value off disables", () => {
    const f = (v: string | undefined): boolean => deferToolsEnabled(v === undefined ? {} : { WUDAO_DEFER_TOOLS: v });
    expect(f(undefined)).toBe(true);
    expect(f("")).toBe(true);
    expect(f("on")).toBe(true);
    expect(f("0")).toBe(true);
    expect(f("off")).toBe(false);
    expect(f(" OFF ")).toBe(false);
  });

  it("markDeferCandidates is pure; the builtin whitelist beats buildTool's fail-closed default", () => {
    const eager: Tool = {
      name: "read_file",
      description: "d",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      async execute() {
        return { content: "" };
      },
    };
    // 2026-11-06：task 不再延后——用 docs 名字验证同一件事（白名单盖掉
    // buildTool 的 fail-closed 默认）。
    const docTool: Tool = { ...eager, name: "make_docx", shouldDefer: () => false };
    const marked = markDeferCandidates([eager, docTool]);
    expect(marked[1]?.shouldDefer?.()).toBe(true);
    expect(marked[0]?.shouldDefer?.()).toBeUndefined();
    // The original objects are untouched (new objects only).
    expect(docTool.shouldDefer?.()).toBe(false);
    // task 现在不在白名单里：保持原样（不被标记）。
    const task: Tool = { ...eager, name: "task", shouldDefer: () => false };
    expect(markDeferCandidates([task])[0]?.shouldDefer?.()).toBe(false);
    // Disabled: nothing is marked (objects pass through).
    expect(markDeferCandidates([task], false)[0]?.shouldDefer?.()).toBe(false);
  });
});
