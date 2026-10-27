// T008 探针 #6j：空 pool、cmd-finished 混入等边界
import { describe, it, expect } from "vitest";
import { importableEntry, closesImportPool } from "../../src/workflow/import-cache.js";

describe("T008 #6j — 空 pool / 不相关条目", () => {
  it("6j-1) 空 pool + pastEditPoint=true → undefined（不应 throw）", () => {
    expect(importableEntry([], "K", { pastEditPoint: true, firstWrite: true })).toBeUndefined();
  });

  it("6j-2) pool 中只有 cmd-finished（同 key 命名空间）→ 不命中", () => {
    const pool = [
      // 用 cmd 形 record 模拟
      { type: "cmd-finished" as const, seq: 0, key: "K", cmd: "x", args: [], code: 0, stdout: "", stderr: "", timedOut: false, endedAt: "x" },
    ];
    expect(importableEntry(pool as never, "K", { pastEditPoint: true, firstWrite: false })).toBeUndefined();
  });

  it("6j-3) pastEditPoint=false → undefined（编辑前不走导入）", () => {
    const pool = [
      { type: "task-finished" as const, seq: 0, key: "K", prompt: "p", ok: true, text: "t", toolsUsed: [], cost: { promptTokens: 0, completionTokens: 0 }, endedAt: "x" },
    ];
    expect(importableEntry(pool as never, "K", { pastEditPoint: false, firstWrite: false })).toBeUndefined();
    expect(importableEntry(pool as never, "K", { pastEditPoint: false, firstWrite: true })).toBeUndefined();
  });

  it("6j-4) key 不匹配 → undefined", () => {
    const pool = [
      { type: "task-finished" as const, seq: 0, key: "K1", prompt: "p", ok: true, text: "t", toolsUsed: [], cost: { promptTokens: 0, completionTokens: 0 }, endedAt: "x" },
    ];
    expect(importableEntry(pool as never, "K2", { pastEditPoint: true, firstWrite: false })).toBeUndefined();
  });

  it("6j-5) closesImportPool 收到空数组 → false", () => {
    expect(closesImportPool([])).toBe(false);
  });

  it("6j-6) closesImportPool 收到多个工具 → true", () => {
    expect(closesImportPool(["read_file", "write_file"])).toBe(true);
  });
});
