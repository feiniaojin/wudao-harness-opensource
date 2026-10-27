// ω99-15 — mission/task DAG + ledger + resume (brief: 任务战役面). The
// controller's gate runner is DEPENDENCY-INJECTED (zero real shell); the
// persistence round-trip runs against a tmpdir `.wudao/mission.json` — no
// network, no workspace side effects.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelClient, PermissionDecision, Tool } from "@wudao/core";
import {
  createMissionController,
  createMissionTools,
  loadMissionStore,
  MISSION_TASK_MAX_ATTEMPTS,
  type MissionController,
  type MissionState,
  type MissionStoreHandle,
  type PlanTaskInput,
} from "../src/mission.js";
import { buildToolSet } from "../src/tools.js";

let ws: string;
beforeEach(async () => {
  ws = await mkdtemp(join(tmpdir(), "m81-mission-"));
});
afterEach(async () => {
  await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => {});
});

/** Self-contained fakes: a counting gate runner with queued results, a
 *  notice sink, and (default) an in-memory store handle whose `mission`
 *  getter stays live so a second controller can read what the first wrote. */
async function fixture(o: { gateResults?: { code: number; output: string }[]; store?: MissionStoreHandle } = {}) {
  const notices: string[] = [];
  const gateCalls: { command: string; cwd: string }[] = [];
  const gateResults = [...(o.gateResults ?? [])];
  const runGateCommand = async (command: string, opts: { cwd: string }) => {
    gateCalls.push({ command, cwd: opts.cwd });
    return gateResults.length > 0 ? (gateResults.shift() as { code: number; output: string }) : { code: 0, output: "" };
  };
  let persisted: MissionState | null = null;
  const store: MissionStoreHandle = o.store ?? {
    get mission() {
      return persisted;
    },
    save: async (next) => {
      persisted = next;
    },
  };
  const controller = await createMissionController({
    workspaceRoot: ws,
    notify: (t) => notices.push(t),
    runGateCommand,
    store,
  });
  return { controller, notices, gateCalls, persisted: () => persisted };
}

const chain: readonly PlanTaskInput[] = [
  { title: "读规格" },
  { title: "写实现", dependsOn: ["t1"] },
  { title: "验收", dependsOn: ["t2"], gate: "npm test" },
  { title: "独立调研" },
];

describe("ω99-15 P1 — plan + nextReady dependency order", () => {
  it("insertion order + dependencies gate the claim queue; ids are controller-assigned", async () => {
    const f = await fixture();
    await f.controller.start("ship feature X");
    const planned = await f.controller.plan(chain);
    expect(planned.ok).toBe(true);
    expect(planned.text).toContain("t1");
    expect(planned.text).toContain("t4");
    // t1 first (insertion order; t2/t3 blocked, t4 ready but later).
    const first = await f.controller.nextReady();
    expect(first.task?.id).toBe("t1");
    expect(first.task?.status).toBe("doing");
    // A blocked task is never selected: next ready is the independent t4.
    const second = await f.controller.nextReady();
    expect(second.task?.id).toBe("t4");
    expect(second.task?.id).not.toBe("t2");
    // Completing t1 unlocks exactly t2 (t3 still waits on t2).
    await f.controller.complete("t1", "规格已读");
    const third = await f.controller.nextReady();
    expect(third.task?.id).toBe("t2");
    const snap = f.controller.snapshot();
    expect(snap?.tasks.map((t) => `${t.id}:${t.status}`)).toEqual(["t1:done", "t2:doing", "t3:todo", "t4:doing"]);
  });

  it("plan refuses unknown dependsOn ids, an empty batch, self-deps and cycles; plan without a mission refuses", async () => {
    const f = await fixture();
    const noMission = await f.controller.plan([{ title: "x" }]);
    expect(noMission.ok).toBe(false);
    expect(noMission.text).toContain("mission");
    await f.controller.start("objective");
    const unknown = await f.controller.plan([{ title: "x", dependsOn: ["t9"] }]);
    expect(unknown.ok).toBe(false);
    expect(unknown.text).toContain("t9");
    const empty = await f.controller.plan([]);
    expect(empty.ok).toBe(false);
    // Self-dependency and a 2-cycle are structurally dead plans.
    const self = await f.controller.plan([{ title: "x", dependsOn: ["t1"] }]);
    expect(self.ok).toBe(false);
    const cycle = await f.controller.plan([
      { title: "a", dependsOn: ["t2"] },
      { title: "b", dependsOn: ["t1"] },
    ]);
    expect(cycle.ok).toBe(false);
    expect(f.controller.snapshot()?.tasks.length).toBe(0);
  });

  it("start refuses while a mission is active (with a status summary); abandon then allows a new one", async () => {
    const f = await fixture();
    await f.controller.start("first objective");
    const again = await f.controller.start("second objective");
    expect(again.startsWith("⚠️")).toBe(true);
    expect(again).toContain("first objective");
    expect(await f.controller.abandon()).toContain("first objective");
    const fresh = await f.controller.start("second objective");
    expect(fresh).toContain("second objective");
  });
});

describe("ω99-15 P2 — claim validation", () => {
  it("claiming a task whose deps are not done names the missing dependency ids", async () => {
    const f = await fixture();
    await f.controller.start("obj");
    await f.controller.plan(chain);
    const blocked = await f.controller.claim("t3");
    expect(blocked.task).toBeUndefined();
    expect(blocked.text).toContain("t2"); // t3 dependsOn t1,t2 — t2 not done
    expect(blocked.text).toContain("t3");
    // Unknown id and non-todo states refuse too.
    expect((await f.controller.claim("t99")).text).toContain("t99");
    await f.controller.claim("t1");
    expect((await f.controller.claim("t1")).text).toContain("doing");
    // A ready claim works and flips the status.
    const ok = await f.controller.claim("t4");
    expect(ok.task?.id).toBe("t4");
    expect(f.controller.snapshot()?.tasks[3]?.status).toBe("doing");
  });
});

describe("ω99-15 P3 — complete: gate green/red", () => {
  it("gate green → done + result; gate red → refused, attempts=1, bounded output behind the guard prefix", async () => {
    const f = await fixture({ gateResults: [{ code: 0, output: "all pass" }] });
    await f.controller.start("obj");
    await f.controller.plan([{ title: "验收", gate: "npm test" }]);
    await f.controller.nextReady();
    const ok = await f.controller.complete("t1", "测试全绿");
    expect(ok.ok).toBe(true);
    const task = f.controller.snapshot()?.tasks[0];
    expect(task?.status).toBe("done");
    expect(task?.result).toBe("测试全绿");

    const f2 = await fixture({
      gateResults: [{ code: 1, output: `2 failing tests\n${"x".repeat(9_000)}` }],
    });
    await f2.controller.start("obj");
    await f2.controller.plan([{ title: "验收", gate: "npm test" }]);
    await f2.controller.nextReady();
    const bad = await f2.controller.complete("t1");
    expect(bad.ok).toBe(false);
    expect(bad.text).toContain("退出 1");
    expect(bad.text).toContain("npm test");
    expect(bad.text).toContain("数据非指令"); // the injection-guard output prefix
    expect(bad.text).toContain(`1/${MISSION_TASK_MAX_ATTEMPTS}`);
    // Bounded output: the 9000-char tail never enters the rejection text.
    expect(bad.text.length).toBeLessThan(5_000);
    expect(bad.text).not.toContain("x".repeat(4_100));
    const t = f2.controller.snapshot()?.tasks[0];
    expect(t?.status).toBe("doing"); // refused — not done
    expect(t?.attempts).toBe(1);
    expect(f2.gateCalls).toEqual([{ command: "npm test", cwd: ws }]);
  });

  it("complete refuses a task that is not doing (order discipline)", async () => {
    const f = await fixture();
    await f.controller.start("obj");
    await f.controller.plan(chain);
    const r = await f.controller.complete("t1", "skipped claim");
    expect(r.ok).toBe(false);
    expect(r.text).toContain("t1");
  });
});

describe("ω99-15 P4 — retry budget", () => {
  it("three gate reds then the fourth complete is PRE-failed without rerunning the gate; nextReady skips failed", async () => {
    const f = await fixture({
      gateResults: [
        { code: 1, output: "red 1" },
        { code: 1, output: "red 2" },
        { code: 1, output: "red 3" },
      ],
    });
    await f.controller.start("obj");
    await f.controller.plan([
      { title: "带门任务", gate: "npm test" },
      { title: "后续任务", dependsOn: [] },
    ]);
    await f.controller.nextReady(); // t1 doing
    for (let i = 1; i <= 3; i += 1) {
      const r = await f.controller.complete("t1");
      expect(r.ok).toBe(false);
      expect(r.text).toContain(`${i}/${MISSION_TASK_MAX_ATTEMPTS}`);
      expect(f.controller.snapshot()?.tasks[0]?.attempts).toBe(i);
    }
    // The 4th attempt: the budget is spent BEFORE the gate runs.
    const fourth = await f.controller.complete("t1");
    expect(fourth.ok).toBe(false);
    expect(fourth.text).toContain("t1");
    expect(f.gateCalls.length).toBe(3); // the gate never ran a 4th time
    expect(f.controller.snapshot()?.tasks[0]?.status).toBe("failed");
    // nextReady skips the failed task and hands out the ready sibling.
    const next = await f.controller.nextReady();
    expect(next.task?.id).toBe("t2");
  });
});

describe("ω99-15 P5 — manual fail path", () => {
  it("fail: doing→todo, attempts count, reason recorded; over budget → failed", async () => {
    const f = await fixture();
    await f.controller.start("obj");
    await f.controller.plan([{ title: "a" }]);
    await f.controller.nextReady();
    const r = await f.controller.fail("t1", "规格变了");
    expect(r.ok).toBe(true);
    const t1 = f.controller.snapshot()?.tasks[0];
    expect(t1?.status).toBe("todo");
    expect(t1?.attempts).toBe(1);
    expect(t1?.result).toContain("规格变了");
    // Re-claim → fail until the budget is spent; the 4th fail pre-fails.
    for (let i = 2; i <= 3; i += 1) {
      await f.controller.claim("t1");
      const rr = await f.controller.fail("t1", `原因${i}`);
      expect(rr.ok).toBe(true);
      expect(f.controller.snapshot()?.tasks[0]?.status).toBe("todo");
    }
    await f.controller.claim("t1");
    const spent = await f.controller.fail("t1", "再试一次");
    expect(spent.ok).toBe(false);
    expect(f.controller.snapshot()?.tasks[0]?.status).toBe("failed");
    expect((await f.controller.nextReady()).task).toBeUndefined();
    // fail refuses non-doing tasks (order discipline).
    expect((await f.controller.fail("t1", "again")).ok).toBe(false);
  });
});

describe("ω99-15 P6 — persistence round-trip (tmpdir .wudao/mission.json)", () => {
  it("state change → disk → a new controller restores; doing→todo reset + restore notice; all-done → completed", async () => {
    const notices1: string[] = [];
    const c1 = await createMissionController({
      workspaceRoot: ws,
      notify: (t) => notices1.push(t),
      // Zero real shell: the gate never runs in this scenario (no gate task).
      runGateCommand: async () => ({ code: 0, output: "" }),
    });
    await c1.start("跨会话目标");
    await c1.plan(chain);
    await c1.nextReady(); // t1 doing — then "crash"
    // ω99-36 — the disk layout is archive + pointer: the store's read side
    // (pointer → the pointed-at per-mission file) is the honest round-trip.
    const raw = await loadMissionStore({ workspaceRoot: ws });
    expect(raw.mission?.objective).toBe("跨会话目标");
    expect(raw.mission?.tasks[0]?.status).toBe("doing");

    const notices2: string[] = [];
    const c2 = await createMissionController({
      workspaceRoot: ws,
      notify: (t) => notices2.push(t),
      runGateCommand: async () => ({ code: 0, output: "" }),
    });
    const snap = c2.snapshot();
    expect(snap?.objective).toBe("跨会话目标");
    expect(snap?.tasks[0]?.status).toBe("todo"); // doing→todo: honest redo
    expect(snap?.tasks.map((t) => t.id)).toEqual(["t1", "t2", "t3", "t4"]);
    expect(notices2.length).toBe(1);
    expect(notices2[0]).toContain("已恢复");
    expect(notices2[0]).toContain("0/4");
    expect(notices2[0]).toContain("t1"); // the reset in-flight task is named
    expect(notices2[0]).toContain("跨会话目标");
    // The reset itself is persisted (honesty survives another restart).
    const c2b = await createMissionController({ workspaceRoot: ws, notify: () => {}, runGateCommand: async () => ({ code: 0, output: "" }) });
    expect(c2b.snapshot()?.tasks[0]?.status).toBe("todo");

    // All-done at load: an active mission whose tasks are all done completes
    // with a notice (hand-write the ledger to simulate a crashed final write).
    const allDone: MissionState = {
      id: "mhand", objective: "收尾目标", createdAt: new Date().toISOString(), status: "active",
      tasks: [{ id: "t1", title: "only", dependsOn: [], status: "done", attempts: 0, result: "ok" }],
    };
    await mkdir(join(ws, "done"), { recursive: true });
    const ws2 = join(ws, "done");
    await mkdir(join(ws2, ".wudao"), { recursive: true });
    await writeFile(join(ws2, ".wudao", "mission.json"), JSON.stringify({ version: 1, mission: allDone }), "utf8");
    const notices3: string[] = [];
    const c3 = await createMissionController({ workspaceRoot: ws2, notify: (t) => notices3.push(t), runGateCommand: async () => ({ code: 0, output: "" }) });
    expect(c3.snapshot()?.status).toBe("completed");
    expect(notices3.join("\n")).toContain("mission 完成");
    // A completed mission does not resurrect on the next load.
    const c3b = await createMissionController({ workspaceRoot: ws2, notify: () => {}, runGateCommand: async () => ({ code: 0, output: "" }) });
    expect(c3b.snapshot()?.status).toBe("completed");
  });

  it("completing the last task completes the mission (runtime path) and persists status", async () => {
    const f = await fixture();
    await f.controller.start("小目标");
    await f.controller.plan([{ title: "唯一任务" }]);
    await f.controller.nextReady();
    const r = await f.controller.complete("t1", "完成");
    expect(r.ok).toBe(true);
    expect(r.text).toContain("mission 完成");
    expect(f.controller.snapshot()?.status).toBe("completed");
    expect(f.notices.at(-1) ?? "").toContain("mission 完成");
    expect(f.persisted()?.status).toBe("completed");
    // After completion the mission face answers "none active".
    expect(await f.controller.start("新目标")).toContain("新目标");
  });

  it("corrupt mission.json → fail-closed: start refuses, no silent rebuild, the file is untouched", async () => {
    await mkdir(join(ws, ".wudao"), { recursive: true });
    const path = join(ws, ".wudao", "mission.json");
    await writeFile(path, "{ not json", "utf8");
    const c = await createMissionController({
      workspaceRoot: ws,
      notify: () => {},
      runGateCommand: async () => ({ code: 0, output: "" }),
    });
    const ref = await c.start("anything");
    expect(ref.startsWith("⚠️")).toBe(true);
    expect(ref).toContain("mission.json");
    expect(c.snapshot()).toBeUndefined();
    // Fail-closed: the corrupt bytes are still there (never rebuilt over).
    expect(await readFile(path, "utf8")).toBe("{ not json");
    // The store loader itself throws the corrupt refusal (no silent empty).
    await expect(loadMissionStore({ workspaceRoot: ws })).rejects.toThrow();
  });
});

describe("ω99-15 P7 — status rendering", () => {
  it("objective, counts, current doing and the ready queue", async () => {
    const f = await fixture();
    await f.controller.start("把系统迁移到新架构");
    await f.controller.plan(chain);
    await f.controller.claim("t1");
    await f.controller.complete("t1", "done");
    // t2 was never claimed: nothing is doing; ready queue shows t2 + t4.
    const s = f.controller.status();
    expect(s).toContain("把系统迁移到新架构");
    expect(s).toContain("1/4");
    expect(s).toContain("t2");
    expect(s).toContain("t4");
    await f.controller.nextReady(); // t2 doing
    const s2 = f.controller.status();
    expect(s2).toContain("doing");
    expect(s2).toContain("t2");
    // No mission → the empty status line.
    const none = await fixture();
    expect(none.controller.status()).toContain("mission");
  });
});

describe("ω99-15 P8 — tool wrappers (late-bound missionBox)", () => {
  const stubModel: ModelClient = {
    async generate() {
      return { role: "assistant", content: "" };
    },
  } as unknown as ModelClient;
  const allowAll = async (): Promise<PermissionDecision> => "allow";

  /** A recording stub controller — every call logged verbatim. */
  function stubController(log: string[]): MissionController {
    return {
      plan: async (tasks) => {
        log.push(`plan:${JSON.stringify(tasks)}`);
        return { ok: true, text: "planned" };
      },
      nextReady: async () => {
        log.push("next");
        return { task: { id: "t1", title: "读规格", dependsOn: [], status: "doing", attempts: 0 }, text: "已认领 t1" };
      },
      complete: async (id, result) => {
        log.push(`complete:${id}:${result ?? ""}`);
        return { ok: true, text: "done" };
      },
      fail: async (id, reason) => {
        log.push(`fail:${id}:${reason}`);
        return { ok: true, text: "failed" };
      },
      start: async (o) => {
        log.push(`start:${o}`);
        return `started ${o}`;
      },
      claim: async (id) => {
        log.push(`claim:${id}`);
        return { task: undefined, text: "no" };
      },
      abandon: async () => {
        log.push("abandon");
        return "abandoned";
      },
      status: () => "status",
      snapshot: () => undefined,
    } as unknown as MissionController;
  }

  it("mission_next/mission_complete drive the controller through the real tool objects; validation precedes side effects", async () => {
    const log: string[] = [];
    const box: { current?: MissionController } = { current: stubController(log) };
    const tools = createMissionTools(() => box.current);
    const byName = new Map<string, Tool>(tools.map((t) => [t.name, t]));
    expect([...byName.keys()].sort()).toEqual(["mission_bundle", "mission_complete", "mission_fail", "mission_know", "mission_know_add", "mission_next", "mission_plan", "mission_ratchet", "mission_start"]);
    // Fail-closed risk annotations: all four are state writers.
    for (const t of tools) {
      expect(t.isReadOnly?.({})).toBe(false);
      expect(t.isDestructive?.({})).toBe(false);
      expect(t.isOpenWorld?.({})).toBe(false);
      expect(t.isConcurrencySafe?.({})).toBe(false);
    }
    const next = await byName.get("mission_next")!.execute({});
    expect(next.content).toContain("已认领 t1");
    expect(log).toContain("next");
    await byName.get("mission_complete")!.execute({ taskId: "t1", result: "成果" });
    expect(log).toContain('complete:t1:成果');
    // Argument validation fires BEFORE the controller is touched.
    const before = log.length;
    const bad = await byName.get("mission_complete")!.execute({ taskId: 42 });
    expect(bad.isError).toBe(true);
    const badPlan = await byName.get("mission_plan")!.execute({ tasks: [{ title: "" }] });
    expect(badPlan.isError).toBe(true);
    const badGate = await byName.get("mission_plan")!.execute({ tasks: [{ title: "x", gate: "c".repeat(501) }] });
    expect(badGate.isError).toBe(true);
    expect(log.length).toBe(before); // zero controller calls from the rejects
    // An empty box (controller not yet created / absent) is a loud refusal.
    box.current = undefined;
    const none = await byName.get("mission_next")!.execute({});
    expect(none.isError).toBe(true);
  });

  it("the tools join the SHARED tool face through buildToolSet (fixed registration; absent option → zero surface)", async () => {
    const log: string[] = [];
    const box: { current?: MissionController } = { current: stubController(log) };
    const set = buildToolSet({
      workspaceRoot: "/tmp/m81-ws",
      model: stubModel,
      canUseTool: allowAll,
      contextWindowTokens: 64_000,
      mission: { getController: () => box.current },
    });
    const names = set.map((t) => t.name);
    expect(names).toContain("mission_plan");
    expect(names).toContain("mission_next");
    const viaRegistry = set.find((t) => t.name === "mission_next")!;
    const r = await viaRegistry.execute({});
    expect(r.content).toContain("已认领 t1");
    expect(log).toContain("next");
    const bare = buildToolSet({
      workspaceRoot: "/tmp/m81-ws",
      model: stubModel,
      canUseTool: allowAll,
      contextWindowTokens: 64_000,
    });
    expect(bare.map((t) => t.name).some((n) => n.startsWith("mission_"))).toBe(false);
  });
});
