// ω99-213: #R — 回来摘要（auto-recap）receipts。先红后绿：红=新模块缺位
// （module not found，如实分类）。契约面：纯层（统计计数/请求形/净化/双阈
// 判据）+ op 半（失败降级 stats-only、querySource 记账区分主对话、零触发
// 零调用、只读旁路不写 history/state.messages）。
import { describe, it, expect } from "vitest";
import type { ModelClient, ModelInput } from "@wudao/core";
import { createScriptedModel } from "@wudao/core";
import {
  RECAP_QUERY_SOURCE,
  RECAP_MIN_AWAY_MS,
  RECAP_MIN_NEW_MESSAGES,
  buildRecapRequest,
  composeRecapStats,
  countNewMessages,
  recapDue,
  sanitizeRecap,
} from "../src/session-recap.js";
import type { HistoryEntry } from "../src/driver/agent-driver.js";
import { createAgentDriver } from "../src/driver/agent-driver.js";
import { summarizeToolCall } from "../src/log.js";

const wait = (ms = 10) => new Promise((r) => setTimeout(r, ms));

async function until(cond: () => boolean | Promise<boolean>, what: string, timeoutMs = 4000): Promise<void> {
  const start = Date.now();
  await wait();
  while (!(await cond())) {
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${what}`);
    await wait();
  }
}

const E = {
  user: (text: string): HistoryEntry => ({ kind: "user", text }),
  assistant: (text: string): HistoryEntry => ({ kind: "assistant", text }),
  tool: (name: string, file?: string): HistoryEntry =>
    file === undefined
      ? { kind: "tool", name, summary: "ok" }
      : { kind: "tool", name, summary: "ok", file: { path: file, name: "x", bytes: 8 } },
  edit: (path: string): HistoryEntry => ({ kind: "edit", path, oldString: "a", newString: "b" }),
  board: (): HistoryEntry => ({ kind: "board", done: 1, total: 2, lines: ["a", "b"] }),
  notice: (text: string): HistoryEntry => ({ kind: "notice", text }),
};

describe("composeRecapStats（结构化计数，模型不参与）ω99-213", () => {
  it("counts turns / toolCalls / filesTouched from the history slice — duplicates deduped, notices free", () => {
    const slice = [
      E.user("跑测试"),
      E.assistant("开始"),
      E.tool("read_file"),
      E.edit("src/a.ts"),
      E.edit("src/a.ts"),
      E.tool("make_xlsx", "out/x.xlsx"),
      E.board(),
      E.notice("（收据行）"),
      E.assistant("完成"),
    ];
    expect(composeRecapStats(slice)).toEqual({ turns: 1, toolCalls: 5, filesTouched: 2 });
  });

  it("countNewMessages counts only conversational entries (user ∪ assistant)", () => {
    expect(countNewMessages(slice3())).toBe(3);
    expect(countNewMessages([E.tool("read_file"), E.notice("x")])).toBe(0);
  });
});

const slice3 = (): HistoryEntry[] => [E.user("u"), E.assistant("a1"), E.assistant("a2")];

describe("buildRecapRequest（独立 system prompt + 切片边界）ω99-213", () => {
  it("builds from the slice AFTER the mark — first line contract, both ends present, pre-mark entries absent", () => {
    // The caller hands the OP the post-mark slice (history.slice(mark)) —
    // buildRecapRequest must read exactly that, never reach further back.
    const all = [
      E.user("离开前的旧消息"),
      E.assistant("旧回答"),
      E.user("夜间任务"),
      E.tool("read_file"),
      E.assistant("夜间结论"),
    ];
    const slice = all.slice(2);
    const req = buildRecapRequest(slice);
    expect(req).toBeDefined();
    expect(req!.systemPrompt.split("\n")[0]).toBe("You summarize what happened in a chat session while the user was away. Reply with ONLY the recap:");
    expect(req!.systemPrompt).toContain("完成了：");
    expect(req!.systemPrompt).toContain("还在进行：");
    expect(req!.systemPrompt).toContain("等你决定：");
    expect(req!.user).toContain("夜间任务");
    expect(req!.user).toContain("夜间结论");
    expect(req!.user).not.toContain("离开前的旧消息");
  });

  it("no assistant entry in the slice → undefined (nothing happened to recap)", () => {
    expect(buildRecapRequest([E.user("q")])).toBeUndefined();
  });

  it("caps excerpts so the call stays tiny", () => {
    const big = "x".repeat(20_000);
    const req = buildRecapRequest([E.user(big), E.assistant(big)])!;
    expect(req.user.length).toBeLessThan(4_000);
  });
});

describe("sanitizeRecap（叙事合同：帽/控制字符/三段标签）ω99-213", () => {
  const good = "完成了：跑通了全部测试\n还在进行：文档还没写\n等你决定：是否发版";
  it("keeps a well-formed three-label recap intact", () => {
    expect(sanitizeRecap(good)).toBe(good);
  });
  it("strips junk lines before the first label", () => {
    expect(sanitizeRecap(`好的，以下是摘要：\n${good}`)).toBe(good);
  });
  it("over the 400-code-point cap → undefined (honest degradation, no mangled half-recap)", () => {
    const long = `完成了：${"很".repeat(500)}\n还在进行：x\n等你决定：y`;
    expect(sanitizeRecap(long)).toBeUndefined();
  });
  it("control characters → undefined (\\n exempt)", () => {
    expect(sanitizeRecap(`完成了：a\x07b\n还在进行：c\n等你决定：d`)).toBeUndefined();
    expect(sanitizeRecap(`完成了：a\rb\n还在进行：c\n等你决定：d`)).toBeUndefined();
  });
  it("empty / whitespace-only → undefined", () => {
    expect(sanitizeRecap("")).toBeUndefined();
    expect(sanitizeRecap("  \n  ")).toBeUndefined();
  });
  it("missing any of the three labels → undefined (the card is three-segment by contract)", () => {
    expect(sanitizeRecap("完成了：a\n还在进行：b")).toBeUndefined();
    expect(sanitizeRecap("完成了：a\n等你决定：c")).toBeUndefined();
  });
});

describe("recapDue（双阈纯判据：≥10 分钟 且 ≥3 条新消息）ω99-213", () => {
  it("both met → true; either below → false (zero action zero calls)", () => {
    expect(RECAP_MIN_AWAY_MS).toBe(10 * 60_000);
    expect(RECAP_MIN_NEW_MESSAGES).toBe(3);
    expect(recapDue(RECAP_MIN_AWAY_MS, 3)).toBe(true);
    expect(recapDue(RECAP_MIN_AWAY_MS - 1, 99)).toBe(false);
    expect(recapDue(RECAP_MIN_AWAY_MS * 24, 2)).toBe(false);
  });
});

/** Records every generate() input; the recap-tagged lane FAILS (no key / no
 * answer) — the honest-degradation fixture. Main-lane answers are scripted. */
function recapFailModel(): ModelClient & { inputs: ModelInput[] } {
  const inputs: ModelInput[] = [];
  const scripted = createScriptedModel([{ role: "assistant", content: "主对话回答。" }]);
  return {
    get inputs() {
      return inputs;
    },
    async generate(input: ModelInput) {
      inputs.push({ ...input, messages: input.messages.map((m) => ({ ...m })) });
      if (input.querySource === RECAP_QUERY_SOURCE) throw new Error("no key");
      return scripted.generate(input);
    },
  };
}

describe("driver recap op 半（降级/记账/零触发/只读旁路）ω99-213", () => {
  it("model failure → stats-only payload; the recap call is a distinct background lane", async () => {
    const model = recapFailModel();
    const driver = createAgentDriver({ model, tools: [], systemPrompt: "S", summarize: summarizeToolCall });
    driver.loadHistory(
      [
        { role: "user", content: "u1" },
        { role: "assistant", content: "a1" },
      ],
      "sess-213",
    );
    const mark = driver.getHistory().length; // divider + 2 = 3
    const notices = (): number => driver.getHistory().filter((e) => e.kind === "notice").length;
    // Two real main-lane runs grow the away window: each lands user + assistant
    // + 收据 notice → 4 new conversational messages since the mark (≥ 3).
    driver.submit("夜间任务");
    await until(() => notices() >= 1, "run 1 settle");
    driver.submit("再跑一轮");
    await until(() => notices() >= 2, "run 2 settle");
    const mainInputs = model.inputs.filter((i) => i.querySource === undefined);
    expect(mainInputs.length).toBeGreaterThanOrEqual(1);
    const historyBefore = driver.getHistory().length;
    const messagesBefore = driver.state.messages.length;
    const payload = await driver.recap("sess-213", mark, 1_700_000_000_000);
    expect(payload).toEqual({
      stats: { turns: 2, toolCalls: 0, filesTouched: 0, sinceTs: 1_700_000_000_000 },
    });
    expect("narrative" in (payload ?? {})).toBe(false);
    // Exactly one recap-tagged call; it is NOT the main conversation's shape.
    const recapInputs = model.inputs.filter((i) => i.querySource === RECAP_QUERY_SOURCE);
    expect(recapInputs.length).toBe(1);
    expect(recapInputs[0]!.tools).toEqual([]);
    expect(recapInputs[0]!.systemPrompt).not.toBe("S");
    // Read-only bypass: nothing landed in history or state.messages.
    expect(driver.getHistory().length).toBe(historyBefore);
    expect(driver.state.messages.length).toBe(messagesBefore);
    driver.dispose();
  });

  it("wrong session / below-threshold / no-assistant slice → undefined with ZERO model calls", async () => {
    const model = recapFailModel();
    const driver = createAgentDriver({ model, tools: [], systemPrompt: "S", summarize: summarizeToolCall });
    driver.loadHistory(
      [
        { role: "user", content: "u1" },
        { role: "assistant", content: "a1" },
        { role: "user", content: "u2" },
        { role: "assistant", content: "a2" },
      ],
      "sess-213",
    );
    const calls0 = model.inputs.length;
    expect(await driver.recap("other-session", 1)).toBeUndefined(); // 会话不符
    expect(await driver.recap("sess-213", driver.getHistory().length)).toBeUndefined(); // 新消息 0 < 3
    expect(model.inputs.length).toBe(calls0); // 零模型调用
    driver.dispose();
  });
});
