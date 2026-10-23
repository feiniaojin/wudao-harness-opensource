// M63-A batch A — the config bridge for the new event surface: matcher
// semantics (§2 exact/list/RegExp/invalid), per-event firing + filtering,
// the JSON decision contracts (defer / permission decision / continue-false
// / block+blockReason), and composeAgentHooks over the new methods.
// Fixture scripts live in tests/fixtures (execFile semantics, no shell).
import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadHooksSettings,
  buildConfiguredHooks,
  composeAgentHooks,
  compileHookMatcher,
  parseDeferJson,
  parsePermissionDecisionJson,
  parseContinueFalseJson,
} from "../src/hooks-config.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const fx = (name: string): string => join(FIXTURES, name);

function collector(): { warn: (m: string) => void; messages: string[] } {
  const messages: string[] = [];
  return { warn: (m: string) => messages.push(m), messages };
}

async function tmpWorkspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "wudao-hooks-m63-"));
  await mkdir(join(dir, ".wudao"), { recursive: true });
  return dir;
}

const ROOT = { workspaceRoot: "/tmp" };

describe("§2 matcher rules", () => {
  const noWarn = () => {};

  it("a matcherless hook matches every value", () => {
    const m = compileHookMatcher(undefined, noWarn, "cmd");
    expect(m("startup")).toBe(true);
    expect(m("read_file")).toBe(true);
  });

  it("a plain single word is an EXACT match", () => {
    const m = compileHookMatcher("startup", noWarn, "cmd");
    expect(m("startup")).toBe(true);
    expect(m("resume")).toBe(false);
  });

  it("a comma/pipe list is an exact-value LIST", () => {
    const comma = compileHookMatcher("startup, resume", noWarn, "cmd");
    expect(comma("startup")).toBe(true);
    expect(comma("resume")).toBe(true);
    expect(comma("clear")).toBe(false);
    const pipe = compileHookMatcher("write_file|edit", noWarn, "cmd");
    expect(pipe("write_file")).toBe(true);
    expect(pipe("edit")).toBe(true);
    expect(pipe("read_file")).toBe(false);
  });

  it("any other spelling is a RegExp — WE add no anchors (the user's own ^ still anchors)", () => {
    const m = compileHookMatcher("^read_", noWarn, "cmd");
    expect(m("read_file")).toBe(true);
    expect(m("pread_file")).toBe(false); // the user's ^ anchors — we do not strip it
    const loose = compileHookMatcher("read.file", noWarn, "cmd");
    expect(loose("read_file")).toBe(true);
    expect(loose("pread_file")).toBe(true); // unanchored by default — matches anywhere
    expect(loose("readfile")).toBe(false);
    expect(m("write_file")).toBe(false);
  });

  it("an invalid RegExp warns once and never matches", () => {
    const log = collector();
    const m = compileHookMatcher("([invalid", log.warn, "my-cmd");
    expect(m("anything")).toBe(false);
    expect(log.messages.length).toBe(1);
    expect(log.messages[0]).toContain("my-cmd");
  });
});

describe("loader accepts the batch-A event keys", () => {
  it("parses every new key with matcher entries, warns on unknown ones", async () => {
    const root = await tmpWorkspace();
    const log = collector();
    try {
      await writeFile(join(root, ".wudao", "settings.json"), JSON.stringify({
        hooks: {
          onSessionStart: [{ command: "true", matcher: "startup|resume" }],
          onPreCompact: [{ command: "true", matcher: "auto" }],
          onPostCompact: [{ command: "true" }],
          onPermissionRequest: [{ command: "true", matcher: "write_file,edit" }],
          onNotification: [{ command: "true", matcher: "permission" }],
          onPostToolUseFailure: [{ command: "true", matcher: "^shell$" }],
          onPostToolBatch: [{ command: "true" }],
          onTeleport: [{ command: "true" }],
        },
      }), "utf8");
      const settings = await loadHooksSettings(root, log.warn);
      expect(settings.onSessionStart).toEqual([{ command: "true", matcher: "startup|resume" }]);
      expect(settings.onPreCompact).toEqual([{ command: "true", matcher: "auto" }]);
      expect(settings.onPostCompact).toEqual([{ command: "true" }]);
      expect(settings.onPermissionRequest).toEqual([{ command: "true", matcher: "write_file,edit" }]);
      expect(settings.onNotification).toEqual([{ command: "true", matcher: "permission" }]);
      expect(settings.onPostToolUseFailure).toEqual([{ command: "true", matcher: "^shell$" }]);
      expect(settings.onPostToolBatch).toEqual([{ command: "true" }]);
      expect(log.messages.length).toBe(1);
      expect(log.messages[0]).toContain("onTeleport");
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
});

// cc-plugins E4 — CC's plugin-hook convention: plugin-sourced entries carry
// pluginRoot; firing substitutes ${CLAUDE_PLUGIN_ROOT}/$CLAUDE_PLUGIN_ROOT
// into the command (execFile does no shell expansion) AND exports the env var
// so the command's own children can read it at runtime.
describe("CC plugin-root convention", () => {
  it("pluginRoot entry: token substituted AND env exported to the child", async () => {
    const root = await tmpWorkspace();
    const log = collector();
    try {
      const hooks = buildConfiguredHooks(
        { onSessionStart: [{ command: "${CLAUDE_PLUGIN_ROOT}/dump-plugin-root.sh", pluginRoot: FIXTURES }] },
        { workspaceRoot: root, warn: log.warn },
      );
      await hooks!.onSessionStart!("startup", { sessionId: "s1" });
      // the script ran (substitution worked) and saw the env var
      expect(await readFile(join(root, "plugin-root.txt"), "utf8")).toBe(FIXTURES);
      expect(log.messages).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("bare $CLAUDE_PLUGIN_ROOT (no braces) substitutes too", async () => {
    const root = await tmpWorkspace();
    const log = collector();
    try {
      const hooks = buildConfiguredHooks(
        { onSessionStart: [{ command: "$CLAUDE_PLUGIN_ROOT/dump-plugin-root.sh", pluginRoot: FIXTURES }] },
        { workspaceRoot: root, warn: log.warn },
      );
      await hooks!.onSessionStart!("startup", { sessionId: "s1" });
      expect(await readFile(join(root, "plugin-root.txt"), "utf8")).toBe(FIXTURES);
      expect(log.messages).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("no pluginRoot → no invention: the literal token stays a spawn error (fail-soft warn)", async () => {
    const root = await tmpWorkspace();
    const log = collector();
    try {
      const hooks = buildConfiguredHooks(
        { onSessionStart: [{ command: "${CLAUDE_PLUGIN_ROOT}/dump-plugin-root.sh" }] },
        { workspaceRoot: root, warn: log.warn },
      );
      await hooks!.onSessionStart!("startup", { sessionId: "s1" });
      await expect(readFile(join(root, "plugin-root.txt"))).rejects.toThrow();
      expect(log.messages.length).toBe(1);
      expect(log.messages[0]).toContain("启动失败"); // ω99-207 钉随源演进（启动失败词面中文化）
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  // cc-plugins E4: superpowers ships run-hook.cmd — a shebang-less
  // batch/shell POLYGLOT. Real CC runs hook commands through a shell, where
  // execve(ENOEXEC) makes the shell interpret the file itself. Our execFile
  // runner needs the same fallback: direct exec fails ENOEXEC → retry via
  // /bin/sh interpreting the file.
  it("shebang-less executable falls back to /bin/sh (superpowers polyglot)", async () => {
    const root = await tmpWorkspace();
    const log = collector();
    try {
      const hooks = buildConfiguredHooks(
        { onSessionStart: [{ command: `"${fx("no-shebang.sh")}" poly`, pluginRoot: FIXTURES }] },
        { workspaceRoot: root, warn: log.warn },
      );
      await hooks!.onSessionStart!("startup", { sessionId: "s1" });
      expect(await readFile(join(root, "no-shebang-out.txt"), "utf8")).toBe("ran poly\n");
      expect(log.messages).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  // cc-plugins E4: CC's SessionStart is a CONTEXT hook — the superpowers
  // bootstrap's whole purpose is its hookSpecificOutput.additionalContext
  // reaching the model. The bridge returns it (driver parks it on the
  // MetaNote projection); plain stdout stays log-only (M62 §5 house rule).
  it("SessionStart bridge returns structured additionalContext; entries chain; failures inject nothing", async () => {
    const root = await tmpWorkspace();
    const log = collector();
    try {
      const hooks = buildConfiguredHooks(
        { onSessionStart: [
          { command: fx("emit-context.sh") },
          { command: fx("emit-context.sh") },
          { command: "/no/such/hook" },
        ] },
        { workspaceRoot: root, warn: log.warn },
      );
      const ctx = await hooks!.onSessionStart!("startup", { sessionId: "s1" });
      expect(ctx).toBe("bootstrap-context\n\nbootstrap-context");
      // the dead entry failed soft — one spawn warning, no throw
      expect(log.messages.length).toBe(1);
      expect(log.messages[0]).toContain("启动失败"); // ω99-207 钉随源演进（启动失败词面中文化）
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
});

describe("SessionStart bridge", () => {
  it("fires matching sources only; the payload carries event+source", async () => {
    const root = await tmpWorkspace();
    const log = collector();
    try {
      // dump-payload.sh cats stdin into payload.json in cwd (the workspace).
      await writeFile(join(root, ".wudao", "settings.json"), JSON.stringify({
        hooks: { onSessionStart: [{ command: `${fx("dump-payload.sh")}`, matcher: "clear" }] },
      }), "utf8");
      const settings = await loadHooksSettings(root, log.warn);
      const hooks = buildConfiguredHooks(settings, { workspaceRoot: root, warn: log.warn });
      expect(hooks?.onSessionStart).toBeDefined();
      await hooks!.onSessionStart!("startup", { sessionId: "s1" });
      // Non-matching source: the command never ran — no payload file at all.
      await expect(readFile(join(root, "payload.json"))).rejects.toThrow();
      await hooks!.onSessionStart!("clear", { sessionId: "s1" });
      const payload = JSON.parse(await readFile(join(root, "payload.json"), "utf8"));
      expect(payload).toEqual({ event: "sessionStart", source: "clear", sessionId: "s1" });
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
});

describe("PreCompact bridge", () => {
  it("matcher 'manual' does not fire for the loop's 'auto' trigger", async () => {
    const root = await tmpWorkspace();
    const log = collector();
    try {
      await writeFile(join(root, ".wudao", "settings.json"), JSON.stringify({
        hooks: { onPreCompact: [{ command: fx("defer-compact.sh"), matcher: "manual" }] },
      }), "utf8");
      const settings = await loadHooksSettings(root, log.warn);
      const hooks = buildConfiguredHooks(settings, { workspaceRoot: root, warn: log.warn });
      expect(await hooks!.onPreCompact!([], "auto")).toBe("compact");
      expect(await hooks!.onPreCompact!([{ role: "user", content: "x" }], "manual")).toEqual({
        defer: true,
        reason: "wait for the batch",
      });
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("a non-zero exit defers with the stderr first line as the reason", async () => {
    const root = await tmpWorkspace();
    const log = collector();
    try {
      await writeFile(join(root, ".wudao", "settings.json"), JSON.stringify({
        hooks: { onPreCompact: [{ command: fx("block.sh") }] },
      }), "utf8");
      const settings = await loadHooksSettings(root, log.warn);
      const hooks = buildConfiguredHooks(settings, { workspaceRoot: root, warn: log.warn });
      expect(await hooks!.onPreCompact!([], "auto")).toEqual({ defer: true, reason: "blocked by fixture" });
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
});

describe("PermissionRequest bridge", () => {
  it("allow/deny decisions parse; the matcher filters by tool name", async () => {
    const root = await tmpWorkspace();
    const log = collector();
    try {
      await writeFile(join(root, ".wudao", "settings.json"), JSON.stringify({
        hooks: { onPermissionRequest: [{ command: fx("perm-deny.sh"), matcher: "write_file,edit" }] },
      }), "utf8");
      const settings = await loadHooksSettings(root, log.warn);
      const hooks = buildConfiguredHooks(settings, { workspaceRoot: root, warn: log.warn });
      // A non-matching tool: the command never runs → no opinion.
      expect(await hooks!.onPermissionRequest!("read_file", { path: "a" })).toBeUndefined();
      // A matching tool: the JSON decision answers.
      expect(await hooks!.onPermissionRequest!("write_file", { path: "a" })).toEqual({
        behavior: "deny",
        reason: "permission hook: policy says no",
      });
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("a non-zero exit is a fail-closed deny; a no-decision stdout is no opinion", async () => {
    const root = await tmpWorkspace();
    const log = collector();
    try {
      await writeFile(join(root, ".wudao", "settings.json"), JSON.stringify({
        hooks: { onPermissionRequest: [
          { command: fx("block.sh"), matcher: "write_file" },
          { command: fx("ok.sh"), matcher: "edit" },
        ] },
      }), "utf8");
      const settings = await loadHooksSettings(root, log.warn);
      const hooks = buildConfiguredHooks(settings, { workspaceRoot: root, warn: log.warn });
      expect(await hooks!.onPermissionRequest!("write_file", {})).toEqual({
        behavior: "deny",
        reason: "permission hook: blocked by fixture",
      });
      expect(await hooks!.onPermissionRequest!("edit", {})).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
});

describe("UserPromptSubmit block/blockReason (§2 spelling)", () => {
  it("a 0-exit hook answering {block,blockReason} blocks without rewriting", async () => {
    const root = await tmpWorkspace();
    const log = collector();
    try {
      await writeFile(join(root, ".wudao", "settings.json"), JSON.stringify({
        hooks: { onPromptSubmit: [{ command: fx("block-blockreason.sh") }] },
      }), "utf8");
      const settings = await loadHooksSettings(root, log.warn);
      const hooks = buildConfiguredHooks(settings, { workspaceRoot: root, warn: log.warn });
      expect(await hooks!.onPromptSubmit!("hello")).toEqual({
        block: true,
        reason: "prompt contains secrets",
      });
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
});

describe("PostToolBatch bridge", () => {
  it("a {continue:false} stdout ends the batch; a 0-exit silent hook allows", async () => {
    const root = await tmpWorkspace();
    const log = collector();
    try {
      await writeFile(join(root, ".wudao", "settings.json"), JSON.stringify({
        hooks: { onPostToolBatch: [
          { command: fx("stop-batch.sh"), matcher: "never-matches-a-matcherless-event" },
          { command: fx("ok.sh") },
        ] },
      }), "utf8");
      const settings = await loadHooksSettings(root, log.warn);
      const hooks = buildConfiguredHooks(settings, { workspaceRoot: root, warn: log.warn });
      // A matcher on the matcher-less PostToolBatch event is inert: only the
      // matcher-less entry runs, and its silent 0-exit = allow.
      expect(await hooks!.onPostToolBatch!([{ name: "read_file", input: {}, isError: false, result: "A" }])).toBe("allow");

      await writeFile(join(root, ".wudao", "settings.json"), JSON.stringify({
        hooks: { onPostToolBatch: [{ command: fx("stop-batch.sh") }] },
      }), "utf8");
      const settings2 = await loadHooksSettings(root, log.warn);
      const hooks2 = buildConfiguredHooks(settings2, { workspaceRoot: root, warn: log.warn });
      expect(await hooks2!.onPostToolBatch!([{ name: "read_file", input: {}, isError: false, result: "A" }])).toEqual({
        continue: false,
        reason: "batch quota reached",
      });
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
});

describe("observer bridges (PostCompact / Notification / PostToolUseFailure)", () => {
  it("fire matching commands and settle void regardless of exit codes", async () => {
    const root = await tmpWorkspace();
    const log = collector();
    try {
      await writeFile(join(root, ".wudao", "settings.json"), JSON.stringify({
        hooks: {
          onPostCompact: [{ command: fx("block.sh"), matcher: "manual" }],
          onNotification: [{ command: fx("ok.sh"), matcher: "idle" }],
          onPostToolUseFailure: [{ command: fx("dump-payload.sh"), matcher: "^shell$" }],
        },
      }), "utf8");
      const settings = await loadHooksSettings(root, log.warn);
      const hooks = buildConfiguredHooks(settings, { workspaceRoot: root, warn: log.warn });
      // Non-matching values never run the command (payload stays absent).
      await hooks!.onPostCompact!([], "auto");
      await hooks!.onNotification!("permission", {});
      await hooks!.onPostToolUseFailure!("read_file", {}, "boom");
      await expect(readFile(join(root, "payload.json"))).rejects.toThrow();
      // Matching values run it; observer outcomes are swallowed.
      await expect(hooks!.onPostCompact!([], "manual")).resolves.toBeUndefined();
      await expect(hooks!.onNotification!("idle", {})).resolves.toBeUndefined();
      await hooks!.onPostToolUseFailure!("shell", { command: "ls" }, "exit 1");
      const payload = JSON.parse(await readFile(join(root, "payload.json"), "utf8"));
      expect(payload).toEqual({ event: "postToolUseFailure", tool: "shell", input: { command: "ls" }, result: "exit 1" });
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
});

describe("decision JSON parsers", () => {
  it("parseDeferJson accepts only {defer:true}", () => {
    expect(parseDeferJson('{"defer":true,"reason":"soon"}')).toEqual({ defer: true, reason: "soon" });
    expect(parseDeferJson('{"defer":true}')).toEqual({ defer: true });
    expect(parseDeferJson('{"defer":false}')).toBeUndefined();
    expect(parseDeferJson("plain text")).toBeUndefined();
    expect(parseDeferJson("")).toBeUndefined();
  });

  it("parsePermissionDecisionJson accepts allow/deny with reason", () => {
    expect(parsePermissionDecisionJson('{"decision":"allow"}')).toEqual({ behavior: "allow" });
    expect(parsePermissionDecisionJson('{"decision":"deny","reason":"nope"}')).toEqual({
      behavior: "deny",
      reason: "permission hook: nope",
    });
    expect(parsePermissionDecisionJson('{"decision":"ask"}')).toBeUndefined();
    expect(parsePermissionDecisionJson("junk")).toBeUndefined();
  });

  it("parseContinueFalseJson accepts only {continue:false}", () => {
    expect(parseContinueFalseJson('{"continue":false,"reason":"stop"}')).toEqual({ continue: false, reason: "stop" });
    expect(parseContinueFalseJson('{"continue":true}')).toBeUndefined();
    expect(parseContinueFalseJson("{}")).toBeUndefined();
  });
});

describe("composeAgentHooks over the M63-A methods", () => {
  it("composes onPermissionRequest first-decisive-wins", async () => {
    const calls: string[] = [];
    const first = {
      onPermissionRequest: async (tool: string) => {
        calls.push(`first:${tool}`);
        return undefined;
      },
    };
    const second = {
      onPermissionRequest: async (tool: string) => {
        calls.push(`second:${tool}`);
        return { behavior: "deny" as const, reason: "second layer denies" };
      },
    };
    const composed = composeAgentHooks(first, second)!;
    expect(await composed.onPermissionRequest!("write_file", {})).toEqual({
      behavior: "deny",
      reason: "second layer denies",
    });
    expect(calls).toEqual(["first:write_file", "second:write_file"]);

    const decisiveFirst = { onPermissionRequest: async () => ({ behavior: "allow" as const }) };
    const neverSecond = { onPermissionRequest: async () => { throw new Error("must not run"); } };
    const composed2 = composeAgentHooks(decisiveFirst, neverSecond)!;
    expect(await composed2.onPermissionRequest!("x", {})).toEqual({ behavior: "allow" });
  });

  it("composes onPreCompact with defer short-circuit, onPostToolBatch with block short-circuit", async () => {
    const composed = composeAgentHooks(
      {
        onPreCompact: async () => "compact" as const,
        onPostToolBatch: async () => "allow" as const,
      },
      {
        onPreCompact: async () => ({ defer: true as const, reason: "layer two defers" }),
        onPostToolBatch: async () => ({ continue: false as const, reason: "layer two stops" }),
      },
    )!;
    expect(await composed.onPreCompact!([], "auto")).toEqual({ defer: true, reason: "layer two defers" });
    expect(await composed.onPostToolBatch!([{ name: "t", input: {}, isError: false, result: "" }])).toEqual({
      continue: false,
      reason: "layer two stops",
    });
  });

  it("composes the observers sequentially with trigger forwarding", async () => {
    const seen: string[] = [];
    const mk = (tag: string) => ({
      onPostCompact: async (_m: unknown, trigger: string) => { seen.push(`${tag}:post:${trigger}`); },
      onSessionStart: async (source: string) => { seen.push(`${tag}:start:${source}`); },
      onNotification: async (kind: string) => { seen.push(`${tag}:note:${kind}`); },
      onPostToolUseFailure: async (name: string) => { seen.push(`${tag}:fail:${name}`); },
    });
    const composed = composeAgentHooks(mk("a"), mk("b"))!;
    await composed.onPostCompact!([], "manual");
    await composed.onSessionStart!("clear", {});
    await composed.onNotification!("idle", {});
    await composed.onPostToolUseFailure!("edit", {}, "x");
    expect(seen).toEqual([
      "a:post:manual", "b:post:manual",
      "a:start:clear", "b:start:clear",
      "a:note:idle", "b:note:idle",
      "a:fail:edit", "b:fail:edit",
    ]);
  });

  it("mergeHooksSettings preserves EVERY canonical key (the shared list — review fix pin)", async () => {
    const { mergeHooksSettings } = await import("../src/plugins.js");
    const { CANONICAL_HOOK_EVENTS } = await import("../src/hooks-config.js");
    // One entry per canonical key, built FROM the shared constant: a batch-B/C
    // key added to CANONICAL_HOOK_EVENTS extends this pin automatically — the
    // silent-strip class the review flagged cannot reintroduce itself.
    const user: Record<string, { command: string }[]> = {};
    for (const key of CANONICAL_HOOK_EVENTS) user[key] = [{ command: `cmd-${key}` }];
    const merged = mergeHooksSettings(user as never, []);
    expect(Object.keys(merged).sort()).toEqual([...CANONICAL_HOOK_EVENTS].sort());
    for (const key of CANONICAL_HOOK_EVENTS) {
      expect(merged[key as keyof typeof merged]).toEqual([{ command: `cmd-${key}` }]);
    }
  });

  it("buildConfiguredHooks returns undefined when only unknown events were configured", async () => {
    const log = collector();
    const settings = await loadHooksSettings("/tmp", log.warn);
    expect(buildConfiguredHooks(settings, ROOT)).toBeUndefined();
  });
});
