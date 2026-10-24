// ω99-249: #4 — R1 — the GoalState OBJECT face (core). The model-side budgeted goal
// that lives across turns: a new append-only `goal_state` session entry riding
// the M35 §2 generic lane, a six-state transition machine (every legal move
// pinned, terminals closed), split input/output token accounting settled at
// run boundaries, a continuationsUsed compaction counter, and the safe-pause
// topology helper. Prime-agent goals.ts is the blueprint for the parity parts
// (six states / field face / <goal_context> wrap / continuations counting);
// the derivation-from-mission discipline is ours (cli file pins that).
import { describe, it, expect } from "vitest";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GOAL_STATE_ENTRY_TYPE,
  GOAL_OBJECTIVE_MAX_CHARS,
  GOAL_TRANSITIONS,
  applyGoalSettlement,
  buildGoalStateEntry,
  canTransitionGoal,
  goalBudgetNote,
  goalObjectiveOf,
  goalQueryText,
  goalRemainingTokens,
  GOAL_NEAR_BUDGET_FRACTION,
  goalNearBudgetRemaining,
  goalStatusLine,
  goalTokensTotal,
  goalUsageDeltaOf,
  isLiveGoalStatus,
  parseGoalStateData,
  replayGoalStates,
  safePauseSuggestion,
  type GoalStateData,
} from "../src/goal-state.js";
import { createJsonlSessionStore } from "../src/session/store.js";
import type { SessionEntry } from "../src/session/store.js";

const baseGoal = (over: Partial<GoalStateData> = {}): GoalStateData => ({
  goalId: "g1",
  objective: "完成认证模块并全部测试通过",
  missionTaskId: "t2",
  status: "active",
  tokenBudget: 5000,
  tokensUsed: { input: 0, output: 0 },
  timeUsedMs: 0,
  continuationsUsed: 0,
  createdAt: "2026-09-10T00:00:00.000Z",
  updatedAt: "2026-09-10T00:00:00.000Z",
  ...over,
});

describe("ω99-249 R1 — entry 字段面与 append-only 落盘", () => {
  it("buildGoalStateEntry rides the M35 §2 generic lane with the pinned type and full field face", () => {
    const entry = buildGoalStateEntry(baseGoal());
    expect(entry.type).toBe("goal_state");
    expect((entry as { data: unknown }).data).toEqual({
      goalId: "g1",
      objective: "完成认证模块并全部测试通过",
      missionTaskId: "t2",
      status: "active",
      tokenBudget: 5000,
      tokensUsed: { input: 0, output: 0 },
      timeUsedMs: 0,
      continuationsUsed: 0,
      createdAt: "2026-09-10T00:00:00.000Z",
      updatedAt: "2026-09-10T00:00:00.000Z",
    });
    expect(GOAL_STATE_ENTRY_TYPE).toBe("goal_state");
    expect(GOAL_OBJECTIVE_MAX_CHARS).toBe(4000);
  });

  it("parseGoalStateData round-trips and degrades per-field fail-safe (corrupt rows drop, never throw)", () => {
    const entry = buildGoalStateEntry(baseGoal());
    expect(parseGoalStateData((entry as { data: unknown }).data)).toEqual(baseGoal());
    // missing binding / non-string objective / bad status / negative counters → row dropped
    expect(parseGoalStateData({ goalId: "g1", objective: "x", status: "active", tokensUsed: { input: 1, output: 1 }, timeUsedMs: 0, continuationsUsed: 0, createdAt: "a", updatedAt: "b" })).toBeUndefined(); // no missionTaskId
    expect(parseGoalStateData({ goalId: "g1", objective: 7, missionTaskId: "t2", status: "active", tokensUsed: { input: 1, output: 1 }, timeUsedMs: 0, continuationsUsed: 0, createdAt: "a", updatedAt: "b" })).toBeUndefined();
    expect(parseGoalStateData({ goalId: "g1", objective: "x", missionTaskId: "t2", status: "weird", tokensUsed: { input: 1, output: 1 }, timeUsedMs: 0, continuationsUsed: 0, createdAt: "a", updatedAt: "b" })).toBeUndefined();
    expect(parseGoalStateData(undefined)).toBeUndefined();
    expect(parseGoalStateData("junk")).toBeUndefined();
  });

  it("goal rows are APPEND-ONLY in the session JSONL: a transition adds a new line, the created row's bytes never change", async () => {
    // ★红线：夹具只写 tmpdir 且不做任何删除——目录留给 OS 清理。
    const root = await mkdtemp(join(tmpdir(), "o249-goal-appendonly-"));
    const store = createJsonlSessionStore(root);
    await store.appendEntry("s1", buildGoalStateEntry(baseGoal()));
    const before = await readFile(join(root, "s1.jsonl"), "utf8");
    // a status transition appends a NEW row — the old line stays byte-identical
    await store.appendEntry("s1", buildGoalStateEntry(baseGoal({ status: "paused", updatedAt: "2026-09-10T00:01:00.000Z", lastReason: "任务回到 todo" })));
    const after = await readFile(join(root, "s1.jsonl"), "utf8");
    const linesAfter = after.split("\n").filter((l) => l.trim() !== "");
    // line 1 = the ω99-47 first-write format marker (transport framing);
    // then the created row + the transition row — exactly two goal lines.
    expect(linesAfter).toHaveLength(3);
    expect(after.startsWith(before)).toBe(true); // the marker + the created row's bytes are untouched
    // and the store's entry view reads both rows back in file order
    const entries = await store.loadSessionEntries("s1");
    const goalRows = entries.filter((e) => !("role" in e) && e.type === GOAL_STATE_ENTRY_TYPE);
    expect(goalRows).toHaveLength(2);
  });

  it("replay: the latest row per goal wins; a NEW goalId supersedes the live one; terminal goals close (undefined)", () => {
    const mk = (id: string, over: Partial<GoalStateData>): SessionEntry => buildGoalStateEntry(baseGoal({ goalId: id, ...over }));
    // active → settle row → paused: latest wins
    expect(replayGoalStates([mk("g1", {}), mk("g1", { tokensUsed: { input: 10, output: 2 }, timeUsedMs: 1000 })])).toMatchObject({ goalId: "g1", tokensUsed: { input: 10, output: 2 }, timeUsedMs: 1000 });
    // terminal closes
    expect(replayGoalStates([mk("g1", {}), mk("g1", { status: "complete" })])).toBeUndefined();
    // a new goal replaces the live one even if the old one was never closed
    expect(replayGoalStates([mk("g1", {}), mk("g2", { missionTaskId: "t3" })])).toMatchObject({ goalId: "g2", missionTaskId: "t3" });
    // corrupt rows are skipped silently (unknown junk lines never throw)
    expect(replayGoalStates([{ type: "goal_state", data: { nope: 1 } as unknown }, mk("g1", {})])).toMatchObject({ goalId: "g1" });
    // empty / no goal rows → undefined
    expect(replayGoalStates([])).toBeUndefined();
    expect(replayGoalStates([{ role: "user", content: "hi" } as SessionEntry])).toBeUndefined();
  });
});

describe("ω99-249 R1 — 六态转移机逐条钉", () => {
  it("the transition table is exactly the pinned six-state face (prime parity + our budget_limited outs)", () => {
    expect(GOAL_TRANSITIONS).toEqual({
      idle: ["active"],
      active: ["paused", "budget_limited", "complete", "error"],
      paused: ["active", "complete", "error"],
      budget_limited: ["paused", "complete", "error"],
      complete: [],
      error: [],
    });
  });

  it("canTransitionGoal pins each legal move and rejects the illegal ones (terminals closed, no budget raise-back to active)", () => {
    // idle only materializes
    expect(canTransitionGoal("idle", "active")).toBe(true);
    expect(canTransitionGoal("idle", "paused")).toBe(false);
    expect(canTransitionGoal("idle", "complete")).toBe(false);
    // active spreads to every non-idle sibling
    expect(canTransitionGoal("active", "paused")).toBe(true);
    expect(canTransitionGoal("active", "budget_limited")).toBe(true);
    expect(canTransitionGoal("active", "complete")).toBe(true);
    expect(canTransitionGoal("active", "error")).toBe(true);
    expect(canTransitionGoal("active", "idle")).toBe(false);
    // paused resumes or terminally settles
    expect(canTransitionGoal("paused", "active")).toBe(true);
    expect(canTransitionGoal("paused", "complete")).toBe(true);
    expect(canTransitionGoal("paused", "error")).toBe(true);
    expect(canTransitionGoal("paused", "budget_limited")).toBe(false);
    // budget_limited NEVER goes back to active (no budget-raise face in v1)
    expect(canTransitionGoal("budget_limited", "active")).toBe(false);
    expect(canTransitionGoal("budget_limited", "paused")).toBe(true);
    expect(canTransitionGoal("budget_limited", "complete")).toBe(true);
    expect(canTransitionGoal("budget_limited", "error")).toBe(true);
    // terminals are closed
    expect(canTransitionGoal("complete", "active")).toBe(false);
    expect(canTransitionGoal("complete", "error")).toBe(false);
    expect(canTransitionGoal("error", "active")).toBe(false);
    expect(canTransitionGoal("error", "complete")).toBe(false);
  });

  it("isLiveGoalStatus: active/paused/budget_limited live; idle/complete/error do not", () => {
    expect(isLiveGoalStatus("active")).toBe(true);
    expect(isLiveGoalStatus("paused")).toBe(true);
    expect(isLiveGoalStatus("budget_limited")).toBe(true);
    expect(isLiveGoalStatus("idle")).toBe(false);
    expect(isLiveGoalStatus("complete")).toBe(false);
    expect(isLiveGoalStatus("error")).toBe(false);
  });
});

describe("ω99-249 R1 — 分计结算与 continuationsUsed 计数", () => {
  it("goalUsageDeltaOf splits prompt/completion into input/output", () => {
    expect(goalUsageDeltaOf({ promptTokens: 1000, completionTokens: 50 })).toEqual({ input: 1000, output: 50 });
    expect(goalUsageDeltaOf({ promptTokens: 700 })).toEqual({ input: 700, output: 0 }); // absent completion defaults to 0
    expect(goalTokensTotal({ input: 1000, output: 50 })).toBe(1050);
    expect(goalRemainingTokens(baseGoal({ tokensUsed: { input: 4000, output: 300 }, tokenBudget: 5000 }))).toBe(700);
    expect(goalRemainingTokens(baseGoal({ tokenBudget: undefined }))).toBeNull(); // unbudgeted → null, never a fake number
  });

  it("applyGoalSettlement accumulates the split + time and reports the crossing exactly once", () => {
    const under = applyGoalSettlement(baseGoal(), { tokens: { input: 3000, output: 500 }, timeMs: 12_000 });
    expect(under.crossedBudget).toBe(false);
    expect(under.goal.tokensUsed).toEqual({ input: 3000, output: 500 });
    expect(under.goal.timeUsedMs).toBe(12_000);
    expect(under.goal.status).toBe("active");
    // 3500 + 2000 = 5500 ≥ 5000 → budget_limited, crossing reported
    const crossed = applyGoalSettlement(under.goal, { tokens: { input: 1500, output: 500 }, timeMs: 3000 });
    expect(crossed.crossedBudget).toBe(true);
    expect(crossed.goal.status).toBe("budget_limited");
    expect(crossed.goal.tokensUsed).toEqual({ input: 4500, output: 1000 });
    expect(crossed.goal.timeUsedMs).toBe(15_000);
    // settling an ALREADY budget_limited goal keeps counting but reports no new crossing
    const again = applyGoalSettlement(crossed.goal, { tokens: { input: 100, output: 10 }, timeMs: 100 });
    expect(again.crossedBudget).toBe(false);
    expect(again.goal.status).toBe("budget_limited");
    expect(again.goal.tokensUsed).toEqual({ input: 4600, output: 1010 });
    // clamped: never negative, counters truncated to integers
    const clamped = applyGoalSettlement(baseGoal(), { tokens: { input: -5, output: -5 }, timeMs: -100 });
    expect(clamped.goal.tokensUsed).toEqual({ input: 0, output: 0 });
    expect(clamped.goal.timeUsedMs).toBe(0);
  });
});

describe("ω99-249 R1/R3 — 模型侧渲染面：状态行、预算注记、安全暂停拓扑", () => {
  it("goalStatusLine wraps in <goal_context>, carries objective/budget split/progress, and never claims model self-report", () => {
    const line = goalStatusLine(
      baseGoal({ tokensUsed: { input: 4000, output: 300 }, timeUsedMs: 90_000, continuationsUsed: 2 }),
      { done: 2, total: 5 },
    );
    expect(line.startsWith("<goal_context>\n")).toBe(true);
    expect(line.trimEnd().endsWith("</goal_context>")).toBe(true);
    expect(line).toContain("完成认证模块并全部测试通过");
    expect(line).toContain("t2");
    expect(line).toContain("4300"); // total used
    expect(line).toContain("5000"); // budget
    expect(line).toContain("2/5"); // ledger progress
    expect(line).toContain("台账"); // progress is the ledger's word, not a self-report
    // unbudgeted goal: no budget line, no fake numbers
    const unbudgeted = goalStatusLine(baseGoal({ tokenBudget: undefined }), { done: 0, total: 3 });
    expect(unbudgeted).not.toContain("预算");
  });

  it("goalBudgetNote names the safe pause node and states that nothing auto-continues", () => {
    const note = goalBudgetNote(
      baseGoal({ status: "budget_limited", tokensUsed: { input: 4500, output: 900 } }),
      { taskId: "t3", title: "联调收尾" },
      { done: 2, total: 5 },
    );
    expect(note.startsWith("<goal_context>\n")).toBe(true);
    expect(note).toContain("预算");
    expect(note).toContain("t3");
    expect(note).toContain("联调收尾");
    expect(note).toContain("安全暂停");
    expect(note).toContain("不会自动");
    // without a suggestion the note still lands honestly
    const bare = goalBudgetNote(baseGoal({ status: "budget_limited" }), undefined, { done: 1, total: 2 });
    expect(bare).toContain("预算");
    expect(bare).not.toContain("安全暂停于");
  });

  it("safePauseSuggestion: the DEEPEST doing node by dependency depth; ties break to the later ledger position; no doing → undefined", () => {
    const tasks = [
      { id: "t1", dependsOn: [] as string[], status: "done" },
      { id: "t2", dependsOn: ["t1"], status: "doing" },
      { id: "t3", dependsOn: ["t2"], status: "doing" }, // depth 3 — the frontier
      { id: "t4", dependsOn: ["t1"], status: "todo" },
    ];
    expect(safePauseSuggestion(tasks)).toEqual({ taskId: "t3", depth: 3 });
    // parallel doing at equal depth → the LATER ledger position (deterministic)
    const parallel = [
      { id: "t1", dependsOn: [] as string[], status: "done" },
      { id: "t5", dependsOn: ["t1"], status: "doing" },
      { id: "t6", dependsOn: ["t1"], status: "doing" },
    ];
    expect(safePauseSuggestion(parallel)).toEqual({ taskId: "t6", depth: 2 });
    // nothing doing → no suggestion
    expect(safePauseSuggestion([{ id: "t1", dependsOn: [], status: "todo" }])).toBeUndefined();
    expect(safePauseSuggestion([])).toBeUndefined();
  });

  it("goalObjectiveOf derives the objective from a mission task's title+detail, clamped to the 4000-char face", () => {
    expect(goalObjectiveOf("写认证模块", "覆盖登录与刷新")).toBe("写认证模块——覆盖登录与刷新");
    expect(goalObjectiveOf("写认证模块")).toBe("写认证模块");
    expect(goalObjectiveOf("写认证模块", undefined)).toBe("写认证模块");
    const long = "x".repeat(5000);
    expect(goalObjectiveOf(long, long).length).toBeLessThanOrEqual(GOAL_OBJECTIVE_MAX_CHARS);
  });
});

describe("114 长任务纪律 ② — 预算感知收尾：goalStatusLine 的近耗尽收尾建议", () => {
  it("crossing the 20% line appends the best-effort wrap-up suggestion, advisory-only, inside <goal_context>", () => {
    const line = goalStatusLine(baseGoal({ tokensUsed: { input: 4300, output: 300 } }), { done: 2, total: 5 }); // 剩 400/5000 = 8%
    expect(line.startsWith("<goal_context>\n")).toBe(true);
    expect(line.trimEnd().endsWith("</goal_context>")).toBe(true);
    expect(line).toContain("预算还剩约 400");
    expect(line).toContain("停止开启新的探索");
    expect(line).toContain("提交/落盘");
    expect(line).toContain("收尾建议，非强制");
    // rides right after the budget line (the broadcast seam), before progress
    expect(line.indexOf("预算还剩约 400")).toBeGreaterThan(line.indexOf("预算：已花"));
    expect(line.indexOf("预算还剩约 400")).toBeLessThan(line.indexOf("进度："));
  });

  it("above the line, unbudgeted, and fresh (zero spent) stay silent — no noise", () => {
    const above = goalStatusLine(baseGoal({ tokensUsed: { input: 2000, output: 300 } }), { done: 1, total: 5 }); // 剩 2700 = 54%
    expect(above).not.toContain("收尾建议");
    const unbudgeted = goalStatusLine(baseGoal({ tokenBudget: undefined, tokensUsed: { input: 900, output: 100 } }), { done: 1, total: 3 });
    expect(unbudgeted).not.toContain("收尾建议");
    const fresh = goalStatusLine(baseGoal({ tokensUsed: { input: 0, output: 0 } }), { done: 0, total: 3 });
    expect(fresh).not.toContain("收尾建议");
  });

  it("goalNearBudgetRemaining: fraction line = max(1, floor(20% of budget)); boundary pinned on both sides", () => {
    expect(GOAL_NEAR_BUDGET_FRACTION).toBe(0.2);
    // budget 5000 → line 1000
    expect(goalNearBudgetRemaining(baseGoal({ tokensUsed: { input: 3999, output: 0 } }))).toBeUndefined(); // 剩 1001
    expect(goalNearBudgetRemaining(baseGoal({ tokensUsed: { input: 4000, output: 0 } }))).toBe(1000); // 剩 1000
    // tiny budget 4 → floor(0.8)=0 → line 1
    expect(goalNearBudgetRemaining(baseGoal({ tokenBudget: 4, tokensUsed: { input: 2, output: 0 } }))).toBeUndefined(); // 剩 2
    expect(goalNearBudgetRemaining(baseGoal({ tokenBudget: 4, tokensUsed: { input: 3, output: 0 } }))).toBe(1); // 剩 1
    // overspent clamps at zero (honest floor, still advises wrap-up)
    expect(goalNearBudgetRemaining(baseGoal({ tokensUsed: { input: 4900, output: 300 } }))).toBe(0);
  });

  it("the exhausted channel stays goalBudgetNote's — the suggestion never leaks into it", () => {
    const note = goalBudgetNote(baseGoal({ status: "budget_limited", tokensUsed: { input: 4500, output: 900 } }), undefined, { done: 2, total: 5 });
    expect(note).toContain("预算");
    expect(note).not.toContain("收尾建议");
    expect(note).not.toContain("停止开启新的探索");
  });
});

// ---------------------------------------------------------------------------
// 121 §4（CodeWhale budget death salvage）— 预算善终协议：the crossing stamps
// the honest death cause, and the budget note carries the wrap-up directive
// (the driver fires ONE salvage round whose first model call drains it).
// ---------------------------------------------------------------------------

describe("121 §4 — 预算善终：诚死因 deathCause + 收尾指引注记", () => {
  it("applyGoalSettlement stamps deathCause:budget_exhausted exactly at the crossing; normal settles and terminals never carry it", () => {
    // under the budget: no death cause
    const under = applyGoalSettlement(baseGoal(), { tokens: { input: 3000, output: 500 }, timeMs: 1000 });
    expect(under.crossedBudget).toBe(false);
    expect(under.goal.deathCause).toBeUndefined();
    // the crossing: status flips AND the death cause is stamped
    const crossed = applyGoalSettlement(under.goal, { tokens: { input: 1500, output: 500 }, timeMs: 1000 });
    expect(crossed.crossedBudget).toBe(true);
    expect(crossed.goal.status).toBe("budget_limited");
    expect(crossed.goal.deathCause).toBe("budget_exhausted");
    // settling an already-limited goal keeps counting, keeps the cause, reports no NEW crossing
    const again = applyGoalSettlement(crossed.goal, { tokens: { input: 100, output: 10 }, timeMs: 100 });
    expect(again.crossedBudget).toBe(false);
    expect(again.goal.deathCause).toBe("budget_exhausted");
    expect(again.goal.status).toBe("budget_limited");
    // an unbudgeted goal never crosses and never carries a cause
    const unbudgeted = applyGoalSettlement(baseGoal({ tokenBudget: undefined }), { tokens: { input: 10_000, output: 5_000 }, timeMs: 1 });
    expect(unbudgeted.crossedBudget).toBe(false);
    expect(unbudgeted.goal.deathCause).toBeUndefined();
  });

  it("the entry round-trips deathCause (additive lane); an UNKNOWN cause value drops the whole row (fail-safe parse law)", () => {
    const dead = baseGoal({ status: "budget_limited", deathCause: "budget_exhausted" });
    const entry = buildGoalStateEntry(dead);
    expect(entry.data).toMatchObject({ status: "budget_limited", deathCause: "budget_exhausted" });
    expect(parseGoalStateData(entry.data)).toMatchObject({ deathCause: "budget_exhausted" });
    // old rows without the field still load clean
    const { deathCause: _absent, ...legacy } = dead;
    void _absent;
    expect(parseGoalStateData(buildGoalStateEntry(legacy as GoalStateData).data)?.deathCause).toBeUndefined();
    // a future/unknown cause value is structurally wrong for THIS reader: the row drops
    const future = { ...buildGoalStateEntry(dead).data, deathCause: "context_overflow" } as unknown;
    expect(parseGoalStateData(future)).toBeUndefined();
  });

  it("goalBudgetNote carries the salvage directive (three wrap-up steps + no-new-tools), the death receipt, and the one-round honesty line", () => {
    const dead = baseGoal({ status: "budget_limited", deathCause: "budget_exhausted", tokensUsed: { input: 4500, output: 900 } });
    const note = goalBudgetNote(dead, { taskId: "t3", title: "联调收尾" }, { done: 2, total: 5 });
    expect(note.startsWith("<goal_context>\n")).toBe(true);
    expect(note).toContain("预算已耗尽。请立即做以下收尾：");
    expect(note).toContain("(1) 用一至两句话总结你已完成的部分");
    expect(note).toContain("(2) 列出还差什么没做");
    expect(note).toContain("(3) 如果有部分成果文件，确认已保存。");
    expect(note).toContain("不要再发起新的工具调用。");
    expect(note).toContain("死因已记录：budget_exhausted");
    expect(note).toContain("只自动触发这一次收尾回答"); // advisory-only, but exactly once
    expect(note).toContain("由用户决定"); // the user owns continuation/budget changes
    // a legacy limited goal without the field still gets the directive, just no death receipt line
    const legacy = goalBudgetNote(baseGoal({ status: "budget_limited", tokensUsed: { input: 4500, output: 900 } }), undefined, { done: 1, total: 2 });
    expect(legacy).toContain("不要再发起新的工具调用。");
    expect(legacy).not.toContain("死因已记录");
  });

  it("goalQueryText names the death cause for a budget-dead goal; a live goal carries no death line", () => {
    const dead = goalQueryText(baseGoal({ status: "budget_limited", deathCause: "budget_exhausted" }), { done: 1, total: 2 });
    expect(dead).toContain("死因：budget_exhausted");
    const live = goalQueryText(baseGoal(), { done: 1, total: 2 });
    expect(live).not.toContain("死因");
  });
});
