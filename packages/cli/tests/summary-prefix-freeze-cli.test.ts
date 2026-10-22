// 120-a A2 (the upstream format #6540 形) — the CLI half of the summary-call prefix-
// freeze census (the core half: core/tests/summary-prefix-freeze.test.ts).
// Every summary/review-class call on the CLI side declares one of three
// cache postures, and this file pins each declaration:
//   prefix-fork       memory review fork — replays the parent transcript
//                     byte-for-byte + ONE trailing brief (the warm fork);
//                     tools ride as byte-identical definitions (neutered
//                     execute only)
//   prefix-preserving side-question's stamp — never touches the prefix
//                     fields, only adds request params (querySource /
//                     maxTokens / the session's reasoning tier)
//   declared own-context  dream (fresh registry child: own system prompt,
//                     ledger-only tools, NO forkFrom — never claims the
//                     parent prefix), ask-reviewer / title / recap (constant
//                     byte-stable prompts of their own). Their contract is
//   the declaration itself: a change of posture must be conscious.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildTool, toModelToolDefinition, summaryPrefixDrift } from "@wudao/core";
import type { AgentMessage, AssistantMessage, ModelClient, ModelInput, Tool } from "@wudao/core";
import type { AgentRegistry, AgentSpawnSpec } from "../src/agents/index.js";
import { createSessionRegistry } from "../src/agents/index.js";
import { openMemoryStore } from "../src/memory/index.js";
import { createMemoryWriteTool, createMemorySearchTool } from "../src/memory/tools.js";
import { spawnBackgroundReview, REVIEW_PROMPT } from "../src/memory/review.js";
import { runDreamVerb, DREAM_SYSTEM_PROMPT } from "../src/memory/dream.js";
import { stampSideModelClient } from "../src/side-question.js";
import { buildAskReviewerModelInput, ASK_REVIEWER_SYSTEM_PROMPT } from "../src/ask-reviewer.js";
import { buildTitleRequest } from "../src/session-title.js";
import { buildRecapRequest } from "../src/session-recap.js";
import type { HistoryEntry } from "../src/driver/types.js";

function expectFrozen(parent: ModelInput, child: ModelInput, label: string, tailCount: number): void {
  const drift = summaryPrefixDrift(parent, child, { label, tailCount });
  expect(drift, `${label} broke the summary prefix-freeze contract:\n${drift.join("\n")}`).toEqual([]);
}

/** A recording model: every ModelInput captured as a DEEP snapshot (the
 *  loop mutates its live messages array after the call — an exact-count
 *  prefix contract must see the bytes as sent, not as later grown). */
function recordingModel(respond: (input: ModelInput, call: number) => AssistantMessage): ModelClient & { inputs: ModelInput[] } {
  const inputs: ModelInput[] = [];
  let call = 0;
  return {
    inputs,
    async generate(input: ModelInput): Promise<AssistantMessage> {
      inputs.push({
        ...input,
        messages: input.messages.map((m) => ({ ...m })),
        tools: input.tools.map((t) => ({ ...t })),
      });
      call += 1;
      return respond(input, call);
    },
  };
}

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "wudao-freeze-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

// ---------------------------------------------------------------------------
// prefix-fork — the memory review fork (M49 §2)
// ---------------------------------------------------------------------------

describe("prefix-freeze census (cli) — memory review fork", () => {
  it("the child's first request is the parent transcript + exactly ONE trailing brief, tool defs byte-identical", async () => {
    const model = recordingModel(() => ({ role: "assistant", content: "reviewed: nothing worth saving" }));
    const store = openMemoryStore(dir);
    const tools: Tool[] = [
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
    const messages: AgentMessage[] = [
      { role: "user", content: "fix the build" },
      { role: "assistant", content: "(working)" },
      { role: "user", content: "and the tests" },
    ];
    const spawn = await spawnBackgroundReview({
      workspaceRoot: dir,
      model,
      registry: createSessionRegistry(),
      systemPrompt: "parent prompt (byte-stable)",
      messages,
      tools,
    });
    expect(spawn).toBeDefined();
    await spawn!.done;
    expect(model.inputs.length).toBeGreaterThanOrEqual(1);
    // The freeze parent: the parent turn's own request fields. The neutered
    // write tools keep DEFINITIONS byte-identical (only execute swaps).
    const parent: ModelInput = {
      systemPrompt: "parent prompt (byte-stable)",
      tools: tools.map(toModelToolDefinition),
      messages,
    };
    expectFrozen(parent, model.inputs[0]!, "memory review fork", 1);
    // The declared tail is the [subagent task] brief carrying the review ask.
    const tail = model.inputs[0]!.messages.at(-1)!;
    expect(tail.role).toBe("user");
    expect(tail.content).toContain("[subagent task]");
    expect(tail.content).toContain(REVIEW_PROMPT.slice(0, 20));
  });
});

// ---------------------------------------------------------------------------
// prefix-preserving — the side-question (btw) stamp
// ---------------------------------------------------------------------------

describe("prefix-freeze census (cli) — side-question stamp", () => {
  const base: ModelInput = {
    systemPrompt: "parent system",
    tools: [{ name: "t", description: "d", parameters: { type: "object", properties: {}, additionalProperties: false } }],
    messages: [{ role: "user", content: "the parent's warm prefix" }],
  };

  it("the stamp never touches the prefix fields — only adds request params", async () => {
    const model = recordingModel(() => ({ role: "assistant", content: "side answer" }));
    const stamped = stampSideModelClient(model, "high");
    await stamped.generate(base);
    const child = model.inputs[0]!;
    // The prefix fields pass through byte-identical (the stamp is
    // prefix-PRESERVING, not a fork — it adds no messages).
    expect(child.systemPrompt).toBe(base.systemPrompt);
    expect(child.tools).toEqual(base.tools);
    expect(child.messages).toEqual(base.messages);
    // …and the stamp adds exactly the declared params.
    expect(child.querySource).toBe("btw");
    expect(child.maxTokens).toBeDefined();
    expect(child.reasoningEffort).toBe("high");
  });

  it("no session tier declared → the stamp adds none (deliberate omission pinned)", async () => {
    const model = recordingModel(() => ({ role: "assistant", content: "side answer" }));
    const stamped = stampSideModelClient(model);
    await stamped.generate(base);
    expect(model.inputs[0]!.reasoningEffort).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// declared own-context — dream / ask-reviewer / title / recap
// ---------------------------------------------------------------------------

describe("prefix-freeze census (cli) — declared own-context members", () => {
  it("dream spawns a FRESH registry child: own system prompt, ledger-only tools, NO forkFrom — it never claims the parent prefix", async () => {
    // Seed the ledger so the consolidation has a batch to work on.
    const store = openMemoryStore(dir);
    for (let i = 0; i < 4; i += 1) {
      await store.write({ kind: "fact", content: `fact ${i}: the build prefers pnpm filter workspaces` });
    }
    const captured: AgentSpawnSpec[] = [];
    const registry = {
      spawn(spec: AgentSpawnSpec) {
        captured.push(spec);
        return {
          id: "dream-1",
          done: Promise.resolve({ id: "dream-1", role: spec.role.id, ok: true, report: "consolidated" }),
        };
      },
      awaitAgents: async () => [],
      status: () => [],
      cancel: () => true,
    } as unknown as AgentRegistry;
    const model = recordingModel(() => ({ role: "assistant", content: "dream done" }));
    const line = await runDreamVerb({ workspaceRoot: dir, model, registry });
    expect(line).not.toContain("disabled");
    expect(captured).toHaveLength(1);
    const spec = captured[0]!;
    // The declared posture: no parent prefix claim anywhere.
    expect(spec.forkFrom).toBeUndefined();
    expect(spec.role.systemPrompt).toBe(DREAM_SYSTEM_PROMPT);
    expect(spec.allTools.map((t) => t.name).sort()).toEqual(["memory_search", "memory_write"]);
  });

  it("ask-reviewer builds its OWN context: pinned constant system prompt, empty tool table (cold by design, byte-stable across asks)", () => {
    const excerpt = { entries: [{ role: "user" as const, text: "run pnpm test before merging", truncated: false }] };
    const a = buildAskReviewerModelInput(excerpt, { toolName: "shell", input: { command: "pnpm test" } }, undefined);
    const b = buildAskReviewerModelInput(excerpt, { toolName: "shell", input: { command: "pnpm test" } }, undefined);
    expect(a.systemPrompt).toBe(ASK_REVIEWER_SYSTEM_PROMPT);
    expect(a.tools).toEqual([]);
    expect(a.messages).toHaveLength(1);
    // Byte-stable: the same ask produces the same request bytes (its own
    // cross-invocation cache property — there is no parent prefix to ride).
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("session title / recap builders are deterministic own-context requests (same input → same bytes)", () => {
    const t1 = buildTitleRequest([
      { role: "user", content: "fix the login bug" },
      { role: "assistant", content: "done" },
    ]);
    const t2 = buildTitleRequest([
      { role: "user", content: "fix the login bug" },
      { role: "assistant", content: "done" },
    ]);
    expect(t1).toBeDefined();
    expect(JSON.stringify(t1)).toBe(JSON.stringify(t2));
    expect(t1!.systemPrompt).toContain("title");

    const entries: HistoryEntry[] = [
      { kind: "user", text: "hi" },
      { kind: "assistant", text: "hello" },
    ];
    const r1 = buildRecapRequest(entries);
    const r2 = buildRecapRequest(entries);
    expect(r1).toBeDefined();
    expect(JSON.stringify(r1)).toBe(JSON.stringify(r2));
  });
});
