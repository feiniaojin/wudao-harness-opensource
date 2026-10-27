// M-Memory 弧第二半 — boot 召回注入的确定性钉：同记忆 → 同 systemPrompt 尾块
// （字节稳定）；注入只追加（前缀字节不动断言——前缀缓存不变量）；冻结幂等；
// 种子选择（首条真实用户消息）；禁用=零字节；refresh 的轮界换尾。
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage, AgentState } from "@wudao/core";
import { openMemoryStore } from "@wudao/core";
import {
  createLongtermMemoryRuntime,
  openLongtermMemoryStore,
  firstGenuineUserText,
  withFirstRunMemoryInjection,
  setLongtermMemoryRuntime,
} from "../src/longterm-memory.js";

let ws: string;
let globalHome: string;
let savedEnv: string | undefined;
beforeEach(async () => {
  ws = await mkdtemp(join(tmpdir(), "wudao-lts-boot-"));
  // 隔离全局设置读取（loadLayeredSettings 读 ~/.wudao——测试必须自持）。
  globalHome = await mkdtemp(join(tmpdir(), "wudao-lts-boot-global-"));
  savedEnv = process.env.WUDAO_GLOBAL_HOME;
  process.env.WUDAO_GLOBAL_HOME = globalHome;
});
afterEach(async () => {
  setLongtermMemoryRuntime(undefined);
  if (savedEnv === undefined) delete process.env.WUDAO_GLOBAL_HOME;
  else process.env.WUDAO_GLOBAL_HOME = savedEnv;
  await rm(ws, { recursive: true, force: true });
  await rm(globalHome, { recursive: true, force: true });
});

function user(text: string): AgentMessage {
  return { role: "user", content: text };
}

function stateWith(messages: readonly AgentMessage[], systemPrompt = "BASE PROMPT"): AgentState {
  return { systemPrompt, messages: [...messages], tools: [], status: "idle" };
}

describe("M-Memory boot 注入 — 字节稳定性", () => {
  it("同记忆 + 同种子 → 两个 runtime 的注入块逐字节相同（缓存不伤）", async () => {
    const seedStore = openLongtermMemoryStore(ws);
    await seedStore.save({ kind: "preference", text: "回复用中文", tags: ["语言"] });
    await seedStore.save({ kind: "fact", text: "构建命令是 pnpm build", tags: ["build"] });
    const rtA = await createLongtermMemoryRuntime({ workspaceRoot: ws });
    const stA = stateWith([user("帮我看看构建命令和语言偏好")]);
    rtA.injectAtFirstRun(stA);
    const rtB = await createLongtermMemoryRuntime({ workspaceRoot: ws });
    const stB = stateWith([user("帮我看看构建命令和语言偏好")]);
    rtB.injectAtFirstRun(stB);
    expect(rtB.block()).toBe(rtA.block());
    expect(rtB.block()).not.toBe("");
    // 块形：<long-term-memory> 包裹（core renderInjection 的 canonical 形）
    expect(rtA.block().startsWith("<long-term-memory>")).toBe(true);
    expect(rtA.block().endsWith("</long-term-memory>")).toBe(true);
  });

  it("前缀不变断言：注入只追加尾块，BASE 逐字节保留", async () => {
    const store = openLongtermMemoryStore(ws);
    await store.save({ kind: "fact", text: "测试事实：注入只追加" });
    const rt = await createLongtermMemoryRuntime({ workspaceRoot: ws });
    const base = "SYSTEM PREFIX (must never move)";
    const state = stateWith([user("注入只追加")], base);
    rt.injectAtFirstRun(state);
    expect(state.systemPrompt.startsWith(base)).toBe(true);
    expect(state.systemPrompt.length).toBe(base.length + "\n\n".length + rt.block().length);
    expect(rt.appendTo("X")).toBe(`X\n\n${rt.block()}`);
  });

  it("冻结幂等：第二次注入零操作（同会话字节稳定）；无命中冻结为空", async () => {
    const store = openLongtermMemoryStore(ws);
    await store.save({ kind: "fact", text: "量子纠缠与本题无关吗？其实有关：种子会命中它" });
    const rt = await createLongtermMemoryRuntime({ workspaceRoot: ws });
    const state = stateWith([user("量子纠缠")]);
    rt.injectAtFirstRun(state);
    const afterFirst = state.systemPrompt;
    rt.injectAtFirstRun(state); // 幂等
    expect(state.systemPrompt).toBe(afterFirst);
    // appendTo（rescan 位点）与 boot 位点字节一致
    expect(rt.appendTo("BASE")).toBe(`BASE\n\n${rt.block()}`);
  });

  it("种子选择：跳过 [合成] 与 / 命令，取首条真实用户消息", async () => {
    const store = openLongtermMemoryStore(ws);
    await store.save({ kind: "fact", text: "pnpm workspace 布局" });
    const msgs: readonly AgentMessage[] = [
      { role: "assistant", content: "earlier assistant turn" },
      user("[context rule] 附加上下文"),
      user("/memory list"),
      user("讲讲 pnpm workspace 布局"),
      user("后续第二条真实消息"),
    ];
    expect(firstGenuineUserText(msgs)).toBe("讲讲 pnpm workspace 布局");
    const rt = await createLongtermMemoryRuntime({ workspaceRoot: ws });
    const state = stateWith(msgs);
    rt.injectAtFirstRun(state);
    expect(rt.block()).toContain("pnpm workspace 布局");
  });

  it("无真实用户消息：不冻结、不注入（下轮重试）；后续到达时注入", async () => {
    const store = openLongtermMemoryStore(ws);
    await store.save({ kind: "fact", text: "晚到用户消息的事实" });
    const rt = await createLongtermMemoryRuntime({ workspaceRoot: ws });
    const state = stateWith([user("[synthetic] 自动续跑")]);
    rt.injectAtFirstRun(state);
    expect(state.systemPrompt).toBe("BASE PROMPT");
    state.messages.push(user("晚到用户消息"));
    rt.injectAtFirstRun(state);
    expect(state.systemPrompt).not.toBe("BASE PROMPT");
  });

  it("enabled:false → 零字节注入、零块、capture 零写入", async () => {
    const store = openLongtermMemoryStore(ws);
    await store.save({ kind: "fact", text: "关闭时不可见的事实" });
    const rt = await createLongtermMemoryRuntime({ workspaceRoot: ws, enabled: false });
    const state = stateWith([user("关闭时不可见的事实")]);
    rt.injectAtFirstRun(state);
    expect(state.systemPrompt).toBe("BASE PROMPT");
    expect(rt.block()).toBe("");
    expect(rt.appendTo("BASE")).toBe("BASE");
    await rt.captureAtSessionEnd({ sessionId: "s1", messages: [user("别再忘了跑测试再提交")] });
    expect(store.list()).toHaveLength(1); // 仅 boot 前的种子，无沉淀
  });

  it("withFirstRunMemoryInjection：driver hooks 包裹后 onRunStart 触发注入；原 onRunStart 仍执行", async () => {
    const store = openLongtermMemoryStore(ws);
    await store.save({ kind: "fact", text: "hooks 注入事实" });
    const rt = await createLongtermMemoryRuntime({ workspaceRoot: ws });
    const seen: string[] = [];
    const wrapped = withFirstRunMemoryInjection(
      { onRunStart: () => { seen.push("original"); } },
      rt,
    );
    const state = stateWith([user("hooks 注入事实")]);
    await wrapped.onRunStart?.(state);
    expect(seen).toEqual(["original"]);
    expect(state.systemPrompt).toContain("hooks 注入事实");
    // 包裹不吞其它 hook 面
    expect((wrapped as { onRunStop?: unknown }).onRunStop).toBeUndefined();
  });
});

describe("M-Memory refresh — 轮界换尾（显式缓存代价）", () => {
  it("换尾保前缀：旧块整体替换为新块，旧块之前的字节逐字不动", async () => {
    const store = openLongtermMemoryStore(ws);
    await store.save({ kind: "fact", text: "refresh 旧事实" });
    const rt = await createLongtermMemoryRuntime({ workspaceRoot: ws });
    const base = "REFRESH BASE";
    const state = stateWith([user("refresh 旧事实")], base);
    rt.injectAtFirstRun(state);
    const oldBlock = rt.block();
    expect(oldBlock).toContain("refresh 旧事实");
    const afterInject = state.systemPrompt;
    // 新增一条可命中记忆后 refresh（经 runtime 的句柄写——per-handle 索引）
    await rt.store.save({ kind: "lesson", text: "refresh 新教训：换尾保前缀" });
    const receipt = rt.refresh(state);
    expect(receipt).not.toBe("");
    expect(state.systemPrompt.startsWith(base)).toBe(true);
    expect(state.systemPrompt).toContain("refresh 新教训");
    expect(state.systemPrompt).not.toBe(afterInject);
    expect(rt.block()).not.toBe(oldBlock);
  });

  it("refresh(undefined)：同种子重算冻结块（新命中记忆进块），不动 prompt", async () => {
    const store = openLongtermMemoryStore(ws);
    await store.save({ kind: "fact", text: "refresh 主题事实甲" });
    const rt = await createLongtermMemoryRuntime({ workspaceRoot: ws });
    const state = stateWith([user("refresh 主题")]);
    rt.injectAtFirstRun(state);
    expect(rt.block()).toContain("事实甲");
    const afterInject = state.systemPrompt;
    await rt.store.save({ kind: "fact", text: "refresh 主题事实乙" });
    rt.refresh(undefined);
    expect(rt.block()).toContain("事实乙"); // 重算纳入新记忆（同种子）
    expect(state.systemPrompt).toBe(afterInject); // 无 state → 不动 prompt
  });
});
