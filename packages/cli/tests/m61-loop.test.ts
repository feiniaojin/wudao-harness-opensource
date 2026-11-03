// M61 §2 — /loop: the interval grammar (bare token + "every X" clause,
// seconds→minute, non-clean→nearest tier AND told), the maintenance prompt's
// discipline clauses (verbatim), loop.md override (project > global, 25KB
// truncation), skills-as-prompts visibility (M58-B #4), the dynamic rules
// (clamp [60,3600], stop, ~20m fallback, second silent round ends), and the
// controller/driver wiring (Esc clears only loop wakeups).
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage } from "@wudao-org/core";
import { createCronRuntime } from "../src/cron.js";
import { summarizeToolCall } from "../src/log.js";
import {
  parseLoopInterval,
  resolveLoopPrompt,
  expandLoopSkillPrompt,
  createLoopController,
  createScheduleWakeupTool,
  nextDynamicAction,
  MAINTENANCE_LOOP_PROMPT,
  WAKEUP_FALLBACK_MS,
  type LoopController,
} from "../src/commands/loop.js";
import { parseSkillFrontmatter, type LoadedSkill } from "../src/skills.js";
import { createAgentDriver } from "../src/driver/agent-driver.js";
import type { AgentDriver } from "../src/driver/agent-driver.js";

const MIN = 60_000;
const HOUR = 3_600_000;
let ws: string;
beforeEach(async () => {
  ws = await mkdtemp(join(tmpdir(), "m61-loop-"));
});
afterEach(async () => {
  await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => {});
});

describe("M61 §2 — interval grammar", () => {
  it("parses bare tokens and every-clauses; units s/m/h/d", () => {
    expect(parseLoopInterval("30m")).toEqual({ ok: true, interval: { ms: 30 * MIN } });
    expect(parseLoopInterval("2h")).toEqual({ ok: true, interval: { ms: 2 * HOUR } });
    expect(parseLoopInterval("1d")).toEqual({ ok: true, interval: { ms: 86_400_000 } });
    expect(parseLoopInterval("every 2 hours")).toEqual({ ok: true, interval: { ms: 2 * HOUR } });
    expect(parseLoopInterval("every 45 minutes")).toEqual({ ok: true, interval: { ms: 45 * MIN } });
    expect(parseLoopInterval("20m")).toEqual({ ok: true, interval: { ms: 20 * MIN } });
    expect(parseLoopInterval("EVERY 1 DAY")).toEqual({ ok: true, interval: { ms: 86_400_000 } });
  });

  it("seconds carry UP to a minute", () => {
    const r = parseLoopInterval("45s");
    expect(r.ok && r.interval.ms).toBe(MIN);
    expect(r.ok && r.interval.note).toContain("1m");
  });

  it("non-clean intervals round to the nearest clean tier AND say which", () => {
    const seven = parseLoopInterval("7m");
    expect(seven.ok && seven.interval.ms).toBe(5 * MIN);
    expect(seven.ok && seven.interval.note).toContain("5m");
    const ninety = parseLoopInterval("90m");
    expect(ninety.ok && ninety.interval.ms).toBe(2 * HOUR); // tie 1h/2h rounds up
    expect(ninety.ok && ninety.interval.note).toContain("2h");
    const bad = parseLoopInterval("soon");
    expect(bad.ok).toBe(false);
  });
});

describe("M61 §2 — maintenance prompt discipline (verbatim clauses)", () => {
  it("carries the ladder + both non-negotiable clauses", () => {
    expect(MAINTENANCE_LOOP_PROMPT).toContain("Continue unfinished work");
    expect(MAINTENANCE_LOOP_PROMPT).toContain("Tend the current branch's health");
    expect(MAINTENANCE_LOOP_PROMPT).toContain("cleanup and housekeeping");
    // The two disciplines det-48 asserts verbatim.
    expect(MAINTENANCE_LOOP_PROMPT).toContain("Do NOT open new initiatives");
    expect(MAINTENANCE_LOOP_PROMPT).toContain("Irreversible actions are limited to continuing work already authorized in this transcript");
  });
});

describe("M61 §2 — loop.md override", () => {
  it("project loop.md wins over global; arg wins over both; 25KB truncated", async () => {
    const globalHome = await mkdtemp(join(tmpdir(), "m61-global-"));
    await mkdir(join(ws, ".wudao"), { recursive: true });
    await writeFile(join(ws, ".wudao", "loop.md"), "PROJECT LOOP", "utf8");
    await writeFile(join(globalHome, "loop.md"), "GLOBAL LOOP", "utf8");
    const env = { WUDAO_GLOBAL_HOME: globalHome };

    expect((await resolveLoopPrompt({ workspaceRoot: ws, env })).prompt).toBe("PROJECT LOOP");
    const arg = await resolveLoopPrompt({ workspaceRoot: ws, env, arg: "explicit arg" });
    expect(arg.prompt).toBe("explicit arg");
    expect(arg.source).toBe("arg");

    await rm(join(ws, ".wudao", "loop.md"));
    expect((await resolveLoopPrompt({ workspaceRoot: ws, env })).prompt).toBe("GLOBAL LOOP");
    await rm(globalHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });

    const none = await resolveLoopPrompt({ workspaceRoot: ws, env: {} });
    expect(none.source).toBe("maintenance");
    expect(none.prompt).toBe(MAINTENANCE_LOOP_PROMPT);
  });

  it("a 30KB loop.md is truncated at 25KB", async () => {
    const globalHome = await mkdtemp(join(tmpdir(), "m61-global-"));
    await mkdir(join(ws, ".wudao"), { recursive: true });
    await writeFile(join(ws, ".wudao", "loop.md"), "x".repeat(30 * 1024), "utf8");
    const r = await resolveLoopPrompt({ workspaceRoot: ws, env: {} });
    expect(r.prompt.length).toBe(25 * 1024);
    expect(r.source).toBe("project-loop-md");
    await rm(globalHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
});

describe("M61 §2 — skills as prompts (M58-B #4 linkage)", () => {
  const mkSkill = (name: string, disable?: boolean): LoadedSkill => {
    const fm = parseSkillFrontmatter(`---\nname: ${name}\ndescription: d${disable ? "\ndisable-model-invocation: true" : ""}\n---\nBODY ${name}`);
    return {
      name,
      description: "d",
      filePath: `/sk/${name}/SKILL.md`,
      relPath: `.claude/skills/${name}/SKILL.md`,
      content: `---\nname: ${name}\n---\nBODY ${name}`,
      ...(disable ? { disableModelInvocation: true as const } : {}),
      ...(fm?.context !== undefined ? { context: fm.context } : {}),
    };
  };

  it("a model-invocable skill expands; disable-model-invocation arrives as plain text", () => {
    const ok = mkSkill("alpha");
    const hidden = mkSkill("beta", true);
    const skills = [ok, hidden];
    expect(expandLoopSkillPrompt("/skill:alpha do it", skills)).toContain("<skill name=\"alpha\" args=\"do it\">");
    expect(expandLoopSkillPrompt("/skill:beta do it", skills)).toBe("/skill:beta do it");
    expect(expandLoopSkillPrompt("just a prompt", skills)).toBe("just a prompt");
    expect(expandLoopSkillPrompt("/skill:nosuch x", skills)).toBe("/skill:nosuch x");
  });
});

describe("M61 §2 — dynamic rules (clamp / stop / fallback / end)", () => {
  it("delaySeconds clamps into [60, 3600]", () => {
    const low = nextDynamicAction({ kind: "continue", delaySeconds: 5 }, false);
    expect(low.kind === "schedule" && low.delayMs).toBe(60_000);
    const high = nextDynamicAction({ kind: "continue", delaySeconds: 99999 }, false);
    expect(high.kind === "schedule" && high.delayMs).toBe(3_600_000);
    const mid = nextDynamicAction({ kind: "continue", delaySeconds: 300 }, false);
    expect(mid.kind === "schedule" && mid.delayMs).toBe(300_000);
  });

  it("stop ends; silence gets one ~20m fallback; a second silent round ends", () => {
    expect(nextDynamicAction({ kind: "stop" }, false).kind).toBe("end");
    const first = nextDynamicAction(undefined, false);
    expect(first.kind === "schedule" && first.delayMs).toBe(WAKEUP_FALLBACK_MS);
    expect(first.kind === "schedule" && first.fallback).toBe(true);
    expect(nextDynamicAction(undefined, true).kind).toBe("end");
    // A wakeup on a fallback round continues normally.
    const wake = nextDynamicAction({ kind: "continue", delaySeconds: 120 }, true);
    expect(wake.kind === "schedule" && wake.fallback).toBe(false);
  });
});

describe("M61 §2 — controller over the cron runtime", () => {
  async function fixture(args: { readonly prompt?: string } = {}) {
    const cron = await createCronRuntime({ workspaceRoot: ws, sessionId: "s-loop", tickMs: 0 });
    const submitted: string[] = [];
    const notices: string[] = [];
    const controller = createLoopController({
      cron,
      workspaceRoot: ws,
      submit: (p) => submitted.push(p),
      notify: (t) => notices.push(t),
    });
    return { cron, controller, submitted, notices, ...(args.prompt !== undefined ? { prompt: args.prompt } : {}) };
  }

  it("fixed start arms a loop task and submits round 1 with the maintenance prompt", async () => {
    const f = await fixture();
    const notice = await f.controller.command("30m");
    expect(notice).toContain("every 30m");
    expect(f.submitted.length).toBe(1);
    expect(f.submitted[0]).toBe(MAINTENANCE_LOOP_PROMPT);
    const tasks = f.cron.list();
    // No wakeup task yet (it arms at the run's settle); the loop is active.
    expect(f.controller.active()).toBe(true);
    expect(f.controller.status()).toContain("fixed");
    // Settle arms the next wakeup at now+30m with a fresh prompt.
    await f.controller.onRunEnd();
    const armed = f.cron.list();
    expect(armed.length).toBe(1);
    expect(armed[0]!.origin).toBe("loop");
    expect(armed[0]!.schedule.type).toBe("at");
    f.cron.stop();
  });

  it("non-clean interval is rounded AND the notice tells the chosen tier", async () => {
    const f = await fixture();
    const notice = await f.controller.command("7m check the build");
    expect(notice).toContain("5m");
    expect(notice).toContain("not a clean interval");
    expect(f.submitted[0]).toBe("check the build"); // explicit arg wins
    f.cron.stop();
  });

  it("stop clears the loop tasks and pending wakeups, not explicit ones", async () => {
    const f = await fixture();
    await f.controller.command("30m");
    await f.controller.onRunEnd(); // arm the wakeup
    await f.cron.createTask({ prompt: "explicit", schedule: { type: "interval", everyMs: 60 * MIN } });
    const stop = f.controller.stopCommand();
    expect(stop).toContain("stopped");
    const remaining = f.cron.list();
    expect(remaining.length).toBe(1);
    expect(remaining[0]!.origin ?? "model").toBe("model");
    expect(f.controller.active()).toBe(false);
    f.cron.stop();
  });

  it("dynamic: schedule_wakeup delays re-arm at +delay; two silent rounds end", async () => {
    const f = await fixture();
    await f.controller.command(""); // bare /loop = dynamic + maintenance prompt
    expect(f.submitted[0]).toBe(MAINTENANCE_LOOP_PROMPT);
    // Silent round 1 → fallback wakeup (~20m out).
    await f.controller.onRunEnd();
    const armed = f.cron.list()[0]!;
    expect(armed.schedule.type).toBe("at");
    const at = (armed.schedule as { at: number }).at;
    expect(at - Date.now()).toBeGreaterThanOrEqual(WAKEUP_FALLBACK_MS - 5_000);
    expect(at - Date.now()).toBeLessThanOrEqual(WAKEUP_FALLBACK_MS + 5_000);
    expect(f.notices.some((n) => n.includes("fallback"))).toBe(true);
    // Silent round 2 (fallback round) → the loop ENDS.
    await f.controller.onRunEnd();
    expect(f.controller.active()).toBe(false);
    expect(f.cron.list().length).toBe(0);
    f.cron.stop();
  });

  it("schedule_wakeup tool refuses without a loop; records the decision with one", async () => {
    const f = await fixture();
    const box: { current?: LoopController } = {};
    const tool = createScheduleWakeupTool(() => box.current);
    const no = await tool.execute({ delaySeconds: 120 });
    expect(no.isError).toBe(true);
    box.current = f.controller;
    await f.controller.command("keep watching the CI");
    const bad = await tool.execute({ reason: "no delay" });
    expect(bad.isError !== true && bad.content).toContain("needs delaySeconds");
    const clamped = await tool.execute({ delaySeconds: 5, reason: "quick check" });
    expect(clamped.content).toContain("clamped from 5s");
    // stop:true ends the loop at the round's close.
    const stop = await tool.execute({ stop: true });
    expect(stop.content).toContain("stop recorded");
    await f.controller.onRunEnd();
    expect(f.controller.active()).toBe(false);
    f.cron.stop();
  });
});

describe("M61 §2 — driver wiring", () => {
  it("/loop routes through the driver; Esc clears only loop pending wakeups", async () => {
    const cron = await createCronRuntime({ workspaceRoot: ws, sessionId: "s-drv", tickMs: 0 });
    const responses: AssistantMessage[] = [{ role: "assistant", content: "ok" }];
    let i = 0;
    const model = { generate: async () => responses[i++] ?? { role: "assistant", content: "done" } };
    const driver: AgentDriver = createAgentDriver({
      model: model as never,
      tools: [],
      systemPrompt: "sp",
      summarize: summarizeToolCall,
      onPermissionAsk: async () => ({ kind: "allow" }),
      workspaceRoot: ws,
      cron,
    });
    // An explicit task + a loop wakeup both armed.
    await cron.createTask({ prompt: "explicit task", schedule: { type: "at", at: Date.now() + 1000 } });
    await cron.createTask({ prompt: "loop round", schedule: { type: "at", at: Date.now() + 1000 }, origin: "loop" });
    await cron.tick(Date.now() + 5 * MIN);
    expect(cron.pending().length).toBe(2);
    // Esc → only the loop wakeup clears.
    driver.interrupt();
    expect(cron.pending().length).toBe(1);
    expect(cron.pending()[0]!.task.origin ?? "model").toBe("model");
    // /loop stop clears loop tasks (none left) and reports.
    driver.submit("/loop stop");
    const history = driver.getHistory();
    expect(history.some((h) => h.kind === "notice" && h.text.includes("/loop"))).toBe(true);
    cron.stop();
    driver.dispose();
  });
});
