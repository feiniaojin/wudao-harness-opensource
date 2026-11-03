// ω99-286: #7 — 断点续跑（durable runs L1）的 cli 层测试：
//  1) isUnfinishedTail 派生判据——三类中断尾全真（尾=user / 尾=孤儿
//     tool_use / 尾=tool_result），settled assistant 文本尾假，graceful
//     abort 两形（committed partial interrupted:true + 合成 "(interrupted)"）
//     真，空会话假；
//  2) continueSession 快乐径——未完成会话（尾=tool_result）→ scripted 模型
//     一轮收尾 → started:true，JSONL 落 settle（新 assistant 持久），行
//     unfinished 翻 false；
//  3) 拒答三形——id 不存在 / 已完成会话（零模型调用亲证）/ side- 前缀；
//  4) 无新用户消息亲证——续跑轮的 ModelInput 不含新增 user 行，历史尾原样。
// 夹具全在 mkdtemp(os.tmpdir())，rm 清理，零触碰 ~/.wudao-desktop。
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJsonlSessionStore, createScriptedModel, type AgentMessage, type AssistantMessage, type ModelClient, type ModelInput } from "@wudao-org/core";
import { summarizeToolCall } from "../src/log.js";
import { collectSessionRows, isUnfinishedTail } from "../src/session-list.js";
import { selectMessagesToPersist } from "../src/persist.js";
import { createAgentDriver } from "../src/driver/agent-driver.js";
import type { AgentDriver } from "../src/driver/agent-driver.js";

const wait = (ms = 10) => new Promise((r) => setTimeout(r, ms));

async function until(cond: () => boolean | Promise<boolean>, what: string, timeoutMs = 4000): Promise<void> {
  const start = Date.now();
  await wait();
  while (!(await cond())) {
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${what}`);
    await wait();
  }
}

const user = (content: string): AgentMessage => ({ role: "user", content });
const settled = (content: string): AgentMessage => ({ role: "assistant", content });

describe("ω99-286 — isUnfinishedTail 派生判据（日志形状的纯函数）", () => {
  it("尾=user（首模型调用前死）→ true", () => {
    expect(isUnfinishedTail([user("派个活"), settled("好")])).toBe(false); // 对照组
    expect(isUnfinishedTail([settled("先做了点"), user("继续把这些也做了")])).toBe(true);
  });

  it("尾=孤儿 tool_use（工具执行中死，装载时修补为 UNKNOWN）→ true", () => {
    const tail: AgentMessage = {
      role: "assistant",
      content: "",
      toolCalls: [{ id: "call-1", name: "shell", arguments: { command: "cargo test" } }],
    };
    expect(isUnfinishedTail([user("跑测试"), tail])).toBe(true);
  });

  it("尾=tool_result 无后续 settled assistant（工具完成后、settle 前死）→ true", () => {
    const messages: AgentMessage[] = [
      user("跑测试"),
      { role: "assistant", content: "", toolCalls: [{ id: "call-1", name: "shell", arguments: { command: "cargo test" } }] },
      { role: "tool", toolCallId: "call-1", name: "shell", content: "test result: ok" },
    ];
    expect(isUnfinishedTail(messages)).toBe(true);
  });

  it("尾=settled assistant 文本 → false；空会话 → false", () => {
    expect(isUnfinishedTail([user("跑测试"), settled("测试全过")])).toBe(false);
    expect(isUnfinishedTail([])).toBe(false);
  });

  it("graceful abort 两形（committed partial interrupted:true / 合成 \"(interrupted)\"）→ true", () => {
    // 夜移 001：中断流的已交付前缀带 interrupted:true 落盘。
    expect(isUnfinishedTail([user("跑测试"), { role: "assistant", content: "跑到一半", interrupted: true }])).toBe(true);
    // M12 起：工具相中断的合成 "(interrupted)"（driver 落盘字面）。
    expect(isUnfinishedTail([user("跑测试"), settled("(interrupted)")])).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 夹具：tmpdir 工作区 + 种子 JSONL + session-engine 同款最小持久化臂。
// ---------------------------------------------------------------------------

/** <root>/.wudao/sessions/<id>.jsonl —— 每行一条 JSON 消息。 */
function seedSessionLines(root: string, id: string, messages: readonly AgentMessage[]): void {
  mkdirSync(join(root, ".wudao", "sessions"), { recursive: true });
  writeFileSync(
    join(root, ".wudao", "sessions", `${id}.jsonl`),
    messages.map((m) => JSON.stringify(m)).join("\n") + "\n",
    "utf8",
  );
}

const UNFINISHED_TAIL: readonly AgentMessage[] = [
  { role: "user", content: "把测试修绿", uuid: "u1" },
  { role: "assistant", content: "", toolCalls: [{ id: "call-1", name: "shell", arguments: { command: "cargo test" } }], uuid: "a1" },
  { role: "tool", toolCallId: "call-1", name: "shell", content: "test result: FAILED", uuid: "t1" },
];

interface Harness {
  readonly driver: AgentDriver;
  readonly root: string;
  /** 续跑轮实际收到的 ModelInput（字节级亲证面）。 */
  readonly inputs: ModelInput[];
  /** scripted 模型的真实调用计数（零调用亲证面）。 */
  readonly calls: () => number;
  /** 最近一次 run 的收尾持久落盘（JSONL 断言前 await——run 回执先于盘）。 */
  readonly flush: () => Promise<void>;
}

/** driver + session-engine 同款最小持久化臂（onUserTurn/onBeforeToolDispatch/
 * onRunComplete/onHistoryReplaced——loadedRef 恒等基）。 */
function makeHarness(root: string, responses: readonly AssistantMessage[]): Harness {
  const store = createJsonlSessionStore(join(root, ".wudao", "sessions"));
  const loadedRef: AgentMessage[] = [];
  const inputs: ModelInput[] = [];
  const scripted = createScriptedModel(responses);
  let earlyUserPersist: Promise<void> = Promise.resolve();
  // 先声明后建（闭包体调用时 driver 已定——TDZ 无虞）。
  let driverRef: AgentDriver;
  let lastSettle: Promise<void> = Promise.resolve();
  const model: ModelClient = {
    async generate(input: ModelInput) {
      // 128-2：prewarm 探针（resume 暖前缀请求）不计量——不消耗脚本也不进断言口径的 inputs。
      if (input.querySource === "prewarm") return { role: "assistant", content: "" };
      inputs.push(input);
      return scripted.generate(input);
    },
  };
  const persistTail = async (messages: readonly AgentMessage[]): Promise<void> => {
    await earlyUserPersist;
    const sid = driverRef.getSessionId();
    for (const m of selectMessagesToPersist(messages, loadedRef)) {
      await store.append(sid, m);
      loadedRef.push(m);
    }
  };
  driverRef = createAgentDriver({
    model,
    tools: [],
    systemPrompt: "s",
    summarize: summarizeToolCall,
    workspaceRoot: root,
    onUserTurn: (m) => {
      loadedRef.push(m);
      earlyUserPersist = store.append(driverRef.getSessionId(), m).catch(() => {
        const i = loadedRef.indexOf(m);
        if (i >= 0) loadedRef.splice(i, 1);
      });
    },
    onBeforeToolDispatch: persistTail,
    onRunComplete: (messages) => {
      lastSettle = persistTail(messages);
      lastSettle.catch(() => {});
    },
    onHistoryReplaced: (messages) => {
      loadedRef.length = 0;
      loadedRef.push(...messages);
    },
  });
  return { driver: driverRef, root, inputs, calls: () => scripted.calls, flush: () => lastSettle };
}

describe("ω99-286 — continueSession 快乐径与拒答", () => {
  it("未完成会话（尾=tool_result）→ 一轮收尾：started:true · JSONL 落 settle · 行 unfinished 翻 false", async () => {
    const root = mkdtempSync(join(tmpdir(), "wudao-o286-happy-"));
    try {
      seedSessionLines(root, "o286happy", UNFINISHED_TAIL);
      const h = makeHarness(root, [{ role: "assistant", content: "测试已修绿", uuid: "a2" }]);
      await wait();
      const verdict = await h.driver.continueSession("o286happy");
      expect(verdict).toEqual({ started: true });
      await until(
        () => h.driver.getStatus().busy === false && h.driver.getHistory().some((e) => e.kind === "assistant" && e.text === "测试已修绿"),
        "continue run to settle",
      );
      await h.flush(); // run 回执先于盘——收尾持久落定后再断言 JSONL
      // JSONL 落 settle：尾部多出收尾 assistant（append-only，前缀原样）。
      const entries = await createJsonlSessionStore(join(root, ".wudao", "sessions")).loadSessionEntries("o286happy");
      const messages = entries.filter((e): e is AgentMessage => "role" in e);
      expect(messages.at(-1)).toMatchObject({ role: "assistant", content: "测试已修绿" });
      expect(messages.length).toBe(4); // 原 3 条 + 收尾 1 条——无新增 user 行
      // 行派生位翻 false（settled 尾）。
      const rows = await collectSessionRows(join(root, ".wudao", "sessions"));
      expect(rows.find((r) => r.id === "o286happy")?.unfinished).toBe(false);
      h.driver.dispose();
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("无新用户消息亲证：续跑轮 ModelInput 不含新增 user 行，历史尾原样", async () => {
    const root = mkdtempSync(join(tmpdir(), "wudao-o286-bytes-"));
    try {
      seedSessionLines(root, "o286bytes", UNFINISHED_TAIL);
      const h = makeHarness(root, [{ role: "assistant", content: "收尾", uuid: "a2" }]);
      await wait();
      await h.driver.continueSession("o286bytes");
      await until(() => h.driver.getStatus().busy === false && h.inputs.length === 1, "one model call");
      const input = h.inputs[0]!;
      // 用户行只有种子那条——续跑不 append 任何 user 消息。
      const userRows = input.messages.filter((m) => m.role === "user");
      expect(userRows.length).toBe(1);
      expect(userRows[0]).toMatchObject({ role: "user", content: "把测试修绿" });
      // 历史尾原样（前缀字节稳定）：最后一条就是种子 tool_result 本体——
      // 夜移 003 的 current-time grounding 是每个 run 首调的既有投影（纯
      // 追加在 tool 尾部，盘上历史零变），不是续跑注入的新消息；种子内容
      // 是其字节前缀。
      const seedTail = UNFINISHED_TAIL.at(-1)!;
      const inputTail = input.messages.at(-1)!;
      expect(input.messages.length).toBe(3);
      expect(inputTail.role).toBe("tool");
      expect(inputTail.toolCallId).toBe(seedTail.toolCallId);
      expect(inputTail.name).toBe(seedTail.name);
      expect(inputTail.content.startsWith(seedTail.content)).toBe(true);
      h.driver.dispose();
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("拒答：id 不存在 → started:false（零模型调用）", async () => {
    const root = mkdtempSync(join(tmpdir(), "wudao-o286-nf-"));
    try {
      mkdirSync(join(root, ".wudao", "sessions"), { recursive: true });
      const h = makeHarness(root, [{ role: "assistant", content: "不该被调" }]);
      await wait();
      expect(await h.driver.continueSession("no-such-session")).toEqual({ started: false, refused: "not_found" }); // 127 项 3（F2）：拒答成因随加性字段披露
      expect(h.calls()).toBe(0);
      h.driver.dispose();
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("拒答：已完成会话（settled 尾）→ started:false，零模型调用亲证", async () => {
    const root = mkdtempSync(join(tmpdir(), "wudao-o286-done-"));
    try {
      seedSessionLines(root, "o286done", [user("跑测试"), settled("测试全过")]);
      const h = makeHarness(root, [{ role: "assistant", content: "不该被调" }]);
      await wait();
      expect(await h.driver.continueSession("o286done")).toEqual({ started: false, refused: "settled" }); // 127 项 3（F2）
      expect(h.calls()).toBe(0); // 不空转——settled 尾一发模型调用都不花
      h.driver.dispose();
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("拒答：side- 前缀 → started:false（副链绝不当作主会话采纳，文件在场也拒）", async () => {
    const root = mkdtempSync(join(tmpdir(), "wudao-o286-side-"));
    try {
      seedSessionLines(root, "side-o286child", [user("子代理任务"), settled("子代理答案")]);
      const h = makeHarness(root, [{ role: "assistant", content: "不该被调" }]);
      await wait();
      expect(await h.driver.continueSession("side-o286child")).toEqual({ started: false, refused: "shape" }); // 127 项 3（F2）
      expect(h.calls()).toBe(0);
      expect(h.driver.getSessionId()).not.toBe("side-o286child"); // 未被采纳
      h.driver.dispose();
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
});

describe("ω99-286 — collectSessionRows 的行派生位", () => {
  it("未完成种子 → unfinished:true；settled 种子 → false（同一趟读，零额外 IO 面）", async () => {
    const root = mkdtempSync(join(tmpdir(), "wudao-o286-rows-"));
    try {
      seedSessionLines(root, "o286-unfin", UNFINISHED_TAIL);
      seedSessionLines(root, "o286-settled", [user("跑测试"), settled("测试全过")]);
      const rows = await collectSessionRows(join(root, ".wudao", "sessions"));
      expect(rows.find((r) => r.id === "o286-unfin")?.unfinished).toBe(true);
      expect(rows.find((r) => r.id === "o286-settled")?.unfinished).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
});
