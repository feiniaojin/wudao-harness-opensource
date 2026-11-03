// ω99-289: #5 — 失败尾一键重试（286 C① 收口）的 cli 层测试：
//  1) isErrorTail 派生判据——错误尾（合成 "(error: …)" assistant）真；
//     interrupted 两形 / settled 文本尾 / 带 toolCalls / user 尾 / 空会话假；
//  2) 行派生 errored——错误尾种子 true、settled 种子 false、与 unfinished
//     互斥（同一趟读，零额外 IO 面）；
//  3) continueSession 错误臂——先全门后变异：
//     a) 工具轮后失败（前驱 tool_result）→ started:true，pop 后从失败点
//        续跑（零新增 user 行），重试轮首条新消息 parentUuid 链失败点前驱，
//        JSONL 旧条目原样在盘（append-only 一字不动）；
//     b) settled 前驱（构造上不可达的防御形状）→ started:false 且零模型
//        调用、零 history 重建（↪ 已恢复 notice 原样在）、盘上零新增行；
//     c) 连续两次失败重试 → 每次重链同一前驱，旧错误支孤儿在树，重启后
//        resume 走最新链（旧 "(error:" 不在读回对话里，跑成的工作在）。
// 夹具全在 mkdtemp(os.tmpdir())，rm 清理，零触碰 ~/.wudao-desktop。
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJsonlSessionStore, createScriptedModel, type AgentMessage, type AssistantMessage, type ModelClient, type ModelInput } from "@wudao-org/core";
import { summarizeToolCall } from "../src/log.js";
import { collectSessionRows, isErrorTail, isUnfinishedTail } from "../src/session-list.js";
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

describe("ω99-289 — isErrorTail 派生判据（日志形状的纯函数）", () => {
  it("错误尾（合成 \"(error: …)\" assistant、无 toolCalls）→ true", () => {
    expect(isErrorTail([user("把测试修绿"), settled("(error: Connection reset)")])).toBe(true);
    expect(isErrorTail([user("派个活"), settled("(error: 401 unauthorized)")])).toBe(true);
  });

  it("interrupted 两形（interrupted:true partial / \"(interrupted)\" 哨兵）→ false（286 的领地，不收编）", () => {
    expect(isErrorTail([user("跑测试"), { role: "assistant", content: "跑到一半", interrupted: true }])).toBe(false);
    expect(isErrorTail([user("跑测试"), settled("(interrupted)")])).toBe(false);
  });

  it("settled 文本尾 / 带 toolCalls 的 \"(error: …)\" 形 / user 尾 / 空会话 → false", () => {
    expect(isErrorTail([user("跑测试"), settled("测试全过")])).toBe(false);
    // 孤儿 tool_use 形（中断领地）：即便 content 碰巧以 (error: 起也不收。
    expect(
      isErrorTail([
        user("跑测试"),
        { role: "assistant", content: "(error: boom)", toolCalls: [{ id: "call-1", name: "shell", arguments: { command: "cargo test" } }] },
      ]),
    ).toBe(false);
    expect(isErrorTail([user("派个活")])).toBe(false);
    expect(isErrorTail([])).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 夹具：tmpdir 工作区 + 种子 JSONL + session-engine 同款最小持久化臂。
// ---------------------------------------------------------------------------

/** <root>/.wudao/sessions/<id>.jsonl —— 每行一条 JSON 消息（286 件同款）。 */
function seedSessionLines(root: string, id: string, messages: readonly AgentMessage[]): string {
  mkdirSync(join(root, ".wudao", "sessions"), { recursive: true });
  const path = join(root, ".wudao", "sessions", `${id}.jsonl`);
  writeFileSync(path, messages.map((m) => JSON.stringify(m)).join("\n") + "\n", "utf8");
  return path;
}

/** 工具轮后失败的真实形状：user → assistant(tool_use) → tool_result → 合成错误尾。 */
const TOOL_ROUND_FAILURE: readonly AgentMessage[] = [
  { role: "user", content: "把测试修绿", uuid: "u1" },
  { role: "assistant", content: "", toolCalls: [{ id: "call-1", name: "shell", arguments: { command: "cargo test" } }], uuid: "a1" },
  { role: "tool", toolCallId: "call-1", name: "shell", content: "test result: FAILED", uuid: "t1" },
  { role: "assistant", content: "(error: Connection reset)", uuid: "e1" },
];

/** 首腿失败的真实形状：user → 合成错误尾。 */
const FIRST_LEG_FAILURE: readonly AgentMessage[] = [
  { role: "user", content: "派个活", uuid: "u1" },
  { role: "assistant", content: "(error: 401 unauthorized)", uuid: "e1" },
];

interface Harness {
  readonly driver: AgentDriver;
  readonly root: string;
  /** 重试轮实际收到的 ModelInput（字节级亲证面）。 */
  readonly inputs: ModelInput[];
  /** scripted 模型的真实调用计数（零调用亲证面）。 */
  readonly calls: () => number;
  /** 最近一次 run 的收尾持久落盘（JSONL 断言前 await——run 回执先于盘）。 */
  readonly flush: () => Promise<void>;
}

/** driver + session-engine 同款最小持久化臂（286 件同款；model 可注入
 *  「先败后成」序列钉连续失败重试）。 */
function makeHarness(root: string, responses: readonly AssistantMessage[], modelOverride?: ModelClient): Harness {
  const store = createJsonlSessionStore(join(root, ".wudao", "sessions"));
  const loadedRef: AgentMessage[] = [];
  const inputs: ModelInput[] = [];
  const scripted = createScriptedModel(responses);
  let earlyUserPersist: Promise<void> = Promise.resolve();
  let driverRef: AgentDriver;
  let lastSettle: Promise<void> = Promise.resolve();
  const model: ModelClient =
    modelOverride ?? {
      async generate(input: ModelInput) {
        // 128-2：prewarm 探针不进断言口径的 inputs（丢弃语义）。
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

const storeAt = (root: string) => createJsonlSessionStore(join(root, ".wudao", "sessions"));
const messagesOf = async (root: string, id: string): Promise<AgentMessage[]> =>
  (await storeAt(root).loadSessionEntries(id)).filter((e): e is AgentMessage => "role" in e);

describe("ω99-289 — collectSessionRows 的行派生位（errored）", () => {
  it("错误尾种子 → errored:true；settled 种子 → false；中断尾种子 → errored:false 且 unfinished:true（互斥）", async () => {
    const root = mkdtempSync(join(tmpdir(), "wudao-o289-rows-"));
    try {
      seedSessionLines(root, "o289-errtool", TOOL_ROUND_FAILURE);
      seedSessionLines(root, "o289-errfirst", FIRST_LEG_FAILURE);
      seedSessionLines(root, "o289-settled", [user("跑测试"), settled("测试全过")]);
      seedSessionLines(root, "o289-unfin", [user("跑测试"), settled("(interrupted)")]);
      const rows = await collectSessionRows(join(root, ".wudao", "sessions"));
      expect(rows.find((r) => r.id === "o289-errtool")).toMatchObject({ errored: true, unfinished: false });
      expect(rows.find((r) => r.id === "o289-errfirst")).toMatchObject({ errored: true, unfinished: false });
      expect(rows.find((r) => r.id === "o289-settled")).toMatchObject({ errored: false, unfinished: false });
      expect(rows.find((r) => r.id === "o289-unfin")).toMatchObject({ errored: false, unfinished: true });
      // 互斥是构造保证：任何行不同时挂两位。
      for (const r of rows) expect(r.unfinished && r.errored).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
});

describe("ω99-289 — continueSession 错误臂（先全门后变异）", () => {
  it("工具轮后失败 → started:true：pop 后从失败点续跑，重试轮首条新消息 parentUuid 链前驱，JSONL 旧条目原样在盘", async () => {
    const root = mkdtempSync(join(tmpdir(), "wudao-o289-happy-"));
    try {
      const path = seedSessionLines(root, "o289happy", TOOL_ROUND_FAILURE);
      const h = makeHarness(root, [{ role: "assistant", content: "重试成功，测试已修绿", uuid: "a2" }]);
      await wait();
      const verdict = await h.driver.continueSession("o289happy");
      expect(verdict).toEqual({ started: true });
      await until(
        () => h.driver.getStatus().busy === false && h.driver.getHistory().some((e) => e.kind === "assistant" && e.text === "重试成功，测试已修绿"),
        "retry run to settle",
      );
      await h.flush(); // run 回执先于盘——收尾持久落定后再断言 JSONL
      // ① append-only 一字不动：种子的 4 行逐字节原样在盘（前缀不变式）。
      const seedBytes = TOOL_ROUND_FAILURE.map((m) => JSON.stringify(m)).join("\n") + "\n";
      expect(readFileSync(path, "utf8").startsWith(seedBytes)).toBe(true);
      // ② 重试轮首条新消息 parentUuid 链失败点前驱（tool_result，nodeKey=uuid
      //    "t1"）——合成错误条目留在旧支（分支不是删除）。
      const messages = await messagesOf(root, "o289happy");
      expect(messages.length).toBe(5); // 原 4 条 + 重试 1 条——无新增 user 行
      const retryFirst = messages[4]!;
      expect(retryFirst).toMatchObject({ role: "assistant", content: "重试成功，测试已修绿" });
      expect(retryFirst.parentUuid).toBe("t1");
      // ③ 无新用户消息亲证：重试轮 ModelInput 不含新增 user 行。
      expect(h.inputs.length).toBe(1);
      expect(h.inputs[0]!.messages.filter((m) => m.role === "user").length).toBe(1);
      // ④ 行派生位翻 false（settled 尾——跑完了）。
      const rows = await collectSessionRows(join(root, ".wudao", "sessions"));
      expect(rows.find((r) => r.id === "o289happy")).toMatchObject({ errored: false, unfinished: false });
      h.driver.dispose();
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("settled 前驱（防御形状）→ started:false：零模型调用、零 history 重建（↪ 通知原样在）、盘上零新增行", async () => {
    const root = mkdtempSync(join(tmpdir(), "wudao-o289-def-"));
    try {
      const path = seedSessionLines(root, "o289def", [
        { role: "user", content: "派个活", uuid: "u1" },
        { role: "assistant", content: "做完了", uuid: "a1" },
        { role: "assistant", content: "(error: boom)", uuid: "e1" },
      ]);
      const before = readFileSync(path, "utf8");
      const h = makeHarness(root, [{ role: "assistant", content: "不该被调" }]);
      await wait();
      expect(await h.driver.continueSession("o289def")).toEqual({ started: false, refused: "settled" }); // 127 项 3（F2）：settled 前驱的防御形拒
      expect(h.calls()).toBe(0);
      await wait();
      // 零 history 重建：采纳时的 ↪ 已恢复 notice 原样在（重建会整面换掉它）。
      const notices = h.driver.getHistory().filter((e) => e.kind === "notice").map((e) => (e as { text: string }).text);
      expect(notices.some((t) => t.startsWith("↪ 已恢复"))).toBe(true);
      // 盘上零新增行：文件字节原样（append-only 之外连追加都没有）。
      expect(readFileSync(path, "utf8")).toBe(before);
      h.driver.dispose();
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("首腿失败（前驱 user 尾）→ started:true（错误臂两形都接）", async () => {
    const root = mkdtempSync(join(tmpdir(), "wudao-o289-first-"));
    try {
      seedSessionLines(root, "o289first", FIRST_LEG_FAILURE);
      const h = makeHarness(root, [{ role: "assistant", content: "重试成功", uuid: "a2" }]);
      await wait();
      expect(await h.driver.continueSession("o289first")).toEqual({ started: true });
      await until(() => h.driver.getStatus().busy === false && h.inputs.length === 1, "first-leg retry settle");
      await h.flush();
      const messages = await messagesOf(root, "o289first");
      expect(messages.length).toBe(3); // user + 旧错误 + 重试 assistant
      expect(messages[2]!.parentUuid).toBe("u1");
      h.driver.dispose();
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("连续两次失败重试 → 每次重链同一前驱，旧错误支孤儿在树，重启 resume 走最新链", async () => {
    const root = mkdtempSync(join(tmpdir(), "wudao-o289-cc-"));
    try {
      seedSessionLines(root, "o289cc", TOOL_ROUND_FAILURE);
      // 先败后成：第 1 次重试也失败（连接中断），第 2 次成功。
      const scripted = createScriptedModel([{ role: "assistant", content: "第二次重试成功，跑成的工作都在", uuid: "a3" }]);
      let failFirst = true;
      const model: ModelClient = {
        async generate(input: ModelInput) {
          // 128-2：prewarm 探针不消耗 failFirst 也不进脚本（丢弃语义）。
          if (input.querySource === "prewarm") return { role: "assistant", content: "" };
          if (failFirst) {
            failFirst = false;
            throw new Error("连接中断");
          }
          return scripted.generate(input);
        },
      };
      const h = makeHarness(root, [], model);
      await wait();
      // 重试 #1：跑→又败（新的合成错误尾 e2，parentUuid 链 t1）。
      expect(await h.driver.continueSession("o289cc")).toEqual({ started: true });
      await until(() => h.driver.getStatus().busy === false, "failed retry #1 settles");
      await h.flush();
      let messages = await messagesOf(root, "o289cc");
      expect(messages.length).toBe(5);
      expect(messages[4]).toMatchObject({ role: "assistant" });
      expect(String(messages[4]!.content).startsWith("(error: ")).toBe(true);
      expect(messages[4]!.parentUuid).toBe("t1"); // 又一败也链同一前驱
      // 重试 #2：从 e2 的失败点（t1）再续，成功。
      expect(await h.driver.continueSession("o289cc")).toEqual({ started: true });
      await until(
        () => h.driver.getStatus().busy === false && h.driver.getHistory().some((e) => e.kind === "assistant" && e.text === "第二次重试成功，跑成的工作都在"),
        "retry #2 settles",
      );
      await h.flush();
      messages = await messagesOf(root, "o289cc");
      expect(messages.length).toBe(6); // …err1, err2, a3 —— 全在盘（一字未删）
      expect(messages[5]).toMatchObject({ role: "assistant", content: "第二次重试成功，跑成的工作都在" });
      expect(messages[5]!.parentUuid).toBe("t1");
      // 重启模拟：全新 driver resume 同一会话 → 走最新链：新答案在读回对话里，
      // 两条旧 "(error:" 都孤儿在树（不在读回对话里）。
      const h2 = makeHarness(root, []);
      await wait();
      expect(await h2.driver.resume("o289cc")).toEqual({ ok: true });
      const texts = h2.driver.getHistory().map((e) => (("text" in e ? e.text : "") as string));
      expect(texts.some((t) => t === "第二次重试成功，跑成的工作都在")).toBe(true);
      expect(texts.some((t) => t.startsWith("(error: "))).toBe(false);
      // 判据侧一致：最新链 settled → 两个恢复位都归 false。
      const rows = await collectSessionRows(join(root, ".wudao", "sessions"));
      expect(rows.find((r) => r.id === "o289cc")).toMatchObject({ errored: false, unfinished: false });
      h.driver.dispose();
      h2.driver.dispose();
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
});

describe("ω99-289 — isUnfinishedTail 与 isErrorTail 的边界分工（286 判据零动）", () => {
  it("错误尾在 286 判据下仍读 settled（isUnfinishedTail 零动），姊妹判据接手失败面", () => {
    const errTail = [user("派个活"), settled("(error: boom)")] as const;
    expect(isUnfinishedTail(errTail)).toBe(false); // 286 文档边界原样
    expect(isErrorTail(errTail)).toBe(true);
  });
});
