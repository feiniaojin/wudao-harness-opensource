// M63-B batch B — the driver-fired faces: SessionEnd at clear/resume/exit,
// StopFailure at the error settle, InstructionsLoaded(session_start) at
// creation, the FileChanged e2e (watcher fires + the change reaches the
// model through the steering channel as a turn-boundary append with a
// byte-identical prefix — the cache assertion), and the skills-position
// ConfigChange poll. Deterministic: scripted model, stub tools, tmpdirs.
import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildTool, createScriptedModel } from "@wudao-org/core";
import type { AgentHooks, ModelInput, Tool } from "@wudao-org/core";
import { summarizeToolCall } from "../src/log.js";
import { createAgentDriver } from "../src/driver/agent-driver.js";
import type { AgentDriver, AgentDriverOptions } from "../src/driver/agent-driver.js";
import { stripProjectedNotes } from "./projected-notes.js";

const wait = (ms = 10) => new Promise((r) => setTimeout(r, ms));

async function until(cond: () => boolean | Promise<boolean>, what: string, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  await wait();
  while (!(await cond())) {
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${what}`);
    await wait();
  }
}

const params = {
  type: "object" as const,
  properties: { path: { type: "string" as const } },
  required: ["path"],
  additionalProperties: false,
};

function stubReadTool(content = "CONTENT"): Tool {
  return buildTool({
    name: "read_file",
    description: "stub read",
    parameters: params,
    execute: async () => ({ content }),
  });
}

function makeDriver(opts: Partial<AgentDriverOptions>): AgentDriver {
  return createAgentDriver({
    model: createScriptedModel([{ role: "assistant", content: "ok" }]),
    tools: [stubReadTool()],
    systemPrompt: "s",
    summarize: summarizeToolCall,
    ...opts,
  });
}

async function tmpWs(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "wudao-drv-m63b-"));
  await mkdir(join(dir, ".wudao", "sessions"), { recursive: true });
  return dir;
}

describe("M63-B SessionEnd (driver-fired)", () => {
  it("clear → 'clear'; loadHistory → 'resume'; dispose → 'exit'", async () => {
    const ends: string[] = [];
    const hooks: AgentHooks = {
      onSessionEnd: (source) => { ends.push(source); },
    };
    const d = makeDriver({ hooks, sessionId: "s-end" });
    await until(() => ends.length >= 0, "creation (no SessionEnd at start)");
    expect(ends).toEqual([]); // creation fires SessionStart, never SessionEnd
    d.clear();
    await until(() => ends.includes("clear"), "clear end");
    d.loadHistory([{ role: "user", content: "x" }], "s2");
    await until(() => ends.includes("resume"), "resume end");
    d.dispose();
    await until(() => ends.includes("exit"), "exit end");
    expect(ends).toEqual(["clear", "resume", "exit"]);
  });
});

describe("M63-B StopFailure (driver-fired)", () => {
  it("a failing run fires onStopFailure with the error kind", async () => {
    const failures: string[] = [];
    const hooks: AgentHooks = {
      onStopFailure: (kind) => { failures.push(kind); },
    };
    const boom = Object.assign(new Error("provider exploded"), {});
    const model = {
      modelId: "boom",
      generate: (): never => { throw boom; },
    };
    const d = makeDriver({ hooks, sessionId: "s-fail", model: model as never });
    d.submit("go");
    await until(() => d.getHistory().some((h) => h.kind === "error"), "run error");
    await until(() => failures.length >= 1, "stopFailure fire");
    expect(failures).toEqual(["error"]);
    d.dispose();
  });
});

describe("M63-B InstructionsLoaded session_start (driver-fired)", () => {
  it("fires once at driver creation", async () => {
    const loaded: string[] = [];
    const d = makeDriver({ sessionId: "s-instr", hooks: { onInstructionsLoaded: (source) => { loaded.push(source); } } });
    await until(() => loaded.length >= 1, "session_start fire");
    expect(loaded).toEqual(["session_start"]);
    d.dispose();
  });
});

describe("M63-B FileChanged e2e (steering delivery + cache assert)", () => {
  it("a watched file's change reaches the NEXT model input as a trailing append with a byte-identical prefix", async () => {
    const ws = await tmpWs();
    try {
      await writeFile(join(ws, "watched.txt"), "v1\n", "utf8");
      const fired: string[] = [];
      const inputs: ModelInput[] = [];
      // A gated read tool holds the run mid-turn so the file change lands
      // BETWEEN model calls (the spec's 轮间到达).
      let releaseTool: (() => void) | undefined;
      const gate = new Promise<void>((resolve) => { releaseTool = resolve; });
      const gatedRead: Tool = buildTool({
        name: "read_file",
        description: "gated read",
        parameters: params,
        execute: async () => {
          await gate;
          return { content: "GATED" };
        },
      });
      const model = {
        modelId: "rec",
        generate: (input: ModelInput) => {
          // SNAPSHOT: the loop passes the live state.messages reference —
          // record a copy or every "input" would alias the final history.
          inputs.push({ ...input, messages: [...input.messages] });
          if (inputs.length === 1) {
            return { role: "assistant" as const, content: "", toolCalls: [{ id: "c1", name: "read_file", arguments: { path: "a.txt" } }] };
          }
          return { role: "assistant" as const, content: "done" };
        },
      };
      const d = makeDriver({
        model: model as never,
        tools: [gatedRead],
        sessionId: "s-file",
        workspaceRoot: ws,
        // The raw driver's gate parks an ASK for every tool when no
        // canUseTool layer is given — allow-all keeps the test on the
        // steering seam (the ask path is covered by the notification tests).
        canUseTool: () => ({ behavior: "allow" as const }),
        fileChangeWatch: {
          targets: ["watched.txt"],
          fire: (p) => { fired.push(p); },
        },
      });
      d.submit("work");
      await until(() => inputs.length >= 1, "first model call");
      await until(() => d.getStatus().live.busyTools.length >= 1, "tool in flight", 4000);
      // Change the watched file while the run is parked mid-turn.
      await writeFile(join(ws, "watched.txt"), "v2\n", "utf8");
      await until(() => fired.includes("watched.txt"), "watcher fire", 4000);
      // Release the tool — the loop proceeds to model call 2, draining the
      // steering queue (the [file_changed] note) before the call.
      releaseTool?.();
      await until(() => inputs.length >= 2, "second model call");

      // (1) The hook fire seam ran with the changed path.
      expect(fired).toEqual(["watched.txt"]);
      // (2) The steering note landed as the TRAILING user message of call 2.
      const second = inputs[1]!;
      const last = second.messages[second.messages.length - 1];
      expect(last && last.role === "user" && last.content).toBe("[file_changed] watched.txt");
      // (3) CACHE ASSERT: every message of call 1 is a byte-identical PREFIX
      // of call 2's messages (the note is a pure append — nothing rewrote
      // history behind the change).
      const first = inputs[0]!;
      // 夜移 003：两侧先剥临时投影（时间提醒）——真实不变量是「稳定历史
      // 字节相同 + 注入是纯后缀」，临时注记随下一请求消失，不参与比较。
      const firstStable = stripProjectedNotes(first.messages);
      expect(stripProjectedNotes(second.messages).slice(0, firstStable.length)).toEqual(firstStable);
      d.dispose();
    } finally {
      await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }, 12_000);
});

describe("M63-B R1 — the system lane never auto-starts a run", () => {
  it("a change landing AFTER the final model call's drain leaves NO follow-up run; the note waits for the next one", async () => {
    const ws = await tmpWs();
    try {
      await writeFile(join(ws, "watched.txt"), "v1\n", "utf8");
      const fired: string[] = [];
      const inputs: ModelInput[] = [];
      // Call 2 (the final answer) is HELD until the test releases it — the
      // file change lands after call 2's steering drain (the loop's last).
      let releaseFinal: (() => void) | undefined;
      const heldFinal = new Promise<void>((resolve) => { releaseFinal = resolve; });
      const model = {
        modelId: "rec",
        generate: async (input: ModelInput) => {
          inputs.push({ ...input, messages: [...input.messages] });
          if (inputs.length === 1) {
            return { role: "assistant" as const, content: "", toolCalls: [{ id: "c1", name: "read_file", arguments: { path: "a.txt" } }] };
          }
          await heldFinal;
          return { role: "assistant" as const, content: "done" };
        },
      };
      const d = makeDriver({
        model: model as never,
        sessionId: "s-nostart",
        workspaceRoot: ws,
        canUseTool: () => ({ behavior: "allow" as const }),
        fileChangeWatch: { targets: ["watched.txt"], fire: (p2) => { fired.push(p2); } },
      });
      d.submit("work");
      await until(() => inputs.length >= 2, "final model call started (drain already done)", 5000);
      // The change lands while the final answer is being "generated" — after
      // the loop's last steering drain. The note parks in the SYSTEM lane.
      await writeFile(join(ws, "watched.txt"), "v2\n", "utf8");
      await until(() => fired.includes("watched.txt"), "watcher fire", 4000);
      releaseFinal?.();
      await until(() => !d.getStatus().busy, "run settled", 5000);
      // R1 assertion: NO follow-up run started for the note.
      await wait(400);
      expect(inputs.length).toBe(2);
      expect(d.getStatus().busy).toBe(false);
      // The parked note is delivered by the NEXT run's first model call
      // (a user submit — not the file change — starts it).
      d.submit("next task");
      await until(() => inputs.length >= 3, "next run first call", 5000);
      const third = inputs[2]!;
      const delivered = third.messages.some((m) => m.role === "user" && m.content === "[file_changed] watched.txt");
      expect(delivered).toBe(true);
      d.dispose();
    } finally {
      await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }, 15_000);
});

describe("M63-B ConfigChange skills position (driver poll)", () => {
  it("a skills-directory change consults the decide seam; a block surfaces the advisory notice", async () => {
    const ws = await tmpWs();
    try {
      const skillsRoot = join(ws, ".wudao", "skills");
      await mkdir(skillsRoot, { recursive: true });
      const consulted: string[] = [];
      let block = false;
      const d = makeDriver({
        sessionId: "s-skills",
        workspaceRoot: ws,
        configChangeSkills: {
          path: skillsRoot,
          decide: (position, path) => {
            consulted.push(`${position}:${path === skillsRoot ? "skills-root" : "other"}`);
            return !block;
          },
        },
      });
      // Touch the skills dir (mtime bump) — the poll (1s) consults.
      await wait(1100);
      await writeFile(join(skillsRoot, "new-skill.md"), "skill", "utf8");
      await until(() => consulted.length >= 1, "skills consult", 4000);
      expect(consulted[0]).toBe("skills:skills-root");
      // Block variant: another change surfaces the advisory notice.
      block = true;
      await wait(1100);
      await writeFile(join(skillsRoot, "another.md"), "skill2", "utf8");
      await until(
        () => d.getHistory().some((h) => h.kind === "notice" && h.text.includes("被 configChange 钩子拦截")), // ω99-166f-iii: 钉随源演进
        "advisory notice",
        4000,
      );
      d.dispose();
    } finally {
      await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }, 12_000);
});

describe("M63-B prompt_blocked rendering (driver)", () => {
  it("a submit-time prompt block renders the user-channel notice", async () => {
    const d = makeDriver({
      sessionId: "s-pblock",
      hooks: { onPromptSubmit: () => ({ block: true, reason: "no secrets" }) },
    });
    d.submit("leak sk-1");
    await until(
      () => d.getHistory().some((h) => h.kind === "notice" && h.text.includes("提示词被钩子拦截：no secrets")), // ω99-166f-iii: 钉随源演进
      "blocked notice",
    );
    d.dispose();
  });
});
