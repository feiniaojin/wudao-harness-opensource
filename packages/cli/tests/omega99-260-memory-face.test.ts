// ω99-260: #1 — 面一（cli driver 记忆方法）R 件：memoryList()/memoryDecide()
// 是 web 记忆面的数据缝——store 直传结构化（全表，字段=wire 全表），决定走
// 新库 confirm（append 同 id confirmed 行）/forget（tombstone）单源（/memory
// ok|del 的同底层，web 不经 runMemoryCommand 的 TUI 文本——258 超越点②纪律：
// 结构化数据 op，绝不解析渲染文本）。无工作区 → 空表（诚实边界）。全 mock
// （scripted model + stub 工具零真模型零网络）；夹具只写 mkdtemp(os.tmpdir())
// 只写不删（★红线——memory.jsonl 是用户数据，测试绝不触真实工作区 store）。
// 记忆两库收敛（retarget 随源演进）：三 op 改读新库（.wudao/memory/）——
// pending=confidence 路径（M49 人审门合流），surfaced 走新库侧 sidecar
// （review-surfaced.json——首次 list 标记，M49 一次性提醒语义保留）。
import { describe, it, expect } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildTool, createScriptedModel } from "@wudao-org/core";
import type { Tool } from "@wudao-org/core";
import { summarizeToolCall } from "../src/log.js";
import { createAgentDriver } from "../src/driver/agent-driver.js";
import { openLongtermMemoryStore, markLongtermMemorySurfaced } from "../src/longterm-memory.js";

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

/** A quiet driver over a REAL temp workspace store — no runs needed: the
 *  memory methods are read/decide seams over the ledger, not run state. */
function makeDriver(dir: string) {
  return createAgentDriver({
    model: createScriptedModel([{ role: "assistant", content: "ok" }]),
    tools: [stubReadTool()],
    systemPrompt: "s",
    summarize: summarizeToolCall,
    workspaceRoot: dir,
    sessionId: "o260",
  });
}

/** Seed a temp store（新库）: one CONFIRMED fact, one PENDING preference, and
 *  one pending-but-SURFACED entry (the boot reminder already consumed it —
 *  the decision stays open). */
async function seedStore(dir: string): Promise<{ activeId: string; pendingId: string; surfacedId: string }> {
  const store = openLongtermMemoryStore(dir);
  const a = await store.save({ kind: "fact", text: "构建命令是 pnpm build", tags: ["build"] });
  const p = await store.save({ kind: "preference", text: "称呼我用「老板」", confidence: "pending" });
  const s = await store.save({ kind: "skill", text: "改动后要跑聚焦测试", confidence: "pending" });
  await markLongtermMemorySurfaced(dir, [s.id]);
  return { activeId: a.id, pendingId: p.id, surfacedId: s.id };
}

describe("ω99-260 R1 — memoryList()/memoryDecide()（面一 driver，合流后钉新库）", () => {
  it("R1a: memoryList 直传全表——wire 字段全表钉（id/kind/content/scope/tags/created/hits/status/surfaced），createdAt+id 序", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wudao-o260-list-"));
    const { activeId, pendingId, surfacedId } = await seedStore(dir);
    const driver = makeDriver(dir);
    const { entries, blocked } = await driver.memoryList();
    expect(blocked).toBe(0);
    const ids = entries.map((e) => e.id).sort();
    expect(ids).toEqual([activeId, pendingId, surfacedId].sort()); // createdAt+id 序（集合钉——同毫秒写入 id 破平）
    const active = entries.find((e) => e.id === activeId)!;
    expect(active).toMatchObject({
      id: activeId,
      kind: "fact",
      content: "构建命令是 pnpm build",
      scope: "project",
      tags: ["build"],
      hits: 1, // useCount 的可见面（save 一次 = 1）
      status: "active",
    });
    expect(typeof active.created).toBe("string");
    expect((active as { surfaced?: boolean }).surfaced).toBeUndefined();
    const pending = entries.find((e) => e.id === pendingId)!;
    expect(pending.status).toBe("pending");
    expect((pending as { surfaced?: boolean }).surfaced).toBeUndefined();
    // surfaced 位镜像直证：sidecar 消费过第三条，位=true——但 status 仍
    // pending（决定还开着，web 待审卡据 status 计数，surfaced 不参与）。
    const surfaced = entries.find((e) => e.id === surfacedId)!;
    expect(surfaced.status).toBe("pending");
    expect((surfaced as { surfaced?: boolean }).surfaced).toBe(true);
    // 首次 list 标记 surfaced（合流语义）：再取一次——pending 条目都带位。
    const second = await driver.memoryList();
    for (const e of second.entries.filter((x) => x.status === "pending")) {
      expect((e as { surfaced?: boolean }).surfaced).toBe(true);
    }
    driver.dispose();
  });

  it("R1b: 无工作区 → {entries:[]}（诚实边界：面板空态、待审卡隐藏的数据源）", async () => {
    const driver = createAgentDriver({
      model: createScriptedModel([{ role: "assistant", content: "ok" }]),
      tools: [stubReadTool()],
      systemPrompt: "s",
      summarize: summarizeToolCall,
    });
    // 永续 v6 弧 A（reef C3）钉随迁：回执多带 blocked=0（被拦学习输入计数，
    // 「已拦 N 条」的数据源；无工作区=无拦截，诚实 0）。
    expect(await driver.memoryList()).toEqual({ entries: [], blocked: 0 });
    // 决定缝同边界：无工作区的 ok/del 不抛——ok:false 的诚实拒答。
    const r = await driver.memoryDecide("m-x", "ok");
    expect(r.ok).toBe(false);
    driver.dispose();
  });

  it("R1c: memoryDecide 三态——ok（pending→confirmed 同 id 换行）/ del（tombstone 行消失）/ 不存在或已处理（ok:false），文案逐字", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wudao-o260-decide-"));
    const { pendingId } = await seedStore(dir);
    const driver = makeDriver(dir);
    // ok：待审 → 生效
    const ok = await driver.memoryDecide(pendingId, "ok");
    expect(ok).toEqual({ ok: true, message: "已确认一条记忆" });
    // 新库单源直证：同 id 在新库里已 confirmed（append 的 confirmed 行后行胜）
    const store = openLongtermMemoryStore(dir);
    expect(store.list({ includePending: true }).find((e) => e.id === pendingId)?.confidence).toBe("confirmed");
    expect(store.listPending()).toHaveLength(1); // 另一条 surfaced 待审仍在
    // 不存在或已处理：同 id 再 ok（已 confirmed）→ ok:false（幂等，重放不破）
    const again = await driver.memoryDecide(pendingId, "ok");
    expect(again).toEqual({ ok: false, message: "没有这条待审记忆（可能已处理过）" });
    // del：行消失（tombstone；per-handle 索引——断言走新句柄读盘）
    const del = await driver.memoryDecide(pendingId, "del");
    expect(del).toEqual({ ok: true, message: "已删除一条记忆" });
    expect(openLongtermMemoryStore(dir).list({ includePending: true }).some((e) => e.id === pendingId)).toBe(false);
    // del 不存在的 id → ok:false（不抛）
    const gone = await driver.memoryDecide("m-nope", "del");
    expect(gone).toEqual({ ok: false, message: "没有这条待审记忆（可能已处理过）" });
    driver.dispose();
  });

  it("R1d: 负证——web 缝不走 runMemoryCommand 的 TUI 文本（结构化 op 纪律）：回执是结构化中文，不含 TUI 渲染串；决定不落 history notice", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wudao-o260-neg-"));
    const { pendingId } = await seedStore(dir);
    const driver = makeDriver(dir);
    const ok = await driver.memoryDecide(pendingId, "ok");
    // runMemoryCommand ok 臂的 TUI 文本是 `memory <id> confirmed (active)`——
    // web 缝的回执绝不该长这样（否则就是在解析/复用渲染文本）。
    expect(ok.message).not.toContain("confirmed");
    expect(ok.message).not.toContain("deleted");
    expect(typeof ok.ok).toBe("boolean");
    // /memory 命令路由会 appendHistory notice；driver 决定缝零 history 写。
    const history = driver.getHistory();
    expect(history.some((h) => typeof h === "object" && h !== null && JSON.stringify(h).includes("已确认一条记忆"))).toBe(false);
    driver.dispose();
  });
});

// R6 — 直证（源钉，202 readFileSync 法）：session-engine 的 boot
// surfacePendingReview 与 recall 接线零触碰；/memory 命令面（TUI 缝）在合流
// 后保留动词族与回执串（web 缝与 TUI 缝的共享面零漂移）。
describe("ω99-260 R6 — 源钉（session-engine / TUI /memory 的合流兼容面）", () => {
  const srcOf = (rel: string): string =>
    readFileSync(fileURLToPath(new URL(`../src/${rel}`, import.meta.url)), "utf8");

  it("session-engine：boot 无条件 surfacePendingReview（实况原样）+ memoryRecall 接线在场", () => {
    const engine = srcOf("driver/session-engine.ts");
    expect(engine).toContain("const pending = await surfacePendingReview(workspaceRoot);");
    expect(engine).toContain("memoryRecall: memoryRuntime.recall,");
    // M-Memory 弧第二半：模型工具面换轨长期记忆三件套（原 M49 挂载行
    // memory: { store: openMemoryStore(workspaceRoot) } 退役）。钉随本提交再生：
    // 换轨行原样在场。
    expect(engine).toContain("...(ltsMemory.enabled ? { longtermMemory: { store: ltsMemory.store } } : {}),");
  });

  it("TUI /memory 命令面：verb 族与用法行原样在场（合流后 ok/del 读新库，回执串不变）", () => {
    const commands = srcOf("memory/commands.ts");
    expect(commands).toContain('if (verb === "del") {');
    expect(commands).toContain('if (verb === "ok") {');
    expect(commands).toContain("用法：/memory [list|del <id>|ok <id>|edit|dream]");
    expect(commands).toContain("memory ${rest} confirmed (active)");
  });
});
