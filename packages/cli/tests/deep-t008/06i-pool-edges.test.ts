// T008 探针 #6i：pool 中混入 task-failed / task-replayed 等的过滤
import { describe, it, expect } from "vitest";
import { importableEntry } from "../../src/workflow/import-cache.js";

describe("T008 #6i — pool 过滤", () => {
  it("6i-1) task-failed 在 pool 中：应被过滤（不导入）", () => {
    const pool = [
      { type: "task-failed" as const, seq: 0, key: "K", label: "x", category: "x", message: "x", endedAt: "x" },
    ];
    const result = importableEntry(pool as never, "K", { pastEditPoint: true, firstWrite: false });
    expect(result).toBeUndefined();
  });

  it("6i-2) ok:false task-finished 在 pool 中：应被过滤（不导入）", () => {
    const pool = [
      { type: "task-finished" as const, seq: 0, key: "K", prompt: "p", ok: false, text: "t", toolsUsed: [], cost: { promptTokens: 0, completionTokens: 0 }, endedAt: "x" },
    ];
    const result = importableEntry(pool as never, "K", { pastEditPoint: true, firstWrite: false });
    expect(result).toBeUndefined();
  });

  it("6i-3) task-replayed 在 pool 中：应被过滤（不导入）", () => {
    const pool = [
      { type: "task-replayed" as const, seq: 0, key: "K", label: "x" },
    ];
    const result = importableEntry(pool as never, "K", { pastEditPoint: true, firstWrite: false });
    expect(result).toBeUndefined();
  });

  it("6i-4) 多条同 key 但不同 seq：返回第一条匹配（find 行为）", () => {
    const pool = [
      { type: "task-finished" as const, seq: 0, key: "K", prompt: "p1", ok: true, text: "first", toolsUsed: [], cost: { promptTokens: 0, completionTokens: 0 }, endedAt: "x" },
      { type: "task-finished" as const, seq: 1, key: "K", prompt: "p2", ok: true, text: "second", toolsUsed: [], cost: { promptTokens: 0, completionTokens: 0 }, endedAt: "x" },
    ];
    const result = importableEntry(pool as never, "K", { pastEditPoint: true, firstWrite: false });
    expect(result?.text).toBe("first");
  });
});
