// 128-3（codex 21eb55513d 引进）— per-chain 压缩所有权收据。
// 不变量（digest 验收原文）：主链/子链自身连续压缩 N 次后，sidechain 证据
// 条目数不变——盘上只有原始消息 + 边界条目，投影件（摘要/丢弃/修剪标记）
// 不落盘；resume 全量裸重放。
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSubagent } from "../src/subagent.js";
import { createJsonlSessionStore } from "../src/session/store.js";
import { buildTool, SUMMARY_MARKER, type ModelClient, type Tool, type SubagentType } from "../src/index.js";

/** A role that allows ONLY the evidence tool（角色的 toolNames 白名单——内建
 * coder 不认识自定义工具名，调用会以 unknown tool 落败进 failure_streak）。 */
const emitter: SubagentType = { name: "emitter", description: "emits evidence", systemPrompt: "s", toolNames: ["emit"] };

let dir = "";
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "arc128-own-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => {});
});

/** A tool whose result is a big string (inflates occupancy → compaction fires). */
const bigTool = (): Tool =>
  buildTool({
    name: "emit",
    description: "emit a big result",
    parameters: { type: "object", properties: { seq: { type: "number" } }, additionalProperties: false },
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    isDestructive: () => false,
    isOpenWorld: () => false,
    async execute(input: { seq?: number }) {
      const s = input.seq ?? 0;
      return { content: `EVIDENCE#${String(s)}: ` + `x`.repeat(600) }; // ~700B/次 不同序号——指纹不撞、占位够大
    },
  });

/** A model that calls `emit` N times then answers. 每轮的参数与叙述都不同
 * （循环安全车道管重复形状——那是它的案子；本弧要的是真实推进的转录）。 */
const toolingModel = (n: number): ModelClient => {
  let i = 0;
  return {
    async generate() {
      if (i < n) {
        i += 1;
        return { role: "assistant" as const, content: `查第 ${i} 项。`, toolCalls: [{ id: `c${i}`, name: "emit", arguments: { seq: i } }] };
      }
      return { role: "assistant" as const, content: "DONE" };
    },
  };
};

describe("128-3 — sidechain 压缩所有权", () => {
  it("子链中途 tier-2 压缩：盘上证据全量保留 + 恰一枚边界条目 + 零投影件", async () => {
    const store = createJsonlSessionStore(join(dir, "sessions"));
    const CALLS = 12; // 12×1KB 证据 + 3k 窗——中段恰过阈一次（防压缩风暴死亡螺旋）
    const answer = await runSubagent({
      model: toolingModel(CALLS),
      allTools: [bigTool()],
      subagentType: emitter,
      prompt: "emit a lot",
      session: { mode: "new", id: "ownchild1", store },
      loopOptions: {
        maxTurns: 40,
        // 小窗 + 零 LLM 摘要（static fallback——压缩不依赖模型配合）。
        compaction: { contextWindowTokens: 1_600, zeroLlmDigest: true },
      },
    });
    expect(answer).toContain("DONE");

    // 证据全量：每枚 emit 调用的 user/assistant/tool 消息都在盘上。
    const messages = await store.loadSidechain("ownchild1");
    const evidence = messages.filter((m) => m.role === "tool" && m.content.includes("EVIDENCE#"));

    expect(evidence.length).toBe(CALLS);

    // 零投影件：没有 SUMMARY_MARKER 行（主链 persist 律的镜像）。
    expect(messages.some((m) => m.role === "user" && m.content.startsWith(SUMMARY_MARKER))).toBe(false);

    // 恰≥1 枚边界条目（压缩确实发生过——证据侧证：边界在场）。
    const entries = await store.loadSidechainEntries("ownchild1");
    const boundaries = entries.filter((e) => !("role" in e) && (e as { type?: string }).type === "compact_boundary");
    expect(boundaries.length).toBeGreaterThanOrEqual(1);
    const b = boundaries[0] as { data?: { firstKeptEntryId?: string; reason?: string; tier?: number } };
    expect(b.data?.tier).toBe(2);
    expect(typeof b.data?.firstKeptEntryId).toBe("string");
  }, 20_000);

  it("压缩后 resume：priorMessages 全量裸重放（证据数不缩水）", async () => {
    const store = createJsonlSessionStore(join(dir, "sessions"));
    const CALLS = 12;
    await runSubagent({
      model: toolingModel(CALLS),
      allTools: [bigTool()],
      subagentType: emitter,
      prompt: "emit a lot",
      session: { mode: "new", id: "ownchild2", store },
      loopOptions: { maxTurns: 40, compaction: { contextWindowTokens: 1_600, zeroLlmDigest: true } },
    });
    const onDisk = (await store.loadSidechain("ownchild2")).length;

    let resumedCount = -1;
    await runSubagent({
      model: { async generate() { return { role: "assistant" as const, content: "OK2" }; } },
      allTools: [bigTool()],
      subagentType: emitter,
      prompt: "continue",
      session: { mode: "resume", id: "ownchild2", store },
      loopOptions: { maxTurns: 2 },
      onBeforeResume: ({ priorMessages }) => {
        resumedCount = priorMessages.length;
        return "[resume] go on";
      },
    });
    // 全量重放：resume 看到的与盘上消息数一致（压缩没有吃掉任何证据）。
    expect(resumedCount).toBe(onDisk);
    // 且没有 SUMMARY_MARKER 被当作普通消息重放（旧索引基把投影件落盘时会有）。
    const after = await store.loadSidechain("ownchild2");
    expect(after.some((m) => m.role === "user" && m.content.startsWith(SUMMARY_MARKER))).toBe(false);
  }, 20_000);

  it("fork 复制全转录到新链（copy 语义——源链不动）", async () => {
    const store = createJsonlSessionStore(join(dir, "sessions"));
    const CALLS = 4;
    await runSubagent({
      model: toolingModel(CALLS),
      allTools: [bigTool()],
      subagentType: emitter,
      prompt: "emit",
      session: { mode: "new", id: "ownsrc", store },
      loopOptions: { maxTurns: 10 },
    });
    const srcCount = (await store.loadSidechain("ownsrc")).length;
    await runSubagent({
      model: { async generate() { return { role: "assistant" as const, content: "FORKED" }; } },
      allTools: [bigTool()],
      subagentType: emitter,
      prompt: "fork off",
      session: { mode: "fork", id: "ownsrc", store },
      loopOptions: { maxTurns: 2 },
    });
    // fork 写到新链（fork-<uuid>）：源链消息数不变。
    expect((await store.loadSidechain("ownsrc")).length).toBe(srcCount);
    // 新链存在且含源转录（loadSidechainEntries 至少含 CALLS 枚 tool 证据）。
    const fs = await import("node:fs/promises");
    const files = (await fs.readdir(join(dir, "sessions"))).filter((f) => f.startsWith("side-fork-"));
    expect(files.length).toBe(1);
    const forkMsgs = await store.loadSidechain(files[0]!.replace(/^side-|\.jsonl$/g, ""));
    expect(forkMsgs.filter((m) => m.role === "tool").length).toBeGreaterThanOrEqual(CALLS);
  }, 20_000);
});
