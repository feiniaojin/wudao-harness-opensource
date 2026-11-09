import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, rm, writeFile, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  modeFromArgv,
  resolveInitialMode,
  modeLabel,
  cycleMode,
  decidePermission,
  parseAskAnswer,
  askRuleFor,
  ruleMatches,
  createSessionAllowlist,
  parsePermissionSettings,
  decideRichPermission,
  createPermissionSettingsWatcher,
  askAnswerToDecision,
  protectedSettingsFile,
  credentialMaterialPath,
  applyAskAnswer,
  recordAskRules,
  safeWorkspaceCommand,
  PLAN_DENY_REASON,
  EMPTY_PERMISSION_SETTINGS,
  unionPermissionTiers,
  withSidecarLayer,
} from "../src/permission.js";
import { createSidecar } from "../src/sidecar.js";
import type { AssistantMessage, ModelClient, ModelInput } from "@wudao-org/core";

describe("modeFromArgv", () => {
  it("defaults to workspace", () => { expect(modeFromArgv(["hi"])).toBe("workspace"); });
  it("--auto", () => { expect(modeFromArgv(["--auto"])).toBe("auto"); });
  it("--ask", () => { expect(modeFromArgv(["--ask"])).toBe("ask"); });
  it("--plan", () => { expect(modeFromArgv(["--plan"])).toBe("plan"); });
  it("--auto outranks --ask when both appear", () => { expect(modeFromArgv(["--ask", "--auto"])).toBe("auto"); });
});

// The boot chain every entrypoint shares: explicit CLI flag > the persisted
// default (global settings.json permissions.defaultMode) > "workspace".
// env is explicit so tests stay hermetic against the real home.
describe("resolveInitialMode (boot chain)", () => {
  const envWith = async (settings: unknown): Promise<NodeJS.ProcessEnv> => {
    const home = await mkdtemp(join(tmpdir(), "wudao-rim-"));
    await mkdir(join(home), { recursive: true });
    await writeFile(join(home, "settings.json"), `${JSON.stringify(settings, null, 2)}\n`, "utf8");
    return { WUDAO_GLOBAL_HOME: home };
  };
  it("no flag, no persisted default → workspace", async () => {
    expect(resolveInitialMode(["wudao"], await envWith({}))).toBe("workspace");
  });
  it("no flag + persisted default → the persisted tier", async () => {
    for (const mode of ["workspace", "ask", "auto", "plan"] as const) {
      expect(resolveInitialMode(["wudao"], await envWith({ permissions: { defaultMode: mode } }))).toBe(mode);
    }
  });
  it("legacy persisted values migrate on read: acceptEdits→workspace, default→ask", async () => {
    expect(resolveInitialMode(["wudao"], await envWith({ permissions: { defaultMode: "acceptEdits" } }))).toBe("workspace");
    expect(resolveInitialMode(["wudao"], await envWith({ permissions: { defaultMode: "default" } }))).toBe("ask");
  });
  it("an explicit CLI flag outranks the persisted default", async () => {
    const env = await envWith({ permissions: { defaultMode: "auto" } });
    expect(resolveInitialMode(["wudao", "--ask"], env)).toBe("ask");
    expect(resolveInitialMode(["wudao", "--auto"], await envWith({ permissions: { defaultMode: "ask" } }))).toBe("auto");
  });
  it("a corrupted or retired persisted node reads as absent (never a stale tier)", async () => {
    expect(resolveInitialMode(["wudao"], await envWith({ permissions: { defaultMode: "read-only" } }))).toBe("workspace");
    expect(resolveInitialMode(["wudao"], await envWith({ permissions: { defaultMode: 42 } }))).toBe("workspace");
  });
});

describe("modeLabel + cycleMode (0.3.13: the CC vocabulary — workspace displays as accept)", () => {
  it("modeLabel maps workspace→accept; ask/auto/plan are themselves", () => {
    expect(modeLabel("workspace")).toBe("accept");
    expect(modeLabel("ask")).toBe("ask");
    expect(modeLabel("auto")).toBe("auto");
    expect(modeLabel("plan")).toBe("plan");
  });
  it("cycleMode walks workspace → ask → auto → plan → workspace from any start", () => {
    expect(cycleMode("workspace")).toBe("ask");
    expect(cycleMode("ask")).toBe("auto");
    expect(cycleMode("auto")).toBe("plan");
    expect(cycleMode("plan")).toBe("workspace");
  });
});

describe("decidePermission", () => {
  it("auto allows everything", () => { expect(decidePermission("auto", "shell")).toEqual({ behavior: "allow" }); });
  it("ask asks for a read too (每次执行工具都要询问)", () => {
    expect(decidePermission("ask", "read_file")).toBe("ask");
    expect(decidePermission("ask", "write_file")).toBe("ask");
  });
  it("plan allows the read class and denies writes with the way-out reason (不询问,不打断)", () => {
    expect(decidePermission("plan", "read_file")).toEqual({ behavior: "allow" });
    expect(decidePermission("plan", "grep")).toEqual({ behavior: "allow" });
    expect(decidePermission("plan", "write_file")).toEqual({ behavior: "deny", reason: PLAN_DENY_REASON });
    expect(decidePermission("plan", "shell")).toEqual({ behavior: "deny", reason: PLAN_DENY_REASON });
  });
});

describe("decidePermission — workspace (0.3.12 default: edits free, commands still ask)", () => {
  it("workspace allows the file-edit class without asking (工作区本来就应该可读写)", () => {
    expect(decidePermission("workspace", "write_file")).toEqual({ behavior: "allow" });
    expect(decidePermission("workspace", "edit")).toEqual({ behavior: "allow" });
  });
  it("workspace still asks for everything outside the workspace class", () => {
    expect(decidePermission("workspace", "shell")).toBe("ask");
    expect(decidePermission("workspace", "mcp__fake__echo")).toBe("ask");
    expect(decidePermission("workspace", "task")).toBe("ask");
  });
  it("workspace keeps reads allowed", () => {
    expect(decidePermission("workspace", "read_file")).toEqual({ behavior: "allow" });
  });
  it("a protected settings write still asks in workspace (bypass-immune layer outranks modes)", () => {
    expect(
      decideRichPermission({
        mode: "workspace",
        toolName: "write_file",
        input: { path: ".wudao/settings.json", content: "{}" },
        settings: EMPTY_PERMISSION_SETTINGS,
      }),
    ).toBe("ask");
  });
});

describe("decidePermission — MCP tools (mcp__*)", () => {
  it("auto allows mcp tools", () => { expect(decidePermission("auto", "mcp__fake__echo")).toEqual({ behavior: "allow" }); });
  it("workspace asks for mcp tools (outside the workspace class)", () => {
    expect(decidePermission("workspace", "mcp__fake__echo")).toBe("ask");
  });
  it("ask asks for mcp tools like everything else", () => { expect(decidePermission("ask", "mcp__fake__echo")).toBe("ask"); });
  it("builtin read tools are unaffected in workspace", () => { expect(decidePermission("workspace", "read_file")).toEqual({ behavior: "allow" }); });
});

describe("decidePermission — todo_write (M23)", () => {
  it("routes with the no-ask class in every mode (harness state, not user code)", () => {
    expect(decidePermission("auto", "todo_write")).toEqual({ behavior: "allow" });
    expect(decidePermission("workspace", "todo_write")).toEqual({ behavior: "allow" });
    expect(decidePermission("ask", "todo_write")).toEqual({ behavior: "allow" });
  });
});

// ---------------------------------------------------------------------------
// M33 §1: the y/a/N ask menu answer parser (shared by one-shot, REPL, TUI).
// ---------------------------------------------------------------------------

describe("parseAskAnswer (M33 menu)", () => {
  it("y / yes / Y / YES → allow (once)", () => {
    expect(parseAskAnswer("y")).toEqual({ kind: "allow" });
    expect(parseAskAnswer("yes")).toEqual({ kind: "allow" });
    expect(parseAskAnswer(" Y ")).toEqual({ kind: "allow" });
    expect(parseAskAnswer("YES")).toEqual({ kind: "allow" });
  });
  it("a / all / A → allow for this session (allowlist)", () => {
    expect(parseAskAnswer("a")).toEqual({ kind: "session" });
    expect(parseAskAnswer("all")).toEqual({ kind: "session" });
    expect(parseAskAnswer(" A ")).toEqual({ kind: "session" });
  });
  it("0.3.14: p / always / P → allow always (a persistent project-tier rule)", () => {
    expect(parseAskAnswer("p")).toEqual({ kind: "always" });
    expect(parseAskAnswer("always")).toEqual({ kind: "always" });
    expect(parseAskAnswer(" P ")).toEqual({ kind: "always" });
  });
  it("empty / n / no / N / Enter-default → deny without a reason", () => {
    expect(parseAskAnswer("")).toEqual({ kind: "deny" });
    expect(parseAskAnswer("n")).toEqual({ kind: "deny" });
    expect(parseAskAnswer("N")).toEqual({ kind: "deny" });
    expect(parseAskAnswer("no")).toEqual({ kind: "deny" });
  });
  it("n <reason> / no <reason> → deny carrying the user's reason", () => {
    expect(parseAskAnswer("n 需要先看测试")).toEqual({ kind: "deny", reason: "需要先看测试" });
    expect(parseAskAnswer("no run the tests first")).toEqual({ kind: "deny", reason: "run the tests first" });
    expect(parseAskAnswer("N  because reasons")).toEqual({ kind: "deny", reason: "because reasons" });
  });
  it("a reason survives inner spacing; outer whitespace is trimmed", () => {
    expect(parseAskAnswer("n  two  spaces ")).toEqual({ kind: "deny", reason: "two  spaces" });
  });
  it("anything else → deny (fail-closed)", () => {
    expect(parseAskAnswer("maybe")).toEqual({ kind: "deny" });
    expect(parseAskAnswer("yolo whatever")).toEqual({ kind: "deny" });
  });
});

describe("askAnswerToDecision — the deny reason flows back to the model", () => {
  it("allow/session → allow; plain deny keeps the existing reason", () => {
    expect(askAnswerToDecision({ kind: "allow" })).toEqual({ behavior: "allow" });
    expect(askAnswerToDecision({ kind: "session" })).toEqual({ behavior: "allow" });
    expect(askAnswerToDecision({ kind: "deny" })).toEqual({ behavior: "deny", reason: "user denied" });
  });
  it("deny with a reason → 'by user: <reason>' (loop renders 'permission denied: by user: …')", () => {
    expect(askAnswerToDecision({ kind: "deny", reason: "需要先看测试" })).toEqual({
      behavior: "deny",
      reason: "by user: 需要先看测试",
    });
    expect(askAnswerToDecision({ kind: "deny", reason: "   " })).toEqual({ behavior: "deny", reason: "user denied" });
  });
});

// ---------------------------------------------------------------------------
// M33 §1: session allowlist rules (tool, or tool:path-prefix).
// ---------------------------------------------------------------------------

describe("askRuleFor — the rule recorded by an `a` answer", () => {
  it("path-bearing input records tool:path (the path is the prefix)", () => {
    expect(askRuleFor("write_file", { path: "src/foo.ts", content: "x" })).toBe("write_file:src/foo.ts");
  });
  it("input without a path records the bare tool name", () => {
    expect(askRuleFor("grep_tool", { pattern: "x" })).toBe("grep_tool");
  });
  // 夜移 006: shell records a command-prefix rule (arity-aware) —
  // never the bare `shell` (one approval = every command).
  it("shell records an arity-prefix rule (never the bare tool)", () => {
    expect(askRuleFor("shell", { command: "ls" })).toBe("shell:ls");
    expect(askRuleFor("shell", { command: "git checkout main" })).toBe("shell:git checkout");
    expect(askRuleFor("shell", { command: "npm run dev" })).toBe("shell:npm run dev");
    // destructive → exact; compound → nothing; unknown → exact.
    expect(askRuleFor("shell", { command: "rm -rf /tmp/x" })).toBe("shell:rm -rf /tmp/x");
    expect(askRuleFor("shell", { command: "git push && npm publish" })).toBeNull();
    expect(askRuleFor("shell", { command: "python a.py" })).toBe("shell:python a.py");
  });
  it("empty/whitespace path degrades to the bare tool name", () => {
    expect(askRuleFor("write_file", { path: "  " })).toBe("write_file");
    expect(askRuleFor("write_file", {})).toBe("write_file");
  });
});

describe("ruleMatches — tool / tool:path-prefix patterns", () => {
  it("bare tool rule matches the tool by exact name only", () => {
    expect(ruleMatches("write_file", "write_file", { path: "a.txt" })).toBe(true);
    expect(ruleMatches("write_file", "edit", { path: "a.txt" })).toBe(false);
    expect(ruleMatches("write_file", "write_files", {})).toBe(false);
  });
  it("path rule matches the exact path and deeper paths, not siblings", () => {
    expect(ruleMatches("write_file:src/foo.ts", "write_file", { path: "src/foo.ts" })).toBe(true);
    expect(ruleMatches("write_file:src/foo.ts", "write_file", { path: "src/foo.ts.bak" })).toBe(false);
    expect(ruleMatches("write_file:src/", "write_file", { path: "src/a.ts" })).toBe(true);
    expect(ruleMatches("write_file:src/", "write_file", { path: "src/sub/a.ts" })).toBe(true);
    expect(ruleMatches("write_file:src/", "write_file", { path: "srcx/a.ts" })).toBe(false);
  });
  it("a directory rule without the trailing slash still matches directory-wise", () => {
    expect(ruleMatches("write_file:src", "write_file", { path: "src/a.ts" })).toBe(true);
    expect(ruleMatches("write_file:src", "write_file", { path: "srcx/a.ts" })).toBe(false);
  });
  it("path rule with no path in the input does not match", () => {
    expect(ruleMatches("write_file:src/", "write_file", { command: "ls" })).toBe(false);
    expect(ruleMatches("write_file:src/", "write_file", {})).toBe(false);
  });
  it("malformed rules never match", () => {
    expect(ruleMatches("", "write_file", {})).toBe(false);
    expect(ruleMatches(":src", "write_file", { path: "src/a" })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 波次 7 #32 (a reference harness A1+A2+A3): operator glob rules. Explicit `glob:`
// suffix opt-in — plain suffixes keep byte-identical semantics (a literal `*`
// in a 夜移006 exact command rule must never silently widen into a wildcard).
// ---------------------------------------------------------------------------

describe("ruleMatches — glob: rules (wave 7 #32)", () => {
  it("path glob matches absolute and relative spellings; ** crosses /", () => {
    expect(ruleMatches("write_file:glob:**/.ssh/**", "write_file", { path: "/home/u/.ssh/config" })).toBe(true);
    expect(ruleMatches("write_file:glob:**/.ssh/**", "write_file", { path: ".ssh/id_rsa" })).toBe(true);
    expect(ruleMatches("write_file:glob:**/.ssh/**", "write_file", { path: "src/a.ts" })).toBe(false);
  });
  it("dual form: a directory-root argument still matches a trailing-star glob", () => {
    // normalizePath drops the trailing slash, so `/repo/.ssh` would miss
    // `**/.ssh/**` without the trailing-slash twin (OH A2).
    expect(ruleMatches("write_file:glob:**/.ssh/**", "write_file", { path: "/repo/.ssh" })).toBe(true);
  });
  it("* stays inside one segment — workspace dialect, same as the glob tool", () => {
    expect(ruleMatches("write_file:glob:src/*.ts", "write_file", { path: "src/a.ts" })).toBe(true);
    expect(ruleMatches("write_file:glob:src/*.ts", "write_file", { path: "src/sub/a.ts" })).toBe(false);
  });
  it("command glob matches the raw command string (* spans spaces and slashes)", () => {
    expect(ruleMatches("shell:glob:rm -rf *", "shell", { command: "rm -rf /tmp/x" })).toBe(true);
    expect(ruleMatches("shell:glob:git push --force*", "shell", { command: "git push --force-with-lease" })).toBe(true);
    expect(ruleMatches("shell:glob:rm -rf *", "shell", { command: "rm -r /tmp/x" })).toBe(false);
  });
  it("glob rules still require the tool name to match", () => {
    expect(ruleMatches("write_file:glob:**/.ssh/**", "edit", { path: "/x/.ssh/k" })).toBe(false);
  });
  it("no matching input kind → false", () => {
    expect(ruleMatches("write_file:glob:**/.ssh/**", "write_file", {})).toBe(false);
    expect(ruleMatches("shell:glob:rm *", "shell", { path: "x" })).toBe(false);
  });
  it("plain suffixes keep exact semantics — a literal * is NOT a glob", () => {
    expect(ruleMatches("shell:echo *", "shell", { command: "echo *" })).toBe(true);
    expect(ruleMatches("shell:echo *", "shell", { command: "echo hello" })).toBe(false);
  });
  it("empty glob pattern matches nothing", () => {
    expect(ruleMatches("write_file:glob:", "write_file", { path: "src/a.ts" })).toBe(false);
    expect(ruleMatches("write_file:glob:  ", "write_file", { path: "src/a.ts" })).toBe(false);
  });
});

describe("createSessionAllowlist", () => {
  it("starts empty; add() then matches() by tool or path prefix; rules() lists", () => {
    const al = createSessionAllowlist();
    expect(al.matches("write_file", { path: "src/a.ts" })).toBe(false);
    al.add("write_file:src/");
    expect(al.matches("write_file", { path: "src/a.ts" })).toBe(true);
    expect(al.matches("write_file", { path: "other/a.ts" })).toBe(false);
    expect(al.rules()).toEqual(["write_file:src/"]);
  });
  it("add() is idempotent per rule string", () => {
    const al = createSessionAllowlist();
    al.add("shell");
    al.add("shell");
    expect(al.rules()).toEqual(["shell"]);
  });
});

// ---------------------------------------------------------------------------
// M33 §1: .wudao/settings.json permissions node.
// ---------------------------------------------------------------------------

describe("parsePermissionSettings", () => {
  it("empty default", () => {
    expect(EMPTY_PERMISSION_SETTINGS).toEqual({ allow: [], deny: [], ask: [], sidecarExempt: [] }); // ω99-27: the fourth list joins the empty shape
  });
  it("parses the three lists", () => {
    expect(parsePermissionSettings({ allow: ["read_file"], deny: ["shell:rm -rf"], ask: ["write_file"] }))
      .toEqual({ allow: ["read_file"], deny: ["shell:rm -rf"], ask: ["write_file"], sidecarExempt: [] });
  });
  it("undefined → empty, no warning", () => {
    const warns: string[] = [];
    expect(parsePermissionSettings(undefined, (m) => warns.push(m))).toEqual(EMPTY_PERMISSION_SETTINGS);
    expect(warns).toEqual([]);
  });
  it("non-object → warn + empty", () => {
    const warns: string[] = [];
    expect(parsePermissionSettings(["nope"], (m) => warns.push(m))).toEqual(EMPTY_PERMISSION_SETTINGS);
    expect(warns.length).toBe(1);
    expect(parsePermissionSettings("x", (m) => warns.push(m))).toEqual(EMPTY_PERMISSION_SETTINGS);
    expect(warns.length).toBe(2);
  });
  it("a non-string[] list → that list becomes [] with a warning, others survive", () => {
    const warns: string[] = [];
    expect(parsePermissionSettings({ allow: ["ok"], deny: "nope" }, (m) => warns.push(m)))
      .toEqual({ allow: ["ok"], deny: [], ask: [], sidecarExempt: [] });
    expect(warns.length).toBe(1);
    expect(warns[0]).toContain("deny");
  });

  // ω99-27 T2: the fourth list — same tolerant contract, same shape rules.
  it("ω99-27: sidecarExempt parses as the fourth list; absent key → [] with no warning (legacy files byte-stable)", () => {
    const warns: string[] = [];
    expect(
      parsePermissionSettings(
        { allow: ["read_file"], deny: [], ask: [], sidecarExempt: ["edit:README.md", "shell:grep"] },
        (m) => warns.push(m),
      ),
    ).toEqual({ allow: ["read_file"], deny: [], ask: [], sidecarExempt: ["edit:README.md", "shell:grep"] });
    expect(parsePermissionSettings({ allow: ["read_file"] }, (m) => warns.push(m)))
      .toEqual({ allow: ["read_file"], deny: [], ask: [], sidecarExempt: [] });
    expect(warns).toEqual([]);
  });
  it("ω99-27: a non-string[] sidecarExempt → that list [] with a warning, the others survive", () => {
    const warns: string[] = [];
    expect(parsePermissionSettings({ sidecarExempt: "edit" }, (m) => warns.push(m)))
      .toEqual({ allow: [], deny: [], ask: [], sidecarExempt: [] });
    expect(warns.length).toBe(1);
    expect(warns[0]).toContain("sidecarExempt");
  });
  it("ω99-27: unionPermissionTiers merges sidecarExempt global-first with dedup", () => {
    const merged = unionPermissionTiers(
      { allow: [], deny: [], ask: [], sidecarExempt: ["edit:README.md", "edit:docs/"] },
      { allow: [], deny: [], ask: [], sidecarExempt: ["edit:README.md", "write_file:src/"] },
    );
    expect(merged.sidecarExempt).toEqual(["edit:README.md", "edit:docs/", "write_file:src/"]);
  });
});

// ---------------------------------------------------------------------------
// M33 §1 layering (security fix: deny-first) — settings deny > session
// allowlist > settings ask/allow > builtin modes (workspace/ask/auto).
// An operator's hot-added deny always wins over an earlier `a`.
// ---------------------------------------------------------------------------

describe("decideRichPermission — layering matrix", () => {
  const input = (path: string): Record<string, unknown> => ({ path });

  it("a settings deny outranks the session allowlist (an operator's hot-added deny beats an earlier `a`)", () => {
    const d = decideRichPermission({
      mode: "workspace",
      toolName: "write_file",
      input: input("src/a.ts"),
      session: ["write_file:src/"],
      settings: { allow: [], deny: ["write_file"], ask: [] },
    });
    expect(d).toEqual({ behavior: "deny", reason: 'settings deny rule "write_file"' });
  });

  it("the session allowlist still outranks settings ask/allow and the builtin modes", () => {
    expect(decideRichPermission({
      mode: "workspace",
      toolName: "write_file",
      input: input("src/a.ts"),
      session: ["write_file:src/"],
      settings: { allow: [], deny: [], ask: ["write_file"] },
    })).toEqual({ behavior: "allow" });
    expect(decideRichPermission({
      mode: "ask",
      toolName: "write_file",
      input: input("src/a.ts"),
      session: ["write_file:src/"],
      settings: { allow: ["write_file"], deny: [], ask: [] },
    })).toEqual({ behavior: "allow" });
  });

  it("settings deny beats settings ask/allow, builtin allow, and --auto", () => {
    const settings = { allow: ["write_file"], deny: ["write_file"], ask: ["write_file"] };
    expect(decideRichPermission({ mode: "auto", toolName: "write_file", input: input("a.ts"), settings }))
      .toEqual({ behavior: "deny", reason: 'settings deny rule "write_file"' });
    expect(decideRichPermission({ mode: "ask", toolName: "write_file", input: input("a.ts"), settings }))
      .toEqual({ behavior: "deny", reason: 'settings deny rule "write_file"' });
  });

  it("settings ask forces the prompt even in auto mode", () => {
    expect(decideRichPermission({
      mode: "auto", toolName: "shell", input: { command: "ls" },
      settings: { allow: [], deny: [], ask: ["shell"] },
    })).toBe("ask");
  });

  it("settings allow pre-empts the workspace-mode ask (no prompt)", () => {
    expect(decideRichPermission({
      mode: "workspace", toolName: "shell", input: { command: "ls" },
      settings: { allow: ["shell"], deny: [], ask: [] },
    })).toEqual({ behavior: "allow" });
  });

  it("path-scoped rules only decide their path (ask mode makes both legs discriminative)", () => {
    const settings = { allow: ["write_file:src/safe/"], deny: [], ask: [] };
    expect(decideRichPermission({ mode: "ask", toolName: "write_file", input: input("src/safe/a.ts"), settings }))
      .toEqual({ behavior: "allow" });
    expect(decideRichPermission({ mode: "ask", toolName: "write_file", input: input("src/evil.ts"), settings }))
      .toBe("ask");
  });

  it("no session rules and no settings rules → the builtin mode decides unchanged", () => {
    expect(decideRichPermission({ mode: "workspace", toolName: "read_file", input: input("a.ts") }))
      .toEqual({ behavior: "allow" });
    expect(decideRichPermission({ mode: "workspace", toolName: "shell", input: {} })).toBe("ask");
    expect(decideRichPermission({ mode: "ask", toolName: "write_file", input: input("a.ts") }))
      .toBe("ask");
    expect(decideRichPermission({ mode: "auto", toolName: "write_file", input: input("a.ts") }))
      .toEqual({ behavior: "allow" });
  });

  it("a SessionAllowlist instance works as the session layer", () => {
    const al = createSessionAllowlist();
    al.add(askRuleFor("edit", input("src/a.ts")));
    expect(decideRichPermission({ mode: "ask", toolName: "edit", input: input("src/a.ts"), session: al }))
      .toEqual({ behavior: "allow" });
    expect(decideRichPermission({ mode: "ask", toolName: "edit", input: input("src/b.ts"), session: al }))
      .toBe("ask");
  });
});

// ---------------------------------------------------------------------------
// 0.3.14 #3 — plan mode's read-only fence. It sits at layer 1.5 (right after
// settings deny): earlier a/p grants must never widen plan, and nothing
// below it (session allowlist, settings allow, the builtin modes) is ever
// consulted for a non-read tool. shell keeps ONLY the safe read-only
// class. It never asks — plan must not interrupt the run.
// ---------------------------------------------------------------------------

describe("decideRichPermission — plan read-only fence (layer 1.5)", () => {
  const input = (path: string): Record<string, unknown> => ({ path });

  it("reads pass untouched by the fence", () => {
    expect(decideRichPermission({ mode: "plan", toolName: "read_file", input: input("src/a.ts") }))
      .toEqual({ behavior: "allow" });
    expect(decideRichPermission({ mode: "plan", toolName: "grep", input: { pattern: "x" } }))
      .toEqual({ behavior: "allow" });
  });

  it("writes deny with the way-out reason — even against the session allowlist and settings allow", () => {
    expect(decideRichPermission({
      mode: "plan", toolName: "write_file", input: input("src/a.ts"),
      session: ["write_file:src/"], settings: { allow: ["write_file"], deny: [], ask: [] },
    })).toEqual({ behavior: "deny", reason: PLAN_DENY_REASON });
  });

  it("shell keeps only the safe read-only class (same classifier as accept 4.7)", () => {
    expect(decideRichPermission({ mode: "plan", toolName: "shell", input: { command: "git status" } }))
      .toEqual({ behavior: "allow" });
    expect(decideRichPermission({ mode: "plan", toolName: "shell", input: { command: "cat src/a.ts" } }))
      .toEqual({ behavior: "allow" });
    expect(decideRichPermission({ mode: "plan", toolName: "shell", input: { command: "npm install" } }))
      .toEqual({ behavior: "deny", reason: PLAN_DENY_REASON });
    // metachar redirection: even a read verb with > is not 探查
    expect(decideRichPermission({ mode: "plan", toolName: "shell", input: { command: "cat a.ts > b.ts" } }))
      .toEqual({ behavior: "deny", reason: PLAN_DENY_REASON });
    // absent/malformed command input fail-closed to the deny
    expect(decideRichPermission({ mode: "plan", toolName: "shell", input: {} }))
      .toEqual({ behavior: "deny", reason: PLAN_DENY_REASON });
  });

  it("a settings deny still outranks the fence (layer 1 keeps its reason)", () => {
    expect(decideRichPermission({
      mode: "plan", toolName: "read_file", input: input("secret.env"),
      settings: { allow: [], deny: ["read_file"], ask: [] },
    })).toEqual({ behavior: "deny", reason: 'settings deny rule "read_file"' });
  });

  it("an earlier `p` rule cannot widen plan either (settings allow loses the same way)", () => {
    expect(decideRichPermission({
      mode: "plan", toolName: "shell", input: { command: "npm install" },
      settings: { allow: ["shell"], deny: [], ask: [] },
    })).toEqual({ behavior: "deny", reason: PLAN_DENY_REASON });
  });
});

// ---------------------------------------------------------------------------
// Security fix: self-escalation via settings write. .wudao/settings.json (and
// .wudao/mcp.json) ARE the runtime policy — a model that can write them
// silently widens its own authority. Writes via write_file/edit are
// bypass-immune: read-only denies; auto/default ALWAYS ask (plain y/N, no
// session-allowlist shortcut, `a` unavailable).
// ---------------------------------------------------------------------------

describe("protectedSettingsFile — runtime-policy files a write must not silently touch", () => {
  it("write_file/edit on the policy files are protected", () => {
    expect(protectedSettingsFile("write_file", { path: ".wudao/settings.json" })).toBe(".wudao/settings.json");
    expect(protectedSettingsFile("edit", { path: ".wudao/mcp.json" })).toBe(".wudao/mcp.json");
  });
  it("dodge variants still match: ./ prefix, ../ traversal, absolute, nested, case-folded", () => {
    expect(protectedSettingsFile("write_file", { path: "./.wudao/settings.json" })).toBe(".wudao/settings.json");
    expect(protectedSettingsFile("write_file", { path: "src/../.wudao/settings.json" })).toBe(".wudao/settings.json");
    expect(protectedSettingsFile("edit", { path: "/Users/x/proj/.wudao/mcp.json" })).toBe(".wudao/mcp.json");
    expect(protectedSettingsFile("write_file", { path: "docs/.wudao/settings.json" })).toBe(".wudao/settings.json");
    expect(protectedSettingsFile("write_file", { path: ".WUDAO/SETTINGS.JSON" })).toBe(".wudao/settings.json");
  });
  it("reads, commands, other tools, and ordinary paths are not protected", () => {
    expect(protectedSettingsFile("read_file", { path: ".wudao/settings.json" })).toBeUndefined();
    expect(protectedSettingsFile("shell", { command: "cat .wudao/settings.json" })).toBeUndefined();
    expect(protectedSettingsFile("todo_write", { path: ".wudao/plan.md" })).toBeUndefined();
    expect(protectedSettingsFile("write_file", { path: "src/a.ts" })).toBeUndefined();
    expect(protectedSettingsFile("write_file", {})).toBeUndefined();
  });
  it("ω99-124: make_pptx is covered — write target is the filename key", () => {
    expect(protectedSettingsFile("make_pptx", { filename: ".wudao/settings.json" })).toBe(".wudao/settings.json");
    expect(protectedSettingsFile("make_pptx", { filename: ".wudao/extensions/evil.pptx" })).toBe(".wudao/extensions");
    expect(protectedSettingsFile("make_pptx", { filename: "docs/.wudao/plugins/hook.pptx" })).toBe(".wudao/plugins");
    expect(protectedSettingsFile("make_pptx", { filename: "汇报/季度.pptx" })).toBeUndefined();
    expect(protectedSettingsFile("make_pptx", { path: ".wudao/settings.json" })).toBeUndefined(); // path 键不是本工具目标
  });
  it("ω99-126: make_docx is covered (Set 收口后) — write target is the filename key; xlsx/pptx/write_file 既有面零变", () => {
    expect(protectedSettingsFile("make_docx", { filename: ".wudao/settings.json" })).toBe(".wudao/settings.json");
    expect(protectedSettingsFile("make_docx", { filename: ".wudao/extensions/evil.docx" })).toBe(".wudao/extensions");
    expect(protectedSettingsFile("make_docx", { filename: "docs/.wudao/plugins/hook.docx" })).toBe(".wudao/plugins");
    expect(protectedSettingsFile("make_docx", { filename: "报告/季度.docx" })).toBeUndefined();
    expect(protectedSettingsFile("make_docx", { path: ".wudao/settings.json" })).toBeUndefined(); // path 键不是本工具目标
    // Set 收口行为零变：三名齐 + 旧工具照旧（xlsx/pptx 走 filename 键，write_file/edit 走 path 键）。
    expect(protectedSettingsFile("make_xlsx", { filename: ".wudao/settings.json" })).toBe(".wudao/settings.json");
    expect(protectedSettingsFile("write_file", { path: ".wudao/mcp.json" })).toBe(".wudao/mcp.json");
    expect(protectedSettingsFile("read_file", { path: ".wudao/settings.json" })).toBeUndefined();
  });
});

describe("decideRichPermission — settings writes are bypass-immune", () => {
  const input = (path: string): Record<string, unknown> => ({ path });

  it("auto mode still asks for a settings write (no silent self-escalation)", () => {
    expect(decideRichPermission({ mode: "auto", toolName: "write_file", input: input(".wudao/settings.json") }))
      .toBe("ask");
  });
  it("workspace mode asks (as it always did, now guaranteed)", () => {
    expect(decideRichPermission({ mode: "workspace", toolName: "edit", input: input(".wudao/mcp.json") }))
      .toBe("ask");
  });
  it("ask mode asks too (the retired read-only deny branch is gone — every mode asks)", () => {
    expect(decideRichPermission({ mode: "ask", toolName: "write_file", input: input(".wudao/settings.json") }))
      .toBe("ask");
  });
  it("no layer can silence the ask: session allowlist and settings allow both fail to bypass", () => {
    expect(decideRichPermission({
      mode: "workspace", toolName: "write_file", input: input(".wudao/settings.json"),
      session: ["write_file"], settings: { allow: ["write_file"], deny: [], ask: [] },
    })).toBe("ask");
    expect(decideRichPermission({
      mode: "auto", toolName: "edit", input: input(".wudao/settings.json"),
      session: ["edit:.wudao/"], settings: { allow: ["edit"], deny: [], ask: [] },
    })).toBe("ask");
  });
  it("a settings deny still names its own rule first (deny stays the top layer)", () => {
    expect(decideRichPermission({
      mode: "auto", toolName: "write_file", input: input(".wudao/settings.json"),
      settings: { allow: [], deny: ["write_file:.wudao/"], ask: [] },
    })).toEqual({ behavior: "deny", reason: 'settings deny rule "write_file:.wudao/"' });
  });
  it("traversal into the policy file in auto mode still asks", () => {
    expect(decideRichPermission({ mode: "auto", toolName: "write_file", input: input("src/../.wudao/settings.json") }))
      .toBe("ask");
  });
  it("ordinary writes keep their mode behavior (auto allows; ask still asks; workspace allows)", () => {
    expect(decideRichPermission({ mode: "auto", toolName: "write_file", input: input("src/a.ts") }))
      .toEqual({ behavior: "allow" });
    expect(decideRichPermission({ mode: "ask", toolName: "write_file", input: input("src/a.ts") }))
      .toBe("ask");
    expect(decideRichPermission({ mode: "workspace", toolName: "write_file", input: input("src/a.ts") }))
      .toEqual({ behavior: "allow" });
  });
});

describe("applyAskAnswer — `a`/`p` cannot whitelist a settings write", () => {
  it("a session answer on a settings write downgrades to allow-ONCE and records no rule", () => {
    const r = applyAskAnswer({ kind: "session" }, "write_file", { path: ".wudao/settings.json" });
    expect(r.decision).toEqual({ behavior: "allow" });
    expect(r.sessionRule).toBeNull();
    expect(r.persistentRule).toBeNull();
  });
  it("because no rule was recorded, the very next settings write still asks", () => {
    const al = createSessionAllowlist();
    const r = applyAskAnswer({ kind: "session" }, "write_file", { path: ".wudao/settings.json" });
    if (r.sessionRule !== null) al.add(r.sessionRule);
    expect(decideRichPermission({
      mode: "auto", toolName: "write_file", input: { path: ".wudao/settings.json" }, session: al,
    })).toBe("ask");
  });
  it("a session answer on an ordinary write records the tool:path rule as before", () => {
    expect(applyAskAnswer({ kind: "session" }, "write_file", { path: "src/a.ts" }))
      .toEqual({ decision: { behavior: "allow" }, sessionRule: "write_file:src/a.ts", persistentRule: null });
    expect(applyAskAnswer({ kind: "session" }, "shell", { command: "ls" }))
      .toEqual({ decision: { behavior: "allow" }, sessionRule: "shell:ls", persistentRule: null });
  });
  it("y records no rule; n <reason> keeps the by-user reason", () => {
    expect(applyAskAnswer({ kind: "allow" }, "write_file", { path: ".wudao/settings.json" }).sessionRule).toBeNull();
    expect(applyAskAnswer({ kind: "deny", reason: "not yet" }, "write_file", { path: "src/a.ts" }).decision)
      .toEqual({ behavior: "deny", reason: "by user: not yet" });
  });
  it("0.3.14: an always answer yields BOTH rules (session covers the write/hot-reload gap)", () => {
    expect(applyAskAnswer({ kind: "always" }, "write_file", { path: "src/a.ts" }))
      .toEqual({ decision: { behavior: "allow" }, sessionRule: "write_file:src/a.ts", persistentRule: "write_file:src/a.ts" });
    expect(applyAskAnswer({ kind: "always" }, "shell", { command: "pnpm test" }))
      .toEqual({ decision: { behavior: "allow" }, sessionRule: "shell:pnpm test", persistentRule: "shell:pnpm test" });
  });
  it("0.3.14: an always answer on a settings write degrades exactly like `a` — allow-once, no rules", () => {
    expect(applyAskAnswer({ kind: "always" }, "write_file", { path: ".wudao/mcp.json" }))
      .toEqual({ decision: { behavior: "allow" }, sessionRule: null, persistentRule: null });
  });
});

describe("recordAskRules — 夜移 009: the `a` answer's session rule gets receipt parity", () => {
  // Post-006 a session rule is meaningfully scoped (`shell:git checkout`
  // — the exact head the user approved), but it landed SILENTLY while `p` got
  // a receipt: the user never saw the scope they granted. recordAskRules is
  // the ONE recording seam every ask site shares (REPL stdout / TUI notify /
  // session-engine askRelay + onAskRule), so receipt semantics live here.
  it("records a session-only rule and returns its receipt (the `a` answer)", () => {
    const added: string[] = [];
    const receipt = recordAskRules(
      { add: (r) => added.push(r) },
      { sessionRule: "shell:git checkout", persistentRule: null },
    );
    expect(added).toEqual(["shell:git checkout"]);
    expect(receipt).toBe('permissions: session rule "shell:git checkout" — no more asks this session');
  });
  it("an `always` answer records the session copy but returns NO receipt — the persistent receipt subsumes it (no double-notify)", () => {
    const added: string[] = [];
    const receipt = recordAskRules(
      { add: (r) => added.push(r) },
      { sessionRule: "write_file:src/a.ts", persistentRule: "write_file:src/a.ts" },
    );
    // The session copy still records (it covers the write/hot-reload gap —
    // applyAskAnswer's contract), but the user sees ONE receipt: the
    // persistAllowRule line naming the same rule.
    expect(added).toEqual(["write_file:src/a.ts"]);
    expect(receipt).toBeNull();
  });
  it("no session rule → nothing recorded, no receipt (settings-write degradation stays silent)", () => {
    const added: string[] = [];
    const sink = { add: (r: string) => added.push(r) };
    expect(recordAskRules(sink, { sessionRule: null, persistentRule: "write_file:src/a.ts" })).toBeNull();
    expect(recordAskRules(sink, { sessionRule: null, persistentRule: null })).toBeNull();
    expect(added).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 夜移 010 (a reference harness-Py permissions/checker.py:18-200): credential-material
// ask gate. OH-Py hard-DENIES a fnmatch denylist (`*/.ssh/*`, `*/.aws/credentials`,
// `*/.gnupg/*`, `*/.kube/config`, its own credential store) before mode — even
// --dangerously-skip-permissions cannot override. Wudao's deliberate divergence,
// along its own capability≠policy line: ASK, not deny — a human can approve a
// legitimate key workflow (deploy pubkey, kube-context work). The gate sits
// ABOVE the builtin modes (auto can no longer read key material silently) but
// BELOW explicit human grants: an `a` answer's session rule (its 夜移 009 receipt
// promised "no more asks this session") and an operator's settings allow both
// pre-approve. Scope: any call whose `path` input names credential material
// (wudao's grep/glob are workspace-rooted with no path param today — the
// check is param-driven so a future directory param is covered for free).
// shell is out of scope: substring-matching command text is noisy AND
// trivially bypassed (env vars, base64); the reliable surface is the path tools.
// ---------------------------------------------------------------------------

describe("credentialMaterialPath — 夜移 010: detect credential material in a tool path", () => {
  it("matches the OH-Py credential set wherever the directory sits in the path", () => {
    for (const p of [
      "~/.ssh/id_rsa", "/Users/q/.ssh/id_rsa", ".ssh/id_rsa", "deploy/.ssh/staging_key",
      "../.ssh/id_ed25519",
      "~/.aws/credentials", "infra/.aws/credentials",
      "~/.gnupg/pubring.kbx", "backup/.gnupg/trustdb.gpg",
      "~/.kube/config", "lab/.kube/config",
    ]) {
      expect(credentialMaterialPath("read_file", { path: p }), p).toBeDefined();
    }
  });
  it("matches wudao's own credential store", () => {
    expect(credentialMaterialPath("read_file", { path: "~/.wudao/.credentials.yaml" })).toBeDefined();
    expect(credentialMaterialPath("read_file", { path: "/Users/q/.wudao/.credentials.yaml" })).toBeDefined();
  });
  it("ordinary paths — including .env and settings READS — stay untouched", () => {
    for (const p of ["src/a.ts", ".env", "config/.env.local", ".wudao/settings.json", "~/.zshrc", "doc/ssh-notes.md"]) {
      expect(credentialMaterialPath("read_file", { path: p }), p).toBeUndefined();
    }
  });
  it("a path-shaped dir without a file under it does not match (segment rule, not substring)", () => {
    // `*/.ssh/*` needs something AFTER the directory: a file named literally
    // `.ssh` or a docs folder mentioning ssh is not credential material.
    expect(credentialMaterialPath("read_file", { path: "notes/.ssh" })).toBeUndefined();
    expect(credentialMaterialPath("read_file", { path: "my-ssh-keys-notes.md" })).toBeUndefined();
  });
  it("covers every path-taking tool — write_file and edit too — and ignores calls without a path", () => {
    expect(credentialMaterialPath("write_file", { path: "~/.ssh/authorized_keys" })).toBeDefined();
    expect(credentialMaterialPath("edit", { path: "/Users/q/.kube/config" })).toBeDefined();
    expect(credentialMaterialPath("read_file", {})).toBeUndefined();
    expect(credentialMaterialPath("shell", { command: "cat ~/.ssh/id_rsa" })).toBeUndefined();
    // ω99-123 fix2: make_xlsx carries its write target as `filename` — the
    // credential gate reads the right key for it (same posture as write_file).
    expect(credentialMaterialPath("make_xlsx", { filename: "deploy/.ssh/staging.xlsx" })).toBeDefined();
    expect(credentialMaterialPath("make_xlsx", { filename: "notes/清单.xlsx" })).toBeUndefined();
    expect(credentialMaterialPath("make_xlsx", { path: "deploy/.ssh/staging.xlsx" })).toBeUndefined(); // path 键不是本工具目标
    // ω99-124: make_pptx carries its write target as `filename` — same rule.
    expect(credentialMaterialPath("make_pptx", { filename: "deploy/.ssh/staging.pptx" })).toBeDefined();
    expect(credentialMaterialPath("make_pptx", { filename: "汇报/清单.pptx" })).toBeUndefined();
    expect(credentialMaterialPath("make_pptx", { path: "deploy/.ssh/staging.pptx" })).toBeUndefined(); // path 键不是本工具目标
    // ω99-126: make_docx carries its write target as `filename` — same rule
    // (Set 收口后三名齐；xlsx/pptx/write_file 既有面照旧)。
    expect(credentialMaterialPath("make_docx", { filename: "deploy/.ssh/staging.docx" })).toBeDefined();
    expect(credentialMaterialPath("make_docx", { filename: "报告/清单.docx" })).toBeUndefined();
    expect(credentialMaterialPath("make_docx", { path: "deploy/.ssh/staging.docx" })).toBeUndefined(); // path 键不是本工具目标
  });
});

describe("decideRichPermission — 夜移 010: the credential ask gate", () => {
  const cred = { path: "~/.ssh/id_rsa" };
  it("auto mode ASKS on credential material (bypass-immune: mode cannot allow it)", () => {
    expect(decideRichPermission({ mode: "auto", toolName: "read_file", input: cred })).toBe("ask");
    expect(decideRichPermission({ mode: "auto", toolName: "edit", input: { path: "/Users/q/.aws/credentials" } })).toBe("ask");
  });
  it("an `a` answer's session rule silences the rest of the session (the 009 receipt promise)", () => {
    const al = createSessionAllowlist();
    const r = applyAskAnswer({ kind: "session" }, "read_file", cred);
    expect(r.sessionRule).toBe("read_file:~/.ssh/id_rsa"); // normal recording — NO settings-write degradation
    al.add(r.sessionRule ?? "");
    expect(decideRichPermission({ mode: "auto", toolName: "read_file", input: cred, session: al }))
      .toEqual({ behavior: "allow" });
  });
  it("an operator's settings allow pre-approves (capability≠policy: explicit grants outrank the gate)", () => {
    const settings = parsePermissionSettings({ allow: ["read_file:~/.ssh/id_rsa"] });
    expect(decideRichPermission({ mode: "auto", toolName: "read_file", input: cred, settings }))
      .toEqual({ behavior: "allow" });
  });
  it("a settings deny still hard-denies above the gate", () => {
    const settings = parsePermissionSettings({ deny: ["read_file:~/.ssh"] });
    expect(decideRichPermission({ mode: "auto", toolName: "read_file", input: cred, settings }))
      .toEqual({ behavior: "deny", reason: 'settings deny rule "read_file:~/.ssh"' });
  });
  it("ordinary reads keep their old decisions in every mode (no false positives)", () => {
    expect(decideRichPermission({ mode: "auto", toolName: "read_file", input: { path: "src/a.ts" } }))
      .toEqual({ behavior: "allow" });
    expect(decideRichPermission({ mode: "plan", toolName: "read_file", input: { path: "src/a.ts" } }))
      .toEqual({ behavior: "allow" });
    expect(decideRichPermission({ mode: "workspace", toolName: "read_file", input: { path: ".env" } }))
      .toEqual({ behavior: "allow" });
  });
  it("plan mode also asks for credential material (read-only fence is about mutation, not secrets)", () => {
    expect(decideRichPermission({ mode: "plan", toolName: "read_file", input: cred })).toBe("ask");
  });
});

// ---------------------------------------------------------------------------
// Security fix: shell rules were inert — rule matching only ever looked
// at input.path, so `deny: ["shell:rm -rf"]` never fired. A rule suffix
// on a command-bearing call now matches the command by token-boundary prefix.
// ---------------------------------------------------------------------------

describe("ruleMatches — shell rules match the command (prefix semantics)", () => {
  const cmd = (command: string): Record<string, unknown> => ({ command });

  it("`deny shell:rm` blocks `rm -rf x` (the README example is real now)", () => {
    expect(ruleMatches("shell:rm", "shell", cmd("rm -rf x"))).toBe(true);
    expect(ruleMatches("shell:rm -rf", "shell", cmd("rm -rf x"))).toBe(true);
  });
  it("token boundary: `rm` does not catch `rmlint`", () => {
    expect(ruleMatches("shell:rm", "shell", cmd("rmlint --dry-run"))).toBe(false);
    expect(ruleMatches("shell:git", "shell", cmd("gitty up"))).toBe(false);
  });
  it("multi-token prefixes and exact matches work, whitespace-normalized", () => {
    expect(ruleMatches("shell:git status", "shell", cmd("git status --short"))).toBe(true);
    expect(ruleMatches("shell:rm  -rf", "shell", cmd("rm -rf /tmp/x"))).toBe(true);
    expect(ruleMatches("shell:git", "shell", cmd("git"))).toBe(true);
    expect(ruleMatches("shell:git", "shell", cmd("git status"))).toBe(true);
  });
  it("a non-matching command does not hit the rule", () => {
    expect(ruleMatches("shell:rm", "shell", cmd("ls -la"))).toBe(false);
    expect(ruleMatches("shell:rm", "shell", {})).toBe(false);
  });
  // 安全审计 2026-11 C6 —— 扩权 flag 降级：族级前缀规则不再放行带
  // --force/-D/--hard/--privileged… 的命令；只有整条相等（或显式 glob:
  // 规则）可命中。env 头任何 1-token 规则都不放行 env CMD。
  it("C6：族规则 shell:git push 不放行 --force/--delete 变体；温和变体照旧", () => {
    expect(ruleMatches("shell:git push", "shell", cmd("git push --force origin main"))).toBe(false);
    expect(ruleMatches("shell:git push", "shell", cmd("git push --force-with-lease origin main"))).toBe(false);
    expect(ruleMatches("shell:git push", "shell", cmd("git push --delete origin leak"))).toBe(false);
    // 温和形态：族规则照常命中（正常工作流零影响）。
    expect(ruleMatches("shell:git push", "shell", cmd("git push origin dev"))).toBe(true);
    expect(ruleMatches("shell:git push", "shell", cmd("git push origin main"))).toBe(true);
  });
  it("C6：扩权命令自身被批准后（整条精确规则）重跑同命令免问，其它变体不放行", () => {
    expect(ruleMatches("shell:git push --force origin main", "shell", cmd("git push --force origin main"))).toBe(true);
    expect(ruleMatches("shell:git push --force origin main", "shell", cmd("git push --force origin other"))).toBe(false);
  });
  it("C6：env 头不被任何 1-token 规则放行（env 启动器）", () => {
    expect(ruleMatches("shell:env", "shell", cmd("env rm -rf /"))).toBe(false);
    expect(ruleMatches("shell:env", "shell", cmd("env"))).toBe(true); // 裸 env 本身照旧
    expect(ruleMatches("shell:env FOO=1 npm test", "shell", cmd("env FOO=1 npm test"))).toBe(true);
    expect(ruleMatches("shell:env FOO=1 npm test", "shell", cmd("env FOO=1 rm -rf /"))).toBe(false);
  });
  it("path rules keep their old semantics (unaffected by the command lane)", () => {
    expect(ruleMatches("write_file:src/", "write_file", { path: "src/a.ts" })).toBe(true);
    expect(ruleMatches("write_file:src/", "write_file", cmd("ls"))).toBe(false);
  });
  it("the command lane decides through the full layering", () => {
    expect(decideRichPermission({
      mode: "auto", toolName: "shell", input: cmd("rm -rf x"),
      settings: { allow: [], deny: ["shell:rm"], ask: [] },
    })).toEqual({ behavior: "deny", reason: 'settings deny rule "shell:rm"' });
    expect(decideRichPermission({
      mode: "default", toolName: "shell", input: cmd("git status"),
      settings: { allow: ["shell:git"], deny: [], ask: [] },
    })).toEqual({ behavior: "allow" });
    expect(decideRichPermission({
      mode: "default", toolName: "shell", input: cmd("rm -rf x"),
      settings: { allow: ["shell:git"], deny: [], ask: [] },
    })).toBe("ask");
  });
});

// ---------------------------------------------------------------------------
// 0.3.14 #2 — the workspace-safe command class (accept tier): a curated
// read-only verb list auto-allowed in workspace mode; everything else keeps
// the ask. Fail-closed: any unparsed shape asks.
// ---------------------------------------------------------------------------
describe("safeWorkspaceCommand — the accept-tier read-only class", () => {
  const cmd = (command: string): Record<string, unknown> => ({ command });

  it("listed verbs and git read subcommands qualify", () => {
    for (const c of [
      "git status", "git diff", "git log", "git show", "git blame src/a.ts",
      "git diff --stat", "git log --oneline -5", "git show v1.0..v2.0",
      "ls", "ls -la src", "pwd", "cat package.json", "head -n 20 a.txt",
      "tail -f out.log", "wc -l src/a.ts",
    ]) expect(safeWorkspaceCommand(c)).toBe(true);
  });
  it("compounds qualify when EVERY segment does (; / && / || / newline)", () => {
    expect(safeWorkspaceCommand("git status && git diff")).toBe(true);
    expect(safeWorkspaceCommand("git status; git log --oneline")).toBe(true);
    expect(safeWorkspaceCommand("pwd\nls -la")).toBe(true);
    expect(safeWorkspaceCommand("git status && npm install")).toBe(false);
    expect(safeWorkspaceCommand("git status; rm -rf x")).toBe(false);
  });
  it("unlisted verbs and mutating git subcommands do not qualify", () => {
    for (const c of [
      "npm install", "echo hi", "git branch", "git branch -D feat",
      "git add -A", "git commit -m x", "git stash list", "rm -rf x",
    ]) expect(safeWorkspaceCommand(c)).toBe(false);
  });
  it("shell metacharacters disqualify (pipes, redirects, substitution)", () => {
    for (const c of [
      "git status | sh", "cat a > b", "cat a >> b", "git log < file",
      "git log -S\"$(whoami)\"", "git status &", "echo `id`",
      "cat (weird)", "git log;\nrm x",
    ]) expect(safeWorkspaceCommand(c)).toBe(false);
  });
  it("args that could escape the workspace disqualify (fail-closed)", () => {
    for (const c of [
      "cat /etc/passwd", "cat ~/.ssh/id_rsa", "cat ../outside.txt",
      "ls ../../", "git diff ../other", "git show HEAD:../../x",
    ]) expect(safeWorkspaceCommand(c)).toBe(false);
  });
  // 安全审计 2026-11 C7（HIGH）：凭据物料段——workspace 根在 $HOME 时
  // `.ssh/id_rsa` 是合法相对路径，路径逃逸检查够不着；文件工具早已 ask
  // （credentialMaterialPath），shell 只读类此前是漏网路径。
  it("C7：触及凭据段的相对路径退出安全类（与文件工具对齐）", () => {
    for (const c of [
      "cat .ssh/id_rsa", "head .aws/credentials", "tail .kube/config",
      "wc -c .wudao/.credentials.yaml", "cat .gnupg/private.key",
      "cat config/.ssh/id_rsa", // 段在任意深度同样命中
    ]) expect(safeWorkspaceCommand(c)).toBe(false);
  });
  it("C7：非凭据近邻与普通源码照常免问（不扩大打击面）", () => {
    for (const c of [
      "cat src/main.ts", "cat .ssh-notes.md", "ls .ssh", // 目录本身（文件工具同语义：需目录之下的东西）
      "head package.json", "wc -l a.ts",
    ]) expect(safeWorkspaceCommand(c)).toBe(true);
  });
  it("git's relocating/output flags disqualify even with a safe subcommand", () => {
    for (const c of [
      "git -C ../other status", "git status -C../other",
      "git --git-dir=/x/.git status", "git --work-tree=/x status",
      "git diff --output=../stolen", "git -c x=y status",
    ]) expect(safeWorkspaceCommand(c)).toBe(false);
  });
  it("degenerate shapes are not safe (empty / whitespace / only separators)", () => {
    for (const c of ["", "   ", ";", "&&", "\n\n"]) expect(safeWorkspaceCommand(c)).toBe(false);
  });

  it("layer 4.7: workspace mode auto-allows the class; ask/auto/ask-mode do not share it", () => {
    expect(decideRichPermission({ mode: "workspace", toolName: "shell", input: cmd("git status --short") }))
      .toEqual({ behavior: "allow" });
    // outside the class the workspace tier still asks (fail-closed)
    expect(decideRichPermission({ mode: "workspace", toolName: "shell", input: cmd("npm install") }))
      .toBe("ask");
    // non-command tools are untouched; ask mode still asks everything
    expect(decideRichPermission({ mode: "ask", toolName: "shell", input: cmd("git status") }))
      .toBe("ask");
    // a non-string command input falls through to ask
    expect(decideRichPermission({ mode: "workspace", toolName: "shell", input: {} })).toBe("ask");
  });
  it("layer 4.7 sits BELOW the rule layers: deny/ask rules still force the human", () => {
    expect(decideRichPermission({
      mode: "workspace", toolName: "shell", input: cmd("git status"),
      settings: { allow: [], deny: ["shell:git"], ask: [] },
    })).toEqual({ behavior: "deny", reason: 'settings deny rule "shell:git"' });
    expect(decideRichPermission({
      mode: "workspace", toolName: "shell", input: cmd("git status"),
      settings: { allow: [], deny: [], ask: ["shell:git status"] },
    })).toBe("ask");
    // and a session `a` recorded earlier still widens to allow
    expect(decideRichPermission({
      mode: "workspace", toolName: "shell", input: cmd("npm install"),
      session: ["shell:npm install"],
    })).toEqual({ behavior: "allow" });
  });
});

// ---------------------------------------------------------------------------
// Security fix (minor): normalizePath collapses `.`/`..` segments so
// `src/../.env` cannot dodge `deny write_file:.env`. Leading `..` is kept —
// escaping the workspace is the tool layer's confinement job (outer bound).
// ---------------------------------------------------------------------------

describe("ruleMatches — dot-segment collapse in path prefixes", () => {
  it("`deny write_file:.env` catches src/../.env and ./.env", () => {
    expect(ruleMatches("write_file:.env", "write_file", { path: "src/../.env" })).toBe(true);
    expect(ruleMatches("write_file:.env", "write_file", { path: "./.env" })).toBe(true);
  });
  it("`./src/./a.ts` matches the `src` prefix like a clean path", () => {
    expect(ruleMatches("write_file:src", "write_file", { path: "./src/./a.ts" })).toBe(true);
    expect(ruleMatches("write_file:src/", "write_file", { path: "src/../other/a.ts" })).toBe(false);
  });
  it("a leading `..` is preserved (confinement stays with the tool layer)", () => {
    expect(ruleMatches("write_file:.env", "write_file", { path: "../.env" })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// M33 §1 hot-reload: .wudao/settings.json changes take effect mid-session,
// with a printed receipt.
// ---------------------------------------------------------------------------

describe("createPermissionSettingsWatcher", () => {
  async function tmpWorkspace(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "wudao-perms-"));
    await mkdir(join(dir, ".wudao"), { recursive: true });
    return dir;
  }
  async function writeSettings(root: string, text: string, mtime: Date): Promise<void> {
    const file = join(root, ".wudao", "settings.json");
    await writeFile(file, text, "utf8");
    await utimes(file, mtime, mtime);
  }

  it("missing file → empty rules, no receipt", async () => {
    const root = await tmpWorkspace();
    const receipts: string[] = [];
    try {
      const w = createPermissionSettingsWatcher(root, (l) => receipts.push(l), { revalidateMs: 0 });
      expect(await w.get()).toEqual(EMPTY_PERMISSION_SETTINGS);
      expect(receipts).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("loads rules; same mtime+size → cached (no receipt); a change reloads with a receipt", async () => {
    const root = await tmpWorkspace();
    const receipts: string[] = [];
    try {
      await writeSettings(root, JSON.stringify({ permissions: { deny: ["shell"] } }), new Date("2024-01-01T00:00:00Z"));
      const w = createPermissionSettingsWatcher(root, (l) => receipts.push(l), { revalidateMs: 0 });
      // First load: silent (startup is not a reload).
      expect(await w.get()).toEqual({ allow: [], deny: ["shell"], ask: [], sidecarExempt: [] });
      expect(receipts).toEqual([]);
      // Unchanged file: cached, still silent.
      expect(await w.get()).toEqual({ allow: [], deny: ["shell"], ask: [], sidecarExempt: [] });
      expect(receipts).toEqual([]);
      // Hot change: new rules take effect immediately + a receipt line.
      await writeSettings(
        root,
        JSON.stringify({ permissions: { allow: ["shell", "write_file:src/"], deny: [], ask: ["edit"] } }),
        new Date("2024-01-02T00:00:00Z"),
      );
      expect(await w.get()).toEqual({ allow: ["shell", "write_file:src/"], deny: [], ask: ["edit"], sidecarExempt: [] });
      expect(receipts.length).toBe(1);
      expect(receipts[0]).toContain("permissions");
      expect(receipts[0]).toContain("allow 2");
      expect(receipts[0]).toContain("ask 1");
      // And the new rules actually decide:
      expect(decideRichPermission({
        mode: "default", toolName: "shell", input: { command: "ls" },
        settings: await w.get(),
      })).toEqual({ behavior: "allow" });
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("malformed JSON on reload → empty rules + warning receipt (never a crash)", async () => {
    const root = await tmpWorkspace();
    const receipts: string[] = [];
    try {
      await writeSettings(root, JSON.stringify({ permissions: { allow: ["shell"] } }), new Date("2024-01-01T00:00:00Z"));
      const w = createPermissionSettingsWatcher(root, (l) => receipts.push(l), { revalidateMs: 0 });
      await w.get();
      await writeSettings(root, "{ not json", new Date("2024-01-02T00:00:00Z"));
      expect(await w.get()).toEqual(EMPTY_PERMISSION_SETTINGS);
      expect(receipts.some((r) => r.includes("not valid JSON") || r.includes("⚠"))).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
});

// ---------------------------------------------------------------------------
// ω99-27 T2 — the sidecarExempt lane's settings surface: the reload receipt
// names the fourth list, and a hot-added rule exempts the very next gated
// call through the same wiring the frontends use (watcher → seam getter).
// ---------------------------------------------------------------------------

describe("ω99-27 T2: sidecarExempt hot-reload (operator relief without restart)", () => {
  async function tmpWorkspace(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "wudao-exempt-"));
    await mkdir(join(dir, ".wudao"), { recursive: true });
    return dir;
  }

  it("the reload receipt names the sidecarExempt count beside allow/deny/ask", async () => {
    const root = await tmpWorkspace();
    const receipts: string[] = [];
    try {
      await writeFile(join(root, ".wudao", "settings.json"), JSON.stringify({ permissions: { allow: ["shell"] } }), "utf8");
      await utimes(join(root, ".wudao", "settings.json"), new Date("2024-01-01T00:00:00Z"), new Date("2024-01-01T00:00:00Z"));
      const w = createPermissionSettingsWatcher(root, (l) => receipts.push(l), { revalidateMs: 0 });
      await w.get();
      expect(receipts).toEqual([]); // first load silent
      await writeFile(
        join(root, ".wudao", "settings.json"),
        JSON.stringify({ permissions: { allow: ["shell"], sidecarExempt: ["edit:README.md"] } }),
        "utf8",
      );
      await utimes(join(root, ".wudao", "settings.json"), new Date("2024-01-02T00:00:00Z"), new Date("2024-01-02T00:00:00Z"));
      expect((await w.get()).sidecarExempt).toEqual(["edit:README.md"]);
      expect(receipts.length).toBe(1);
      expect(receipts[0]).toContain("allow 1");
      expect(receipts[0]).toContain("sidecarExempt 1");
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("a rule written mid-run exempts the NEXT gated call (watcher → seam → allow; #452: high auto-allows with the receipt)", async () => {
    const root = await tmpWorkspace();
    const receipts: string[] = [];
    // A scripted-always-high sidecar model: #452 auto 托付 means every
    // classified call ALLOWS (with the loud audit receipt) — the exemption's
    // observable difference is ZERO classifier calls + the exempt receipt.
    const inputs: ModelInput[] = [];
    const model: ModelClient = {
      async generate(input: ModelInput): Promise<AssistantMessage> {
        inputs.push(input);
        return { role: "assistant", content: '{"risk":"high","reason":"unbounded modification"}' };
      },
    };
    const sidecar = createSidecar({ model });
    const escalations: { circuitOpen: boolean; reason?: string }[] = [];
    try {
      const w = createPermissionSettingsWatcher(root, (l) => receipts.push(l), { revalidateMs: 0 });
      const gate = withSidecarLayer(
        {
          sidecar,
          getMode: () => "auto",
          escalate: async (_t, _i, ctx) => {
            escalations.push(ctx);
            return { behavior: "deny", reason: "escalated" };
          },
          receipt: (l) => void receipts.push(l),
          sidecarExemptRules: async () => (await w.get()).sidecarExempt,
        },
        async () => ({ behavior: "allow" as const }),
      );
      const args = { path: "README.md", old_string: "@v0.2.0", new_string: "@v0.3.0" };
      // Before the rule: classified (high) → auto 托付 allow + the loud receipt.
      expect(await gate("edit", args)).toEqual({ behavior: "allow" });
      expect(sidecar.checks()).toBe(1);
      expect(escalations).toHaveLength(0); // the seam is never consulted
      const highReceipt = receipts.find((r) => r.includes("sidecar:high"));
      expect(highReceipt).toBeDefined();
      expect(highReceipt).toContain("auto 托付模式自动放行");
      expect(highReceipt).toContain("unbounded modification");
      // The operator writes the rule mid-run — hot reload, no restart.
      await writeFile(
        join(root, ".wudao", "settings.json"),
        JSON.stringify({ permissions: { sidecarExempt: ["edit:README.md"] } }),
        "utf8",
      );
      await utimes(join(root, ".wudao", "settings.json"), new Date("2024-01-02T00:00:00Z"), new Date("2024-01-02T00:00:00Z"));
      const checksBefore = sidecar.checks();
      expect(await gate("edit", args)).toEqual({ behavior: "allow" });
      expect(sidecar.checks()).toBe(checksBefore); // zero new classifier calls
      expect(receipts.some((r) => r.includes("sidecarExempt 1"))).toBe(true);
      expect(receipts.some((r) => r.includes("🛡 sidecar exempt — settings rule «edit:README.md» (operator)"))).toBe(true);
      expect(inputs).toHaveLength(1);
      expect(escalations).toHaveLength(0);
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
});
