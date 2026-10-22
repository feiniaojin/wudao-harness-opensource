// M63-B batch B — the config bridge for the new event surface: loader keys,
// matcher filtering per event, the decision contracts (task block /
// subagentStop continue / configChange veto), the SessionEnd shared 1.5s
// budget (over-budget kill), fileChangeTargets extraction, and compose
// semantics. Fixture scripts in tests/fixtures (execFile semantics).
import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadHooksSettings, buildConfiguredHooks, composeAgentHooks, fileChangeTargets, SESSION_END_BUDGET_MS } from "../src/hooks-config.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const fx = (name: string): string => join(FIXTURES, name);

function collector(): { warn: (m: string) => void; messages: string[] } {
  const messages: string[] = [];
  return { warn: (m: string) => messages.push(m), messages };
}

async function tmpWorkspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "wudao-hooks-m63b-"));
  await mkdir(join(dir, ".wudao"), { recursive: true });
  return dir;
}

describe("loader accepts the batch-B keys (CANONICAL_HOOK_EVENTS extension)", () => {
  it("parses every new key; the merge pin covers them automatically", async () => {
    const root = await tmpWorkspace();
    const log = collector();
    try {
      await writeFile(join(root, ".wudao", "settings.json"), JSON.stringify({
        hooks: {
          onTaskCreated: [{ command: "true" }],
          onTaskCompleted: [{ command: "true" }],
          onSubagentStart: [{ command: "true", matcher: "coder" }],
          onSubagentStop: [{ command: "true", matcher: "coder|fork" }],
          onFileChanged: [{ command: "true", matcher: "package.json" }],
          onConfigChange: [{ command: "true", matcher: "project" }],
          onInstructionsLoaded: [{ command: "true", matcher: "path_glob_match" }],
          onSessionEnd: [{ command: "true", matcher: "clear" }],
          onStopFailure: [{ command: "true", matcher: "context" }],
        },
      }), "utf8");
      const settings = await loadHooksSettings(root, log.warn);
      expect(settings.onSubagentStart).toEqual([{ command: "true", matcher: "coder" }]);
      expect(settings.onSessionEnd).toEqual([{ command: "true", matcher: "clear" }]);
      expect(log.messages).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
});

describe("batch-B matcher filtering per event", () => {
  it("subagentStart filters by agent type", async () => {
    const root = await tmpWorkspace();
    const log = collector();
    try {
      await writeFile(join(root, ".wudao", "settings.json"), JSON.stringify({
        hooks: { onSubagentStart: [{ command: fx("dump-payload.sh"), matcher: "coder" }] },
      }), "utf8");
      const settings = await loadHooksSettings(root, log.warn);
      const hooks = buildConfiguredHooks(settings, { workspaceRoot: root, warn: log.warn });
      await hooks!.onSubagentStart!("general-purpose", {});
      await expect(readFile(join(root, "payload.json"))).rejects.toThrow();
      await hooks!.onSubagentStart!("coder", { sessionId: "s" });
      const payload = JSON.parse(await readFile(join(root, "payload.json"), "utf8"));
      expect(payload).toEqual({ event: "subagentStart", agentType: "coder", sessionId: "s" });
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("configChange filters by position; instructionsLoaded by source; sessionEnd by source; stopFailure by kind", async () => {
    const root = await tmpWorkspace();
    const log = collector();
    try {
      await writeFile(join(root, ".wudao", "settings.json"), JSON.stringify({
        hooks: {
          onConfigChange: [{ command: fx("ok.sh"), matcher: "user,local" }],
          onInstructionsLoaded: [{ command: fx("ok.sh"), matcher: "session_start|compact" }],
          onSessionEnd: [{ command: fx("ok.sh"), matcher: "exit" }],
          onStopFailure: [{ command: fx("ok.sh"), matcher: "context" }],
        },
      }), "utf8");
      const settings = await loadHooksSettings(root, log.warn);
      const hooks = buildConfiguredHooks(settings, { workspaceRoot: root, warn: log.warn });
      // Non-matching values settle without error (commands no-op); matching
      // values run them — the observers resolve void either way, so the
      // assertions ride on resolve-not-reject plus decision events below.
      await hooks!.onConfigChange!("project", {});
      await hooks!.onInstructionsLoaded!("nested_traversal", {});
      await hooks!.onSessionEnd!("clear", {});
      await hooks!.onStopFailure!("error", {});
      await hooks!.onConfigChange!("user", {});
      await hooks!.onInstructionsLoaded!("compact", {});
      await hooks!.onSessionEnd!("exit", {});
      await hooks!.onStopFailure!("context", {});
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
});

describe("batch-B decision contracts", () => {
  it("task hooks: {block,blockReason} refuses; non-zero exit refuses; silent 0-exit allows", async () => {
    const root = await tmpWorkspace();
    const log = collector();
    try {
      await writeFile(join(root, ".wudao", "settings.json"), JSON.stringify({
        hooks: {
          onTaskCreated: [{ command: fx("block-blockreason.sh") }],
          onTaskCompleted: [{ command: fx("block.sh") }],
        },
      }), "utf8");
      const settings = await loadHooksSettings(root, log.warn);
      const hooks = buildConfiguredHooks(settings, { workspaceRoot: root, warn: log.warn });
      expect(await hooks!.onTaskCreated!(["a"], { total: 1, done: 0 })).toEqual({
        block: true,
        reason: "prompt contains secrets",
      });
      expect(await hooks!.onTaskCompleted!(["a"], { total: 1, done: 1 })).toEqual({
        block: true,
        reason: "blocked by fixture",
      });

      await writeFile(join(root, ".wudao", "settings.json"), JSON.stringify({
        hooks: { onTaskCreated: [{ command: fx("ok.sh") }] },
      }), "utf8");
      const settings2 = await loadHooksSettings(root, log.warn);
      const hooks2 = buildConfiguredHooks(settings2, { workspaceRoot: root, warn: log.warn });
      expect(await hooks2!.onTaskCreated!(["a"], { total: 1, done: 0 })).toBe("allow");
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("subagentStop: {continue:false} keeps the child working; silent 0-exit allows the stop", async () => {
    const root = await tmpWorkspace();
    const log = collector();
    try {
      await writeFile(join(root, ".wudao", "settings.json"), JSON.stringify({
        hooks: { onSubagentStop: [{ command: fx("substop-continue.sh") }] },
      }), "utf8");
      const settings = await loadHooksSettings(root, log.warn);
      const hooks = buildConfiguredHooks(settings, { workspaceRoot: root, warn: log.warn });
      expect(await hooks!.onSubagentStop!("coder", undefined as never)).toEqual({
        continue: false,
        reason: "keep the child working",
      });

      await writeFile(join(root, ".wudao", "settings.json"), JSON.stringify({
        hooks: { onSubagentStop: [{ command: fx("ok.sh") }] },
      }), "utf8");
      const settings2 = await loadHooksSettings(root, log.warn);
      const hooks2 = buildConfiguredHooks(settings2, { workspaceRoot: root, warn: log.warn });
      expect(await hooks2!.onSubagentStop!("coder", undefined as never)).toBe("allow");
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("configChange: {block} vetoes; silent 0-exit allows", async () => {
    const root = await tmpWorkspace();
    const log = collector();
    try {
      await writeFile(join(root, ".wudao", "settings.json"), JSON.stringify({
        hooks: { onConfigChange: [{ command: fx("block-json.sh") }] },
      }), "utf8");
      const settings = await loadHooksSettings(root, log.warn);
      const hooks = buildConfiguredHooks(settings, { workspaceRoot: root, warn: log.warn });
      expect(await hooks!.onConfigChange!("project", {})).toEqual({
        block: true,
        reason: "json says no",
      });

      await writeFile(join(root, ".wudao", "settings.json"), JSON.stringify({
        hooks: { onConfigChange: [{ command: fx("ok.sh") }] },
      }), "utf8");
      const settings2 = await loadHooksSettings(root, log.warn);
      const hooks2 = buildConfiguredHooks(settings2, { workspaceRoot: root, warn: log.warn });
      expect(await hooks2!.onConfigChange!("project", {})).toBe("allow");
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
});

describe("SessionEnd shared 1.5s budget", () => {
  it("two slow hooks are killed within the shared budget (not their own timeouts)", async () => {
    const root = await tmpWorkspace();
    const log = collector();
    try {
      // Two sleep-1.2s commands: individually fine (10s default), together
      // 2.4s — the SHARED 1.5s budget kills the second mid-flight and skips
      // the rest. Elapsed must stay near the budget, not the naive sum.
      await writeFile(join(root, ".wudao", "settings.json"), JSON.stringify({
        hooks: { onSessionEnd: [{ command: fx("sleep-1200.sh") }, { command: fx("sleep-1200.sh") }] },
      }), "utf8");
      const settings = await loadHooksSettings(root, log.warn);
      const hooks = buildConfiguredHooks(settings, { workspaceRoot: root, warn: log.warn });
      const started = Date.now();
      await hooks!.onSessionEnd!("exit", {});
      const elapsed = Date.now() - started;
      // Budget: 1.5s. Two naive runs: 2.4s. Assert comfortably between.
      expect(elapsed).toBeGreaterThanOrEqual(1200); // the first hook ran
      expect(elapsed).toBeLessThan(2100); // the second was killed at the budget (~1.5s) + slack
      expect(log.messages.some((m) => m.includes("sessionEnd hook") && m.includes("预算"))).toBe(true); // ω99-207 钉随源演进（预算词面中文化，sessionEnd hook 术语保留）
      expect(SESSION_END_BUDGET_MS).toBe(1500);
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }, 10_000);
});

describe("R1: the SessionEnd budget is GLOBAL across composed layers", () => {
  it("two layers × one slow hook each share ONE 1.5s window (not 3s)", async () => {
    const root = await tmpWorkspace();
    const log = collector();
    try {
      const settings = {
        onSessionEnd: [{ command: fx("sleep-1200.sh") }],
      } as const;
      const layer = () => buildConfiguredHooks(settings as never, { workspaceRoot: root, warn: log.warn })!;
      const composed = composeAgentHooks(layer(), layer())!;
      // The FIRING SITE creates the one deadline (as the driver/REPL/one-shot
      // now do) — every layer consumes the same window.
      const started = Date.now();
      await composed.onSessionEnd!("exit", { budgetEndsAt: Date.now() + SESSION_END_BUDGET_MS });
      const elapsed = Date.now() - started;
      // Two naive windows: 3.0s. One shared: ~1.5s (+ slack).
      expect(elapsed).toBeGreaterThanOrEqual(1200);
      expect(elapsed).toBeLessThan(2400);
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }, 10_000);
});

describe("fileChangeTargets", () => {
  it("extracts the PLAIN single-value matchers; lists/regexps/matcherless are not watch targets", async () => {
    const root = await tmpWorkspace();
    const log = collector();
    try {
      await writeFile(join(root, ".wudao", "settings.json"), JSON.stringify({
        hooks: {
          onFileChanged: [
            { command: "true", matcher: "package.json" },
            { command: "true", matcher: "src/config.ts" },
            { command: "true", matcher: "a.json,b.json" }, // a list — not a single literal
            { command: "true", matcher: "\\.env$" }, // a regexp — not enumerable
            { command: "true" }, // matcherless — fires for any watched change
          ],
        },
      }), "utf8");
      const settings = await loadHooksSettings(root, log.warn);
      expect(fileChangeTargets(settings)).toEqual(["package.json", "src/config.ts"]);
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("fileChanged observer fires matching commands with the path payload", async () => {
    const root = await tmpWorkspace();
    const log = collector();
    try {
      await writeFile(join(root, ".wudao", "settings.json"), JSON.stringify({
        hooks: { onFileChanged: [{ command: fx("dump-payload.sh"), matcher: "watched.txt" }] },
      }), "utf8");
      const settings = await loadHooksSettings(root, log.warn);
      const hooks = buildConfiguredHooks(settings, { workspaceRoot: root, warn: log.warn });
      await hooks!.onFileChanged!("other.txt");
      await expect(readFile(join(root, "payload.json"))).rejects.toThrow();
      await hooks!.onFileChanged!("watched.txt");
      const payload = JSON.parse(await readFile(join(root, "payload.json"), "utf8"));
      expect(payload).toEqual({ event: "fileChanged", path: "watched.txt" });
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
});

describe("composeAgentHooks over the batch-B methods", () => {
  it("gate decisions short-circuit; observers chain", async () => {
    const order: string[] = [];
    const composed = composeAgentHooks(
      {
        onTaskCreated: async () => { order.push("a:created"); return "allow" as const; },
        onSubagentStop: async () => { order.push("a:stop"); return "allow" as const; },
        onConfigChange: async () => { order.push("a:cfg"); return "allow" as const; },
        onSessionEnd: async () => { order.push("a:end"); },
        onStopFailure: async () => { order.push("a:fail"); },
        onSubagentStart: async () => { order.push("a:start"); },
        onFileChanged: async () => { order.push("a:file"); },
        onInstructionsLoaded: async () => { order.push("a:instr"); },
      },
      {
        onTaskCreated: async () => { order.push("b:created"); return { block: true as const, reason: "second layer" }; },
        onSubagentStop: async () => { order.push("b:stop"); return { continue: false as const }; },
        onConfigChange: async () => { order.push("b:cfg"); return { block: true as const, reason: "veto" }; },
        onSessionEnd: async () => { order.push("b:end"); },
        onStopFailure: async () => { order.push("b:fail"); },
        onSubagentStart: async () => { order.push("b:start"); },
        onFileChanged: async () => { order.push("b:file"); },
        onInstructionsLoaded: async () => { order.push("b:instr"); },
      },
    )!;
    expect(await composed.onTaskCreated!(["x"], { total: 1, done: 0 })).toEqual({ block: true, reason: "second layer" });
    expect(await composed.onSubagentStop!("coder", undefined as never)).toEqual({ continue: false });
    expect(await composed.onConfigChange!("project", {})).toEqual({ block: true, reason: "veto" });
    await composed.onSessionEnd!("exit", {});
    await composed.onStopFailure!("error", {});
    await composed.onSubagentStart!("coder", {});
    await composed.onFileChanged!("a.txt");
    await composed.onInstructionsLoaded!("compact", {});
    expect(order).toEqual([
      "a:created", "b:created",
      "a:stop", "b:stop",
      "a:cfg", "b:cfg",
      "a:end", "b:end",
      "a:fail", "b:fail",
      "a:start", "b:start",
      "a:file", "b:file",
      "a:instr", "b:instr",
    ]);
  });
});
