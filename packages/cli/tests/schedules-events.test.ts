// 借鉴弧 ε（Cursor Projects 事件订阅思想，digest-c 候选 C3）— 事件触发源：
// 触发维度从「钟」（at/every/weekly/cron）泛化到「信号」（file 盯梢 /
// webhook 回环 POST）。对垒：定时任务触发源只有时间——群里来了报告、文件
// 更新了，用户只能自己盯着再手动起会话。本件让预设任务盯信号自启。
// 纪律复用面：熔断/绑定会话/busy 跳过落账（ω99-321）原样；漏火补跑语义
// 不适用（事件无「火」——armMissRetry 拒绝 event），同信号防抖必须。
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, readFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createScheduleDaemon, armMissRetry, nextFireOf, describeScheduleHuman,
  validWatchPath, eventSourceError, parseScheduleCommand,
  scheduleRowsOf, SCHEDULE_EVENT_DEBOUNCE_MS,
} from "../src/schedules.js";
import { validDurable } from "../src/schedules-model.js";
import type { DurableTask } from "../src/schedules.js";

let ws: string;
beforeEach(async () => {
  ws = await mkdtemp(join(tmpdir(), "arc-eps-sched-"));
});
afterEach(async () => {
  await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => {});
});

const poll = async (pred: () => boolean | Promise<boolean>, ms = 8_000): Promise<void> => {
  const by = Date.now() + ms;
  while (!(await pred())) {
    if (Date.now() > by) return;
    await new Promise((r) => setTimeout(r, 25));
  }
};

const storedTasks = async (): Promise<Record<string, unknown>[]> => {
  const stored = JSON.parse(await readFile(join(ws, ".wudao", "schedules.json"), "utf8")) as { tasks: Record<string, unknown>[] };
  return stored.tasks;
};

const eventTask = (over: Partial<DurableTask> = {}): DurableTask => ({
  id: "aaaaaaaa",
  schedule: { type: "event", source: { kind: "file", path: "watched.md" } },
  prompt: "rebuild the report",
  workspace: ws,
  createdFrom: "test",
  createdAt: Date.now(),
  ...over,
});

describe("ε 纯逻辑 — 触发数学对 event 关门", () => {
  it("nextFireOf / armMissRetry 对 event 行一律 undefined（事件无「火」：不推进、不补跑）", () => {
    const t = eventTask();
    expect(nextFireOf(t, Date.now())).toBeUndefined();
    expect(armMissRetry(t, Date.now() - 60_000, Date.now())).toBeUndefined();
  });

  it("describeScheduleHuman 的事件人话形（收益语，不出现机制词）", () => {
    expect(describeScheduleHuman({ type: "event", source: { kind: "file", path: "docs/x.md" } })).toBe("当「docs/x.md」变化时");
    expect(describeScheduleHuman({ type: "event", source: { kind: "webhook", token: "t".repeat(24) } })).toBe("当收到 webhook 信号时");
  });

  it("validWatchPath 逃逸门：拒绝对路径/盘符/../空，接受工作区相对路径", () => {
    expect(validWatchPath("docs/x.md")).toBe(true);
    expect(validWatchPath("a/b/c.txt")).toBe(true);
    expect(validWatchPath("/etc/passwd")).toBe(false);
    expect(validWatchPath("C:\\\\win")).toBe(false);
    expect(validWatchPath("../outside.md")).toBe(false);
    expect(validWatchPath("a/../../escape.md")).toBe(false);
    expect(validWatchPath("")).toBe(false);
    expect(validWatchPath(".")).toBe(false);
    expect(eventSourceError({ kind: "file", path: "../escape.md" })).toContain("相对路径");
    expect(eventSourceError({ kind: "file", path: "ok.md" })).toBeUndefined();
    expect(eventSourceError({ kind: "webhook" })).toBeUndefined();
  });

  it("validDurable：event 行往返；少 token 的 webhook 行/逃逸路径行按畸形丢弃", () => {
    const round = eventTask();
    expect(validDurable({ ...round } as unknown as Record<string, unknown>)).toEqual(round);
    const hook: Record<string, unknown> = {
      ...eventTask(),
      schedule: { type: "event", source: { kind: "webhook", token: "abc123def456ghi789" } },
    };
    expect((validDurable(hook)?.schedule as { source: { kind: string } }).source.kind).toBe("webhook");
    const tokenless: Record<string, unknown> = {
      ...eventTask(),
      schedule: { type: "event", source: { kind: "webhook" } },
    };
    expect(validDurable(tokenless)).toBeUndefined();
    const escaped: Record<string, unknown> = {
      ...eventTask(),
      schedule: { type: "event", source: { kind: "file", path: "../escape.md" } },
    };
    expect(validDurable(escaped)).toBeUndefined();
  });

  it("parse：add watch / add webhook / webhook <id> 三形", () => {
    const w = parseScheduleCommand("add watch docs/x.md 重新生成报告");
    expect(w).toMatchObject({ kind: "add", prompt: "重新生成报告", schedule: { type: "event", source: { kind: "file", path: "docs/x.md" } } });
    const h = parseScheduleCommand("add webhook 收到信号就跑部署检查");
    expect(h).toMatchObject({ kind: "add", prompt: "收到信号就跑部署检查", schedule: { type: "event", source: { kind: "webhook" } } });
    expect(parseScheduleCommand("webhook abcdefgh")).toEqual({ kind: "webhook", id: "abcdefgh" });
    expect(parseScheduleCommand("add watch docs/x.md")).toMatchObject({ kind: "bad" });
    expect(parseScheduleCommand("add webhook")).toMatchObject({ kind: "bad" });
  });

  it("scheduleRowsOf：event 行带 triggerKind/eventSource；日历行缺省（老面零变化）", () => {
    const rows = scheduleRowsOf([eventTask(), { ...eventTask({ id: "bbbbbbbb", schedule: { type: "every", intervalMs: 300_000 } }) }]);
    expect(rows[0]).toMatchObject({ triggerKind: "event", eventSource: "file", nextRunAt: null });
    expect(rows[1]!.triggerKind).toBeUndefined();
    expect(rows[1]!.nextRunAt).toBeGreaterThan(0);
  });
});

describe("ε 守护 — file 盯梢车道", () => {
  it("文件变化即跑一次；同信号防抖吸收突发；rm 后盯梢退场", async () => {
    const runs: string[] = [];
    const lines: string[] = [];
    const daemon = await createScheduleDaemon({
      workspaceRoot: ws,
      tickMs: 0,
      env: {},
      eventSeams: { debounceMs: 150 },
      runTask: async (task) => {
        runs.push(task.id);
        return { ok: true, exitCode: 0, output: "done" };
      },
      notify: (line) => lines.push(line),
    });
    await writeFile(join(ws, "watched.md"), "v0\n", "utf8");
    const receipt = await daemon.add({ schedule: { type: "event", source: { kind: "file", path: "watched.md" } }, prompt: "rebuild", createdFrom: "test" });
    expect(receipt).toContain("已添加");
    expect(receipt).toContain("当「watched.md」变化时");
    // 一次保存的事件串（rename+change 连拍）只算一次。
    await writeFile(join(ws, "watched.md"), "v1\n", "utf8");
    await writeFile(join(ws, "watched.md"), "v1b\n", "utf8");
    await writeFile(join(ws, "watched.md"), "v1c\n", "utf8");
    await poll(() => runs.length >= 1);
    await new Promise((r) => setTimeout(r, 250));
    expect(runs).toHaveLength(1);
    // 防抖窗外的下一次变化 = 下一次运行。
    await writeFile(join(ws, "watched.md"), "v2\n", "utf8");
    await poll(() => runs.length >= 2);
    expect(runs).toHaveLength(2);
    // 列表面：event 行说「等信号」。
    expect(daemon.listText()).toContain("等信号");
    // rm → reconcile 关 watcher：再写不再跑。
    const id = (await storedTasks())[0]!.id as string;
    await daemon.rm(id);
    await new Promise((r) => setTimeout(r, 120));
    await writeFile(join(ws, "watched.md"), "v3\n", "utf8");
    await new Promise((r) => setTimeout(r, 400));
    expect(runs).toHaveLength(2);
    daemon.stop();
  });

  it("暂停即收不到信号；恢复后重新武装", async () => {
    const runs: string[] = [];
    const daemon = await createScheduleDaemon({
      workspaceRoot: ws,
      tickMs: 0,
      env: {},
      eventSeams: { debounceMs: 60 },
      runTask: async (task) => {
        runs.push(task.id);
        return { ok: true, exitCode: 0, output: "ok" };
      },
    });
    await writeFile(join(ws, "watched.md"), "v0\n", "utf8");
    await daemon.add({ schedule: { type: "event", source: { kind: "file", path: "watched.md" } }, prompt: "p", createdFrom: "test" });
    const id = (await storedTasks())[0]!.id as string;
    await daemon.pause(id);
    await writeFile(join(ws, "watched.md"), "v1\n", "utf8");
    await new Promise((r) => setTimeout(r, 350));
    expect(runs).toHaveLength(0);
    await daemon.unpause(id);
    await writeFile(join(ws, "watched.md"), "v2\n", "utf8");
    await poll(() => runs.length === 1);
    daemon.stop();
  });

  it("运行中的任务收到信号 = 跳过落账（ω99-321 语义：信号消耗、不排队）", async () => {
    const ledger: Record<string, unknown>[] = [];
    let release: (() => void) | undefined;
    const daemon = await createScheduleDaemon({
      workspaceRoot: ws,
      tickMs: 0,
      env: {},
      eventSeams: { debounceMs: 40 },
      runTask: async () => {
        await new Promise<void>((r) => {
          release = r;
        });
        return { ok: true, exitCode: 0, output: "slow" };
      },
      appendRun: async (e) => {
        ledger.push(e.data);
      },
    });
    await writeFile(join(ws, "watched.md"), "v0\n", "utf8");
    await daemon.add({ schedule: { type: "event", source: { kind: "file", path: "watched.md" } }, prompt: "p", createdFrom: "test" });
    const id = (await storedTasks())[0]!.id as string;
    await writeFile(join(ws, "watched.md"), "v1\n", "utf8"); // 启动慢运行
    await poll(() => release !== undefined);
    await new Promise((r) => setTimeout(r, 120));
    await writeFile(join(ws, "watched.md"), "v2\n", "utf8"); // 运行中的第二信号
    await poll(() => ledger.some((d) => d.mode === "skipped"));
    const skip = ledger.find((d) => d.mode === "skipped")!;
    expect(skip.triggeredBy).toBe("event");
    expect(skip.eventSource).toBe("file");
    expect(skip.ok).toBe(true); // 「不失败」占位——消费面先判 mode 再判 ok
    release!();
    await poll(() => ledger.some((d) => d.triggeredBy === "event" && d.mode === undefined));
    daemon.stop();
  });

  it("熔断照喂：连败 3 次自动停用，信号不再点火", async () => {
    const lines: string[] = [];
    const daemon = await createScheduleDaemon({
      workspaceRoot: ws,
      tickMs: 0,
      env: {},
      eventSeams: { debounceMs: 40 },
      runTask: async () => ({ ok: false, exitCode: 1, output: "boom" }),
      notify: (line) => lines.push(line),
    });
    await writeFile(join(ws, "watched.md"), "v0\n", "utf8");
    await daemon.add({ schedule: { type: "event", source: { kind: "file", path: "watched.md" } }, prompt: "p", createdFrom: "test" });
    const id = (await storedTasks())[0]!.id as string;
    for (let i = 1; i <= 3; i += 1) {
      await writeFile(join(ws, "watched.md"), `f${i}\n`, "utf8");
      await poll(async () => ((await storedTasks())[0]!.consecutiveFailures as number | undefined) === i);
      await new Promise((r) => setTimeout(r, 80));
    }
    expect((await storedTasks())[0]!.enabled).toBe(false);
    expect(lines.some((l) => l.includes("连续 3 次没跑成"))).toBe(true);
    await writeFile(join(ws, "watched.md"), "f4\n", "utf8");
    await new Promise((r) => setTimeout(r, 350));
    expect(((await storedTasks())[0]!.consecutiveFailures as number | undefined) ?? 0).toBe(3); // 第 4 信号零点火
    daemon.stop();
  });

  it("盯不存在的路径：一次诚实 notify，不武装、不拖垮守护", async () => {
    const lines: string[] = [];
    const daemon = await createScheduleDaemon({
      workspaceRoot: ws,
      tickMs: 0,
      env: {},
      runTask: async () => ({ ok: true, exitCode: 0, output: "ok" }),
      notify: (line) => lines.push(line),
    });
    await daemon.add({ schedule: { type: "event", source: { kind: "file", path: "no/such/file.md" } }, prompt: "p", createdFrom: "test" });
    await new Promise((r) => setTimeout(r, 200));
    expect(lines.some((l) => l.includes("不存在") && l.includes("no/such/file.md"))).toBe(true);
    // 守护还活着：加一条普通 every 任务照常。
    const ok = await daemon.add({ schedule: { type: "every", intervalMs: 300_000 }, prompt: "q", createdFrom: "test" });
    expect(ok).toContain("已添加");
    daemon.stop();
  });
});

describe("ε 守护 — webhook 回环车道", () => {
  const post = async (port: number, id: string, token: string | undefined, init: RequestInit = {}): Promise<{ status: number; body: string }> => {
    const res = await fetch(`http://127.0.0.1:${port}/trigger/${id}`, {
      ...init,
      method: "POST",
      ...(token !== undefined ? { headers: { authorization: `Bearer ${token}` } } : {}),
    });
    return { status: res.status, body: await res.text() };
  };

  it("token 对则跑；错则 401；默认关（无 webhook 任务即无监听）", async () => {
    const runs: string[] = [];
    const lines: string[] = [];
    const FIXED = 47_612; // 结构性默认关的探测位：先证「没人听」再证「有任务才听」
    const daemon = await createScheduleDaemon({
      workspaceRoot: ws,
      tickMs: 0,
      env: {},
      eventSeams: { debounceMs: 80, webhookPort: FIXED },
      runTask: async (task) => {
        runs.push(task.id);
        return { ok: true, exitCode: 0, output: "done" };
      },
      notify: (line) => lines.push(line),
    });
    // 默认关：还没有 webhook 任务，端口上没有监听（连接被拒）。
    await expect(fetch(`http://127.0.0.1:${FIXED}/trigger/aaaaaaaa`, { method: "POST" })).rejects.toThrow();
    const receipt = await daemon.add({ schedule: { type: "event", source: { kind: "webhook" } }, prompt: "deploy check", createdFrom: "test" });
    expect(receipt).toContain("curl -X POST");
    expect(receipt).toContain("/trigger/");
    const id = (await storedTasks())[0]!.id as string;
    const line = await daemon.webhookLine(id);
    expect(line).toContain(`http://127.0.0.1:${FIXED}/`);
    expect(line).toContain(id);
    // 错 token → 401；对 token → 202 + 一次运行。
    const bad = await post(FIXED, id, "wrong-token-entirely-wrong");
    expect(bad.status).toBe(401);
    const ok = await post(FIXED, id, /Bearer ([A-Za-z0-9_-]+)/.exec(line)?.[1]);
    expect(ok.status).toBe(202);
    await poll(() => runs.length === 1);
    // 同信号防抖：窗口内连发两次只算一次。
    await post(FIXED, id, /Bearer ([A-Za-z0-9_-]+)/.exec(line)?.[1]);
    await post(FIXED, id, /Bearer ([A-Za-z0-9_-]+)/.exec(line)?.[1]);
    await new Promise((r) => setTimeout(r, 300));
    expect(runs).toHaveLength(1);
    // 未知任务 → 404；GET → 405。
    expect((await post(FIXED, "zzzzzzzz", /Bearer ([A-Za-z0-9_-]+)/.exec(line)?.[1])).status).toBe(404);
    expect((await fetch(`http://127.0.0.1:${FIXED}/trigger/${id}`)).status).toBe(405);
    // rm 唯一的 webhook 任务 → 监听关闭（默认关是结构性的）。
    await daemon.rm(id);
    await new Promise((r) => setTimeout(r, 150));
    await expect(post(FIXED, id, /Bearer ([A-Za-z0-9_-]+)/.exec(line)?.[1])).rejects.toThrow();
    daemon.stop();
  });

  it("绑定会话忙时收到信号 = busy 跳过落账（与 cron 车道同语义）", async () => {
    const ledger: Record<string, unknown>[] = [];
    const lines: string[] = [];
    const daemon = await createScheduleDaemon({
      workspaceRoot: ws,
      tickMs: 0,
      env: {},
      eventSeams: { debounceMs: 40 },
      runTask: async () => ({ ok: true, exitCode: 0, output: "spawned" }),
      continueRun: async () => ({ started: false }),
      isBusy: () => true,
      appendRun: async (e) => {
        ledger.push(e.data);
      },
      notify: (line) => lines.push(line),
    });
    await daemon.add({ schedule: { type: "event", source: { kind: "webhook" } }, prompt: "p", sessionId: "sess1234", createdFrom: "test" });
    const id = (await storedTasks())[0]!.id as string;
    const line = await daemon.webhookLine(id);
    const port = Number(/:(\d+)\//.exec(line)?.[1]);
    const token = /Bearer ([A-Za-z0-9_-]+)/.exec(line)?.[1]!;
    expect((await post(port, id, token)).status).toBe(202);
    await poll(() => ledger.length === 1);
    expect(ledger[0]).toMatchObject({ mode: "skipped", triggeredBy: "event", eventSource: "webhook" });
    expect(lines.some((l) => l.includes("会话正忙") && l.includes(id))).toBe(true);
    daemon.stop();
  });

  it("非 webhook 任务问地址 → 拒答；WUDAO_DISABLE_CRON → 整域禁用", async () => {
    const daemon = await createScheduleDaemon({
      workspaceRoot: ws,
      tickMs: 0,
      env: { WUDAO_DISABLE_CRON: "1" },
    });
    expect(await daemon.add({ schedule: { type: "event", source: { kind: "webhook" } }, prompt: "p", createdFrom: "test" })).toContain("已禁用");
    expect(await daemon.webhookLine("aaaaaaaa")).toContain("已禁用");
    daemon.stop();
    const live = await createScheduleDaemon({ workspaceRoot: ws, tickMs: 0, env: {} });
    await live.add({ schedule: { type: "every", intervalMs: 300_000 }, prompt: "q", createdFrom: "test" });
    const id = (await storedTasks())[0]!.id as string;
    expect(await live.webhookLine(id)).toContain("不是 webhook 触发任务");
    live.stop();
  });

  it("token 随任务落库（重启后同一 token 仍可用——吊销 = rm）", async () => {
    const daemon = await createScheduleDaemon({ workspaceRoot: ws, tickMs: 0, env: {} });
    await daemon.add({ schedule: { type: "event", source: { kind: "webhook" } }, prompt: "p", createdFrom: "test" });
    daemon.stop();
    const stored = (await storedTasks())[0]!.schedule as { source: { kind: string; token?: string } };
    expect(stored.source.kind).toBe("webhook");
    expect(typeof stored.source.token).toBe("string");
    expect((stored.source.token ?? "").length).toBeGreaterThanOrEqual(16);
  });
});

describe("ε 常量钉", () => {
  it("防抖窗默认 2s（同信号风暴吸收的单一真值点）", () => {
    expect(SCHEDULE_EVENT_DEBOUNCE_MS).toBe(2_000);
  });
});
