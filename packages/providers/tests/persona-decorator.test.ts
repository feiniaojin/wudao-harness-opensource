// packages/providers/tests/persona-decorator.test.ts
import { describe, it, expect } from "vitest";
import type { ModelClient, ModelInput, AssistantMessage } from "@wudao-org/core";
import { withPersona } from "../src/persona/decorator.js";
import { createPersonaRuntime, resolvePersona } from "../src/persona/runtime.js";
import type { PersonaDefinition } from "../src/persona/types.js";

const def: PersonaDefinition = {
  id: "cc-like", displayName: "CC-like",
  source: { kind: "workspace-source", provenance: "t", pinnedVersion: "1" },
  headers: {},
  prompt: {
    system: { mode: "prefix", text: "You are Claude Code, Anthropic's official CLI.\n" },
    toolNameMap: { read_file: "Read", write_file: "Write" },
  },
};
const INPUT: ModelInput = {
  systemPrompt: "base sys",
  messages: [
    { role: "user", content: "go" },
    { role: "tool", toolCallId: "c1", name: "read_file", content: "ok" },
  ],
  tools: [
    { name: "read_file", description: "reads", parameters: { type: "object", properties: {} } },
    { name: "bash", description: "shell", parameters: { type: "object", properties: {} } },
  ],
};

function spyClient(captured: ModelInput[], reply: AssistantMessage): ModelClient {
  return { modelId: "m", async generate(input) { captured.push(input); return reply; } };
}

describe("withPersona (layer 3)", () => {
  it("prompt OFF (default layers) = decorator is identity: same object reaches the inner client", async () => {
    const cap: ModelInput[] = [];
    const rt = createPersonaRuntime(resolvePersona(def)); // prompt 默认 false
    const inner = spyClient(cap, { role: "assistant", content: "x" });
    const wrapped = withPersona(inner, rt);
    await wrapped.generate(INPUT);
    expect(cap[0]).toBe(INPUT); // 引用不变：零接触
  });
  it("prompt ON: system prefix + outbound tool/message rename; original input object untouched", async () => {
    const cap: ModelInput[] = [];
    const rt = createPersonaRuntime(resolvePersona(def, { prompt: true }));
    const inner = spyClient(cap, { role: "assistant", content: "done", toolCalls: [{ id: "t1", name: "Read", arguments: {} }] });
    const wrapped = withPersona(inner, rt);
    const out = await wrapped.generate(INPUT);
    expect(cap[0].systemPrompt).toBe("You are Claude Code, Anthropic's official CLI.\nbase sys");
    expect(cap[0].tools.map((t) => t.name)).toEqual(["Read", "bash"]); // 未映射的不动
    expect((cap[0].messages[1] as any).name).toBe("Read");            // tool 消息出向改名
    expect(INPUT.systemPrompt).toBe("base sys");                       // 原输入永不改写（M24 纪律）
    expect(INPUT.tools[0].name).toBe("read_file");
    expect((INPUT.messages[1] as any).name).toBe("read_file");
    expect(out.toolCalls?.[0].name).toBe("read_file");                 // 响应入向逆映射
  });
  it("snapshot mode replaces the whole system prompt", async () => {
    const cap: ModelInput[] = [];
    const snap: PersonaDefinition = { ...def, prompt: { system: { mode: "snapshot", text: "REPLACED" } } };
    const rt = createPersonaRuntime(resolvePersona(snap, { prompt: true }));
    await withPersona(spyClient(cap, { role: "assistant", content: "x" }), rt).generate(INPUT);
    expect(cap[0].systemPrompt).toBe("REPLACED");
  });
  it("stream: deltas pass through; done message tool names reverse-mapped", async () => {
    const rt = createPersonaRuntime(resolvePersona(def, { prompt: true }));
    const finalMsg: AssistantMessage = { role: "assistant", content: "y", toolCalls: [{ id: "t9", name: "Write", arguments: {} }] };
    const inner: ModelClient = {
      modelId: "m",
      async generate() { throw new Error("unused"); },
      async *stream(input: ModelInput) {
        expect(input.tools[0].name).toBe("Read"); // 出向已映射
        yield { type: "text_delta", text: "y" };
        yield { type: "done", message: finalMsg };
      },
    };
    const events = [];
    for await (const ev of withPersona(inner, rt).stream!(INPUT)) events.push(ev);
    expect(events[0]).toEqual({ type: "text_delta", text: "y" });
    // 逆映射按 toolNameMap 原键精确还原（Write → write_file，大小写敏感）
    expect((events[1] as any).message.toolCalls[0].name).toBe("write_file");
  });
  it("persona without prompt style = identity even when prompt layer flagged on", async () => {
    const cap: ModelInput[] = [];
    const noPrompt: PersonaDefinition = { ...def, prompt: undefined };
    const rt = createPersonaRuntime(resolvePersona(noPrompt, { prompt: true }));
    await withPersona(spyClient(cap, { role: "assistant", content: "x" }), rt).generate(INPUT);
    expect(cap[0]).toBe(INPUT);
  });
  it("runtime.current = null = identity (persona off)", async () => {
    const cap: ModelInput[] = [];
    await withPersona(spyClient(cap, { role: "assistant", content: "x" }), createPersonaRuntime(null)).generate(INPUT);
    expect(cap[0]).toBe(INPUT);
  });
  it("(a) multi-turn outbound: assistant history toolCalls get renamed alongside definitions", async () => {
    const cap: ModelInput[] = [];
    const multiTurnInput: ModelInput = {
      systemPrompt: "base",
      messages: [
        { role: "user", content: "read file" },
        { role: "assistant", content: "", toolCalls: [{ id: "tc1", name: "read_file", arguments: {} }] },
        { role: "tool", toolCallId: "tc1", name: "read_file", content: "file content" },
      ],
      tools: [
        { name: "read_file", description: "reads", parameters: { type: "object", properties: {} } },
      ],
    };
    const rt = createPersonaRuntime(resolvePersona(def, { prompt: true }));
    const inner = spyClient(cap, { role: "assistant", content: "done" });
    const wrapped = withPersona(inner, rt);
    await wrapped.generate(multiTurnInput);
    // Tool definition renamed: read_file → Read
    expect(cap[0].tools[0].name).toBe("Read");
    // Assistant message toolCall renamed: read_file → Read
    expect((cap[0].messages[1] as any).toolCalls[0].name).toBe("Read");
    // Tool message renamed: read_file → Read
    expect((cap[0].messages[2] as any).name).toBe("Read");
  });
  it("(b) inbound unmapped-name passthrough: tool calls not in map pass through unchanged", async () => {
    const rt = createPersonaRuntime(resolvePersona(def, { prompt: true }));
    const inner = spyClient([], {
      role: "assistant",
      content: "done",
      toolCalls: [
        { id: "t1", name: "read_file", arguments: {} },  // mapped → reverse-mapped
        { id: "t2", name: "bash", arguments: {} },       // unmapped → passes through
      ],
    });
    const wrapped = withPersona(inner, rt);
    const out = await wrapped.generate(INPUT);
    expect(out.toolCalls![0].name).toBe("read_file");  // Read → read_file
    expect(out.toolCalls![1].name).toBe("bash");       // bash → bash (unchanged)
  });
  it("(c) hot-switch: two generate calls across runtime.current change", async () => {
    const cap: ModelInput[] = [];
    const rt = createPersonaRuntime(resolvePersona(def, { prompt: true }));
    const inner = spyClient(cap, { role: "assistant", content: "done", toolCalls: [{ id: "t1", name: "Read", arguments: {} }] });
    const wrapped = withPersona(inner, rt);

    // First call with persona ON
    let out = await wrapped.generate(INPUT);
    expect(cap[0].tools[0].name).toBe("Read");          // outbound transformed
    expect(out.toolCalls![0].name).toBe("read_file");   // inbound reverse-mapped

    // Switch persona OFF
    rt.current = null;
    cap.length = 0;  // clear capture

    // Second call with persona OFF (identity)
    out = await wrapped.generate(INPUT);
    expect(cap[0]).toBe(INPUT);                        // same object (identity)
    expect(cap[0].tools[0].name).toBe("read_file");    // no transformation
    expect(out.toolCalls![0].name).toBe("Read");        // no reverse-mapping
  });
  // -------------------------------------------------------------------------
  // Final-review I2 — display-name collision guard (fail-closed).
  // -------------------------------------------------------------------------
  it("final-review I2: a mapped display name equaling a live unmapped tool name throws before any wire effect, naming persona + both names", async () => {
    const cap: ModelInput[] = [];
    // read_file → "bash" while a REAL unmapped "bash" is in the inventory:
    // two same-named tools on the wire, and the model's "bash" call would
    // reverse-map to read_file — the wrong tool with bash's args.
    const colliding: PersonaDefinition = {
      ...def,
      prompt: { system: { mode: "prefix", text: "p" }, toolNameMap: { read_file: "bash" } },
    };
    const rt = createPersonaRuntime(resolvePersona(colliding, { prompt: true }));
    const inner = spyClient(cap, { role: "assistant", content: "never" });
    let message = "";
    try {
      await withPersona(inner, rt).generate(INPUT);
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain("cc-like");   // persona id
    expect(message).toContain("read_file"); // mapped source
    expect(message).toContain("bash");      // colliding display name == live tool
    expect(cap.length).toBe(0);             // nothing reached the inner client — zero wire effect
    // The stream path shares the guard (transformInput runs before any yield).
    let streamMessage = "";
    const streamInner: ModelClient = {
      modelId: "m",
      async generate() { throw new Error("unused"); },
      async *stream() { yield { type: "text_delta", text: "never" }; },
    };
    try {
      for await (const _ev of withPersona(streamInner, rt).stream!(INPUT)) void _ev;
    } catch (err) {
      streamMessage = err instanceof Error ? err.message : String(err);
    }
    expect(streamMessage).toContain("bash");
  });
  it("final-review I2 companion: a non-colliding map passes the inventory through unchanged", async () => {
    const cap: ModelInput[] = [];
    const rt = createPersonaRuntime(resolvePersona(def, { prompt: true })); // read_file→Read, write_file→Write; live unmapped bash untouched
    const inner = spyClient(cap, { role: "assistant", content: "done" });
    await withPersona(inner, rt).generate(INPUT);
    expect(cap[0].tools.map((t) => t.name)).toEqual(["Read", "bash"]); // no throw, rename only
  });
});
