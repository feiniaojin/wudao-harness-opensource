// 永续迭代 v6 · reef 借鉴弧 A（digest-reef C2）——失败指纹挂缝 RED 件：
// mission 失败结算三路（门红/棘轮红/人工 fail）记指纹；回执徽章（第 N 次
// 出现，persisting 时）；门再绿→fixed + pitfall 知识沉淀（幂等）；跨重启
// （第二个 controller 进程读到同一清单）；status 一眼答「老失败在哪」。
// 台账落 tmpdir（.wudao/failure-fingerprints.jsonl）；gate runner 注入零真
// shell（m81-mission.test.ts 的 fixture 家族）。
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createMissionController,
  MISSION_TASK_MAX_ATTEMPTS,
  type MissionController,
  type MissionStoreHandle,
  type MissionState,
} from "../src/mission.js";
import { failureFingerprintPath, readFailureEvents, foldFailureManifest } from "../src/failure-fingerprints.js";

let ws: string;
beforeEach(async () => {
  ws = await mkdtemp(join(tmpdir(), "fp-mission-"));
});
afterEach(async () => {
  await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => {});
});

/** m81-mission.test.ts 的 fixture 形状：队列化 gate runner + 内存 store。 */
async function fixture(o: { gateResults?: { code: number; output: string }[]; store?: MissionStoreHandle; workspaceRoot?: string } = {}) {
  const notices: string[] = [];
  const gateResults = [...(o.gateResults ?? [])];
  const runGateCommand = async (command: string, opts: { cwd: string }) => {
    void command;
    void opts;
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
    workspaceRoot: o.workspaceRoot ?? ws,
    notify: (t) => notices.push(t),
    runGateCommand,
    store,
  });
  return { controller, notices };
}

const SAME_FAILURE = { code: 1, output: "Error: cannot find module 'leftpad' (ran 300ms)" };
const OTHER_FAILURE = { code: 1, output: "Error: syntax error near unexpected token" };

async function gatedMission(f: { controller: MissionController; notices: string[] }) {
  await f.controller.start("ship the parser");
  const planned = await f.controller.plan([{ title: "实现", gate: "npm test" }]);
  expect(planned.ok).toBe(true);
  const claimed = await f.controller.nextReady();
  expect(claimed.task?.id).toBe("t1");
}

describe("A1 挂缝 — 门红记指纹 + 徽章 + 修复闭环", () => {
  it("first gate red: observed event lands, NO badge (zero noise); a DIFFERENT cause is a separate fingerprint", async () => {
    const f = await fixture({ gateResults: [SAME_FAILURE] });
    await gatedMission(f);
    const red = await f.controller.complete("t1", "done?");
    expect(red.ok).toBe(false);
    expect(red.text).not.toContain("第");
    const events = await readFailureEvents(failureFingerprintPath(ws));
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("observed");
    expect(events[0]!.stage).toBe("gate");
    expect(events[0]!.subject).toBe("npm test");
    // A different cause → a different fingerprint (no conflation). The two
    // controllers share the WORKSPACE fingerprint file by design.
    const f2 = await fixture({ gateResults: [OTHER_FAILURE] });
    await gatedMission(f2);
    await f2.controller.complete("t1", "done?");
    const events2 = await readFailureEvents(failureFingerprintPath(ws));
    expect(events2).toHaveLength(2);
    expect(events2[0]!.fingerprint).not.toBe(events2[1]!.fingerprint);
  });

  it("same cause red again (different noise: path/ms) → SAME fingerprint, receipt carries 第 2 次出现 badge", async () => {
    const noisy = (n: number): { code: number; output: string } => ({ code: 1, output: `Error at /tmp/run-${n}/x.log: cannot find module 'leftpad' (ran ${n * 100}ms)` });
    const f = await fixture({ gateResults: [noisy(1), noisy(2)] });
    await gatedMission(f);
    await f.controller.complete("t1", "first try");
    const second = await f.controller.complete("t1", "second try");
    expect(second.ok).toBe(false);
    expect(second.text).toContain("第 2 次出现");
    const events = await readFailureEvents(failureFingerprintPath(ws));
    expect(events).toHaveLength(2);
    expect(events[0]!.fingerprint).toBe(events[1]!.fingerprint);
  });

  it("gate goes green → resolved event + status fixed + pitfall knowledge deposited (idempotent on re-fix)", async () => {
    const f = await fixture({ gateResults: [SAME_FAILURE, { code: 0, output: "ok" }] });
    await gatedMission(f);
    await f.controller.complete("t1", "red");
    const green = await f.controller.complete("t1", "fixed it");
    expect(green.ok).toBe(true);
    expect(green.text).toContain("修复沉淀");
    const events = await readFailureEvents(failureFingerprintPath(ws));
    expect(events.map((e) => e.type)).toEqual(["observed", "resolved"]);
    const manifest = foldFailureManifest(events);
    expect(manifest[0]!.status).toBe("fixed");
    // The knowledge note: kind pitfall, tagged with the fingerprint (dedup anchor).
    const snap = f.controller.snapshot();
    const notes = snap?.notes ?? [];
    expect(notes).toHaveLength(1);
    expect(notes[0]!.kind).toBe("pitfall");
    expect(notes[0]!.content).toContain("模式 ");
    expect(notes[0]!.taskRef).toBe("t1");
  });

  it("fail→fix→regress→fix deposits NO second note (mode-tag dedup; the ratchet catches the regression)", async () => {
    // t1 (gate npm test): red → green — the mode's FIRST fix deposits the note.
    // t2 (gate pnpm lint): its complete reruns the ratchet (npm test) which is
    // red again — the SAME mode regressed at ratchet stage — then green: the
    // second fix resolves it but must NOT mint a second note (mode-tag dedup).
    const f = await fixture({ gateResults: [SAME_FAILURE, { code: 0, output: "ok" }, SAME_FAILURE, { code: 0, output: "ok" }, { code: 0, output: "ok" }] });
    await f.controller.start("ship the parser");
    await f.controller.plan([
      { title: "实现", gate: "npm test" },
      { title: "收尾", gate: "pnpm lint", dependsOn: ["t1"] },
    ]);
    await f.controller.nextReady(); // t1
    await f.controller.complete("t1", "red"); // observed (gate stage)
    const fixed1 = await f.controller.complete("t1", "fixed it"); // resolved #1 + note n1
    expect(fixed1.ok).toBe(true);
    expect(fixed1.text).toContain("修复沉淀");
    await f.controller.nextReady(); // t2
    const regress = await f.controller.complete("t2", "regressed"); // ratchet red — observed (ratchet stage, SAME mode)
    expect(regress.ok).toBe(false);
    expect(regress.text).toContain("棘轮回退");
    const fixed2 = await f.controller.complete("t2", "fixed again"); // resolved #2 — dedup skips
    expect(fixed2.ok).toBe(true);
    const snap = f.controller.snapshot();
    expect((snap?.notes ?? []).filter((n) => n.kind === "pitfall")).toHaveLength(1);
    const events = await readFailureEvents(failureFingerprintPath(ws));
    expect(events.filter((e) => e.type === "observed")).toHaveLength(2); // gate + ratchet stages
    expect(events.filter((e) => e.type === "resolved")).toHaveLength(2);
    // The two observations share the (subject, normalized) MODE despite stage
    // differing — one note covers both.
    const manifest = foldFailureManifest(events);
    expect(manifest.every((r) => r.status === "fixed")).toBe(true);
  });

  it("manual fail streak: same reason twice → badge; task later done → resolved + deposit (task-fail stage)", async () => {
    const f = await fixture({});
    await f.controller.start("manual campaign");
    await f.controller.plan([{ title: "调研依赖" }]);
    await f.controller.nextReady();
    const first = await f.controller.fail("t1", "上游服务 503");
    expect(first.ok).toBe(true);
    expect(first.text).not.toContain("第");
    await f.controller.nextReady(); // re-claim t1 (todo again)
    const second = await f.controller.fail("t1", "上游服务 503");
    expect(second.ok).toBe(true);
    expect(second.text).toContain("第 2 次出现");
    await f.controller.nextReady(); // re-claim t1 (todo after the second fail)
    const done = await f.controller.complete("t1", "上游恢复了");
    expect(done.ok).toBe(true);
    expect(done.text).toContain("修复沉淀");
    const events = await readFailureEvents(failureFingerprintPath(ws));
    expect(events.map((e) => e.type)).toEqual(["observed", "observed", "resolved"]);
    expect(events[0]!.stage).toBe("task-fail");
    expect(events[0]!.subject).toBe("调研依赖"); // no gate → the task title is the subject
  });

  it("cross-restart stability: a SECOND controller over the same workspace sees the accumulated counts", async () => {
    // ONE shared store handle = the mission ledger surviving the "restart";
    // the fingerprint manifest itself reloads from the workspace file.
    let persisted: MissionState | null = null;
    const store: MissionStoreHandle = {
      get mission() {
        return persisted;
      },
      save: async (n) => {
        persisted = n;
      },
    };
    const f1 = await fixture({ gateResults: [SAME_FAILURE, SAME_FAILURE], store });
    await gatedMission(f1);
    await f1.controller.complete("t1", "red 1");
    await f1.controller.complete("t1", "red 2");
    // A fresh process: new controller, same ledger + same fingerprint file.
    // (Creation's crash recovery honestly resets doing→todo — re-claim first.)
    const f2 = await fixture({ gateResults: [SAME_FAILURE], store });
    await f2.controller.claim("t1");
    const third = await f2.controller.complete("t1", "red 3 after restart");
    expect(third.ok).toBe(false);
    expect(third.text).toContain("第 3 次出现");
  });

  it("ratchet red records a fingerprint with the ratchet stage; the receipt carries the badge", async () => {
    // t1 gated green (enters the ratchet); t2 gated — its complete reruns t1's
    // command FIRST (ratchet red → fingerprint).
    const f = await fixture({ gateResults: [{ code: 0, output: "ok" }, SAME_FAILURE] });
    await f.controller.start("ratchet campaign");
    await f.controller.plan([
      { title: "地基", gate: "npm test" },
      { title: "上层", gate: "pnpm lint", dependsOn: ["t1"] },
    ]);
    await f.controller.nextReady(); // t1
    expect((await f.controller.complete("t1", "done")).ok).toBe(true);
    await f.controller.nextReady(); // t2
    const red = await f.controller.complete("t2", "tried");
    expect(red.ok).toBe(false);
    expect(red.text).toContain("棘轮回退");
    const events = await readFailureEvents(failureFingerprintPath(ws));
    expect(events).toHaveLength(1);
    expect(events[0]!.stage).toBe("ratchet");
    expect(events[0]!.subject).toBe("npm test");
  });

  it("status() answers 「老失败在哪、修好了没」: persisting fingerprints listed with counts", async () => {
    const f = await fixture({ gateResults: [SAME_FAILURE, SAME_FAILURE] });
    await gatedMission(f);
    await f.controller.complete("t1", "red 1");
    await f.controller.complete("t1", "red 2");
    const text = f.controller.status();
    expect(text).toContain("失败指纹");
    expect(text).toContain("npm test");
    expect(text).toContain("第 2 次未修");
  });

  it("v7 γ2 防污染：run-end 记录不进失败行，自己的「结束方式」行呈现（关窗/超时不被记账成失败）", async () => {
    // 先落两条 run-end 观察（driver 关窗/schedules 超时的写侧形状——
    // buildObservedEvent 同构），再开 controller（装载 = fold 一次事件流，
    // boot 即见）；随后 gate 红 live-fold 进同一 manifest。
    const { appendFailureEvent, buildObservedEvent } = await import("../src/failure-fingerprints.js");
    await appendFailureEvent(failureFingerprintPath(ws), buildObservedEvent({
      subject: "夜间重构",
      stage: "run-end",
      cause: "窗口关闭时被结束",
      at: "2026-09-15T03:00:00.000Z",
    }));
    await appendFailureEvent(failureFingerprintPath(ws), buildObservedEvent({
      subject: "夜间重构",
      stage: "run-end",
      cause: "窗口关闭时被结束",
      at: "2026-09-15T04:00:00.000Z",
    }));
    const f = await fixture({ gateResults: [SAME_FAILURE] });
    await gatedMission(f);
    await f.controller.complete("t1", "red 1");
    const text = f.controller.status();
    // 失败行在（gate 红），run-end 不混入失败行——「npm test」只数失败；
    // 结束方式行自己呈现（第 2 次）。
    const failureLine = text.split("\n").find((l) => l.includes("失败指纹"));
    expect(failureLine).toBeDefined();
    expect(failureLine).toContain("npm test");
    expect(failureLine).not.toContain("夜间重构");
    const endLine = text.split("\n").find((l) => l.includes("结束方式"));
    expect(endLine).toBeDefined();
    expect(endLine).toContain("夜间重构");
    expect(endLine).toContain("第 2 次");
    expect(endLine).not.toContain("未修"); // 结束方式的未结不叫「未修」——不是失败
  });

  it("budget exhaustion parks the task failed and the fingerprint stays open (honest: never fixed)", async () => {
    const reds = Array.from({ length: MISSION_TASK_MAX_ATTEMPTS + 1 }, () => SAME_FAILURE);
    const f = await fixture({ gateResults: reds });
    await gatedMission(f);
    let last;
    for (let i = 0; i < MISSION_TASK_MAX_ATTEMPTS + 1; i += 1) {
      last = await f.controller.complete("t1", `try ${i}`);
      if (last.ok) await f.controller.nextReady();
    }
    void last;
    const events = await readFailureEvents(failureFingerprintPath(ws));
    expect(events.every((e) => e.type === "observed")).toBe(true);
    expect(foldFailureManifest(events)[0]!.status).toBe("persisting");
    // The JSONL is one-line-per-event (append-only archaeology).
    const text = await readFile(failureFingerprintPath(ws), "utf8");
    expect(text.trim().split("\n").length).toBe(events.length);
  });
});
