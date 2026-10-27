// M49 §2 — the background review fork: full scripted flow (suggestions land
// through the §1 assessment), the read-only neutering (definitions stay
// byte-identical for the warm fork prefix), the warm-prefix replay, and the
// WUDAO_BG_REVIEW=off kill switch.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildTool, toModelToolDefinition } from "@wudao/core";
import type { AssistantMessage, ModelClient, ModelInput, Tool } from "@wudao/core";
import { createSessionRegistry } from "../src/agents/index.js";
import { openMemoryStore } from "../src/memory/index.js";
import { createMemoryWriteTool, createMemorySearchTool } from "../src/memory/tools.js";
import { spawnBackgroundReview, backgroundReviewEnabled, neuterWriteTools, REVIEW_PROMPT, REVIEW_MAX_TURNS, REVIEW_MIN_TOOL_CALLS } from "../src/memory/review.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "wudao-review-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  delete process.env.WUDAO_BG_REVIEW;
});

/** A scripted model that also records every ModelInput it receives. */
function recordingModel(respond: (input: ModelInput, call: number) => AssistantMessage): ModelClient & { inputs: ModelInput[] } {
  const inputs: ModelInput[] = [];
  let call = 0;
  return {
    inputs,
    async generate(input: ModelInput): Promise<AssistantMessage> {
      inputs.push(input);
      call += 1;
      return respond(input, call);
    },
  };
}

function call(id: string, name: string, args: Record<string, unknown>): AssistantMessage {
  return { role: "assistant", content: "", toolCalls: [{ id, name, arguments: args }] };
}

/** The production-shaped parent set (read + write + memory tools), rooted at
 *  the CURRENT temp dir (the memory store tools close over its path). */
function parentTools(): Tool[] {
  const store = openMemoryStore(dir);
  return [
    buildTool({
      name: "read_file",
      description: "reads",
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false },
      async execute() { return { content: "FILE" }; },
    }),
    buildTool({
      name: "write_file",
      description: "writes",
      parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"], additionalProperties: false },
      async execute() { return { content: "wrote" }; },
    }),
    createMemoryWriteTool(store),
    createMemorySearchTool(store),
  ];
}

describe("backgroundReviewEnabled", () => {
  it("defaults on; =off disables", () => {
    expect(backgroundReviewEnabled({})).toBe(true);
    expect(backgroundReviewEnabled({ WUDAO_BG_REVIEW: "off" })).toBe(false);
    expect(backgroundReviewEnabled({ WUDAO_BG_REVIEW: " OFF " })).toBe(false);
    expect(backgroundReviewEnabled({ WUDAO_BG_REVIEW: "1" })).toBe(true);
  });
});

describe("neuterWriteTools", () => {
  it("keeps tool DEFINITIONS byte-identical and refuses execution", async () => {
    const tools = parentTools();
    const neutered = neuterWriteTools(tools);
    expect(toModelToolDefinition(neutered[0]!)).toEqual(toModelToolDefinition(tools[0]!));
    expect(toModelToolDefinition(neutered[1]!)).toEqual(toModelToolDefinition(tools[1]!));
    const refused = await neutered[1]!.execute({ path: "x", content: "y" });
    expect(refused.isError).toBe(true);
    expect(refused.content).toContain("read-only");
    // The untouched tool still works.
    expect((await neutered[0]!.execute({ path: "x" })).content).toBe("FILE");
  });
});

describe("spawnBackgroundReview — the scripted full flow", () => {
  it("suggestions land through the assessment; the receipt counts auto vs pending", async () => {
    await writeFile(join(dir, "note.txt"), "parent did real work\n", "utf8");
    const model = recordingModel((_input, call) => {
      if (call === 1) {
        return {
          role: "assistant",
          content: "",
          toolCalls: [
            { id: "r1", name: "memory_write", arguments: { kind: "fact", content: "run pnpm eval before merging any milestone", tags: ["build"] } },
            // 永续 v6 弧 A（reef C3）钉随迁：凭据话题（无值）走 M49 pending
            // 人审——原 sk- 值夹具现会被块档门拒（memory-guard.test.ts 覆盖）。
            { id: "r2", name: "memory_write", arguments: { kind: "fact", content: "deploy password policy is rotating monthly" } },
          ],
        };
      }
      return { role: "assistant", content: "reviewed: saved one durable note" };
    });
    const registry = createSessionRegistry();
    const PARENT_TOOLS = parentTools();
    const messages = [
      { role: "user" as const, content: "fix the build" },
      { role: "assistant" as const, content: "(working)" },
    ];
    const spawn = await spawnBackgroundReview({
      workspaceRoot: dir,
      model,
      registry,
      systemPrompt: "parent prompt",
      messages,
      tools: PARENT_TOOLS,
    });
    expect(spawn).toBeDefined();
    const line = await spawn!.done;
    expect(line).toBe("🧠 review: 2 suggestions (1 auto, 1 pending)");

    const entries = await openMemoryStore(dir).load();
    expect(entries).toHaveLength(2);
    const statuses = new Map(entries.map((e) => [e.content.includes("pnpm eval") ? "eval" : "policy", e.status]));
    expect(statuses.get("eval")).toBe("active");
    expect(statuses.get("policy")).toBe("pending");

    // Warm prefix: the child's FIRST input replays the parent transcript plus
    // the [subagent task] brief; the tool definitions are byte-identical.
    const first = model.inputs[0]!;
    expect(first.systemPrompt).toBe("parent prompt");
    expect(first.messages.some((m) => m.role === "user" && m.content === "fix the build")).toBe(true);
    expect(first.messages.some((m) => m.role === "user" && m.content.includes("[subagent task]"))).toBe(true);
    expect(first.messages.some((m) => m.role === "user" && m.content.includes("REVIEW") || m.content.includes(REVIEW_PROMPT.slice(0, 12)))).toBe(true);
    expect(first.tools).toHaveLength(PARENT_TOOLS.length);
    expect(first.tools.map((t) => JSON.stringify(t))).toEqual(PARENT_TOOLS.map((t) => JSON.stringify(toModelToolDefinition(t))));

    // Budget: the reviewer gets at most maxTurns model calls.
    expect(model.inputs.length).toBeLessThanOrEqual(REVIEW_MAX_TURNS);
    expect(REVIEW_MAX_TURNS).toBe(2);
    expect(REVIEW_MIN_TOOL_CALLS).toBe(3);
  });

  it("0 suggestions when the reviewer finds nothing worth saving", async () => {
    const model = recordingModel(() => ({ role: "assistant", content: "nothing worth saving" }));
    const PARENT_TOOLS = parentTools();
    const spawn = await spawnBackgroundReview({
      workspaceRoot: dir,
      model,
      registry: createSessionRegistry(),
      systemPrompt: "p",
      messages: [{ role: "user", content: "hi" }],
      tools: PARENT_TOOLS,
    });
    let receipt = "";
    const line = await spawn!.done.then((l) => (receipt = l));
    expect(line).toBe("🧠 review: 0 suggestions");
    expect(receipt).toBe("🧠 review: 0 suggestions");
    expect(await openMemoryStore(dir).load()).toEqual([]);
  });

  it("the write tools refuse inside the fork (read-only + memory_write only)", async () => {
    const model = recordingModel((input, call) => {
      if (call === 1) return call("w1", "write_file", { path: "evil.txt", content: "nope" });
      return { role: "assistant", content: "done" };
    });
    const PARENT_TOOLS = parentTools();
    const spawn = await spawnBackgroundReview({
      workspaceRoot: dir,
      model,
      registry: createSessionRegistry(),
      systemPrompt: "p",
      messages: [{ role: "user", content: "try writing" }],
      tools: PARENT_TOOLS,
    });
    await spawn!.done;
    await expect(readFile(join(dir, "evil.txt"), "utf8")).rejects.toThrow();
  });

  it("WUDAO_BG_REVIEW=off spawns nothing", async () => {
    process.env.WUDAO_BG_REVIEW = "off";
    const model = recordingModel(() => ({ role: "assistant", content: "x" }));
    const PARENT_TOOLS = parentTools();
    const spawn = await spawnBackgroundReview({
      workspaceRoot: dir,
      model,
      registry: createSessionRegistry(),
      systemPrompt: "p",
      messages: [],
      tools: PARENT_TOOLS,
    });
    expect(spawn).toBeUndefined();
    expect(model.inputs).toHaveLength(0);
  });
});
