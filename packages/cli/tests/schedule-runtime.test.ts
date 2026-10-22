// 113-C1（qm #1593 形）— per-cron runtime 档位：
//   解析面  /schedule add … --runtime <k=v[,k=v…]>（typed 拒绝：未知键/坏
//          effort/空值；缺省 → 旧解析逐字节）；
//   存储面  DurableTask.runtime 持久化往返（validDurable normalize-not-reject）；
//   触发面  spawn 车道把档位交给子 CLI 的启动参数（--provider/--model/
//          --reasoning-effort + WUDAO_PERSONA env——storedModelDefaults 同族
//          解析链，flags→parseSessionFlags 往返钉住）；continue 车道不吃档位
//          （运行中会话不被改档——契约测试）；
//   守门面  daemon.add typed 拒绝（坏 effort/空值/未知 persona——persona 走
//          既有 merged registry，builtin id 通过）。
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseScheduleCommand,
  parseScheduleRuntime,
  scheduleRuntimeFlags,
  scheduleRuntimeEnv,
  spawnScheduleRun,
  createScheduleDaemon,
  loadSchedulesStore,
  SCHEDULE_RUNTIME_EFFORTS,
} from "../src/schedules.js";
import { validDurable } from "../src/schedules-model.js";
import { parseProviderFlags } from "../src/args.js";
import type { DurableTask } from "../src/schedules.js";

let ws: string;
let globalHome: string;
beforeEach(async () => {
  ws = await mkdtemp(join(tmpdir(), "sched-runtime-"));
  globalHome = await mkdtemp(join(tmpdir(), "sched-runtime-home-"));
});
afterEach(async () => {
  await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => {});
  await rm(globalHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => {});
});

const hermeticEnv = (): NodeJS.ProcessEnv => ({ WUDAO_GLOBAL_HOME: globalHome });

describe("113-C1 — 解析面：--runtime 尾缀", () => {
  it("parses the tier off every add form and strips it from the prompt", () => {
    const quoted = parseScheduleCommand('add "*/10 * * * *" run the tests --runtime model=glm-5.3-air,effort=low');
    expect(quoted).toEqual({
      kind: "add",
      schedule: { type: "cron", expr: "*/10 * * * *" },
      prompt: "run the tests",
      runtime: { model: "glm-5.3-air", effort: "low" },
    });
    const at = parseScheduleCommand("add @2026-10-01T03:00 night lint --runtime provider=deepseek,persona=the upstream format");
    expect(at.kind).toBe("add");
    if (at.kind === "add") {
      expect(at.prompt).toBe("night lint");
      expect(at.runtime).toEqual({ provider: "deepseek", persona: "the upstream format" });
    }
    const watch = parseScheduleCommand("add watch reports/weekly.md rebuild --runtime effort=medium");
    expect(watch.kind).toBe("add");
    if (watch.kind === "add") expect(watch.runtime).toEqual({ effort: "medium" });
  });

  it("typed refusals: unknown key, bad effort, empty value, bare spec", () => {
    expect(parseScheduleCommand('add "*/10 * * * *" p --runtime turbo=on')).toEqual({
      kind: "bad",
      error: '--runtime 未知键 "turbo"（可用：model / provider / persona / effort）',
    });
    expect(parseScheduleCommand('add "*/10 * * * *" p --runtime effort=max')).toEqual({
      kind: "bad",
      error: '--runtime effort 需为 low|medium|high（收到 "max"）',
    });
    expect(parseScheduleCommand('add "*/10 * * * *" p --runtime model=')).toEqual({
      kind: "bad",
      error: "--runtime model 需非空值",
    });
    expect(parseScheduleCommand('add "*/10 * * * *" p --runtime')).toEqual({
      kind: "bad",
      error: '--runtime 需为 k=v 逗号串（收到 ""）',
    });
    // The pure parser carries the same rejections.
    expect(typeof parseScheduleRuntime("x")).toBe("string");
    expect(parseScheduleRuntime("model=a,provider=b")).toEqual({ model: "a", provider: "b" });
  });

  it("absent token → the legacy parse, byte-for-byte (no runtime field at all)", () => {
    expect(parseScheduleCommand('add "*/10 * * * *" run the tests')).toEqual({
      kind: "add",
      schedule: { type: "cron", expr: "*/10 * * * *" },
      prompt: "run the tests",
    });
    // A prompt that never carried the token keeps its bytes.
    expect(parseScheduleCommand("add @2026-10-01T03:00 night lint")).toMatchObject({ prompt: "night lint" });
  });
});

describe("113-C1 — 触发面：spawn 档位上子 CLI 的线", () => {
  const task = (runtime?: DurableTask["runtime"]): DurableTask => ({
    id: "aaaaaaaa",
    schedule: { type: "cron", expr: "*/10 * * * *" },
    prompt: "run the tests",
    workspace: ws,
    createdFrom: "test",
    createdAt: 0,
    ...(runtime !== undefined ? { runtime } : {}),
  });

  it("flags/env helpers are pure and byte-zero when the tier is absent", () => {
    expect(scheduleRuntimeFlags(undefined)).toEqual([]);
    expect(scheduleRuntimeFlags({ model: "m1", provider: "p1", effort: "low" }))
      .toEqual(["--provider", "p1", "--model", "m1", "--reasoning-effort", "low"]);
    expect(scheduleRuntimeFlags({ persona: "the upstream format" })).toEqual([]);
    const env = { A: "1" };
    expect(scheduleRuntimeEnv(undefined, env)).toBe(env);
    expect(scheduleRuntimeEnv({ persona: "the upstream format" }, env)).toEqual({ ...env, WUDAO_PERSONA: "the upstream format" });
  });

  it("the child receives the flags + WUDAO_PERSONA on its wire (stub entry records argv/env); absent tier → argv byte-zero", async () => {
    const out = join(ws, "stub-out.json");
    const stub = join(ws, "stub-entry.mjs");
    await writeFile(stub, [
      "import { writeFileSync } from 'node:fs';",
      `writeFileSync(${JSON.stringify(out)}, JSON.stringify({ argv: process.argv.slice(2), persona: process.env.WUDAO_PERSONA, scheduleRun: process.env.WUDAO_SCHEDULE_RUN }));`,
      "",
    ].join("\n"), "utf8");
    // With a tier: provider/model/effort flags + persona env.
    const res = await spawnScheduleRun(
      task({ provider: "deepseek", model: "deepseek-v4-flash", persona: "the upstream format", effort: "low" }),
      { ...hermeticEnv(), STUB_OUT: out },
      { entryPath: stub, timeoutMs: 10_000 },
    );
    expect(res.ok).toBe(true);
    const wire = JSON.parse(await readFile(out, "utf8")) as { argv: string[]; persona?: string; scheduleRun?: string };
    expect(wire.argv).toEqual(["-p", "run the tests", "--provider", "deepseek", "--model", "deepseek-v4-flash", "--reasoning-effort", "low"]);
    expect(wire.persona).toBe("the upstream format");
    expect(wire.scheduleRun).toBe("1");
    // Without a tier: argv is exactly the pre-113 shape and no persona env.
    await rm(out, { force: true });
    const bare = await spawnScheduleRun(task(), { ...hermeticEnv(), STUB_OUT: out }, { entryPath: stub, timeoutMs: 10_000 });
    expect(bare.ok).toBe(true);
    const wireBare = JSON.parse(await readFile(out, "utf8")) as { argv: string[]; persona?: string };
    expect(wireBare.argv).toEqual(["-p", "run the tests"]);
    expect(wireBare.persona).toBeUndefined();
  }, 20_000);

  it("the flags round-trip the SAME session-flag chain a human run uses (parseProviderFlags)", () => {
    const tier = { provider: "deepseek", model: "deepseek-v4-flash", effort: "high" } as const;
    const flags = scheduleRuntimeFlags(tier);
    // What the child CLI will parse back out of its own argv.
    const parsed = parseProviderFlags(flags);
    expect(parsed.provider).toBe("deepseek");
    expect(parsed.model).toBe("deepseek-v4-flash");
    expect(parsed.reasoningEffort).toBe("high");
    // The effort union the add face enforces.
    expect([...SCHEDULE_RUNTIME_EFFORTS]).toEqual(["low", "medium", "high"]);
  });
});

describe("113-C1 — 存储面：持久化往返", () => {
  it("validDurable keeps a well-formed tier; garbage drops per FIELD, an emptied object drops whole", () => {
    const keep = validDurable({
      id: "aaaaaaaa", prompt: "p", workspace: "/w", createdFrom: "t", createdAt: 0,
      schedule: { type: "cron", expr: "* * * * *" },
      runtime: { model: "m1", provider: "p1", persona: "the upstream format", effort: "low" },
    });
    expect(keep?.runtime).toEqual({ model: "m1", provider: "p1", persona: "the upstream format", effort: "low" });
    const partial = validDurable({
      id: "aaaaaaaa", prompt: "p", workspace: "/w", createdFrom: "t", createdAt: 0,
      schedule: { type: "cron", expr: "* * * * *" },
      runtime: { model: "m1", effort: "max", provider: 42 },
    });
    expect(partial?.runtime).toEqual({ model: "m1" }); // effort out of union, provider wrong type → dropped
    const garbage = validDurable({
      id: "aaaaaaaa", prompt: "p", workspace: "/w", createdFrom: "t", createdAt: 0,
      schedule: { type: "cron", expr: "* * * * *" },
      runtime: "cheap",
    });
    expect(garbage?.runtime).toBeUndefined(); // the task survives on defaults
  });

  it("store → reload round-trips the tier (daemon.add persists it verbatim)", async () => {
    const daemon = await createScheduleDaemon({ workspaceRoot: ws, tickMs: 0, now: () => 0, env: hermeticEnv(), runTask: async () => ({ ok: true, exitCode: 0, output: "" }) });
    const receipt = await daemon.add({
      schedule: { type: "weekly", weekdays: [1], time: "03:00" },
      prompt: "night lint",
      createdFrom: "test",
      runtime: { provider: "deepseek", model: "deepseek-v4-flash", effort: "low" },
    });
    expect(receipt.startsWith("📅")).toBe(true);
    expect(receipt).toContain("档位");
    const store = await loadSchedulesStore({ workspaceRoot: ws, env: hermeticEnv() });
    expect(store.tasks[0]?.runtime).toEqual({ provider: "deepseek", model: "deepseek-v4-flash", effort: "low" });
    daemon.stop();
  });
});

describe("113-C1 — 守门面：daemon.add 的 typed 拒绝", () => {
  it("refuses a bad effort / an empty tier / an empty string field (fail-closed, never a silent default)", async () => {
    const daemon = await createScheduleDaemon({ workspaceRoot: ws, tickMs: 0, now: () => 0, env: hermeticEnv(), runTask: async () => ({ ok: true, exitCode: 0, output: "" }) });
    const at = { schedule: { type: "at" as const, at: Date.now() + 60_000 }, prompt: "p", createdFrom: "t" };
    expect(await daemon.add({ ...at, runtime: { effort: "turbo" as unknown as "low" } })).toContain("runtime.effort");
    expect(await daemon.add({ ...at, runtime: {} })).toContain("至少一个字段");
    expect(await daemon.add({ ...at, runtime: { model: "  " } })).toContain("非空字符串");
    expect((await loadSchedulesStore({ workspaceRoot: ws, env: hermeticEnv() })).tasks).toHaveLength(0); // nothing persisted
    daemon.stop();
  });

  it("persona is checked against the MERGED registry: builtin ids pass, typos refuse", async () => {
    const daemon = await createScheduleDaemon({ workspaceRoot: ws, tickMs: 0, now: () => 0, env: hermeticEnv(), runTask: async () => ({ ok: true, exitCode: 0, output: "" }) });
    const at = { schedule: { type: "at" as const, at: Date.now() + 60_000 }, prompt: "p", createdFrom: "t" };
    const refused = await daemon.add({ ...at, runtime: { persona: "no-such-persona-xyz" } });
    expect(refused.startsWith("⚠️")).toBe(true);
    expect(refused).toContain("no-such-persona-xyz");
    const ok = await daemon.add({ ...at, runtime: { persona: "the upstream format" } }); // builtin registry row
    expect(ok.startsWith("📅")).toBe(true);
    daemon.stop();
  });
});

describe("113-C1 — continue 车道契约：运行中会话不被改档", () => {
  it("a bound task whose fire CONTINUES the session never reaches the runner (no runtime handoff); an unbound fire spawns WITH the tier", async () => {
    const seen: DurableTask[] = [];
    let continues = 0;
    const daemon = await createScheduleDaemon({
      workspaceRoot: ws,
      tickMs: 0,
      now: () => 0,
      env: hermeticEnv(),
      runTask: async (t) => {
        seen.push(t);
        return { ok: true, exitCode: 0, output: "ok" };
      },
      continueRun: async () => {
        continues += 1;
        return { started: true };
      },
    });
    // Bound task: the fire rides the continue seam — runTask (the spawn lane,
    // the ONLY runtime consumer) never fires.
    await daemon.add({ schedule: { type: "at", at: Date.now() + 60_000 }, prompt: "bound", createdFrom: "t", sessionId: "sess-1", runtime: { model: "cheap-night-model", effort: "low" } });
    await daemon.runNow((await loadSchedulesStore({ workspaceRoot: ws, env: hermeticEnv() })).tasks[0]!.id);
    expect(continues).toBe(1);
    expect(seen).toHaveLength(0);
    // Unbound task: the spawn lane receives the task WITH the tier (the
    // driver-startup consumer reads task.runtime).
    await daemon.add({ schedule: { type: "at", at: Date.now() + 60_000 }, prompt: "unbound", createdFrom: "t", runtime: { model: "cheap-night-model", effort: "low" } });
    const tasks = (await loadSchedulesStore({ workspaceRoot: ws, env: hermeticEnv() })).tasks;
    await daemon.runNow(tasks[1]!.id);
    await new Promise((r) => setTimeout(r, 50));
    expect(seen.map((t) => t.prompt)).toEqual(["unbound"]);
    expect(seen[0]?.runtime).toEqual({ model: "cheap-night-model", effort: "low" });
    daemon.stop();
  });
});
