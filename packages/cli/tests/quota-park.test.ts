// 113-B3 — the CLI driver's quota-park lane: the parked terminal (notice +
// JSONL quota_park attribution row + no retry storm), the one-shot wake
// registration on the M61 scheduler, the wake firing into continueSession
// (the parked session continues — the marker never reaches the model), and
// the bounded re-park (cap 8 → the 9th gives up; a >24h horizon gives up
// immediately). Harness shape: omega99-289's makeHarness (persistence arms
// + scripted model); the scheduler runs on an injected clock (wake due-ness
// without wall-clock waiting).
import { describe, it, expect, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJsonlSessionStore } from "@wudao-org/core";
import type { AgentMessage, ModelClient, ModelInput, SessionStore } from "@wudao-org/core";
import { QuotaParkError } from "@wudao-org/providers";
import { summarizeToolCall } from "../src/log.js";
import { createAgentDriver } from "../src/driver/agent-driver.js";
import type { AgentDriver, AgentDriverOptions } from "../src/driver/agent-driver.js";
import { createCronRuntime } from "../src/cron.js";
import { QUOTA_PARK_REARM_CAP, QUOTA_PARK_REARM_MS, QUOTA_PARK_WAKE_MARGIN_MS, countQuotaParkEntries, quotaParkEntry, quotaWakeOf, quotaWakePrompt } from "../src/driver/quota-park.js";
import { formatScheduledInjection } from "@wudao-org/core";
import type { CronTask } from "@wudao-org/core";

const wait = (ms = 10) => new Promise((r) => setTimeout(r, ms));

async function until(cond: () => boolean | Promise<boolean>, what: string, timeoutMs = 4_000): Promise<void> {
  const start = Date.now();
  await wait();
  while (!(await cond())) {
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${what}`);
    await wait();
  }
}

const allow = vi.fn(async () => ({ kind: "allow" as const }));

/** The park-flavored model: "park" steps throw QuotaParkError (reset at
 *  now+resetAheadMs), answer steps return their text. Records every input. */
function quotaModel(plan: readonly ("park" | { readonly answer: string })[], resetAheadMs: number): { model: ModelClient; calls: () => number; inputs: ModelInput[] } {
  const inputs: ModelInput[] = [];
  let calls = 0;
  let nextAnswer = 0;
  const answers = plan.filter((p): p is { answer: string } => typeof p === "object");
  const model: ModelClient = {
    async generate(input: ModelInput) {
      inputs.push(input);
      const step = plan[Math.min(calls, plan.length - 1)]!;
      calls += 1;
      if (step === "park") {
        throw new QuotaParkError(
          "request",
          429,
          "[1308][已达到 5 小时的使用上限。您的限额将在 2026-09-24 05:30:32 重置。]",
          new Date(Date.now() + resetAheadMs),
          "glm",
          "glm-5.3",
        );
      }
      const answer = answers[nextAnswer] ?? { answer: "继续完成" };
      nextAnswer += 1;
      return { role: "assistant", content: answer.answer };
    },
  };
  return { model, calls: () => calls, inputs };
}

interface Harness {
  readonly driver: AgentDriver;
  readonly store: SessionStore;
  /** The tmp workspace root (the driver reads .wudao/sessions under it). */
  readonly root: string;
  readonly cron: Awaited<ReturnType<typeof createCronRuntime>>;
  readonly calls: () => number;
  readonly inputs: ModelInput[];
  readonly clock: { advance(to: number): void; base: number };
  dispose(): Promise<void>;
}

async function makeHarness(plan: readonly ("park" | { readonly answer: string })[], resetAheadMs = 3 * 3_600_000): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), "wd-qp-"));
  const store = createJsonlSessionStore(join(root, ".wudao", "sessions"));
  const base = Date.now();
  let clock = base;
  const cron = await createCronRuntime({ workspaceRoot: root, sessionId: "qp-sched", tickMs: 0, now: () => clock });
  const { model, calls, inputs } = quotaModel(plan, resetAheadMs);
  const loadedRef: AgentMessage[] = [];
  let driverRef: AgentDriver;
  let earlyUserPersist: Promise<void> = Promise.resolve();
  driverRef = createAgentDriver({
    model,
    tools: [],
    systemPrompt: "s",
    summarize: summarizeToolCall,
    workspaceRoot: root,
    onPermissionAsk: allow,
    cron: cron as AgentDriverOptions["cron"],
    onUserTurn: (m) => {
      loadedRef.push(m);
      earlyUserPersist = store.append(driverRef.getSessionId(), m).catch(() => {
        const i = loadedRef.indexOf(m);
        if (i >= 0) loadedRef.splice(i, 1);
      });
    },
    onRunComplete: (messages) => {
      void (async () => {
        await earlyUserPersist;
        for (const m of messages) {
          if (loadedRef.includes(m)) continue;
          loadedRef.push(m);
          await store.append(driverRef.getSessionId(), m).catch(() => {});
        }
      })();
    },
    onHistoryReplaced: (messages) => {
      loadedRef.length = 0;
      loadedRef.push(...messages);
    },
  });
  return {
    driver: driverRef,
    store,
    root,
    cron,
    calls,
    inputs,
    clock: { base, advance(to: number) { clock = to; } },
    async dispose() {
      cron.stop();
      driverRef.dispose();
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    },
  };
}

const parkRows = async (h: Harness): Promise<Record<string, unknown>[]> =>
  (await h.store.loadSessionEntries(h.driver.getSessionId()))
    .filter((e) => (e as { type?: string }).type === "quota_park")
    .map((e) => (e as { data: Record<string, unknown> }).data);

/** The attribution rows land fire-and-forget — poll until the expected count
 *  is on disk (bounded; rethrows nothing, the caller asserts right after). */
const parkRowsEventually = async (h: Harness, count: number): Promise<Record<string, unknown>[]> => {
  for (let i = 0; i < 200 && (await parkRows(h)).length < count; i += 1) await wait();
  return parkRows(h);
};

describe("113-B3 — the wake codec (unit pins)", () => {
  it("round-trips through the scheduler's injection wrapper", () => {
    const sid = "qp-1234abcd";
    const task = { id: "ab12cd34", sessionId: sid, prompt: quotaWakePrompt(sid), schedule: { type: "at", at: 1 }, createdAt: 0 } as unknown as CronTask;
    // The fired injection is "[scheduled task <id>] quota-wake <sid>" — the
    // decode must see through the wrapper.
    expect(quotaWakeOf(formatScheduledInjection(task))).toBe(sid);
    expect(quotaWakeOf(quotaWakePrompt(sid))).toBe(sid);
  });

  it("an ordinary prompt that merely MENTIONS the marker mid-sentence is never hijacked", () => {
    expect(quotaWakeOf("[scheduled task ab12cd34] 提醒我看一下 quota-wake 的实现")).toBeUndefined();
    expect(quotaWakeOf("[scheduled task ab12cd34] quota-wake 处理进展如何？后续跟进")).toBeUndefined();
    expect(quotaWakeOf("[scheduled task ab12cd34] 明早九点提醒我开会")).toBeUndefined();
  });

  it("the attribution row builder + the durable counter (the JSONL IS the count)", () => {
    const row = quotaParkEntry({ provider: "glm", resetAt: "2026-09-24T05:30:32.000Z", attempt: 3 });
    expect(row.type).toBe("quota_park");
    expect(countQuotaParkEntries([{ role: "user", content: "hi" } as never, row, quotaParkEntry({ provider: "glm", resetAt: "x", attempt: 4, gaveUp: true, reason: "cap" })])).toBe(2);
  });
});

describe("113-B3 — quota park: the parked terminal", () => {
  it("a QuotaParkError ends the run parked: notice + JSONL row + wake one-shot, no retry storm", async () => {
    const h = await makeHarness(["park", { answer: "unused" }]);
    try {
      h.driver.submit("跑基准");
      await until(() => h.driver.getStatus().busy === false, "parked run to settle");
      // No retry storm: exactly one model call (the ladder and the loop both
      // refused to replay the capped account).
      expect(h.calls()).toBe(1);
      // The user-facing notice: Chinese, the reset promise, NOT an error.
      const history = h.driver.getHistory();
      const parkNotice = history.find((e) => e.kind === "notice" && e.text.includes("⏸"));
      expect(parkNotice).toBeDefined();
      expect(parkNotice!.text).toContain("glm");
      expect(parkNotice!.text).toContain("自动继续");
      expect(history.some((e) => e.kind === "error")).toBe(false);
      // The status face: parked, attempt 1.
      expect(h.driver.getStatus().parked).toMatchObject({ provider: "glm", attempt: 1 });
      // The JSONL attribution row (M35 §2 generic lane; fire-and-forget
      // append — poll for it).
      const sid = h.driver.getSessionId();
      const rows = await parkRowsEventually(h, 1);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ provider: "glm", attempt: 1 });
      expect(typeof rows[0]!.resetAt).toBe("string");
      // The wake one-shot on the scheduler: at = resetAt + 30s margin, the
      // marker prompt naming THIS session.
      const tasks = h.cron.list();
      expect(tasks).toHaveLength(1);
      expect(tasks[0]!.schedule).toMatchObject({ type: "at" });
      expect((tasks[0]!.schedule as { at: number }).at).toBe(Date.parse(rows[0]!.resetAt as string) + QUOTA_PARK_WAKE_MARGIN_MS);
      expect(tasks[0]!.prompt).toBe(`quota-wake ${sid}`);
    } finally {
      await h.dispose();
    }
  });
});

describe("113-B3 — the wake: resume the parked session", () => {
  it("a fired wake continues the parked session (marker never reaches the model)", async () => {
    // Reset ~1s ahead of the real clock (the park lane stamps resetAt off
    // Date.now()); the wake's at = resetAt + 30s margin.
    const h = await makeHarness(["park", { answer: "配额恢复，任务完成" }], 1_000);
    try {
      h.driver.submit("跑基准");
      await until(() => h.driver.getStatus().busy === false, "parked run to settle");
      expect(h.calls()).toBe(1);
      const wake = h.cron.list()[0]!;
      // Advance the scheduler's injected clock past the wake instant and arm
      // the fire; the driver's idle seam (1s real-time poll) drains it.
      h.clock.advance((wake.schedule as { at: number }).at + 1_000);
      await h.cron.tick();
      await until(() => h.calls() === 2, "the wake's continued run to start");
      await until(
        () => h.driver.getStatus().busy === false && h.driver.getHistory().some((e) => e.kind === "assistant" && e.text === "配额恢复，任务完成"),
        "the continued run to settle",
      );
      // The parked face cleared (the session is being driven again).
      expect(h.driver.getStatus().parked).toBeUndefined();
      // The marker never reached the model: the continued call rides the
      // parked point's own history (the persisted user turn is still a member
      // — continueRun injects nothing beyond the loop's ordinary transient
      // tail blocks, the time-reminder note and the language block, both
      // honest for an hours-later resume), and no message carries the marker.
      const second = h.inputs[1]!;
      expect(second.messages.some((m) => (m as { content?: string }).content === "跑基准")).toBe(true);
      expect(second.messages.some((m) => String((m as { content?: string }).content ?? "").includes("quota-wake"))).toBe(false);
      // One-shot self-deleted after firing.
      expect(h.cron.list()).toHaveLength(0);
    } finally {
      await h.dispose();
    }
  });
});

describe("113-B3 — bounded re-park", () => {
  it("the 9th park in one session gives up: error terminal + honest attribution row", async () => {
    const h = await makeHarness(["park"]);
    try {
      for (let i = 1; i <= 9; i += 1) {
        h.driver.submit(`第 ${i} 次尝试`);
        await until(() => h.driver.getStatus().busy === false, `park ${i} to settle`);
        if (i < 9) {
          expect(h.driver.getStatus().parked).toMatchObject({ attempt: i });
        }
      }
      // 9 model calls — one per run, zero replays.
      expect(h.calls()).toBe(9);
      // The give-up: the ordinary error terminal (M12 shape), honest notice.
      const history = h.driver.getHistory();
      expect(history.some((e) => e.kind === "notice" && e.text.includes("⏸"))).toBe(true);
      const giveUp = history.find((e) => e.kind === "error");
      expect(giveUp).toBeDefined();
      expect(giveUp!.text).toContain("放弃等待");
      expect(h.driver.getStatus().parked).toBeUndefined();
      // The JSONL: 9 rows, the last one the gave-up row.
      const rows = await parkRowsEventually(h, 9);
      expect(rows).toHaveLength(9);
      expect(rows[8]).toMatchObject({ attempt: 9, gaveUp: true, reason: "cap" });
    } finally {
      await h.dispose();
    }
  });

  it("a reset more than 24h out gives up immediately (horizon)", async () => {
    const h = await makeHarness(["park"], 25 * 60 * 60 * 1000);
    try {
      h.driver.submit("跑基准");
      await until(() => h.driver.getStatus().busy === false, "run to settle");
      expect(h.calls()).toBe(1);
      const history = h.driver.getHistory();
      expect(history.some((e) => e.kind === "notice" && e.text.includes("⏸"))).toBe(false);
      expect(history.find((e) => e.kind === "error")?.text).toContain("放弃等待");
      const rows = await parkRowsEventually(h, 1);
      expect(rows[0]).toMatchObject({ attempt: 1, gaveUp: true, reason: "horizon" });
      // No wake was registered for a hopeless horizon.
      expect(h.cron.list()).toHaveLength(0);
    } finally {
      await h.dispose();
    }
  });
});

describe("124 项 1 — the wake re-arm budget exhausts honestly (dsh b6775f6d4f lesson pin)", () => {
  it("a persistently refused wake re-arms exactly QUOTA_PARK_REARM_CAP times, then notifies and STOPS — never a silent hang", { timeout: 40_000 }, async () => {
    // dsh b6775f6d4f: a wake budget that dies silently deadlocked every
    // background-driven session (issue #641). Our only bounded wake counter
    // is the quota-park re-arm cap: exhaustion must land a user notice, stop
    // the auto-retry chain, and leave the session in the resting parked state
    // (busy=false, disposeable) — the anti-dsh shape. Make every resume
    // refused by deleting the parked session's JSONL (empty entries →
    // continueSession answers started:false every time).
    const h = await makeHarness(["park"], 1_000);
    try {
      h.driver.submit("跑基准");
      await until(() => h.driver.getStatus().busy === false, "parked run to settle");
      const sid = h.driver.getSessionId();
      // Let the fire-and-forget persists (park row + run messages) land, then
      // delete the session file and keep it gone — the resume then answers
      // started:false (empty entries) on every wake.
      await parkRowsEventually(h, 1);
      await wait(300);
      const sessionFile = join(h.root, ".wudao", "sessions", `${sid}.jsonl`);
      for (let i = 0; i < 5; i += 1) {
        await rm(sessionFile, { force: true });
        await wait(60);
      }
      await rm(sessionFile, { force: true });
      // Fire the original wake: refused → re-arm #1 (+2min task + notice).
      await until(() => h.cron.list().some((t) => t.prompt === `quota-wake ${sid}`), "the wake one-shot to register");
      const first = h.cron.list().find((t) => t.prompt === `quota-wake ${sid}`)!;
      h.clock.advance((first.schedule as { at: number }).at + 1_000);
      await h.cron.tick();
      await until(
        () => h.driver.getHistory().some((e) => e.kind === "notice" && e.text.includes("分钟后自动重试")),
        "re-arm notice #1",
      );
      // Drive the re-arm chain to exhaustion: each +2min one-shot fires, the
      // resume is refused again (file still gone), one more re-arm — until
      // the cap notice. CLOCK DISCIPLINE: a re-arm's `at` is stamped off the
      // REAL clock (Date.now()+2min) while createTask's createdAt reads the
      // INJECTED clock — jumping the injected clock far ahead of real time
      // would make every later re-arm "at < createdAt" (never due, dead on
      // arrival). Advance exactly to each due task's own at+1s instead: the
      // injected clock stays behind the NEXT re-arm (stamped off a later
      // real moment) while still covering this one.
      for (let i = 2; i <= QUOTA_PARK_REARM_CAP + 1; i += 1) {
        const due = h.cron.list().find((t) => t.prompt === `quota-wake ${sid}`);
        expect(due).toBeDefined(); // a re-arm exists while within the cap
        // The 1.5s hold widens the real-time gap past the seam's 1s poll so
        // the NEXT re-arm's `at` (real+2min) always lands beyond the injected
        // clock at its creation — otherwise it is born not-due (see the clock
        // discipline note above).
        await wait(1_500);
        h.clock.advance((due.schedule as { at: number }).at + 1_000);
        await h.cron.tick();
        if (i <= QUOTA_PARK_REARM_CAP) {
          await until(
            () => h.driver.getHistory().filter((e) => e.kind === "notice" && e.text.includes("分钟后自动重试")).length >= i,
            `re-arm notice #${i}`,
          );
        } else {
          await until(
            () => h.driver.getHistory().some((e) => e.kind === "notice" && e.text.includes("已停止自动重试")),
            "the cap notice",
          );
        }
      }
      // Exactly QUOTA_PARK_REARM_CAP re-arm notices, then the cap notice —
      // and the chain STOPPED (no quota-wake task remains scheduled).
      expect(
        h.driver.getHistory().filter((e) => e.kind === "notice" && e.text.includes("分钟后自动重试")).length,
      ).toBe(QUOTA_PARK_REARM_CAP);
      expect(h.cron.list().some((t) => t.prompt === `quota-wake ${sid}`)).toBe(false);
      // Not hung: the driver rests (no busy loop), the cap notice names the
      // manual path, and the session stays parked (a resting state, not a
      // silent deadlock — the user can still continue manually).
      expect(h.driver.getStatus().busy).toBe(false);
      const capNotice = h.driver.getHistory().find((e) => e.kind === "notice" && e.text.includes("已停止自动重试"));
      expect(capNotice!.text).toContain("手动继续");
      expect(h.driver.getStatus().parked).toMatchObject({ attempt: 1 });
    } finally {
      await h.dispose();
    }
  });
});

describe("113-B3 — the durable counter", () => {
  it("resume() restores the park count from the JSONL (the file IS the count)", async () => {
    const h = await makeHarness(["park"]);
    try {
      const sid = h.driver.getSessionId();
      h.driver.submit("第一次");
      await until(() => h.driver.getStatus().busy === false, "park 1");
      h.driver.submit("第二次");
      await until(() => h.driver.getStatus().busy === false, "park 2");
      expect(h.driver.getStatus().parked).toMatchObject({ attempt: 2 });
      // The attribution rows are appended fire-and-forget — let them land
      // before the resume re-reads the file.
      expect((await parkRowsEventually(h, 2)).length).toBe(2);
      const resumed = await h.driver.resume(sid);
      expect(resumed.ok).toBe(true);
      h.driver.submit("第三次");
      await until(() => h.driver.getStatus().busy === false, "park 3");
      expect(h.driver.getStatus().parked).toMatchObject({ attempt: 3 });
    } finally {
      await h.dispose();
    }
  });
});
