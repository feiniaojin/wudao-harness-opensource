// 133 #12（goose 6d5eba9b1 补测试）— wire 工具结果批内连续性不变量。
// goose 的 bug 形状：工具结果里的图片被合成为 user 图片消息后，若内联
// 插在同一个 assistant tool_calls 批的工具结果之间，严格 OpenAI 兼容
// 端点直接拒收整个请求（批内 tool 结果必须连续，中间不许插 user）。
// 我们结构免疫：合成 carrier 只在非 tool 消息到达时冲刷
// （openai-images.ts 的 flushToolImages），永远落在整批之后；文本路径
// （toOpenAIMessage）根本没有 user 插入点。这枚形状不变量钉住两件事：
// (1) 批内 role:"tool" 消息连续（极大段内无 user/system 夹层）；
// (2) 每个极大段紧邻其 assistant tool_calls 批之后。
// 这类"形状不变量"正是将来加图片工具结果（截图工具）时最先破的东西。
import { describe, it, expect } from "vitest";
import { createOpenAICompatibleProvider } from "../src/index.js";
import type { ProviderConfig } from "../src/index.js";

/** One assistant batch of N tool calls + N tool results (the goose shape:
 *  MULTIPLE results in ONE batch — shotsWith-style one-batch-per-call does
 *  not exercise the interleaving hazard). */
function batchOf(n: number, withImages: boolean): Record<string, unknown>[] {
  const calls = Array.from({ length: n }, (_, i) => ({ id: `c${i + 1}`, name: "screen_capture", arguments: {} }));
  const out: Record<string, unknown>[] = [
    { role: "assistant", content: "", toolCalls: calls },
  ];
  for (let i = 1; i <= n; i += 1) {
    out.push({
      role: "tool",
      toolCallId: `c${i}`,
      name: "screen_capture",
      content: `shot ${i}`,
      ...(withImages ? { images: [{ kind: "image", ref: { kind: "image", attachmentId: `shot-${i}`, mediaType: "image/png", byteLength: 3 } }] } : {}),
    });
  }
  return out;
}

function captureFetch(): { fetch: typeof fetch; bodies: Record<string, unknown>[] } {
  const bodies: Record<string, unknown>[] = [];
  const fetch = (async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)));
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { role: "assistant", content: "ok" } }] }) };
  }) as unknown as typeof fetch;
  return { fetch, bodies };
}

const visionConfig: ProviderConfig = { apiKey: "k", baseURL: "https://x/v1", model: "glm-4v-plus" };

const resolver = {
  resolveDataUrl: async (r: { attachmentId: string; mediaType: string }) => `data:${r.mediaType};base64,${r.attachmentId}`,
};

type WireMessage = { role: string; tool_call_id?: string; tool_calls?: { id: string }[]; content: unknown };

/** The invariant walk: every maximal run of role:"tool" wire messages must
 *  (a) contain no non-tool message, trivially, AND (b) sit IMMEDIATELY after
 *  the assistant message whose tool_calls cover the run's ids. Returns the
 *  runs for the caller to also assert placement of synthetic carriers. */
function toolRuns(messages: WireMessage[]): Array<{ start: number; len: number }> {
  const runs: Array<{ start: number; len: number }> = [];
  let i = 0;
  while (i < messages.length) {
    if (messages[i]!.role !== "tool") { i += 1; continue; }
    let j = i;
    while (j < messages.length && messages[j]!.role === "tool") j += 1;
    runs.push({ start: i, len: j - i });
    i = j;
  }
  return runs;
}

describe("133 #12 — wire 批内工具结果连续性不变量（goose 6d5eba9b1）", () => {
  it("文本路径：单批 3 调用 → 3 条 tool 消息连续，紧随 assistant 批，user 轮在其后", async () => {
    const cap = captureFetch();
    const model = createOpenAICompatibleProvider(visionConfig, { fetch: cap.fetch });
    await model.generate({
      systemPrompt: "s",
      messages: [{ role: "user", content: "watch" }, ...batchOf(3, false), { role: "user", content: "after" }],
      tools: [],
    });
    const messages = (cap.bodies[0]!["messages"] as WireMessage[]);
    const runs = toolRuns(messages);
    expect(runs).toHaveLength(1);
    const run = runs[0]!;
    expect(run.len).toBe(3);
    // 连续性：段内三条都是 tool（run 的定义即极大连续段——但钉住位置）
    expect(messages[run.start]!.tool_call_id).toBe("c1");
    expect(messages[run.start + 1]!.tool_call_id).toBe("c2");
    expect(messages[run.start + 2]!.tool_call_id).toBe("c3");
    // 段紧邻 assistant tool_calls 批（id 覆盖）
    const head = messages[run.start - 1]!;
    expect(head.role).toBe("assistant");
    expect(head.tool_calls!.map((t) => t.id)).toEqual(["c1", "c2", "c3"]);
    // 段后才是 user 轮（无任何夹层）
    expect(messages[run.start + 3]!.role).toBe("user");
  });

  it("图片路径：同批 2 结果各带图 → 合成 carrier 落在整批之后，绝不插进批内", async () => {
    const cap = captureFetch();
    const model = createOpenAICompatibleProvider(visionConfig, { fetch: cap.fetch, attachments: resolver });
    await model.generate({
      systemPrompt: "s",
      messages: [{ role: "user", content: "watch" }, ...batchOf(2, true), { role: "user", content: "after" }],
      tools: [],
    });
    const messages = (cap.bodies[0]!["messages"] as WireMessage[]);
    // 批内两条 tool 连续
    const runs = toolRuns(messages);
    expect(runs).toHaveLength(1);
    const run = runs[0]!;
    expect(run.len).toBe(2);
    expect(messages[run.start]!.tool_call_id).toBe("c1");
    expect(messages[run.start + 1]!.tool_call_id).toBe("c2");
    // 合成 carrier（user + 数组 content）在批后，不在批内
    const carrierIdx = messages.findIndex((m) => m.role === "user" && Array.isArray(m.content));
    expect(carrierIdx).toBeGreaterThan(run.start + run.len - 1);
    // carrier 是带图 note（图片路径真的走了）
    const parts = messages[carrierIdx]!.content as { type: string; text?: string }[];
    expect(parts[0]!.text).toContain("tool result");
    expect(parts.some((p) => p.type === "image_url")).toBe(true);
  });

  it("走查不变量：每个 tool 极大段的前驱必是 assistant 且 tool_calls id 集合恰好覆盖该段", async () => {
    // 两批（批1 文本 2 调用、批2 图片 2 调用）+ 首尾 user 轮
    const cap = captureFetch();
    const model = createOpenAICompatibleProvider(visionConfig, { fetch: cap.fetch, attachments: resolver });
    await model.generate({
      systemPrompt: "s",
      messages: [
        { role: "user", content: "watch" },
        ...batchOf(2, false),
        { role: "user", "data-mid": "mid" } as never,
        ...batchOf(2, true),
      ],
      tools: [],
    });
    const messages = (cap.bodies[0]!["messages"] as WireMessage[]);
    const runs = toolRuns(messages);
    expect(runs.length).toBe(2);
    for (const run of runs) {
      const head = messages[run.start - 1]!;
      expect(head.role).toBe("assistant");
      expect(head.tool_calls).toHaveLength(run.len);
      const headIds = new Set(head.tool_calls!.map((t) => t.id));
      for (let k = 0; k < run.len; k += 1) {
        expect(headIds.has(messages[run.start + k]!.tool_call_id!)).toBe(true);
      }
    }
  });
});
