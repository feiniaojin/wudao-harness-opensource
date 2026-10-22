// ω99-264: #1 — 记忆条目改写（driver memoryEdit）R 件：改写 = store.update +
// 条件 store.confirm 的单源缝合——active 原态改后仍 active（用户点「改写」=
// 自己的授权链终点，不重走 LLM 审门）、pending 原态改后仍 pending（改写不替
// 用户审）；content 字节等值 → 零写短路（vault 裸重放会 version+1 两次不幂等，
// 短路使重放收敛、version 恰 +1）；miss（id 无/无工作区）→ ok:false 同族文案。
// store 真值直证：update/confirm 是 rewriteAll 原地改行——JSONL 行数不变（预判
// 「+1 行」低估，实况钉真值）；tags 缺席保原值；hits 跨 version 延续。全 mock
// （scripted model + stub 工具零真模型零真网络零 spawn）；夹具只写
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
import { openMemoryStore } from "../src/memory/store.js";

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

/** The store's raw JSONL line count (the append-only ledger's file-order
 *  truth — update/confirm rewrite lines in place, so a real edit must leave
 *  the count untouched). */
const lineCount = (dir: string): number =>
  readFileSync(join(dir, ".wudao/memory.jsonl"), "utf8").split("\n").filter((l) => l.trim() !== "").length;
const rawText = (dir: string): string => readFileSync(join(dir, ".wudao/memory.jsonl"), "utf8");

/** Seed: one ACTIVE project fact (auto-allow), one PENDING user preference
 *  (user scope never auto-allows). */
async function seedStore(dir: string): Promise<{ activeId: string; pendingId: string }> {
  const store = openMemoryStore(dir);
  const a = await store.write({ kind: "fact", content: "构建命令是 pnpm build", scope: "project", tags: ["build"] });
  const p = await store.write({ kind: "preference", content: "称呼我用「老板」", scope: "user", tags: ["tone"] });
  return { activeId: a.entry.id, pendingId: p.entry.id };
}

describe("ω99-264 R1 — memoryEdit()（改写 = update + 条件 confirm，单源缝合）", () => {
  it("R1a: active 原态改写 → version+1 仍 active、content 落新值、回执「已改写一条记忆」；JSONL 行数不变（原地改行真值）", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wudao-o264-active-"));
    const { activeId } = await seedStore(dir);
    // hits 遥测先攒一次（裁定 6 的前置：跨 version 延续的观察起点）
    await openMemoryStore(dir).bumpHits([activeId]);
    const driver = makeDriver(dir);
    const linesBefore = lineCount(dir);
    const r = await driver.memoryEdit(activeId, "构建命令是 pnpm -r build");
    expect(r).toEqual({ ok: true, message: "已改写一条记忆" });
    const store = openMemoryStore(dir);
    const after = (await store.load()).find((e) => e.id === activeId);
    expect(after).toMatchObject({
      id: activeId,
      content: "构建命令是 pnpm -r build",
      status: "active",
      version: 2,
      tags: ["build"], // update 缺席 tags → 保留原 tags（store.ts:303 真值钉）
      hits: 1, // hits 跨 version 延续（store.ts:305 真值钉——面板数字不复位）
      kind: "fact",
      scope: "project",
    });
    expect(lineCount(dir)).toBe(linesBefore); // update+confirm 都走 rewriteAll 原地改行——行数不变（真值钉）
    driver.dispose();
  });

  it("R1b: pending 原态改写 → version+1 仍 pending（改写不替用户审）、surfaced 位脱落（待审自愈再现）、回执「已改写一条记忆（仍待你确认）」", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wudao-o264-pending-"));
    const { pendingId } = await seedStore(dir);
    const store = openMemoryStore(dir);
    await store.markSurfaced([pendingId]); // 消费过一次性提醒——改写后必须重新进待审
    const driver = makeDriver(dir);
    const r = await driver.memoryEdit(pendingId, "称呼我用「您」");
    expect(r).toEqual({ ok: true, message: "已改写一条记忆（仍待你确认）" });
    const after = (await store.load()).find((e) => e.id === pendingId);
    expect(after).toMatchObject({ status: "pending", version: 2, content: "称呼我用「您」" });
    expect((after as { surfaced?: boolean }).surfaced).toBeUndefined(); // update 逐字段构造——surfaced 脱落
    expect((await store.pendingReview()).some((e) => e.id === pendingId)).toBe(true); // 待审卡自愈再现
    driver.dispose();
  });

  it("R1c: content 字节等值短路——真改写后重放 3 次，version 恰 +1、文件字节零变（vault 重放收敛的 driver 半边直证）", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wudao-o264-short-"));
    const { activeId, pendingId } = await seedStore(dir);
    const driver = makeDriver(dir);
    // active 形：真改写一次
    await driver.memoryEdit(activeId, "构建命令是 pnpm -r build");
    const bytes = rawText(dir);
    const lines = lineCount(dir);
    // vault 中断重放的裸模拟：同 id 同 content 再来 3 次
    const again1 = await driver.memoryEdit(activeId, "构建命令是 pnpm -r build");
    const again2 = await driver.memoryEdit(activeId, "构建命令是 pnpm -r build");
    const again3 = await driver.memoryEdit(activeId, "构建命令是 pnpm -r build");
    expect(again1).toEqual({ ok: true, message: "已改写一条记忆" }); // 短路也按原态回执
    expect(again2.ok).toBe(true);
    expect(again3.ok).toBe(true);
    const store = openMemoryStore(dir);
    const after = (await store.load()).find((e) => e.id === activeId);
    expect(after).toMatchObject({ version: 2, status: "active", content: "构建命令是 pnpm -r build" }); // version 恰 +1（v2，不是 v5）
    expect(rawText(dir)).toBe(bytes); // 零写：三次短路文件字节零变
    expect(lineCount(dir)).toBe(lines); // 行数不变
    // pending 形短路同律：未改过（content 仍原值）直接「改写」原值 → 零写 + pending 回执
    const p0 = await driver.memoryEdit(pendingId, "称呼我用「老板」");
    expect(p0).toEqual({ ok: true, message: "已改写一条记忆（仍待你确认）" });
    expect((await store.load()).find((e) => e.id === pendingId)).toMatchObject({ version: 1, status: "pending" }); // v1 未动
    expect(rawText(dir)).toBe(bytes); // 依旧零写
    driver.dispose();
  });

  it("R1d: miss 三形——id 不存在 / 无工作区 → ok:false「没有这条记忆（可能已处理过）」不抛；回执结构化（零 history notice 写入）", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wudao-o264-miss-"));
    await seedStore(dir);
    const driver = makeDriver(dir);
    const miss = await driver.memoryEdit("m-nope", "任何内容");
    expect(miss).toEqual({ ok: false, message: "没有这条记忆（可能已处理过）" });
    // 已删除的 id 同形（改写 miss 不复活条目）
    const store = openMemoryStore(dir);
    const entries = await store.load();
    const victim = entries[0];
    await store.remove(victim.id);
    const gone = await driver.memoryEdit(victim.id, "改一个已删的");
    expect(gone).toEqual({ ok: false, message: "没有这条记忆（可能已处理过）" });
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

// R5 — 零演进源钉：260 的 TUI /memory 命令面与 store 本体零触碰（改写是
// driver 缝上的新动词，store.update 是 ω99-3a 的既有单源）。
describe("ω99-264 R5 — 零演进源钉（store / TUI 命令面零触碰）", () => {
  const srcOf = (rel: string): string =>
    readFileSync(fileURLToPath(new URL(`../src/${rel}`, import.meta.url)), "utf8");

  it("store.update 本体原样在场（version+1 转 pending 的 ω99-3a 语义零改动——改写缝只消费不修改）", () => {
    const store = srcOf("memory/store.ts");
    expect(store).toContain("async update(id, input)");
    expect(store).toContain("status: \"pending\",");
    expect(store).toContain("version: (target.version ?? 1) + 1,");
    expect(store).toContain("tags: input.tags !== undefined ? [...input.tags] : target.tags,");
  });

  it("TUI /memory 命令面零触碰：verb 族与用法行原样（web 改写缝绝不改命令面）", () => {
    const commands = srcOf("memory/commands.ts");
    expect(commands).toContain('if (verb === "del") {');
    expect(commands).toContain('if (verb === "ok") {');
    expect(commands).toContain("用法：/memory [list|del <id>|ok <id>|edit|dream]");
  });
});
