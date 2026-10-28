// ω99-264: #1 — 记忆条目改写（driver memoryEdit）R 件，记忆两库收敛后钉新库：
// 改写 = 内容哈希 id 语义上的「新内容 = 新 id」——先存新（confidence 沿原态：
// confirmed 原态改后仍 confirmed〔用户点「改写」= 自己的授权链终点，不重走
// 人审门〕、pending 原态改后仍 pending〔改写不替用户审〕）再忘旧（tombstone）。
// content 字节等值 → 零写短路（vault 裸重放不得触库——新 id 不得凭空造出）；
// miss（id 无/无工作区）→ ok:false 同族文案；被拦改写（凭据值/指令注入形状）
// → 原条不动 + 拦截台账留痕。store 真值直证：改写=+1 行 entry +1 行 tombstone
// （append-only 法律，行数 +2）；tags 沿原条；useCount 归 1（新 id 的新生）。
// 全 mock（scripted model + stub 工具零真模型零网络零 spawn）；夹具只写
// mkdtemp(os.tmpdir()) 只写不删（零删除原语——memory.jsonl 是用户数据，测试
// 绝不触真实工作区 store）。
import { describe, it, expect } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildTool, createScriptedModel } from "@wudao/core";
import type { Tool } from "@wudao/core";
import { summarizeToolCall } from "../src/log.js";
import { createAgentDriver } from "../src/driver/agent-driver.js";
import { openLongtermMemoryStore } from "../src/longterm-memory.js";
import { readBlockedLearningAt } from "../src/memory/guard.js";
import { memoryStorePath } from "../src/memory/store.js";

function stubReadTool(): Tool {
  return buildTool({
    name: "read_file",
    description: "stub read",
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
      additionalProperties: false,
    },
    execute: async () => ({ content: "STUB FILE CONTENT" }),
  });
}

/** A quiet driver over a REAL temp workspace store (the 260 R1 shape) — the
 *  edit seam is a store read/decide path, never run state. */
function makeDriver(dir: string) {
  return createAgentDriver({
    model: createScriptedModel([{ role: "assistant", content: "ok" }]),
    tools: [stubReadTool()],
    systemPrompt: "s",
    summarize: summarizeToolCall,
    workspaceRoot: dir,
    sessionId: "o264",
  });
}

/** The new store's raw JSONL line count (the append-only ledger's truth — an
 *  edit = +1 entry line +1 tombstone line, never a rewrite). */
const lineCount = (dir: string): number =>
  readFileSync(join(dir, ".wudao", "memory", "memory.jsonl"), "utf8").split("\n").filter((l) => l.trim() !== "").length;
const rawText = (dir: string): string => readFileSync(join(dir, ".wudao", "memory", "memory.jsonl"), "utf8");

/** Seed（新库）: one CONFIRMED project fact + one PENDING preference. */
async function seedStore(dir: string): Promise<{ activeId: string; pendingId: string }> {
  const store = openLongtermMemoryStore(dir);
  const a = await store.save({ kind: "fact", text: "构建命令是 pnpm build", tags: ["build"] });
  const p = await store.save({ kind: "preference", text: "称呼我用「老板」", tags: ["tone"], confidence: "pending" });
  return { activeId: a.id, pendingId: p.id };
}

describe("ω99-264 R1 — memoryEdit()（改写 = 新 id 重存 + 旧 id tombstone，合流语义）", () => {
  it("R1a: confirmed 原态改写 → 新 id 仍 confirmed、content 落新值、旧 id 退场（tombstone）、回执「已改写一条记忆」；台账 +2 行（append 真值）", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wudao-o264-active-"));
    const { activeId } = await seedStore(dir);
    const driver = makeDriver(dir);
    const linesBefore = lineCount(dir);
    const r = await driver.memoryEdit(activeId, "构建命令是 pnpm -r build");
    expect(r).toEqual({ ok: true, message: "已改写一条记忆" });
    // per-handle 索引——真值走新句柄读盘
    const store = openLongtermMemoryStore(dir);
    const after = store.list({ includePending: true });
    const edited = after.find((e) => e.text === "构建命令是 pnpm -r build");
    expect(edited).toMatchObject({
      kind: "fact",
      confidence: "confirmed",
      tags: ["build"], // tags 沿原条（改写只换内容）
      useCount: 1, // 新 id 的新生——强度从此重新积累
    });
    expect(edited!.id).not.toBe(activeId); // 内容变=id 变（内容哈希语义）
    expect(after.some((e) => e.id === activeId)).toBe(false); // 旧 id 退场
    expect(store.list().some((e) => e.id === edited!.id)).toBe(true); // 参与回忆
    expect(lineCount(dir)).toBe(linesBefore + 2); // +1 entry +1 tombstone（append-only 法律）
    driver.dispose();
  });

  it("R1b: pending 原态改写 → 新 id 仍 pending（改写不替用户审）、待审队列自愈再现（新 id 未 surfaced）、回执「已改写一条记忆（仍待你确认）」", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wudao-o264-pending-"));
    const { pendingId } = await seedStore(dir);
    const driver = makeDriver(dir);
    const r = await driver.memoryEdit(pendingId, "称呼我用「您」");
    expect(r).toEqual({ ok: true, message: "已改写一条记忆（仍待你确认）" });
    const store = openLongtermMemoryStore(dir);
    const pending = store.listPending();
    expect(pending).toHaveLength(1);
    expect(pending[0]!.text).toBe("称呼我用「您」");
    expect(pending[0]!.confidence).toBe("pending");
    expect(pending[0]!.id).not.toBe(pendingId);
    // 待审自愈再现：新 id 不在 surfaced sidecar——下一次 boot 提醒会再浮出
    expect(store.list().some((e) => e.id === pending[0]!.id)).toBe(false); // 不参与回忆
    driver.dispose();
  });

  it("R1c: 重放收敛——真改写后旧 id 重放 3 次全 MISS（tombstone 后 id 失效=幂等收敛形）且文件字节零变；在条 id 的 content 等值短路 → ok 零写", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wudao-o264-short-"));
    const { activeId, pendingId } = await seedStore(dir);
    const driver = makeDriver(dir);
    // active 形：真改写一次
    await driver.memoryEdit(activeId, "构建命令是 pnpm -r build");
    const bytes = rawText(dir);
    const lines = lineCount(dir);
    // vault 中断重放的裸模拟：同 id 同 content 再来 3 次——旧 id 已 tombstone，
    // 重放=MISS（「可能已处理过」——与 memoryDecide 重放同律的幂等收敛形，
    // 绝不复活条目、绝不补写）
    const MISS = { ok: false, message: "没有这条记忆（可能已处理过）" };
    expect(await driver.memoryEdit(activeId, "构建命令是 pnpm -r build")).toEqual(MISS);
    expect(await driver.memoryEdit(activeId, "构建命令是 pnpm -r build")).toEqual(MISS);
    expect(await driver.memoryEdit(activeId, "构建命令是 pnpm -r build")).toEqual(MISS);
    expect(rawText(dir)).toBe(bytes); // 三次重放零写：文件字节零变
    expect(lineCount(dir)).toBe(lines);
    // 在条 id 的字节等值短路：未改过（content 仍原值）直接「改写」原值 → 零写 + pending 回执
    const p0 = await driver.memoryEdit(pendingId, "称呼我用「老板」");
    expect(p0).toEqual({ ok: true, message: "已改写一条记忆（仍待你确认）" });
    expect(rawText(dir)).toBe(bytes); // 依旧零写
    driver.dispose();
  });

  it("R1d: miss 三形——id 不存在 / 已删的 id / 无工作区 → ok:false「没有这条记忆（可能已处理过）」不抛；回执结构化（零 history notice 写入）；被拦改写原条不动 + 台账留痕", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wudao-o264-miss-"));
    const { activeId } = await seedStore(dir);
    const driver = makeDriver(dir);
    const miss = await driver.memoryEdit("m-nope", "任何内容");
    expect(miss).toEqual({ ok: false, message: "没有这条记忆（可能已处理过）" });
    // 已删除的 id 同形（改写 miss 不复活条目）
    await driver.memoryDecide(activeId, "del");
    const gone = await driver.memoryEdit(activeId, "改一个已删的");
    expect(gone).toEqual({ ok: false, message: "没有这条记忆（可能已处理过）" });
    // 被拦改写（凭据值形状）：原条不动、拦截台账留痕（预览脱敏）
    const { pendingId } = await seedStore(dir);
    const blocked = await driver.memoryEdit(pendingId, "新密钥是 sk-abcdef12345678 请记好");
    expect(blocked.ok).toBe(false);
    expect(blocked.message).toContain("被拦下");
    const fresh = openLongtermMemoryStore(dir);
    expect(fresh.listPending().some((e) => e.text === "称呼我用「老板」")).toBe(true); // 原条未动
    const ledger = await readBlockedLearningAt(memoryStorePath(dir));
    expect(ledger.some((l) => l.source === "edit")).toBe(true);
    expect(JSON.stringify(ledger)).not.toContain("sk-abcdef12345678"); // 台账先脱敏
    // 无工作区：诚实拒答不抛
    const bare = createAgentDriver({
      model: createScriptedModel([{ role: "assistant", content: "ok" }]),
      tools: [stubReadTool()],
      systemPrompt: "s",
      summarize: summarizeToolCall,
    });
    expect(await bare.memoryEdit("m-x", "内容")).toEqual({ ok: false, message: "没有这条记忆（可能已处理过）" });
    bare.dispose();
    // 结构化纪律（260 R1d 同形）：零 history notice、回执不含 TUI 渲染串
    expect(driver.getHistory().some((h) => typeof h === "object" && h !== null && JSON.stringify(h).includes("已改写一条记忆"))).toBe(false);
    driver.dispose();
  });
});

// R5 — 源钉：260/264 的 TUI /memory 命令面与 M49 store 本体在合流弧保持原样
// （store.update 是 ω99-3a 的既有单源——冻结回滚线；改写缝不再消费它，但
// 模块零改动是本弧的回滚承诺）。
describe("ω99-264 R5 — 源钉（store / TUI 命令面零改动）", () => {
  const srcOf = (rel: string): string =>
    readFileSync(fileURLToPath(new URL(`../src/${rel}`, import.meta.url)), "utf8");

  it("store.update 本体原样在场（version+1 转 pending 的 ω99-3a 语义零改动——冻结回滚线）", () => {
    const store = srcOf("memory/store.ts");
    expect(store).toContain("async update(id, input)");
    expect(store).toContain("status: \"pending\",");
    expect(store).toContain("version: (target.version ?? 1) + 1,");
    expect(store).toContain("tags: input.tags !== undefined ? [...input.tags] : target.tags,");
  });

  it("TUI /memory 命令面：verb 族与用法行原样（web 改写缝与 TUI 缝的共享面零漂移）", () => {
    const commands = srcOf("memory/commands.ts");
    expect(commands).toContain('if (verb === "del") {');
    expect(commands).toContain('if (verb === "ok") {');
    expect(commands).toContain("用法：/memory [list|del <id>|ok <id>|edit|dream]");
  });
});
