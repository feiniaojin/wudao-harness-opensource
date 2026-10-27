// ω99-57 — child→parent mail (the child half-arc). Deterministic coverage:
// the globally-registered message_parent tool (typed refusals outside an
// edge), the ambient mail scope runSubagent enters for attributed children,
// delivery formatting (unforgeable sender derived from the child identity),
// the M35 §2 sidechain record, FIFO causality (messages land before the
// settlement is produced, send order preserved, nothing lost on child death),
// the shareContext-fork refusal ruling, and the registry threading.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { runSubagent } from "../src/subagent.js";
import type { SubagentType } from "../src/subagent.js";
import { buildTool } from "../src/tool.js";
import { toModelToolDefinition } from "../src/tool.js";
import type { Tool } from "../src/tool.js";
import { createScriptedModel } from "../src/model-client.js";
import type { ModelClient, ModelInput } from "../src/model-client.js";
import type { AssistantMessage } from "../src/types.js";
import { createJsonlSessionStore } from "../src/session/store.js";
import type { SessionStore } from "../src/session/store.js";
import { createAgentRegistry } from "../src/agents/registry.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createParentMessageTool,
  currentMailScope,
  runWithMailScope,
  PARENT_MESSAGE_TOOL_NAME,
  MAIL_CONTENT_MAX_CHARS,
} from "../src/agents/mail.js";

let root: string;
let store: SessionStore;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "mail-"));
  store = createJsonlSessionStore(join(root, "sessions"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
});

/** A parent-side lane: every delivered text, in order. */
function lane(): { texts: string[]; sink: { deliver: (text: string) => void } } {
  const texts: string[] = [];
  return { texts, sink: { deliver: (text) => { texts.push(text); } } };
}

function recording(responses: readonly AssistantMessage[]): { model: ModelClient; inputs: ModelInput[] } {
  const inputs: ModelInput[] = [];
  let call = 0;
  const model: ModelClient = {
    async generate(input: ModelInput): Promise<AssistantMessage> {
      inputs.push({ ...input, messages: [...input.messages], tools: [...input.tools] });
      const r = responses[call];
      call += 1;
      if (!r) throw new Error("scripted responses exhausted");
      return r;
    },
  };
  return { model, inputs };
}

const sendCall = (id: string, content: string) => ({
  id,
  name: PARENT_MESSAGE_TOOL_NAME,
  arguments: { content },
});

// A child type whose tool set includes the mail tool (what the CLI's task
// tool draws for its children in this arc).
const mailType = (tools: readonly Tool[]): SubagentType => ({
  name: "coder",
  description: "d",
  systemPrompt: "child sys",
  toolNames: tools.map((t) => t.name),
});

// ---------------------------------------------------------------------------
// The tool itself — global registration, typed refusals (acceptance 3/4)
// ---------------------------------------------------------------------------

describe("ω99-57 message_parent tool (global face)", () => {
  it("exists under the reserved name with a {content} schema", async () => {
    const tool = createParentMessageTool();
    expect(tool.name).toBe("message_parent");
    expect(tool.parameters).toEqual({
      type: "object",
      properties: { content: { type: "string", description: expect.stringContaining("self-contained") } },
      required: ["content"],
      additionalProperties: false,
    });
  });

  it("outside any mail scope (the top-level session) the call is a typed refusal", async () => {
    expect(currentMailScope()).toBeUndefined();
    const tool = createParentMessageTool();
    const r = await tool.execute({ content: "hello" });
    expect(r.isError).toBe(true);
    expect(r.content).toContain("no live parent edge");
  });

  it("inside an edge scope the send reaches the sink and the model gets a receipt", async () => {
    const { texts, sink } = lane();
    const tool = createParentMessageTool();
    const r = await runWithMailScope(
      { kind: "edge", childId: "side-1", role: "coder", send: async (content) => { sink.deliver(`[message from subagent side-1 (coder)]\n${content}`); } },
      async () => tool.execute({ content: "found the flaky test" }),
    );
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain("delivered");
    expect(texts).toEqual(["[message from subagent side-1 (coder)]\nfound the flaky test"]);
  });

  it("a refusal scope (fork ruling) is a typed error carrying its reason", async () => {
    const tool = createParentMessageTool();
    const r = await runWithMailScope(
      { kind: "none", reason: "fork ruling" },
      async () => tool.execute({ content: "x" }),
    );
    expect(r.isError).toBe(true);
    expect(r.content).toContain("fork ruling");
  });

  it("fail-closed argument shapes: empty, non-string, over-cap content", async () => {
    const tool = createParentMessageTool();
    const empty = await tool.execute({ content: "   " });
    expect(empty.isError).toBe(true);
    expect(empty.content).toContain('"content" must be a non-empty string');
    const nonString = await tool.execute({ content: 42 });
    expect(nonString.isError).toBe(true);
    const tooLong = await tool.execute({ content: "x".repeat(MAIL_CONTENT_MAX_CHARS + 1) });
    expect(tooLong.isError).toBe(true);
    expect(tooLong.content).toContain(`${MAIL_CONTENT_MAX_CHARS}`);
  });
});

// ---------------------------------------------------------------------------
// runSubagent — scope entry, delivery, sidechain record, causality
// ---------------------------------------------------------------------------

describe("ω99-57 runSubagent mail (child→parent half-arc)", () => {
  it("an attributed child sends mid-run: formatted delivery + M35 sidechain entry + the run continues", async () => {
    const mail = createParentMessageTool();
    const { texts, sink } = lane();
    const { model } = recording([
      { role: "assistant", content: "", toolCalls: [sendCall("m1", "found it: the fixture leaks")] },
      { role: "assistant", content: "final answer after sending" },
    ]);
    const answer = await runSubagent({
      model,
      allTools: [mail],
      subagentType: mailType([mail]),
      prompt: "work",
      loopOptions: { maxTurns: 5 },
      parentMail: sink,
      session: { mode: "new", id: "side-abc", store },
    });
    expect(answer).toBe("final answer after sending");
    // Delivery: exactly one formatted line, sender derived from the sidechain id + role.
    expect(texts).toEqual(["[message from subagent side-abc (coder)]\nfound it: the fixture leaks"]);
    // Persistence: the send rides the child's own sidechain as a generic entry.
    const entries = await store.loadSidechainEntries("side-abc");
    const sent = entries.filter((e) => (e as { type?: string }).type === "subagent-message");
    expect(sent).toHaveLength(1);
    expect((sent[0] as { data: { role: string; content: string } }).data).toMatchObject({
      role: "coder",
      content: "found it: the fixture leaks",
    });
    // The tool conversation itself also persisted (the send is a real turn).
    const messages = await store.loadSidechain("side-abc");
    expect(messages.some((m) => m.role === "assistant" && m.toolCalls?.some((c) => c.name === PARENT_MESSAGE_TOOL_NAME))).toBe(true);
  });

  it("causality (FIFO): a child that sends twice then dies leaves both messages, in order, before the settlement", async () => {
    const mail = createParentMessageTool();
    const { texts, sink } = lane();
    const script = recording([
      { role: "assistant", content: "", toolCalls: [sendCall("m1", "first finding")] },
      { role: "assistant", content: "", toolCalls: [sendCall("m2", "second finding")] },
    ]);
    // The third model call rejects — the child dies mid-run.
    let call = 0;
    const dying: ModelClient = {
      generate: async (input: ModelInput) => {
        call += 1;
        if (call === 3) throw new Error("child model crashed");
        return script.model.generate(input);
      },
    };
    await expect(runSubagent({
      model: dying,
      allTools: [mail],
      subagentType: mailType([mail]),
      prompt: "work",
      loopOptions: { maxTurns: 5 },
      parentMail: sink,
    })).rejects.toThrow("child model crashed");
    // Both messages landed in the parent lane, in send order, BEFORE the
    // settlement (the rejected runSubagent promise) was ever produced. A
    // sessionless child signs both with ONE ephemeral identity.
    expect(texts).toHaveLength(2);
    expect(texts[0]!.endsWith("\nfirst finding")).toBe(true);
    expect(texts[1]!.endsWith("\nsecond finding")).toBe(true);
    const senderOf = (t: string): string => t.split("\n")[0]!;
    expect(senderOf(texts[0]!).startsWith("[message from subagent eph-")).toBe(true);
    expect(senderOf(texts[1]!)).toBe(senderOf(texts[0]!));
  });

  it("a shareContext fork is REFUSED (T0-3 ruling): typed error, nothing delivered", async () => {
    const mail = createParentMessageTool();
    const { texts, sink } = lane();
    const { model, inputs } = recording([
      { role: "assistant", content: "", toolCalls: [sendCall("m1", "fork tries to send")] },
      { role: "assistant", content: "fork answer" },
    ]);
    const answer = await runSubagent({
      model,
      allTools: [mail],
      subagentType: mailType([mail]),
      prompt: "fork brief",
      loopOptions: { maxTurns: 5 },
      parentMail: sink,
      forkFrom: {
        systemPrompt: "PARENT-SYS",
        tools: [mail],
        messages: [{ role: "user", content: "parent prompt" }],
      },
    });
    expect(answer).toBe("fork answer");
    expect(texts).toEqual([]);
    // The refusal reached the model as a typed tool error (visible in the
    // request AFTER the tool turn, not the one that issued the call).
    const toolResult = inputs[1]!.messages.find((m) => m.role === "tool");
    expect(toolResult).toBeDefined();
    expect((toolResult as { content: string; isError?: boolean }).isError).toBe(true);
    expect((toolResult as { content: string }).content).toContain("fork");
    expect((toolResult as { content: string }).content).toContain("final answer");
  });

  it("two children, two lanes: each send lands ONLY on its own spawn's lane (no second edge exists to address)", async () => {
    const mail = createParentMessageTool();
    const a = lane();
    const b = lane();
    const run = async (sink: { deliver: (t: string) => void }, content: string): Promise<void> => {
      const { model } = recording([
        { role: "assistant", content: "", toolCalls: [sendCall("m", content)] },
        { role: "assistant", content: "done" },
      ]);
      await runSubagent({
        model,
        allTools: [mail],
        subagentType: mailType([mail]),
        prompt: "work",
        loopOptions: { maxTurns: 5 },
        parentMail: sink,
        session: { mode: "new", id: content === "from-a" ? "side-a" : "side-b", store },
      });
    };
    await Promise.all([run(a.sink, "from-a"), run(b.sink, "from-b")]);
    // No cross-delivery, no addressable surface: the schema exposes ONLY
    // content (no sender/target field exists to forge — acceptance 4).
    expect(a.texts).toHaveLength(1);
    expect(b.texts).toHaveLength(1);
    expect(a.texts[0]!.startsWith("[message from subagent side-a (coder)]\n")).toBe(true);
    expect(b.texts[0]!.startsWith("[message from subagent side-b (coder)]\n")).toBe(true);
    const schema = mail.parameters as { properties: Record<string, unknown>; additionalProperties: boolean };
    expect(Object.keys(schema.properties)).toEqual(["content"]);
    expect(schema.additionalProperties).toBe(false);
  });

  it("a child spawned WITHOUT parentMail (unattributed runner) gets the no-edge refusal", async () => {
    const mail = createParentMessageTool();
    const { model, inputs } = recording([
      { role: "assistant", content: "", toolCalls: [sendCall("m1", "anyone there?")] },
      { role: "assistant", content: "done" },
    ]);
    const answer = await runSubagent({
      model,
      allTools: [mail],
      subagentType: mailType([mail]),
      prompt: "work",
      loopOptions: { maxTurns: 5 },
    });
    expect(answer).toBe("done");
    const toolResult = inputs[1]!.messages.find((m) => m.role === "tool") as { content: string; isError?: boolean };
    expect(toolResult.isError).toBe(true);
    expect(toolResult.content).toContain("no live parent edge");
  });

  it("resume keeps the attribution stable: the same sidechain id signs both runs' sends", async () => {
    const mail = createParentMessageTool();
    const { texts, sink } = lane();
    const first = recording([
      { role: "assistant", content: "", toolCalls: [sendCall("m1", "from the first stint")] },
      { role: "assistant", content: "first stint done" },
    ]);
    await runSubagent({
      model: first.model,
      allTools: [mail],
      subagentType: mailType([mail]),
      prompt: "work",
      loopOptions: { maxTurns: 5 },
      parentMail: sink,
      session: { mode: "new", id: "side-resume", store },
    });
    const second = recording([
      { role: "assistant", content: "", toolCalls: [sendCall("m2", "from the resumed stint")] },
      { role: "assistant", content: "resumed stint done" },
    ]);
    await runSubagent({
      model: second.model,
      allTools: [mail],
      subagentType: mailType([mail]),
      prompt: "continue",
      loopOptions: { maxTurns: 5 },
      parentMail: sink,
      session: { mode: "resume", id: "side-resume", store },
    });
    expect(texts).toEqual([
      "[message from subagent side-resume (coder)]\nfrom the first stint",
      "[message from subagent side-resume (coder)]\nfrom the resumed stint",
    ]);
  });

  it("the registry threads parentMail: a background child's send reaches the lane", async () => {
    const mail = createParentMessageTool();
    const { texts, sink } = lane();
    const registry = createAgentRegistry({
      maxConcurrent: 2,
      hardCap: 4,
      childTurns: 5,
      graceTools: [],
    });
    const spawned = registry.spawn({
      model: createScriptedModel([
        { role: "assistant", content: "", toolCalls: [sendCall("m1", "background finding")] },
        { role: "assistant", content: "bg answer" },
      ]),
      allTools: [mail],
      role: { id: "coder", description: "d", systemPrompt: "s", toolNames: [PARENT_MESSAGE_TOOL_NAME] },
      prompt: "work",
      parentMail: sink,
    });
    const result = await spawned.done;
    expect(result.ok).toBe(true);
    expect(texts).toHaveLength(1);
    expect(texts[0]!.startsWith("[message from subagent eph-")).toBe(true);
    expect(texts[0]!.endsWith("(coder)]\nbackground finding")).toBe(true);
  });

  it("prefix bytes (acceptance 3): a fork's request tools are byte-identical to the parent serialization", async () => {
    const mail = createParentMessageTool();
    const stub = buildTool({ name: "read_file", description: "r", parameters: { type: "object", properties: {} }, async execute() { return { content: "ok" }; } });
    const parentTools = [stub, mail];
    const parentBytes = JSON.stringify(parentTools.map(toModelToolDefinition));
    const { model, inputs } = recording([{ role: "assistant", content: "fork done" }]);
    await runSubagent({
      model,
      allTools: parentTools,
      subagentType: mailType(parentTools),
      prompt: "fork brief",
      loopOptions: { maxTurns: 5 },
      forkFrom: { systemPrompt: "PARENT-SYS", tools: parentTools, messages: [{ role: "user", content: "p" }] },
    });
    expect(JSON.stringify(inputs[0]!.tools)).toBe(parentBytes);
    // And the mail tool is IN that array (globally registered, not child-only).
    expect(inputs[0]!.tools.some((t) => t.name === PARENT_MESSAGE_TOOL_NAME)).toBe(true);
  });
});
