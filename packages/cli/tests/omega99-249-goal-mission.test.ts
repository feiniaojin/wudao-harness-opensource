// ω99-249: #9 — R2/R3/R4 — the GoalState runtime's mission derivation (anti
// dual-truth), run-boundary settlement, and the injection seam. The goal is a
// PROJECTION of the mission ledger: it materializes only for a claimed
// (doing) task that declared a token budget, its status follows the task's
// lifecycle deterministically, and its progress is the ledger's doing/done
// count — never a model self-report. Settlement lands at the run boundary
// (fire-and-forget entry append, never breaking the run chain); the short
// status line rides the SAME MetaNote queue 233's mode steering uses
// (tail-side projection, zero system-prompt prefix bytes).
import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelInput, AssistantMessage, GenericSessionEntry, SessionEntry } from "@wudao-org/core";
import type { ProviderConfig } from "@wudao-org/providers";
import { createGoalRuntime, createGoalTools, type GoalRuntime } from "../src/goal-runtime.js";
import { createMissionController, loadMissionStore, type MissionStoreHandle, type PlanTaskInput } from "../src/mission.js";
import type { MissionController, MissionState, MissionTask } from "../src/mission.js";
import { createDriverSession } from "../src/driver/session-engine.js";

// ---------------------------------------------------------------------------
// fixtures — ledger snapshots are plain MissionState literals behind a mutable
// holder (pure reads); entry appends go through a recording sink (in-memory,
// nothing touches disk outside the driver test's tmpdir).
// ---------------------------------------------------------------------------

const task = (id: string, over: Partial<MissionTask> = {}): MissionTask => ({
  id,
  title: `任务 ${id}`,
  dependsOn: [],
  status: "todo",
  attempts: 0,
  ...over,
});

const mission = (tasks: readonly MissionTask[], over: Partial<MissionState> = {}): MissionState => ({
  id: "m1",
  objective: "完成发布",
  createdAt: "2026-09-10T00:00:00.000Z",
  status: "active",
  tasks,
  ...over,
});

interface Recorder {
  readonly entries: GenericSessionEntry[];
  failNext: boolean;
}

const recorder = (): Recorder => ({ entries: [], failNext: false });

const makeRuntime = (
  getMission: () => MissionState | undefined,
  rec: Recorder = recorder(),
): { runtime: GoalRuntime; rec: Recorder } => ({
  runtime: createGoalRuntime({
    appendEntry: async (entry) => {
      if (rec.failNext) {
        rec.failNext = false;
        throw new Error("simulated persist failure");
      }
      rec.entries.push(entry);
    },
    getMission,
  }),
  rec,
});

const goalRows = (rec: Recorder): readonly { type: string; data: Record<string, unknown> }[] =>
  rec.entries.filter((e) => e.type === "goal_state") as unknown as { type: string; data: Record<string, unknown> }[];

describe("ω99-249 R2 — goal 从 mission 任务派生（防双头真相）", () => {
  it("materializes ONLY for a doing task that declared a budget — missionTaskId bound, objective derived from title+detail", () => {
    const ledger = { current: mission([task("t1", { status: "done" }), task("t2", { status: "doing", title: "写认证模块", detail: "覆盖登录", budgetTokens: 5000 })]) };
    const { runtime, rec } = makeRuntime(() => ledger.current);
    const line = runtime.onRunStart();
    expect(line).toBeDefined();
    expect(line).toContain("写认证模块");
    const rows = goalRows(rec);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.data).toMatchObject({ missionTaskId: "t2", status: "active", tokenBudget: 5000, objective: "写认证模块——覆盖登录" });
  });

  it("NO budget on the doing task → no goal, no row, no injection (zero noise)", () => {
    const ledger = { current: mission([task("t2", { status: "doing" })]) };
    const { runtime, rec } = makeRuntime(() => ledger.current);
    expect(runtime.onRunStart()).toBeUndefined();
    expect(goalRows(rec)).toHaveLength(0);
    expect(runtime.webSnapshot()).toBeNull();
  });

  it("multiple budgeted doing tasks → the LAST ledger-order task (deterministic single goal)", () => {
    const ledger = { current: mission([task("t2", { status: "doing", budgetTokens: 1000 }), task("t3", { status: "doing", budgetTokens: 2000 })]) };
    const { runtime } = makeRuntime(() => ledger.current);
    runtime.onRunStart();
    expect(runtime.snapshot()).toMatchObject({ missionTaskId: "t3", tokenBudget: 2000 });
  });

  it("随动 doing→done→complete; fail retry→paused; re-claim→active; failed→error; task gone→error; mission abandoned→error", () => {
    const ledger = {
      current: mission([
        task("t1", { status: "done" }),
        task("t2", { status: "doing", budgetTokens: 5000 }),
        task("t3", { status: "todo", dependsOn: ["t2"] }),
      ]),
    };
    const { runtime } = makeRuntime(() => ledger.current);
    runtime.onRunStart();
    expect(runtime.snapshot()!.status).toBe("active");
    // mission_complete landed mid-run → the settle reconcile projects done
    ledger.current = mission([task("t1", { status: "done" }), task("t2", { status: "done" }), task("t3", { status: "todo", dependsOn: ["t2"] })]);
    runtime.onRunSettle({ input: 100, output: 20, ms: 1000 });
    expect(runtime.snapshot()!.status).toBe("complete");
    // a NEW budgeted claim after the old goal closed materializes a fresh goal
    ledger.current = mission([task("t1", { status: "done" }), task("t2", { status: "done" }), task("t3", { status: "doing", budgetTokens: 800 })]);
    runtime.onRunStart();
    expect(runtime.snapshot()).toMatchObject({ missionTaskId: "t3", status: "active", tokenBudget: 800 });
    // fail retry: doing→todo (attempts+1) → paused
    ledger.current = mission([task("t1", { status: "done" }), task("t2", { status: "done" }), task("t3", { status: "todo", budgetTokens: 800 })]);
    runtime.onRunStart();
    expect(runtime.snapshot()!.status).toBe("paused");
    // re-claim: todo→doing → active again (paused→active is the designed resume)
    ledger.current = mission([task("t1", { status: "done" }), task("t2", { status: "done" }), task("t3", { status: "doing", budgetTokens: 800 })]);
    runtime.onRunStart();
    expect(runtime.snapshot()!.status).toBe("active");
    // terminal failed → error, and a failed task never re-materializes (no injection)
    ledger.current = mission([task("t1", { status: "done" }), task("t2", { status: "done" }), task("t3", { status: "failed", budgetTokens: 800 })]);
    runtime.onRunStart();
    expect(runtime.snapshot()!.status).toBe("error");
    expect(runtime.onRunStart()).toBeUndefined();
    // task disappears from the ledger → honest error for a restored live goal
    const live = makeRuntime(() => mission([task("t2", { status: "doing", budgetTokens: 5000 })]));
    live.runtime.onRunStart();
    const gone = makeRuntime(() => mission([task("t9", { status: "doing" })]));
    expect(gone.runtime.restoreFromEntries([...live.rec.entries] as readonly SessionEntry[])).toBe(true);
    gone.runtime.onRunStart();
    expect(gone.runtime.snapshot()!.status).toBe("error");
    // mission abandoned → the LIVE goal errors with it (the goal must exist
    // first — an abandoned mission never materializes a new one)
    const abandonedLedger = { current: mission([task("t5", { status: "doing", budgetTokens: 100 })]) };
    const abandoned = makeRuntime(() => abandonedLedger.current);
    abandoned.runtime.onRunStart();
    expect(abandoned.runtime.snapshot()!.status).toBe("active");
    abandonedLedger.current = mission([task("t5", { status: "doing", budgetTokens: 100 })], { status: "abandoned" });
    abandoned.runtime.onRunStart();
    expect(abandoned.runtime.snapshot()!.status).toBe("error");
    // mission completed (flipped terminal with task still doing) → complete
    const completedLedger = { current: mission([task("t5", { status: "doing", budgetTokens: 100 })]) };
    const completed = makeRuntime(() => completedLedger.current);
    completed.runtime.onRunStart();
    completedLedger.current = mission([task("t5", { status: "doing", budgetTokens: 100 })], { status: "completed" });
    completed.runtime.onRunStart();
    expect(completed.runtime.snapshot()!.status).toBe("complete");
  });

  it("progress is the ledger's doing/done projection — a model CLAIM of completion moves nothing (no self-report input exists)", () => {
    const ledger = {
      current: mission([
        task("t1", { status: "done" }),
        task("t2", { status: "doing", budgetTokens: 5000 }),
        task("t3", { status: "todo", dependsOn: ["t2"] }),
      ]),
    };
    const { runtime } = makeRuntime(() => ledger.current);
    runtime.onRunStart();
    // whatever the model SAYS in its answers (even "t2 已完成") is not an input
    // the runtime reads: query()/webSnapshot() derive from the ledger alone.
    const q = runtime.query();
    expect(q.text).toContain("1/3");
    expect(q.text).toContain("进行中");
    expect(runtime.webSnapshot()).toMatchObject({ progress: { done: 1, total: 3 }, status: "active" });
    // flipping the LEDGER (the only truth) is what moves the projection
    ledger.current = mission([task("t1", { status: "done" }), task("t2", { status: "done", budgetTokens: 5000 }), task("t3", { status: "todo", dependsOn: ["t2"] })]);
    runtime.onRunSettle({ input: 10, output: 5, ms: 100 });
    expect(runtime.webSnapshot()).toBeNull(); // terminal → no live face
  });

  it("query() without a goal is the honest none-face; restoreFromEntries replays a persisted live goal with counters intact", () => {
    const none = makeRuntime(() => undefined);
    const q = none.runtime.query();
    expect(q.none).toBe(true);
    expect(q.text).toContain("没有");

    const ledger = { current: mission([task("t2", { status: "doing", budgetTokens: 5000 })]) };
    const src = makeRuntime(() => ledger.current);
    src.runtime.onRunStart();
    src.runtime.onRunSettle({ input: 1000, output: 200, ms: 9000 });
    const restored = makeRuntime(() => ledger.current);
    expect(restored.runtime.restoreFromEntries([...src.rec.entries] as readonly SessionEntry[])).toBe(true);
    expect(restored.runtime.snapshot()).toMatchObject({ missionTaskId: "t2", status: "active", tokensUsed: { input: 1000, output: 200 }, timeUsedMs: 9000 });
  });
});

describe("ω99-249 R3 — 轮界预算结算（分计、安全暂停建议、失败不破坏主链）", () => {
  it("settlements accumulate input/output separately across runs; rows carry the split", () => {
    const ledger = { current: mission([task("t2", { status: "doing", budgetTokens: 10_000 })]) };
    const { runtime, rec } = makeRuntime(() => ledger.current);
    runtime.onRunStart();
    runtime.onRunSettle({ input: 1000, output: 100, ms: 5000 });
    runtime.onRunSettle({ input: 2000, output: 50, ms: 3000 });
    const rows = goalRows(rec);
    expect(rows).toHaveLength(3); // materialize + two settle rows
    expect(rows[2]!.data).toMatchObject({ status: "active", tokensUsed: { input: 3000, output: 150 }, timeUsedMs: 8000 });
    expect(runtime.snapshot()!.tokensUsed).toEqual({ input: 3000, output: 150 });
  });

  it("budget crossing → budget_limited + a safe-pause note naming the DEEPEST doing node (topology pinned)", () => {
    const ledger = {
      current: mission([
        task("t1", { status: "done" }),
        task("t2", { status: "doing", budgetTokens: 1500 }),
        task("t3", { status: "doing", dependsOn: ["t2"] }),
      ]),
    };
    const { runtime } = makeRuntime(() => ledger.current);
    runtime.onRunStart();
    const crossed = runtime.onRunSettle({ input: 1400, output: 200, ms: 1000 }); // 1600 ≥ 1500
    expect(crossed).toBeDefined();
    expect(crossed!.budgetNote).toContain("t3"); // deepest doing (depth 3), not t2
    expect(crossed!.budgetNote).toContain("安全暂停");
    expect(runtime.snapshot()!.status).toBe("budget_limited");
    // already limited: still counts, no new note
    const again = runtime.onRunSettle({ input: 100, output: 10, ms: 100 });
    expect(again).toBeUndefined();
    expect(runtime.snapshot()!.tokensUsed).toEqual({ input: 1500, output: 210 });
    // the NEXT run's injected line is the budget note face
    const line = runtime.onRunStart();
    expect(line).toContain("预算");
  });

  it("continuationsUsed counts the goal's compactions; mid-turn compaction + same-run continuation just counts (no rollback face exists)", () => {
    const ledger = { current: mission([task("t2", { status: "doing", budgetTokens: 100_000 })]) };
    const { runtime } = makeRuntime(() => ledger.current);
    runtime.onRunStart();
    runtime.onCompacted();
    runtime.onCompacted();
    runtime.onRunSettle({ input: 10, output: 1, ms: 10 });
    expect(runtime.snapshot()!.continuationsUsed).toBe(2);
    // compactions with NO live goal count for nothing
    const none = makeRuntime(() => undefined);
    none.runtime.onCompacted();
    const later = makeRuntime(() => mission([task("t4", { status: "doing", budgetTokens: 100 })]));
    later.runtime.onRunStart();
    later.runtime.onRunSettle({ input: 1, output: 1, ms: 1 });
    expect(later.runtime.snapshot()!.continuationsUsed).toBe(0);
  });

  it("settlement entry failure NEVER breaks the run chain (fire-and-forget) — the next settle still works; a paused goal does not settle", () => {
    const ledger = { current: mission([task("t2", { status: "doing", budgetTokens: 5000 })]) };
    const { runtime, rec } = makeRuntime(() => ledger.current);
    runtime.onRunStart();
    rec.failNext = true;
    expect(() => runtime.onRunSettle({ input: 100, output: 10, ms: 100 })).not.toThrow();
    // the in-memory accumulation survived the failed persist
    expect(runtime.snapshot()!.tokensUsed).toEqual({ input: 100, output: 10 });
    runtime.onRunSettle({ input: 50, output: 5, ms: 50 });
    expect(runtime.snapshot()!.tokensUsed).toEqual({ input: 150, output: 15 });
    // a PAUSED goal does not settle (its task is not the running focus)
    const pausedLedger = { current: mission([task("t2", { status: "doing", budgetTokens: 5000 })]) };
    const p = makeRuntime(() => pausedLedger.current);
    p.runtime.onRunStart();
    pausedLedger.current = mission([task("t2", { status: "todo", budgetTokens: 5000 })]);
    p.runtime.onRunStart(); // reconcile → paused
    expect(p.runtime.onRunSettle({ input: 999, output: 99, ms: 999 })).toBeUndefined();
    expect(p.runtime.snapshot()!.status).toBe("paused");
    expect(p.runtime.snapshot()!.tokensUsed).toEqual({ input: 0, output: 0 });
  });
});

describe("ω99-249 R2 — mission_plan 的 budgetTokens 声明面（goal 的唯一预算真相）", () => {
  const fixtureStore = (): MissionStoreHandle & { read: () => MissionState | null } => {
    let persisted: MissionState | null = null;
    return {
      get mission() {
        return persisted;
      },
      save: async (next) => {
        persisted = next;
      },
      read: () => persisted,
    };
  };
  const mkController = async (store: MissionStoreHandle): Promise<MissionController> =>
    createMissionController({ workspaceRoot: "/tmp/o249-unused-ws", notify: () => {}, store });

  it("plan() carries budgetTokens onto the task (receipt names it); invalid budgets refuse the whole batch atomically", async () => {
    const store = fixtureStore();
    const controller = await mkController(store);
    await controller.start("完成发布");
    const ok = await controller.plan([{ title: "写认证模块", budgetTokens: 5000 }, { title: "联调" }] as readonly PlanTaskInput[]);
    expect(ok.ok).toBe(true);
    expect(ok.text).toContain("预算 5000 tokens");
    const tasks = store.read()!.tasks;
    expect(tasks[0]).toMatchObject({ id: "t1", budgetTokens: 5000 });
    expect(tasks[1]).toMatchObject({ id: "t2" });
    expect(tasks[1]!.budgetTokens).toBeUndefined();
    // invalid shapes refuse BEFORE any ledger write (fail-closed)
    const before = store.read();
    for (const bad of [0, -5, 2.5, "5000"] as unknown as number[]) {
      const r = await controller.plan([{ title: "x", budgetTokens: bad }] as readonly PlanTaskInput[]);
      expect(r.ok).toBe(false);
      expect(r.text).toContain("budgetTokens");
    }
    expect(store.read()).toBe(before); // atomic refusal — nothing landed
  });

  it("the ledger round-trip keeps budgetTokens (validMission passes; old ledgers without it load clean)", async () => {
    // ★红线：夹具只写 tmpdir 且不做任何删除——目录留给 OS 清理。
    const ws = mkdtempSync(join(tmpdir(), "o249-goal-ledger-"));
    const store = await loadMissionStore({ workspaceRoot: ws });
    const controller = await createMissionController({ workspaceRoot: ws, notify: () => {}, store });
    await controller.start("完成发布");
    await controller.plan([{ title: "写认证模块", budgetTokens: 1234 }] as readonly PlanTaskInput[]);
    const reloaded = await loadMissionStore({ workspaceRoot: ws });
    expect(reloaded.mission!.tasks[0]).toMatchObject({ budgetTokens: 1234 });
  });
});

describe("ω99-249 R4 — 注入缝与 goal 查询面（runtime 面）", () => {
  it("the injected line is <goal_context>-wrapped and absent without a goal (zero noise)", () => {
    const withGoal = makeRuntime(() => mission([task("t2", { status: "doing", budgetTokens: 500 })]));
    const line = withGoal.runtime.onRunStart();
    expect(line!.startsWith("<goal_context>\n")).toBe(true);
    expect(line!.trimEnd().endsWith("</goal_context>")).toBe(true);
    const noGoal = makeRuntime(() => mission([task("t2", { status: "doing" })]));
    expect(noGoal.runtime.onRunStart()).toBeUndefined();
    expect(noGoal.runtime.webSnapshot()).toBeNull();
  });

  it("the goal tool is read-only and reports the query face (or the honest none-face)", async () => {
    const ledger = { current: mission([task("t1", { status: "done" }), task("t2", { status: "doing", title: "写认证模块", budgetTokens: 5000 })]) };
    const { runtime } = makeRuntime(() => ledger.current);
    runtime.onRunStart();
    runtime.onRunSettle({ input: 1000, output: 200, ms: 8000 });
    const tools = createGoalTools(() => runtime);
    expect(tools).toHaveLength(1);
    const goal = tools[0]!;
    expect(goal.name).toBe("goal");
    expect(goal.isReadOnly()).toBe(true);
    expect(goal.isConcurrencySafe()).toBe(true);
    const r = await goal.execute({});
    expect(r.isError).toBeUndefined();
    expect(r.content).toContain("写认证模块");
    expect(r.content).toContain("1/2"); // ledger progress
    expect(r.content).toContain("1200"); // used total
    expect(r.content).toContain("5000"); // budget
    // the none-face: a wired runtime with NO live goal answers honestly
    // (not an error); an UNWIRED runtime refuses like the mission tools do.
    const noneRuntime = makeRuntime(() => mission([task("t2", { status: "doing" })]));
    const noneTools = createGoalTools(() => noneRuntime.runtime);
    const noneR = await noneTools[0]!.execute({});
    expect(noneR.isError).toBeUndefined();
    expect(noneR.content).toContain("没有");
    const unwired = createGoalTools(() => undefined);
    const unwiredR = await unwired[0]!.execute({});
    expect(unwiredR.isError).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The DRIVER seam — the real wiring: injection lands on the model input
// (MetaNote tail projection), the system prompt's bytes never move, and
// DriverStatus carries the web face. Harness shape: goal-driver-budget-meter
// .test.ts (offline boot + scripted model + stub swap over missionBox).
// ---------------------------------------------------------------------------

const wait = (ms: number) => new Promise((res) => setTimeout(res, ms));
async function untilFn(cond: () => boolean | Promise<boolean>, what: string, timeoutMs = 8000): Promise<void> {
  const start = Date.now();
  await wait(10);
  while (!(await cond())) {
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${what}`);
    await wait(10);
  }
}

describe("ω99-249 R4 — driver 缝：注入落模型输入、前缀字节零变、status 露出", () => {
  it("goal line rides the MetaNote seam onto the model input; system-prompt bytes are IDENTICAL with and without a goal (M24 zero prefix change)", async () => {
    const roots: string[] = [];
    const savedEnv: Record<string, string | undefined> = {};
    for (const k of ["WUDAO_GLOBAL_HOME", "WUDAO_API_KEY", "WUDAO_API_KEYS", "OPENAI_API_KEY"] as const) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
    const config: ProviderConfig = { apiKey: "test-key", baseURL: "http://127.0.0.1:1/v1", model: "fake-goal-model" };
    const inputs: { systemPrompt: string; messages: { role: string; content: string }[] }[] = [];
    const model = {
      async generate(input: ModelInput): Promise<AssistantMessage> {
        inputs.push({ systemPrompt: input.systemPrompt, messages: input.messages.map((m) => ({ role: m.role, content: m.content })) });
        if (input.querySource === undefined) input.onUsage?.({ promptTokens: 1200, cacheHitTokens: 0, cacheMissTokens: 1200, completionTokens: 300 });
        return { role: "assistant", content: "OK" };
      },
    };
    const home = mkdtempSync(join(tmpdir(), "o249-drv-home-"));
    const ws = mkdtempSync(join(tmpdir(), "o249-drv-ws-"));
    roots.push(home, ws);
    process.env.WUDAO_GLOBAL_HOME = home;
    type Session = Awaited<ReturnType<typeof createDriverSession>>;
    const sessions: Session[] = [];
    try {
      // Control session: no mission → no goal → zero injection.
      const control = await createDriverSession({ config, workspaceRoot: ws, contextWindowTokens: 64_000, tools: [], sessionId: "o249-ctrl", modelOverride: model, noPeer: true });
      sessions.push(control);
      control.driver.submit("hi");
      await untilFn(() => control.driver.getStatus().busy === false, "control run settle");
      expect(inputs.length).toBeGreaterThan(0);
      const controlPrompt = inputs[0]!.systemPrompt;
      expect(JSON.stringify(inputs.map((x) => x.messages))).not.toContain("goal_context");
      expect(control.driver.getStatus().goal).toBeNull();

      // Goal session: a stub mission controller whose ledger has a budgeted doing task.
      const goalSession = await createDriverSession({ config, workspaceRoot: ws, contextWindowTokens: 64_000, tools: [], sessionId: "o249-goal", modelOverride: model, noPeer: true });
      sessions.push(goalSession);
      const ledger = { current: mission([task("t1", { status: "done" }), task("t2", { status: "doing", title: "写认证模块", budgetTokens: 5000 })]) };
      goalSession.missionBox.current = { snapshot: () => ledger.current } as unknown as MissionController;
      const before = inputs.length;
      goalSession.driver.submit("work on it");
      await untilFn(() => goalSession.driver.getStatus().busy === false, "goal run settle");
      const goalRunInputs = inputs.slice(before).filter((x) => x.messages.length > 0);
      expect(goalRunInputs.length).toBeGreaterThan(0);
      // M24 direct evidence: the system prompt bytes are IDENTICAL with a live goal.
      expect(goalRunInputs[0]!.systemPrompt).toBe(controlPrompt);
      // the injected line landed on the FIRST model call's message tail (MetaNote projection), never in the system prompt.
      expect(goalRunInputs[0]!.systemPrompt.includes("goal_context")).toBe(false);
      const firstCallTail = goalRunInputs[0]!.messages[goalRunInputs[0]!.messages.length - 1]!;
      expect(firstCallTail.content).toContain("goal_context");
      expect(firstCallTail.content).toContain("t2");
      // settlement landed at the run boundary: the status face carries the goal with the split usage.
      const g = goalSession.driver.getStatus().goal;
      expect(g).toMatchObject({ missionTaskId: "t2", status: "active", usedTokens: 1500, budgetTokens: 5000, progress: { done: 1, total: 2 } });
      if (g !== null) {
        expect(g.inputTokens).toBe(1200);
        expect(g.outputTokens).toBe(300);
      }
    } finally {
      for (const s of sessions.splice(0)) await s.close().catch(() => {});
      for (const k of Object.keys(savedEnv)) {
        if (savedEnv[k] === undefined) delete process.env[k];
        else process.env[k] = savedEnv[k] as string;
      }
      // ★红线：夹具目录只写 tmpdir 且不做任何删除——留给 OS 清理。
    }
  });
});
