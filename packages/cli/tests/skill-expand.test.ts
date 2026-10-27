// cc-plugins D2 — the unified skill/command substitution expander + the
// !`cmd` / ```! dynamic injection. Byte-exact pins: the substitution matrix
// follows real Claude Code semantics (0-based $N, shell-quoted multi-word
// args, named-arg positional mapping), and the injector's one-pass law
// (output never rescanned) is a security property, not a nicety.
import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseSkillArgs,
  expandSubstitutions,
  expandInjections,
  bodyIncludesInjection,
  runSkillInjectionCommand,
  createSkillInjectionExec,
} from "../src/skill-expand.js";
import {
  buildExpandedSkillMessage,
  buildSubstitutedSkillMessage,
  skillBodyNeedsInjection,
  type LoadedSkill,
} from "../src/skills.js";

function tmpDir(prefix: string): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) };
}

/** A minimal LoadedSkill literal for the envelope builders. */
function skill(partial: Partial<LoadedSkill> = {}): LoadedSkill {
  return {
    name: partial.name ?? "demo",
    description: partial.description ?? "Demo skill",
    filePath: partial.filePath ?? "/ws/.claude/skills/demo/SKILL.md",
    relPath: partial.relPath ?? ".claude/skills/demo/SKILL.md",
    content: partial.content ?? "body",
    origin: partial.origin,
    ...(partial.argumentsDecl !== undefined ? { argumentsDecl: partial.argumentsDecl } : {}),
    ...(partial.plugin !== undefined ? { plugin: partial.plugin } : {}),
    ...(partial.pluginScope !== undefined ? { pluginScope: partial.pluginScope } : {}),
  } as LoadedSkill;
}

// ---------------------------------------------------------------------------
// parseSkillArgs — the shell-style argument tokenizer (quoted multi-word)
// ---------------------------------------------------------------------------

describe("parseSkillArgs", () => {
  it("whitespace-split plain args", () => {
    expect(parseSkillArgs("foo bar baz")).toEqual(["foo", "bar", "baz"]);
  });
  it("double-quoted multi-word arg stays ONE argument", () => {
    expect(parseSkillArgs('foo "hello world" bar')).toEqual(["foo", "hello world", "bar"]);
  });
  it("single-quoted multi-word arg stays ONE argument", () => {
    expect(parseSkillArgs("foo 'hello world' bar")).toEqual(["foo", "hello world", "bar"]);
  });
  it("empty / whitespace-only → []", () => {
    expect(parseSkillArgs("")).toEqual([]);
    expect(parseSkillArgs("   ")).toEqual([]);
  });
  it("$KEY tokens survive literally (args are data, not shell)", () => {
    expect(parseSkillArgs("$FILE x")).toEqual(["$FILE", "x"]);
  });
  it("an unbalanced quote degrades to plain whitespace-split (never throws)", () => {
    expect(parseSkillArgs('a "b c')).toEqual(["a", '"b', "c"]);
  });
});

// ---------------------------------------------------------------------------
// expandSubstitutions — $ARGUMENTS / $N / $name(argsDecl) / ${CLAUDE_*} / \$ escape
// ---------------------------------------------------------------------------

describe("expandSubstitutions", () => {
  const ctx = (args: string, argsDecl?: readonly string[]) => ({
    args,
    skillDir: "/ws/.claude/skills/demo",
    projectDir: "/ws",
    sessionId: "sess-42",
    ...(argsDecl !== undefined ? { argsDecl } : {}),
  });

  it("$ARGUMENTS expands to the whole trimmed arg string (inner spacing preserved)", () => {
    expect(expandSubstitutions("run $ARGUMENTS now", ctx(" fix  the bug "))).toBe("run fix  the bug now");
  });
  it("$ARGUMENTS[N] is 0-BASED (CC semantics); a missing index → empty", () => {
    expect(expandSubstitutions("a=$ARGUMENTS[0] b=$ARGUMENTS[1] c=$ARGUMENTS[9]", ctx("x y"))).toBe("a=x b=y c=");
  });
  it("$N is the 0-based shorthand of $ARGUMENTS[N]; missing → empty", () => {
    expect(expandSubstitutions("a=$0 b=$1 c=$2", ctx("x y"))).toBe("a=x b=y c=");
  });
  it("quoted multi-word args land as single positional values", () => {
    expect(expandSubstitutions("hello $0 $1", ctx("\"two words\" tail"))).toBe("hello two words tail");
  });
  it("a declared $name maps POSITIONALLY onto the parsed args (CC mapping)", () => {
    expect(expandSubstitutions("$topic then $style", ctx("chairs modern", ["topic", "style"]))).toBe("chairs then modern");
  });
  it("a declared $name with a missing position → empty", () => {
    expect(expandSubstitutions("[$topic][$style]", ctx("chairs", ["topic", "style"]))).toBe("[chairs][]");
  });
  it("$name matches whole names only — $filename never half-matches $file", () => {
    expect(expandSubstitutions("a=$filename b=$file", ctx("f1 f2", ["file", "filename"]))).toBe("a=f2 b=f1");
  });
  it("numeric-only and empty declared names are ignored (they would collide with $N)", () => {
    expect(expandSubstitutions("$0 is $1", ctx("a b", ["1", ""]))).toBe("a is b");
  });
  it("${CLAUDE_SESSION_ID} / ${CLAUDE_SKILL_DIR} / ${CLAUDE_PROJECT_DIR} substitute", () => {
    const out = expandSubstitutions(
      "s=${CLAUDE_SESSION_ID} d=${CLAUDE_SKILL_DIR} p=${CLAUDE_PROJECT_DIR}",
      ctx(""),
    );
    expect(out).toBe("s=sess-42 d=/ws/.claude/skills/demo p=/ws");
  });
  it("\\$ escapes to a literal dollar and shields the token from substitution", () => {
    expect(expandSubstitutions("costs \\$5 — \\$ARGUMENTS stays", ctx("x"))).toBe("costs $5 — $ARGUMENTS stays");
  });
  it("substituted VALUES are never rescanned (an arg containing $ARGUMENTS injects literally)", () => {
    expect(expandSubstitutions("x $0 y", ctx("$ARGUMENTS"))).toBe("x $ARGUMENTS y");
    expect(expandSubstitutions("x $topic y", ctx("$topic", ["topic"]))).toBe("x $topic y");
  });
  it("no placeholders → unchanged (a lone $ and trailing digits stay)", () => {
    expect(expandSubstitutions("just text and $ and 5$", ctx("x"))).toBe("just text and $ and 5$");
  });
  it("args === '' still substitutes ($ARGUMENTS → empty, not skipped)", () => {
    expect(expandSubstitutions("[$ARGUMENTS][$0]", ctx(""))).toBe("[][]");
  });
});

// ---------------------------------------------------------------------------
// expandInjections — !`cmd` inline + ```! fenced; one pass; disabled
// ---------------------------------------------------------------------------

describe("expandInjections", () => {
  it("an inline !`cmd` at line start or after whitespace is executed and inlined", async () => {
    const calls: string[] = [];
    const out = await expandInjections("Hello !`echo world` end\nstart !`echo x`", async (cmd) => {
      calls.push(cmd);
      return cmd === "echo world" ? "world" : "x";
    });
    expect(out).toBe("Hello world end\nstart x");
    expect(calls).toEqual(["echo world", "echo x"]);
  });
  it("a mid-word !`cmd` (no preceding whitespace) is NOT an injection", async () => {
    const out = await expandInjections("foo!`echo nope`", async () => {
      throw new Error("must not run");
    });
    expect(out).toBe("foo!`echo nope`");
  });
  it("a ```! fenced block is executed and replaced by its output", async () => {
    const out = await expandInjections("before\n```!\necho fenced\n```\nafter", async () => "FENCED");
    expect(out).toBe("before\nFENCED\nafter");
  });
  it("disabled → placeholder text naming the command; exec is never called", async () => {
    let ran = 0;
    const out = await expandInjections(
      "a !`echo secret` b\n```!\necho fenced\n```",
      async () => {
        ran += 1;
        return "";
      },
      { disabled: true },
    );
    expect(ran).toBe(0);
    expect(out).toBe("a [skill shell execution disabled: echo secret] b\n[skill shell execution disabled: echo fenced]");
  });
  it("injection OUTPUT is never rescanned — output containing !`…` stays literal", async () => {
    let runs = 0;
    const out = await expandInjections("!`echo pwn`", async (cmd) => {
      runs += 1;
      return cmd === "echo pwn" ? "got !`echo pwn` bytes" : "SHOULD NOT RUN";
    });
    expect(runs).toBe(1);
    expect(out).toBe("got !`echo pwn` bytes");
  });
  it("an inline !`cmd` INSIDE a fenced block executes once (as part of the block)", async () => {
    const calls: string[] = [];
    const out = await expandInjections("```!\n!`echo inner`\n```", async (cmd) => {
      calls.push(cmd);
      return "OUT";
    });
    expect(calls).toEqual(["!`echo inner`"]);
    expect(out).toBe("OUT");
  });
  it("a whitespace-only command is left verbatim", async () => {
    const out = await expandInjections("a !` ` b", async () => {
      throw new Error("must not run");
    });
    expect(out).toBe("a !` ` b");
  });
  it("exec rejection propagates to the caller (CC's fail-loud posture)", async () => {
    await expect(
      expandInjections("!`boom`", async () => {
        throw new Error("denied");
      }),
    ).rejects.toThrow("denied");
  });
  it("body with no injection syntax returns the input unchanged (identity)", async () => {
    const body = "plain markdown\n```\nnot an injection\n```\n";
    expect(await expandInjections(body, async () => "x")).toBe(body);
  });
  it("bodyIncludesInjection gates the cheap way", () => {
    expect(bodyIncludesInjection("a !`echo x` b")).toBe(true);
    expect(bodyIncludesInjection("```!\necho x\n```")).toBe(true);
    expect(bodyIncludesInjection("plain ``` code ```")).toBe(false);
    expect(bodyIncludesInjection("foo!`no whitespace before`")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// runSkillInjectionCommand — the shell shell boundary (cwd/timeout/env)
// ---------------------------------------------------------------------------

describe("runSkillInjectionCommand", () => {
  it("echo fixture: combined output, trimmed, cwd = the workspace root", async () => {
    const { dir, cleanup } = tmpDir("skill-inj-");
    try {
      const out = await runSkillInjectionCommand("echo hello", { cwd: dir });
      expect(out).toBe("hello");
    } finally {
      cleanup();
    }
  });
  it("CLAUDE_SKILL_DIR / CLAUDE_PROJECT_DIR ride the child env (scripts can read them)", async () => {
    const { dir, cleanup } = tmpDir("skill-inj-");
    try {
      const out = await runSkillInjectionCommand(
        "echo $CLAUDE_SKILL_DIR :: $CLAUDE_PROJECT_DIR",
        { cwd: dir, env: { CLAUDE_SKILL_DIR: "/sk/dir", CLAUDE_PROJECT_DIR: "/proj" } },
      );
      expect(out).toBe("/sk/dir :: /proj");
    } finally {
      cleanup();
    }
  });
  it("a non-zero exit inlines the output WITH the exit label (failure is data, not a crash)", async () => {
    const { dir, cleanup } = tmpDir("skill-inj-");
    try {
      const out = await runSkillInjectionCommand("echo oops; exit 3", { cwd: dir });
      expect(out).toBe("oops\n[exit 3]");
    } finally {
      cleanup();
    }
  });
  it("stderr is labeled and kept alongside stdout", async () => {
    const { dir, cleanup } = tmpDir("skill-inj-");
    try {
      const out = await runSkillInjectionCommand("echo out; echo err 1>&2", { cwd: dir });
      expect(out).toBe("out\n[stderr] err");
    } finally {
      cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// createSkillInjectionExec — the trust tiers (personal/user-scope free,
// plugin/project-tier behind the NORMAL permission pipeline)
// ---------------------------------------------------------------------------

describe("createSkillInjectionExec: trust tiers", () => {
  const ran: string[] = [];
  const execCalls = (cmds: string[]): (cmd: string) => Promise<string> => {
    return async (cmd: string) => {
      cmds.push(cmd);
      return "OUT";
    };
  };

  it("origin personal → no approval (decide never consulted)", async () => {
    const decisions: unknown[] = [];
    const exec = createSkillInjectionExec({
      origin: "personal",
      workspaceRoot: "/ws",
      decide: async (toolName, input) => {
        decisions.push([toolName, input]);
        return { behavior: "allow" };
      },
      run: execCalls(ran),
    });
    expect(await exec("echo free")).toBe("OUT");
    expect(decisions).toEqual([]);
  });

  it("origin plugin + USER scope → no approval (the install was the trust decision)", async () => {
    const decisions: unknown[] = [];
    const exec = createSkillInjectionExec({
      origin: "plugin",
      pluginScope: "user",
      workspaceRoot: "/ws",
      decide: async () => {
        decisions.push(1);
        return { behavior: "allow" };
      },
      run: execCalls(ran),
    });
    expect(await exec("echo user-scope")).toBe("OUT");
    expect(decisions).toEqual([]);
  });

  it("origin plugin + FLAG mount → no approval (explicit --plugin choice)", async () => {
    const decisions: unknown[] = [];
    const exec = createSkillInjectionExec({
      origin: "plugin",
      pluginScope: "flag",
      workspaceRoot: "/ws",
      decide: async () => {
        decisions.push(1);
        return { behavior: "allow" };
      },
      run: execCalls(ran),
    });
    expect(await exec("echo flag")).toBe("OUT");
    expect(decisions).toEqual([]);
  });

  it("origin plugin + PROJECT scope → first execution goes through the shell pipeline", async () => {
    const seen: { toolName: string; input: Record<string, unknown> }[] = [];
    const cmds: string[] = [];
    const exec = createSkillInjectionExec({
      origin: "plugin",
      pluginScope: "project",
      workspaceRoot: "/ws",
      decide: async (toolName, input) => {
        seen.push({ toolName, input });
        return { behavior: "allow" };
      },
      run: execCalls(cmds),
    });
    expect(await exec("echo gated")).toBe("OUT");
    expect(seen).toEqual([{ toolName: "shell", input: { command: "echo gated" } }]);
    expect(cmds).toEqual(["echo gated"]);
  });

  it("origin project (and missing origin) → the pipeline too (the conservative tier)", async () => {
    for (const origin of ["project", undefined] as const) {
      let asked = 0;
      const cmds: string[] = [];
      const exec = createSkillInjectionExec({
        ...(origin !== undefined ? { origin } : {}),
        workspaceRoot: "/ws",
        decide: async () => {
          asked += 1;
          return { behavior: "allow" };
        },
        run: execCalls(cmds),
      });
      expect(await exec("echo x")).toBe("OUT");
      expect(asked).toBe(1);
    }
  });

  it("a DENY decision throws and the command never runs", async () => {
    const cmds: string[] = [];
    const exec = createSkillInjectionExec({
      origin: "plugin",
      pluginScope: "project",
      workspaceRoot: "/ws",
      decide: async () => ({ behavior: "deny", reason: "user said no" }),
      run: execCalls(cmds),
    });
    await expect(exec("rm -rf /")).rejects.toThrow(/user said no/);
    expect(cmds).toEqual([]);
  });

  it("session remembering is the PIPELINE's job — every command is decided (no internal caching)", async () => {
    let asked = 0;
    const cmds: string[] = [];
    const exec = createSkillInjectionExec({
      origin: "plugin",
      pluginScope: "project",
      workspaceRoot: "/ws",
      decide: async () => {
        asked += 1;
        return { behavior: "allow" };
      },
      run: execCalls(cmds),
    });
    await exec("echo a");
    await exec("echo b");
    expect(asked).toBe(2);
    expect(cmds).toEqual(["echo a", "echo b"]);
  });
});

// ---------------------------------------------------------------------------
// The skills.ts envelope builders over the expander
// ---------------------------------------------------------------------------

describe("buildSubstitutedSkillMessage / buildExpandedSkillMessage", () => {
  it("substituted-only: envelope shape preserved, args substituted, !`cmd` stays LITERAL", () => {
    const s = skill({
      content: "---\nname: demo\ndescription: d\n---\n\nUse $ARGUMENTS here.\nRun !`echo x` later.",
      argumentsDecl: ["topic"],
    });
    const out = buildSubstitutedSkillMessage(s, "chairs", { sessionId: "s1", workspaceRoot: "/ws" });
    expect(out).toBe(
      '<skill name="demo" args="chairs">\n---\nname: demo\ndescription: d\n---\n\nUse chairs here.\nRun !`echo x` later.\n</skill>',
    );
  });
  it("skillBodyNeedsInjection detects the syntax", () => {
    expect(skillBodyNeedsInjection(skill({ content: "a !`echo x`" }))).toBe(true);
    expect(skillBodyNeedsInjection(skill({ content: "```!\necho\n```" }))).toBe(true);
    expect(skillBodyNeedsInjection(skill({ content: "plain" }))).toBe(false);
  });
  it("expanded: a personal-tier skill's injection executes with NO decide (echo fixture)", async () => {
    const s = skill({
      origin: "personal",
      content: "Hello !`echo world`",
    });
    const out = await buildExpandedSkillMessage(s, "", {
      workspaceRoot: process.cwd(),
      decide: async () => {
        throw new Error("decide must not be consulted for personal skills");
      },
    });
    expect(out).toBe('<skill name="demo" args="">\nHello world\n</skill>');
  });
  it("expanded: a plugin-tier skill's injection goes through the decide seam", async () => {
    const s = skill({
      origin: "plugin",
      pluginScope: "project",
      content: "X !`echo gated`",
    });
    const seen: string[] = [];
    const out = await buildExpandedSkillMessage(s, "", {
      workspaceRoot: process.cwd(),
      decide: async (toolName, input) => {
        seen.push(`${toolName}:${String(input["command"])}`);
        return { behavior: "allow" };
      },
    });
    expect(seen).toEqual(["shell:echo gated"]);
    expect(out).toContain("X gated");
  });
  it("expanded: a DENIED injection rejects (the invocation fails loud, like CC)", async () => {
    const s = skill({
      origin: "plugin",
      pluginScope: "project",
      content: "!`echo nope`",
    });
    await expect(
      buildExpandedSkillMessage(s, "", {
        workspaceRoot: process.cwd(),
        decide: async () => ({ behavior: "deny", reason: "nope" }),
      }),
    ).rejects.toThrow(/nope/);
  });
  it("expanded: disabled → placeholder, nothing executes", async () => {
    const s = skill({ origin: "personal", content: "!`echo secret`" });
    const out = await buildExpandedSkillMessage(s, "", {
      workspaceRoot: process.cwd(),
      disabled: true,
    });
    expect(out).toContain("[skill shell execution disabled: echo secret]");
  });
  it("expanded: no injection syntax → identical to the substituted envelope (fast path parity)", async () => {
    const s = skill({ origin: "plugin", content: "Just $ARGUMENTS text" });
    const sync = buildSubstitutedSkillMessage(s, "zz", { sessionId: "s", workspaceRoot: "/ws" });
    const asyncOut = await buildExpandedSkillMessage(s, "zz", {
      sessionId: "s",
      workspaceRoot: "/ws",
      decide: async () => {
        throw new Error("no decide expected");
      },
    });
    expect(asyncOut).toBe(sync);
  });
  it("prunedFromContext note preserved on both builders", async () => {
    const s = skill({ content: "b" });
    const sync = buildSubstitutedSkillMessage(s, "", { prunedFromContext: true });
    expect(sync).toContain("[system note: this skill's earlier read was pruned");
    const asyncOut = await buildExpandedSkillMessage(s, "", { prunedFromContext: true });
    expect(asyncOut).toContain("[system note: this skill's earlier read was pruned");
  });
});
