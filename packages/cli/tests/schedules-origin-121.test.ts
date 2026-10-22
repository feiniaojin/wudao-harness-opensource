// 121 项 2（the upstream project d72beaf9e durable wake + the upstream project 5ab0e6df3 形）—
// 「agent 自己安排的周期性再注入」：schedule_add 工具面自动盖 origin 章
// （当前会话 id），fire 时 spawn 车道 resume 该会话（--resume，跨重启
// durable）+「[定时续跑]」prompt 前缀；用户手设（无 origin）路径字节不变；
// 出生地会话不在时降级全新 spawn + 回执说明。
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createScheduleDaemon,
  spawnScheduleRun,
  originResumePrompt,
  SCHEDULE_ORIGIN_PROMPT_PREFIX,
  SCHEDULE_RUN_ENV,
} from "../src/schedules.js";
import { validScheduleOriginSessionId, validDurable } from "../src/schedules-model.js";
import { createScheduleTools } from "../src/schedules-tools.js";
import type { ScheduleToolFace } from "../src/schedules-tools.js";
import type { DurableTask } from "../src/schedules-model.js";

let ws: string;
beforeEach(async () => {
  ws = await mkdtemp(join(tmpdir(), "sched-origin-"));
});
afterEach(async () => {
  await rm(ws, { recursive: true, force: true });
});

const T0 = Date.parse("2026-09-26T03:00:00Z");
const MIN = 60_000;

const task = (over: Partial<DurableTask> = {}): DurableTask => ({
  id: "aaaaaaaa",
  schedule: { type: "every", intervalMs: 60_000 },
  prompt: "check the build",
  workspace: ws,
  createdFrom: "test",
  createdAt: 0,
  nextRunAt: T0,
  ...over,
});

/** Poll until cond or deadline (the daemon's fire bookkeeping is async-void
 *  with real fs I/O — m61's flake lesson). */
async function until(cond: () => boolean, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > deadline) return;
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe("model — origin normalization (normalize-not-reject)", () => {
  it("a well-formed origin survives the load validator (hint optional)", () => {
    const withHint = validDurable(task({ origin: { sessionId: "wudao-abc123", contextHint: "每小时查构建" } }));
    expect(withHint?.origin).toEqual({ sessionId: "wudao-abc123", contextHint: "每小时查构建" });
    const bare = validDurable(task({ origin: { sessionId: "wudao-abc123" } }));
    expect(bare?.origin).toEqual({ sessionId: "wudao-abc123" });
  });

  it("garbage drops the FIELD, never the task (hand-edited rows stay schedulable)", () => {
    const badId = validDurable(task({ origin: { sessionId: "../escape" } as unknown as { sessionId: string } }));
    expect(badId?.origin).toBeUndefined();
    expect(badId?.prompt).toBe("check the build");
    const side = validDurable(task({ origin: { sessionId: "side-abc123" } }));
    expect(side?.origin).toBeUndefined(); // a sidechain file is never a resumable birthplace
    const junk = validDurable(task({ origin: "nope" as unknown as DurableTask["origin"] }));
    expect(junk?.origin).toBeUndefined();
    const badHint = validDurable(task({ origin: { sessionId: "wudao-abc123", contextHint: 42 as unknown as string } }));
    expect(badHint?.origin).toEqual({ sessionId: "wudao-abc123" }); // hint drops, id keeps
  });

  it("the stamp-side id gate: path-safe and never a sidechain", () => {
    expect(validScheduleOriginSessionId("wudao-abc123")).toBe(true);
    expect(validScheduleOriginSessionId("side-abc123")).toBe(false);
    expect(validScheduleOriginSessionId("../etc/passwd")).toBe(false);
    expect(validScheduleOriginSessionId("")).toBe(false);
  });
});

describe("originResumePrompt + spawnScheduleRun argv", () => {
  it("the fired turn's text: hint overrides, prompt otherwise, prefixed once", () => {
    expect(originResumePrompt(task({ origin: { sessionId: "s1" } }))).toBe("[定时续跑] check the build");
    expect(originResumePrompt(task({ origin: { sessionId: "s1", contextHint: "查构建" } }))).toBe("[定时续跑] 查构建");
    expect(originResumePrompt(task())).toBe("check the build"); // no origin, no prefix
    expect(SCHEDULE_ORIGIN_PROMPT_PREFIX).toBe("[定时续跑]");
  });

  it("an origin task spawns a RESUMING child: prompt first, --resume <sid>, WUDAO_SCHEDULE_RUN rides (stub entry)", async () => {
    const out = join(ws, "stub-out.json");
    const stub = join(ws, "stub-entry.mjs");
    await writeFile(stub, [
      "import { writeFileSync } from 'node:fs';",
      `writeFileSync(${JSON.stringify(out)}, JSON.stringify({ argv: process.argv.slice(2), scheduleRun: process.env.${SCHEDULE_RUN_ENV} }));`,
      "",
    ].join("\n"), "utf8");
    const res = await spawnScheduleRun(
      task({ origin: { sessionId: "wudao-resume1", contextHint: "查构建" } }),
      { ...({} as NodeJS.ProcessEnv) },
      { entryPath: stub, timeoutMs: 10_000 },
    );
    expect(res.ok).toBe(true);
    const wire = JSON.parse(await readFile(out, "utf8")) as { argv: string[]; scheduleRun?: string };
    expect(wire.argv).toEqual(["[定时续跑] 查构建", "--resume", "wudao-resume1"]);
    expect(wire.scheduleRun).toBe("1");
  }, 20_000);

  it("an origin-LESS task keeps the exact pre-121 argv (byte pin: ['-p', prompt])", async () => {
    const out = join(ws, "stub-out2.json");
    const stub = join(ws, "stub-entry2.mjs");
    await writeFile(stub, [
      "import { writeFileSync } from 'node:fs';",
      `writeFileSync(${JSON.stringify(out)}, JSON.stringify({ argv: process.argv.slice(2) }));`,
      "",
    ].join("\n"), "utf8");
    await spawnScheduleRun(task(), { ...({} as NodeJS.ProcessEnv) }, { entryPath: stub, timeoutMs: 10_000 });
    const wire = JSON.parse(await readFile(out, "utf8")) as { argv: string[] };
    expect(wire.argv).toEqual(["-p", "check the build"]);
  }, 20_000);
});

describe("daemon — the add door and the fire lanes", () => {
  it("add persists a well-formed origin and says so in the receipt; garbage is refused loudly", async () => {
    let clock = T0;
    const daemon = await createScheduleDaemon({ workspaceRoot: ws, now: () => clock, tickMs: 0, env: {} });
    const ok = await daemon.add({
      schedule: { type: "every", intervalMs: 60_000 },
      prompt: "check the build",
      createdFrom: "test",
      origin: { sessionId: "wudao-live1" },
    });
    expect(ok).toContain("已添加");
    expect(ok).toContain("wudao-live1".slice(0, 8));
    const stored = JSON.parse(await readFile(join(ws, ".wudao", "schedules.json"), "utf8"));
    expect(stored.tasks[0].origin).toEqual({ sessionId: "wudao-live1" });
    // Refusals (typed door, not silent drops): reminder rows never carry one;
    // malformed ids/hints are named.
    expect(await daemon.add({ schedule: { type: "every", intervalMs: 60_000 }, prompt: "p", createdFrom: "test", kind: "reminder", origin: { sessionId: "wudao-live1" } })).toContain("⚠️");
    expect(await daemon.add({ schedule: { type: "every", intervalMs: 60_000 }, prompt: "p", createdFrom: "test", origin: { sessionId: "side-x" } })).toContain("⚠️");
    expect(await daemon.add({ schedule: { type: "every", intervalMs: 60_000 }, prompt: "p", createdFrom: "test", origin: { sessionId: "wudao-live1", contextHint: "  " } })).toContain("⚠️");
    daemon.stop();
  });

  it("a fire with origin + session on disk RESUMES: run receives the origin task, ledger records originResume", async () => {
    let clock = T0;
    const seen: DurableTask[] = [];
    const log: { type: string; data: Record<string, unknown> }[] = [];
    const notifications: string[] = [];
    const daemon = await createScheduleDaemon({
      workspaceRoot: ws,
      now: () => clock,
      tickMs: 0,
      env: {},
      runTask: async (t) => {
        seen.push(t);
        return { ok: true, exitCode: 0, output: "ok" };
      },
      appendRun: async (entry) => {
        log.push(entry as { type: string; data: Record<string, unknown> });
      },
      notify: (line) => notifications.push(line),
      originSessionExists: (id, workspace) => id === "wudao-live1" && workspace === ws,
    });
    await daemon.add({ schedule: { type: "every", intervalMs: 60_000 }, prompt: "check the build", createdFrom: "test", origin: { sessionId: "wudao-live1" } });
    clock = T0 + 2 * MIN; // the materialized nextRunAt is createdAt+60s
    await daemon.tick();
    await until(() => seen.length === 1 && log.length === 1);
    expect(seen[0]!.origin).toEqual({ sessionId: "wudao-live1" }); // the runner got the resume-shaped task
    expect(log[0]!.data.originResume).toBe("wudao-live1");
    expect(log[0]!.data.originDropped).toBeUndefined();
    expect(notifications.some((n) => n.includes("✅"))).toBe(true);
    daemon.stop();
  });

  it("a fire whose birthplace is GONE degrades to the plain spawn and says so (receipt + ledger)", async () => {
    let clock = T0;
    const seen: DurableTask[] = [];
    const log: { type: string; data: Record<string, unknown> }[] = [];
    const notifications: string[] = [];
    const daemon = await createScheduleDaemon({
      workspaceRoot: ws,
      now: () => clock,
      tickMs: 0,
      env: {},
      runTask: async (t) => {
        seen.push(t);
        return { ok: true, exitCode: 0, output: "ok" };
      },
      appendRun: async (entry) => {
        log.push(entry as { type: string; data: Record<string, unknown> });
      },
      notify: (line) => notifications.push(line),
      originSessionExists: () => false, // the session file is gone
    });
    await daemon.add({ schedule: { type: "every", intervalMs: 60_000 }, prompt: "check the build", createdFrom: "test", origin: { sessionId: "wudao-gone1" } });
    clock = T0 + 2 * MIN;
    await daemon.tick();
    await until(() => seen.length === 1 && log.length === 1);
    expect(seen[0]!.origin).toBeUndefined(); // degraded: the runner got the plain-spawn shape
    expect(seen[0]!.prompt).toBe("check the build");
    expect(log[0]!.data.originDropped).toBe(true);
    expect(log[0]!.data.originResume).toBeUndefined();
    expect(notifications.some((n) => n.includes("wudao-gone1".slice(0, 8)) && n.includes("全新任务"))).toBe(true);
    daemon.stop();
  });

  it("a user-set task (no origin) fires the pre-121 lane byte-exactly — no resume keys, no degrade note", async () => {
    let clock = T0;
    const seen: DurableTask[] = [];
    const log: { type: string; data: Record<string, unknown> }[] = [];
    const notifications: string[] = [];
    const daemon = await createScheduleDaemon({
      workspaceRoot: ws,
      now: () => clock,
      tickMs: 0,
      env: {},
      runTask: async (t) => {
        seen.push(t);
        return { ok: true, exitCode: 0, output: "ok" };
      },
      appendRun: async (entry) => {
        log.push(entry as { type: string; data: Record<string, unknown> });
      },
      notify: (line) => notifications.push(line),
    });
    await daemon.add({ schedule: { type: "every", intervalMs: 60_000 }, prompt: "user cron", createdFrom: "/schedule" });
    clock = T0 + 2 * MIN;
    await daemon.tick();
    await until(() => seen.length === 1 && log.length === 1);
    expect(seen[0]!.origin).toBeUndefined();
    expect("originResume" in log[0]!.data).toBe(false);
    expect("originDropped" in log[0]!.data).toBe(false);
    expect(notifications.some((n) => n.includes("全新任务"))).toBe(false);
    daemon.stop();
  });
});

describe("tool face — the automatic origin stamp", () => {
  const runAdd = async (face: ScheduleToolFace, kind: "task" | "reminder" = "task"): Promise<string> => {
    const tools = createScheduleTools(face);
    const add = tools.find((t) => t.name === "schedule_add")!;
    const res = await add.execute({
      kind,
      prompt: "check the build",
      trigger: { type: "every", intervalMs: 3_600_000 },
    });
    expect(res.isError).toBeFalsy();
    return res.content as string;
  };

  it("a task stamped from a live session carries origin (the current conversation id)", async () => {
    const adds: unknown[] = [];
    const face: ScheduleToolFace = {
      add: async (input) => {
        adds.push(input);
        return "📅 ok";
      },
      rm: async () => "",
      listText: () => "",
      liveSessionId: () => "wudao-agent9",
    };
    await runAdd(face);
    expect(adds[0]).toMatchObject({ origin: { sessionId: "wudao-agent9" }, kind: "task" });
  });

  it("no seam (embedders/tests) or a non-task kind → the add input has NO origin key (pre-121 shape)", async () => {
    const adds: unknown[] = [];
    const bare: ScheduleToolFace = { add: async (i) => { adds.push(i); return "📅 ok"; }, rm: async () => "", listText: () => "" };
    await runAdd(bare);
    expect("origin" in (adds[0] as object)).toBe(false);
    await runAdd({ ...bare, liveSessionId: () => "wudao-agent9" }, "reminder");
    expect(adds.length).toBe(2);
    expect("origin" in (adds[1] as object)).toBe(false); // reminders never carry one
  });

  it("a side-chain or junk id never stamps (fail-closed at the tool face)", async () => {
    const adds: unknown[] = [];
    const face: ScheduleToolFace = {
      add: async (i) => { adds.push(i); return "📅 ok"; },
      rm: async () => "",
      listText: () => "",
      liveSessionId: () => "side-leak",
    };
    await runAdd(face);
    expect("origin" in (adds[0] as object)).toBe(false);
  });
});
