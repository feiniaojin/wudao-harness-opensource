// M63-A — the driver-fired session-surface events: SessionStart at every
// boundary the driver owns (creation with derived/explicit source, /clear,
// /resume + loadHistory, /compact + the loop's compacted event) and
// Notification at the ask park + run settle. Deterministic: scripted model,
// stub tools, tmpdir workspaces.
import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildTool, createScriptedModel } from "@wudao/core";
import type { AgentHooks, AgentMessage, ModelInput, SessionStartSource, Tool } from "@wudao/core";
import { summarizeToolCall } from "../src/log.js";
import { createAgentDriver } from "../src/driver/agent-driver.js";
import type { AgentDriver, AgentDriverOptions } from "../src/driver/agent-driver.js";

const wait = (ms = 10) => new Promise((r) => setTimeout(r, ms));

async function until(cond: () => boolean | Promise<boolean>, what: string, timeoutMs = 4000): Promise<void> {
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

// Records every session-surface firing the driver makes.
function recorder() {
  const starts: { source: SessionStartSource; sessionId?: string }[] = [];
  const notes: string[] = [];
  const hooks: AgentHooks = {
    onSessionStart: (source, info) => {
      starts.push({ source, sessionId: info.sessionId });
    },
    onNotification: (kind) => {
      notes.push(kind);
    },
  };
  return { starts, notes, hooks };
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
  const dir = await mkdtemp(join(tmpdir(), "wudao-drv-m63-"));
  await mkdir(join(dir, ".wudao", "sessions"), { recursive: true });
  return dir;
}

describe("M63-A SessionStart (driver-fired)", () => {
  it("creation fires 'startup' for a fresh session and 'resume' for a seeded one", async () => {
    const rec = recorder();
    const fresh = makeDriver({ hooks: rec.hooks, sessionId: "s-fresh" });
    await until(() => rec.starts.length >= 1, "fresh startup fire");
    expect(rec.starts[0]).toEqual({ source: "startup", sessionId: "s-fresh" });
    fresh.dispose();

    const rec2 = recorder();
    const seed: AgentMessage[] = [{ role: "user", content: "old" }];
    const resumed = makeDriver({ hooks: rec2.hooks, sessionId: "s-res", initialMessages: seed });
    await until(() => rec2.starts.length >= 1, "resume fire");
    expect(rec2.starts[0]!.source).toBe("resume");
    resumed.dispose();
  });

  it("an explicit sessionStartSource ('fork') wins over the derivation", async () => {
    const rec = recorder();
    const d = makeDriver({
      hooks: rec.hooks,
      sessionId: "s-fork",
      sessionStartSource: "fork",
      initialMessages: [{ role: "user", content: "old" }],
    });
    await until(() => rec.starts.length >= 1, "fork fire");
    expect(rec.starts[0]).toEqual({ source: "fork", sessionId: "s-fork" });
    d.dispose();
  });

  // cc-plugins E4 (final-review I1): a SessionStart layer's returned
  // additionalContext must reach the model on the AgentDriver frontends too —
  // parked on the driver's MetaNote projection (projection-only, first model
  // call), exactly like the REPL/one-shot drivers.
  it("a returned additionalContext rides the MetaNote projection into the first model call", async () => {
    const inputs: ModelInput[] = [];
    const fired: string[] = [];
    const d = createAgentDriver({
      model: {
        async generate(input: ModelInput) {
          inputs.push(input);
          return { role: "assistant", content: "ok" };
        },
      },
      tools: [stubReadTool()],
      systemPrompt: "s",
      summarize: summarizeToolCall,
      sessionId: "s-ctx",
      hooks: {
        onSessionStart: async () => {
          fired.push("startup");
          await wait(5);
          return "DET52-BOOTSTRAP-CONTEXT";
        },
      },
    });
    await until(() => fired.length >= 1, "startup fire");
    await wait(20); // let the hook's return land on the metaNotes queue
    d.submit("hello");
    await until(() => inputs.length >= 1, "first model call");
    d.dispose();
    const saw = inputs.some((i) => JSON.stringify(i.messages).includes("DET52-BOOTSTRAP-CONTEXT"));
    expect(saw).toBe(true);
  });

  it("clear() fires 'clear'; loadHistory() fires 'resume'", async () => {
    const rec = recorder();
    const d = makeDriver({ hooks: rec.hooks, sessionId: "s-clear" });
    await until(() => rec.starts.length >= 1, "startup fire");
    d.clear();
    await until(() => rec.starts.some((s) => s.source === "clear"), "clear fire");
    d.loadHistory([{ role: "user", content: "adopted" }], "s-other");
    await until(() => rec.starts.filter((s) => s.source === "resume").length >= 1, "loadHistory resume fire");
    expect(rec.starts.map((s) => s.source)).toEqual(["startup", "clear", "resume"]);
    d.dispose();
  });

  it("the ROUTED /clear (submit \"/clear\") fires 'clear' exactly once — the shared wipe owns the fire", async () => {
    const rec = recorder();
    const d = makeDriver({ hooks: rec.hooks, sessionId: "s-routed" });
    await until(() => rec.starts.length >= 1, "startup fire");
    const outcome = d.submit("/clear");
    expect(outcome).not.toBe("frontend"); // the driver-owned routed arm ran
    await until(() => rec.starts.some((s) => s.source === "clear"), "routed clear fire");
    // Exactly one fire — not one per path.
    expect(rec.starts.filter((s) => s.source === "clear").length).toBe(1);
    d.dispose();
  });

  it("a manual /compact fires PreCompact('manual') + PostCompact('manual') + SessionStart('compact')", async () => {
    const ws = await tmpWs();
    try {
      const events: string[] = [];
      const rec = recorder();
      const hooks: AgentHooks = {
        ...rec.hooks,
        onPreCompact: (_m, trigger) => {
          events.push(`pre:${trigger}`);
        },
        onPostCompact: (_m, trigger) => {
          events.push(`post:${trigger}`);
        },
      };
      // Two-turn scripted history + a summarizer answer, keepRecent 1 so the
      // manual compact finds a span.
      const model = createScriptedModel([
        { role: "assistant", content: "A1" },
        { role: "assistant", content: "A2" },
        { role: "assistant", content: "SUMMARY" },
      ]);
      const d = makeDriver({ hooks, sessionId: "s-compact", model, workspaceRoot: ws, compaction: { contextWindowTokens: 64_000, keepRecent: 1 } });
      d.submit("first");
      await until(() => d.getHistory().some((h) => h.kind === "assistant"), "first answer");
      d.submit("second");
      await until(() => d.getHistory().filter((h) => h.kind === "assistant").length >= 2, "second answer");
      d.submit("/compact");
      await until(() => events.includes("post:manual"), "manual compact hooks", 6000);
      expect(events).toEqual(["pre:manual", "post:manual"]);
      await until(() => rec.starts.some((s) => s.source === "compact"), "compact SessionStart");
      d.dispose();
    } finally {
      await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("a deferred manual /compact skips the compaction (PreCompact defer)", async () => {
    const ws = await tmpWs();
    try {
      const model = createScriptedModel([
        { role: "assistant", content: "A1" },
        { role: "assistant", content: "A2" },
        { role: "assistant", content: "SUMMARY-NEVER" },
      ]);
      const d = makeDriver({
        model, sessionId: "s-defer", workspaceRoot: ws,
        compaction: { contextWindowTokens: 64_000, keepRecent: 1 },
        hooks: { onPreCompact: () => ({ defer: true, reason: "hold on" }) },
      });
      d.submit("first");
      await until(() => d.getHistory().some((h) => h.kind === "assistant"), "first answer");
      d.submit("/compact");
      await until(
        () => d.getHistory().some((h) => h.kind === "notice" && h.text.includes("压缩已推迟：hold on")), // ω99-166f-iii: 钉随源演进
        "defer notice",
      );
      // The summarizer model call never happened.
      expect(model.calls).toBe(1);
      d.dispose();
    } finally {
      await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("resume(id) fires 'resume' only for a session the store knows", async () => {
    const ws = await tmpWs();
    try {
      // Seed one session file the store can load.
      await writeFile(
        join(ws, ".wudao", "sessions", "known.jsonl"),
        `${JSON.stringify({ role: "user", content: "hi", uuid: "u1" })}\n`,
        "utf8",
      );
      const rec = recorder();
      const d = makeDriver({ hooks: rec.hooks, sessionId: "s-x", workspaceRoot: ws });
      await until(() => rec.starts.length >= 1, "startup fire");
      expect(await d.resume("missing-id")).toEqual({ ok: false, reason: "not_found" });
      expect(rec.starts.length).toBe(1); // not-found resume fires nothing
      expect(await d.resume("known")).toEqual({ ok: true });
      await until(() => rec.starts.some((s) => s.source === "resume"), "resume fire");
      d.dispose();
    } finally {
      await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
});

describe("M63-A Notification (driver-fired)", () => {
  it("'permission' fires when an ask parks; 'idle' when the run settles", async () => {
    const rec = recorder();
    // A non-read tool in default mode → the gate asks → the ask parks.
    const writeTool = buildTool({
      name: "write_file",
      description: "stub write",
      parameters: params,
      execute: async () => ({ content: "written" }),
    });
    const model = createScriptedModel([
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "write_file", arguments: { path: "x.txt" } }] },
      { role: "assistant", content: "done" },
    ]);
    const d = makeDriver({ hooks: rec.hooks, sessionId: "s-note", model, tools: [writeTool] });
    d.submit("write something");
    await until(() => d.getStatus().pendingPermission !== null, "parked ask");
    expect(rec.notes).toContain("permission");
    d.answerPermission(true);
    await until(() => !d.getStatus().busy, "run settled");
    await until(() => rec.notes.includes("idle"), "idle notification");
    d.dispose();
  });
});
