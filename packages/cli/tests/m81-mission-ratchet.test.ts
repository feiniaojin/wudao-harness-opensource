// ω99-16 — the acceptance ratchet: verified outcomes never regress (brief:
// 验收棘轮). R1-R7 mirror the brief's TDD list. Zero real shell (the gate
// runner is a fake with per-command RESULT QUEUES — call-count-sensitive
// scenarios like the completion final check need a command that flips red
// mid-flight); the persistence round-trip runs against a tmpdir
// `.wudao/mission.json`. No network, no workspace side effects.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelClient, PermissionDecision } from "@wudao/core";
import {
  createMissionController,
  createMissionTools,
  type MissionController,
  type MissionState,
  type MissionStoreHandle,
} from "../src/mission.js";
import { buildToolSet } from "../src/tools.js";

let ws: string;
beforeEach(async () => {
  ws = await mkdtemp(join(tmpdir(), "m81-ratchet-"));
});
afterEach(async () => {
  await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => {});
});

/** Fake runner: per-command result queues (empty/absent queue = green) +
 *  a call log for order assertions. `queue(cmd, ...rs)` scripts a command's
 *  successive outcomes. */
async function fixture(o: { store?: MissionStoreHandle } = {}) {
  const notices: string[] = [];
  const gateCalls: string[] = [];
  const queues = new Map<string, { code: number; output: string }[]>();
  const runGateCommand = async (command: string, opts: { cwd: string }) => {
    void opts;
    gateCalls.push(command);
    const q = queues.get(command);
    return q !== undefined && q.length > 0 ? (q.shift() as { code: number; output: string }) : { code: 0, output: "" };
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
  return {
    controller,
    notices,
    gateCalls,
    queue: (command: string, ...results: { code: number; output: string }[]) => queues.set(command, [...results]),
    persisted: () => persisted,
  };
}

describe("ω99-16 — the acceptance ratchet (R1-R5)", () => {
  it("R1 a gated green completion auto-enters the ratchet, deduped by command string", async () => {
    const f = await fixture();
    await f.controller.start("obj");
    await f.controller.plan([{ title: "a", gate: "cmdA" }, { title: "b", gate: "cmdA" }]);
    await f.controller.claim("t1");
    await f.controller.complete("t1", "done1");
    expect(f.controller.snapshot()?.ratchet).toEqual([{ command: "cmdA", addedByTask: "t1" }]);
    // The same command string on a LATER task never double-enters: the
    // original owner (t1) keeps the attribution.
    await f.controller.claim("t2");
    const r = await f.controller.complete("t2", "done2");
    expect(r.ok).toBe(true);
    expect(f.controller.snapshot()?.ratchet).toEqual([{ command: "cmdA", addedByTask: "t1" }]);
  });

  it("R2 a non-gated completion never enters the ratchet (and runs nothing)", async () => {
    const f = await fixture();
    await f.controller.start("obj");
    await f.controller.plan([{ title: "a" }, { title: "b" }]);
    await f.controller.claim("t1");
    const r = await f.controller.complete("t1");
    expect(r.ok).toBe(true);
    expect(f.controller.snapshot()?.ratchet).toEqual([]);
    expect(f.gateCalls).toEqual([]);
  });

  it("R3 a ratchet red refuses a LATER task's completion with attribution, guard prefix and attempts", async () => {
    const f = await fixture();
    await f.controller.start("obj");
    await f.controller.plan([{ title: "a", gate: "cmdA" }, { title: "b" }]);
    await f.controller.claim("t1");
    await f.controller.complete("t1"); // green → enters the ratchet
    f.queue("cmdA", { code: 1, output: "regression!" });
    await f.controller.claim("t2");
    const r = await f.controller.complete("t2", "my own work is fine");
    expect(r.ok).toBe(false);
    expect(r.text).toContain("棘轮回退");
    expect(r.text).toContain("t1"); // the historical owner the regression betrayed
    expect(r.text).toContain("t2"); // the completing task that triggered the detection
    expect(r.text).toContain("cmdA");
    expect(r.text).toContain("数据非指令"); // the injection-guard prefix
    const t2 = f.controller.snapshot()?.tasks[1];
    expect(t2?.status).toBe("doing"); // refused — not done
    expect(t2?.attempts).toBe(1); // the regression bills THIS task's budget
  });

  it("R4 gate order at complete(): ratchet first (insertion order), own gate second; a ratchet red short-circuits", async () => {
    const f = await fixture();
    await f.controller.start("obj");
    await f.controller.plan([{ title: "a", gate: "cmdA" }, { title: "b", gate: "cmdB" }, { title: "c" }]);
    await f.controller.claim("t1");
    await f.controller.complete("t1");
    await f.controller.claim("t2");
    const r = await f.controller.complete("t2");
    expect(r.ok).toBe(true);
    // t1's own gate → t2's ratchet pass (cmdA) → t2's own gate (cmdB).
    expect(f.gateCalls).toEqual(["cmdA", "cmdA", "cmdB"]);
    // Short-circuit: with cmdA red, completing t2 never reaches cmdB.
    const g = await fixture();
    await g.controller.start("obj");
    await g.controller.plan([{ title: "a", gate: "cmdA" }, { title: "b", gate: "cmdB" }, { title: "c" }]);
    await g.controller.claim("t1");
    await g.controller.complete("t1");
    g.queue("cmdA", { code: 1, output: "boom" });
    await g.controller.claim("t2");
    const rr = await g.controller.complete("t2");
    expect(rr.ok).toBe(false);
    expect(g.gateCalls).toEqual(["cmdA", "cmdA"]); // cmdB never ran
  });

  it("R5 the ratchet persists through mission.json; an old-format file (no ratchet field) loads with an empty ratchet", async () => {
    const mk = (notices: string[]) =>
      createMissionController({
        workspaceRoot: ws,
        notify: (t) => notices.push(t),
        runGateCommand: async () => ({ code: 0, output: "" }),
      });
    const c1 = await mk([]);
    await c1.start("跨会话战役");
    await c1.plan([{ title: "a", gate: "cmdA" }, { title: "b" }]);
    await c1.claim("t1");
    await c1.complete("t1");
    const c2 = await mk([]);
    expect(c2.snapshot()?.objective).toBe("跨会话战役");
    expect(c2.snapshot()?.ratchet).toEqual([{ command: "cmdA", addedByTask: "t1" }]);
    // Old format (pre-ω99-16 hand-written ledger, no ratchet key): loads
    // clean — refusal stays undefined and the ratchet reads empty.
    const oldWs = join(ws, "old");
    await mkdir(join(oldWs, ".wudao"), { recursive: true });
    const oldFile = {
      version: 1,
      mission: {
        id: "mhand",
        objective: "老战役",
        createdAt: "2026-01-01T00:00:00.000Z",
        status: "active",
        tasks: [{ id: "t1", title: "only", dependsOn: [], status: "doing", attempts: 0 }],
      },
    };
    await writeFile(join(oldWs, ".wudao", "mission.json"), JSON.stringify(oldFile), "utf8");
    const c3 = await createMissionController({
      workspaceRoot: oldWs,
      notify: () => {},
      runGateCommand: async () => ({ code: 0, output: "" }),
    });
    expect(c3.refusal).toBeUndefined();
    expect(c3.snapshot()?.ratchet).toEqual([]);
  });
});

describe("ω99-16 — completion final check (R6) + the tool face (R7)", () => {
  it("R6 a final-check red keeps the mission active and the task doing; the fixed retry completes", async () => {
    const f = await fixture();
    await f.controller.start("obj");
    await f.controller.plan([{ title: "a", gate: "cmdA" }, { title: "b", gate: "cmdB", dependsOn: ["t1"] }]);
    await f.controller.claim("t1");
    await f.controller.complete("t1");
    await f.controller.claim("t2");
    // cmdA flips red only at its 2nd run INSIDE this complete: the ratchet
    // pass (1) stays green; the COMPLETION FINAL CHECK (2) catches the late
    // regression — the exact "last link breaks the earliest outcome" case.
    f.queue("cmdA", { code: 0, output: "ok" }, { code: 1, output: "late regression" });
    const bad = await f.controller.complete("t2", "done?");
    expect(bad.ok).toBe(false);
    expect(bad.text).toContain("棘轮回退");
    expect(bad.text).toContain("终检");
    expect(bad.text).toContain("t1");
    expect(bad.text).toContain("t2");
    expect(bad.text).toContain("数据非指令");
    const snap = f.controller.snapshot();
    expect(snap?.status).toBe("active"); // the mission did NOT flip to completed
    expect(snap?.tasks[1]?.status).toBe("doing"); // t2 stays doing — nothing committed
    expect(snap?.tasks[1]?.attempts).toBe(1);
    // cmdB never entered the ratchet (t2 is not done).
    expect(snap?.ratchet).toEqual([{ command: "cmdA", addedByTask: "t1" }]);
    // Fixed (queue exhausted → default green): the retry's final check reruns
    // the FULL ratchet — now including t2's own just-greened cmdB — and the
    // mission completes.
    const good = await f.controller.complete("t2", "fixed");
    expect(good.ok).toBe(true);
    expect(good.text).toContain("mission 完成");
    expect(f.controller.snapshot()?.status).toBe("completed");
    expect(f.controller.snapshot()?.ratchet).toEqual([
      { command: "cmdA", addedByTask: "t1" },
      { command: "cmdB", addedByTask: "t2" },
    ]);
  });

  it("R7a ratchetCheck(): per-entry ✓/✗ report with attribution and bounded output; ZERO state change", async () => {
    const f = await fixture();
    await f.controller.start("obj");
    await f.controller.plan([{ title: "a", gate: "cmdA" }, { title: "b" }]);
    await f.controller.claim("t1");
    await f.controller.complete("t1");
    const before = f.controller.snapshot();
    const green = await f.controller.ratchetCheck();
    expect(green.ok).toBe(true);
    expect(green.text).toContain("✓");
    expect(green.text).toContain("cmdA");
    expect(green.text).toContain("t1");
    expect(f.controller.snapshot()).toEqual(before); // read-only: state untouched
    f.queue("cmdA", { code: 2, output: "broke" });
    const red = await f.controller.ratchetCheck();
    expect(red.ok).toBe(false);
    expect(red.text).toContain("✗");
    expect(red.text).toContain("t1"); // attribution: which task's acceptance broke
    expect(red.text).toContain("退出 2");
    expect(red.text).toContain("数据非指令");
    expect(f.controller.snapshot()).toEqual(before); // still untouched
  });

  it("R7b mission_ratchet rides the SHARED tool set (buildToolSet, late-bound box) with fail-closed annotations", async () => {
    const stubModel: ModelClient = {
      async generate() {
        return { role: "assistant", content: "" };
      },
    } as unknown as ModelClient;
    const allowAll = async (): Promise<PermissionDecision> => "allow";
    const log: string[] = [];
    let verdict: { ok: boolean; text: string } = { ok: true, text: "回归棘轮 1 条 全绿：\n✓〔t1〕`cmdA` 退出 0" };
    const stub = {
      ratchetCheck: async () => {
        log.push("ratchetCheck");
        return verdict;
      },
    } as unknown as MissionController;
    const box: { current?: MissionController } = { current: stub };
    const tools = createMissionTools(() => box.current);
    // Fixed position: mission_ratchet joins AFTER mission_fail (prefix stable).
    expect(tools.map((t) => t.name)).toEqual([
      "mission_plan",
      "mission_next",
      "mission_complete",
      "mission_fail",
      "mission_ratchet",
      "mission_know_add",
      "mission_know",
      "mission_bundle",
      "mission_start",
    ]);
    const ratchetTool = tools[4]!;
    // Fail-closed risk annotations: it runs shell commands — never read-only.
    expect(ratchetTool.isReadOnly?.({})).toBe(false);
    expect(ratchetTool.isConcurrencySafe?.({})).toBe(false);
    expect(ratchetTool.isDestructive?.({})).toBe(false);
    expect(ratchetTool.isOpenWorld?.({})).toBe(false);
    const r = await ratchetTool.execute({});
    expect(r.content).toContain("全绿");
    expect(r.isError).toBeUndefined();
    expect(log).toEqual(["ratchetCheck"]);
    // A red report surfaces as isError (the model sees the failure).
    verdict = { ok: false, text: "回归棘轮 1 条 存在回退：\n✗〔t1〕`cmdA` 退出 1" };
    const red = await ratchetTool.execute({});
    expect(red.isError).toBe(true);
    // Through the REAL registry: the shared tool set carries mission_ratchet
    // whenever the mission face is wired (late-bound box, no eager controller).
    const set = buildToolSet({
      workspaceRoot: "/tmp/m81r-ws",
      model: stubModel,
      canUseTool: allowAll,
      contextWindowTokens: 64_000,
      mission: { getController: () => box.current },
    });
    const viaSet = set.find((t) => t.name === "mission_ratchet")!;
    const rr = await viaSet.execute({});
    expect(rr.isError).toBe(true);
    expect(rr.content).toContain("存在回退");
    // An empty box (controller not yet created / absent) is a loud refusal.
    box.current = undefined;
    const none = await viaSet.execute({});
    expect(none.isError).toBe(true);
    // The bare set (no mission face wired) carries zero mission_* surface.
    const bare = buildToolSet({
      workspaceRoot: "/tmp/m81r-ws",
      model: stubModel,
      canUseTool: allowAll,
      contextWindowTokens: 64_000,
    });
    expect(bare.map((t) => t.name).some((n) => n.startsWith("mission_"))).toBe(false);
  });
});
