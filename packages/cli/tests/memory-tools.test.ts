// M-Memory 弧第二半 — 工具面确定性钉：memory_save/memory_search/
// memory_forget 三件套的 fail-closed 行为 + buildToolSet 装配缝（互斥律）。
// 夹具只写 mkdtemp(os.tmpdir())（★红线——绝不负碰真实工作区的记忆文件）。
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openMemoryStore, readMemoryFile } from "@wudao/core";
import {
  createLongtermMemorySaveTool,
  createLongtermMemorySearchTool,
  createLongtermMemoryForgetTool,
  createLongtermMemoryTools,
  openLongtermMemoryStore,
  longtermMemoryDir,
} from "../src/longterm-memory.js";
import { buildToolSet } from "../src/tools.js";

let ws: string;
beforeEach(async () => { ws = await mkdtemp(join(tmpdir(), "wudao-lts-tools-")); });
afterEach(async () => { await rm(ws, { recursive: true, force: true }); });

const okModel = { generate: async () => ({}) } as never;

function toolSetNames(store: ReturnType<typeof openMemoryStore>, extra: Record<string, unknown> = {}): string[] {
  return buildToolSet({
    workspaceRoot: ws,
    model: okModel,
    canUseTool: async () => ({ behavior: "allow" as const }),
    contextWindowTokens: 64_000,
    longtermMemory: { store },
    ...extra,
  }).map((t) => t.name);
}

describe("M-Memory 工具面 — memory_save", () => {
  it("合法保存落盘到 .wudao/memory/memory.jsonl（与 M49 的 memory.jsonl 分离）", async () => {
    const store = openLongtermMemoryStore(ws);
    const tool = createLongtermMemorySaveTool(store);
    const r = await tool.execute({ kind: "preference", text: "回复用中文", tags: ["语言"] });
    expect(r.isError).toBeFalsy();
    expect(store.list()).toHaveLength(1);
    expect(store.list()[0]!.text).toBe("回复用中文");
    // 物理路径钉：子目录 memory/memory.jsonl，不是 M49 的 .wudao/memory.jsonl
    expect(store.file).toBe(longtermMemoryDir(ws) + "/memory.jsonl");
    expect(store.file.endsWith(join(".wudao", "memory", "memory.jsonl"))).toBe(true);
  });

  it("fail-closed：非法 kind / 空 text → isError，且不落盘", async () => {
    const store = openLongtermMemoryStore(ws);
    const tool = createLongtermMemorySaveTool(store);
    const badKind = await tool.execute({ kind: "diary", text: "x" });
    expect(badKind.isError).toBe(true);
    const emptyText = await tool.execute({ kind: "fact", text: "   " });
    expect(emptyText.isError).toBe(true);
    expect(store.list()).toHaveLength(0);
  });

  it("同内容再存 = 强化（useCount+1），台账仍两行（append-only）", async () => {
    const store = openLongtermMemoryStore(ws);
    const tool = createLongtermMemorySaveTool(store);
    await tool.execute({ kind: "lesson", text: "先跑测试再提交" });
    const again = await tool.execute({ kind: "lesson", text: "先跑测试再提交" });
    expect(again.isError).toBeFalsy();
    expect(String(again.content)).toContain("strengthened");
    expect(store.list()).toHaveLength(1);
    expect(store.list()[0]!.useCount).toBe(2);
    const entries = await readMemoryFile(store.file);
    expect(entries).toHaveLength(1);
  });

  it("tags 清洗：非字符串丢弃、小写、≤8", async () => {
    const store = openLongtermMemoryStore(ws);
    const tool = createLongtermMemorySaveTool(store);
    await tool.execute({ kind: "fact", text: "repo uses pnpm", tags: ["Build", "build", 3, "CI", "a", "b", "c", "d", "e", "f"] });
    const tags = store.list()[0]!.tags;
    expect(tags[0]).toBe("build");
    expect(tags).not.toContain("3");
    expect(tags.length).toBeLessThanOrEqual(8);
  });

  it("记忆两库收敛 — guard 接线：凭据值形状硬拦（isError 回执、零落库、台账留痕且脱敏）；正常路径缺省 confirmed", async () => {
    const store = openLongtermMemoryStore(ws);
    const tool = createLongtermMemorySaveTool(store, ws);
    const blocked = await tool.execute({ kind: "fact", text: "the api key is sk-abcdef12345678" });
    expect(blocked.isError).toBe(true);
    expect(String(blocked.content)).toContain("blocked");
    expect(store.list({ includePending: true })).toHaveLength(0); // 未入库
    const { readFile } = await import("node:fs/promises");
    const ledger = await readFile(join(ws, ".wudao", "memory-blocked.jsonl"), "utf8");
    expect(ledger).toContain("\"source\":\"memory_write\"");
    expect(ledger).not.toContain("sk-abcdef12345678"); // 台账预览先脱敏
    // 正常路径缺省 confirmed（模型工具直写 = confirmed）
    const fine = await tool.execute({ kind: "fact", text: "repo uses vitest" });
    expect(fine.isError).toBeFalsy();
    expect(store.list()[0]!.confidence).toBe("confirmed");
  });
});

describe("M-Memory 工具面 — memory_search / memory_forget", () => {
  it("search：词面命中渲染 id/kind/text 行；无命中=诚实空行", async () => {
    const store = openLongtermMemoryStore(ws);
    await store.save({ kind: "fact", text: "构建命令是 pnpm build", tags: ["build"] });
    await store.save({ kind: "preference", text: "称呼用「老板」" });
    const tool = createLongtermMemorySearchTool(store);
    const hit = await tool.execute({ query: "构建命令" });
    expect(hit.isError).toBeFalsy();
    expect(String(hit.content)).toContain("pnpm build");
    const miss = await tool.execute({ query: "完全不相关的量子力学问题" });
    expect(String(miss.content)).toMatch(/no long-term memories match/);
  });

  it("search：空 query → isError；k 钳制 1..20", async () => {
    const store = openLongtermMemoryStore(ws);
    const tool = createLongtermMemorySearchTool(store);
    expect((await tool.execute({ query: "  " })).isError).toBe(true);
    for (let i = 0; i < 5; i++) await store.save({ kind: "fact", text: `测试事实第 ${i} 条 pnpm` });
    const two = await tool.execute({ query: "测试事实 pnpm", k: 2 });
    expect(String(two.content).split("\n")).toHaveLength(2);
    const junkK = await tool.execute({ query: "测试事实 pnpm", k: 9999 });
    expect(String(junkK.content).split("\n").length).toBeLessThanOrEqual(20);
  });

  it("forget：tombstone 生效（list 清空、文件字节仍含原文）；未知 id → isError", async () => {
    const store = openLongtermMemoryStore(ws);
    const entry = await store.save({ kind: "fact", text: "temporal fact" });
    const tool = createLongtermMemoryForgetTool(store);
    expect((await tool.execute({ id: entry.id })).isError).toBeFalsy();
    expect(store.list()).toHaveLength(0);
    expect((await tool.execute({ id: "nope" })).isError).toBe(true);
  });

  it("readOnly 拼法只带 memory_search（子 agent 永不写长期记忆）", () => {
    const store = openLongtermMemoryStore(ws);
    const names = createLongtermMemoryTools({ store, readOnly: true }).map((t) => t.name);
    expect(names).toEqual(["memory_search"]);
    const full = createLongtermMemoryTools({ store }).map((t) => t.name);
    expect(full).toEqual(["memory_save", "memory_search", "memory_forget"]);
  });
});

describe("M-Memory 装配缝 — buildToolSet", () => {
  it("longtermMemory 在场：三件套进顶层工具集", () => {
    const store = openLongtermMemoryStore(ws);
    const names = toolSetNames(store);
    expect(names).toContain("memory_save");
    expect(names).toContain("memory_search");
    expect(names).toContain("memory_forget");
  });

  it("互斥律：memory（M49）与 longtermMemory 同传 → 构建期拒绝（memory_search 同名）", () => {
    const store = openLongtermMemoryStore(ws);
    const m49 = openMemoryStore(ws); // M49 面（类型兼容即可触发互斥检查）
    expect(() =>
      buildToolSet({
        workspaceRoot: ws,
        model: okModel,
        canUseTool: async () => ({ behavior: "allow" as const }),
        contextWindowTokens: 64_000,
        longtermMemory: { store },
        memory: { store: m49 as never },
      })
    ).toThrow(/互斥/);
  });

  it("两缝都缺席：零记忆工具（前置边界不变）", () => {
    const names = buildToolSet({
      workspaceRoot: ws,
      model: okModel,
      canUseTool: async () => ({ behavior: "allow" as const }),
      contextWindowTokens: 64_000,
    }).map((t) => t.name);
    expect(names).not.toContain("memory_save");
    expect(names).not.toContain("memory_search");
    expect(names).not.toContain("memory_forget");
  });
});
