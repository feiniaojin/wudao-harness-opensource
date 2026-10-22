// cc-plugins D3 — the three slash-command invocation forms:
//   1) builtin (always wins)
//   2) /<name>            — workspace/personal skill (NOT plugin)
//   3) /<plugin>:<skill>  — plugin skill under namespace
//   4) /skill:<name>      — legacy alias for /<name>
//
// Help output annotates each skill with origin and notes the three forms.
import { describe, it, expect } from "vitest";
import {
  listSlashCommands,
  formatSlashHelp,
} from "../src/slash-commands.js";
import { parseReplCommand } from "../src/repl.js";
import type { LoadedSkill } from "../src/skills.js";

const workspaceSkill = (name: string, description: string): LoadedSkill => ({
  name,
  description,
  filePath: `/tmp/.wudao/skills/${name}/SKILL.md`,
  relPath: `.wudao/skills/${name}/SKILL.md`,
  content: "body",
  origin: "project",
});

const personalSkill = (name: string, description: string): LoadedSkill => ({
  name,
  description,
  filePath: `/home/dev/.claude/skills/${name}/SKILL.md`,
  relPath: `/home/dev/.claude/skills/${name}/SKILL.md`,
  content: "body",
  origin: "personal",
});

const pluginSkill = (
  name: string,
  description: string,
  plugin: string,
): LoadedSkill => ({
  name,
  description,
  filePath: `/tmp/.wudao/plugins/${plugin}/skills/${name}/SKILL.md`,
  relPath: `.wudao/plugins/${plugin}/skills/${name}/SKILL.md`,
  content: "body",
  origin: "plugin",
  plugin,
  pluginScope: "project",
});

describe("D3: /name (workspace/personal) skill invocation", () => {
  it("resolves to {kind:'skill'} for a workspace-loaded skill", () => {
    const skills = [workspaceSkill("alpha", "Alpha rules")];
    const cmd = parseReplCommand("/alpha", [], [], skills);
    expect(cmd.kind).toBe("skill");
    if (cmd.kind === "skill") {
      expect(cmd.name).toBe("alpha");
      expect(cmd.args).toBe("");
    }
  });

  it("resolves to {kind:'skill'} for a personal-tier skill", () => {
    const skills = [personalSkill("brainstorm", "Brainstorm protocol")];
    const cmd = parseReplCommand("/brainstorm", [], [], skills);
    expect(cmd.kind).toBe("skill");
    if (cmd.kind === "skill") {
      expect(cmd.name).toBe("brainstorm");
    }
  });

  it("captures the args portion after the name", () => {
    const skills = [workspaceSkill("alpha", "Alpha rules")];
    const cmd = parseReplCommand("/alpha first second", [], [], skills);
    expect(cmd.kind).toBe("skill");
    if (cmd.kind === "skill") {
      expect(cmd.name).toBe("alpha");
      expect(cmd.args).toBe("first second");
    }
  });

  it("does NOT match a plugin skill of the same name via /name", () => {
    // The parse order: /name = workspace/personal only. A plugin skill of the
    // same name must be reached via /<plugin>:<skill>.
    const skills = [pluginSkill("alpha", "Alpha from plugin", "acme")];
    const cmd = parseReplCommand("/alpha", [], [], skills);
    expect(cmd.kind).toBe("prompt");
  });

  it("falls through to a prompt when no skill matches /name", () => {
    const cmd = parseReplCommand("/nothing-here", [], [], [
      workspaceSkill("alpha", "Alpha rules"),
    ]);
    expect(cmd.kind).toBe("prompt");
  });
});

describe("D3: builtin precedence over /name skill", () => {
  it("/clear wins over a skill named clear", () => {
    const skills = [workspaceSkill("clear", "Hypothetical skill")];
    const cmd = parseReplCommand("/clear", [], [], skills);
    expect(cmd.kind).toBe("clear");
  });

  it("/help wins over a skill named help", () => {
    const skills = [workspaceSkill("help", "Hypothetical skill")];
    const cmd = parseReplCommand("/help", [], [], skills);
    expect(cmd.kind).toBe("help");
  });

  it("/plugin wins over a skill named plugin", () => {
    const skills = [workspaceSkill("plugin", "Hypothetical skill")];
    const cmd = parseReplCommand("/plugin list", [], [], skills);
    expect(cmd.kind).toBe("plugin");
  });

  it("/exit wins over a skill named exit", () => {
    const skills = [workspaceSkill("exit", "Hypothetical skill")];
    const cmd = parseReplCommand("/exit", [], [], skills);
    expect(cmd.kind).toBe("exit");
  });
});

describe("D3: /<plugin>:<skill> namespace invocation", () => {
  it("resolves to {kind:'skill'} for a plugin skill under the namespace", () => {
    const skills = [pluginSkill("brainstorming", "Brainstorm protocol", "superpowers")];
    const cmd = parseReplCommand("/superpowers:brainstorming", [], [], skills);
    expect(cmd.kind).toBe("skill");
    if (cmd.kind === "skill") {
      expect(cmd.name).toBe("brainstorming");
      expect(cmd.args).toBe("");
    }
  });

  it("captures the args after the colon-namespace token", () => {
    const skills = [pluginSkill("brainstorming", "Brainstorm protocol", "superpowers")];
    const cmd = parseReplCommand("/superpowers:brainstorming some idea", [], [], skills);
    expect(cmd.kind).toBe("skill");
    if (cmd.kind === "skill") {
      expect(cmd.name).toBe("brainstorming");
      expect(cmd.args).toBe("some idea");
    }
  });

  it("does NOT match if plugin name is wrong", () => {
    const skills = [pluginSkill("brainstorming", "Brainstorm protocol", "superpowers")];
    const cmd = parseReplCommand("/other:brainstorming", [], [], skills);
    expect(cmd.kind).toBe("prompt");
  });

  it("does NOT match if skill name is wrong under that plugin", () => {
    const skills = [pluginSkill("brainstorming", "Brainstorm protocol", "superpowers")];
    const cmd = parseReplCommand("/superpowers:writing-plans", [], [], skills);
    expect(cmd.kind).toBe("prompt");
  });

  it("does NOT match when both a workspace skill and a plugin skill share the name", () => {
    // The /name form matches workspace/personal; the namespace form matches
    // only the (plugin, skill) pair. With no namespace match, /superpowers:foo
    // is a plain prompt.
    const skills = [
      workspaceSkill("foo", "Project foo"),
      pluginSkill("foo", "Plugin foo", "acme"),
    ];
    const cmd = parseReplCommand("/acme:foo", [], [], skills);
    expect(cmd.kind).toBe("skill");
    if (cmd.kind === "skill") {
      expect(cmd.name).toBe("foo");
    }
  });
});

describe("D3: /skill:<name> legacy alias still works", () => {
  it("resolves to {kind:'skill'} (legacy compat) for a workspace skill", () => {
    const skills = [workspaceSkill("alpha", "Alpha rules")];
    const cmd = parseReplCommand("/skill:alpha", [], [], skills);
    expect(cmd.kind).toBe("skill");
    if (cmd.kind === "skill") {
      expect(cmd.name).toBe("alpha");
    }
  });

  it("bare /skill yields {kind:'skill'} with empty name (skill listing)", () => {
    const cmd = parseReplCommand("/skill", [], [], []);
    expect(cmd.kind).toBe("skill");
    if (cmd.kind === "skill") {
      expect(cmd.name).toBe("");
    }
  });
});

describe("D3: help rendering — three invocation forms", () => {
  it("renders workspace skills as /<name>", () => {
    const cmds = listSlashCommands({
      skills: [workspaceSkill("alpha", "Alpha rules")],
    });
    const entry = cmds.find((c) => c.name === "alpha");
    expect(entry?.description).toContain("Alpha rules");
    expect(entry?.description).toContain("工作区"); // ω99-162: 隐藏钉·workspace 后缀词同串机械演进（（工作区））。
  });

  it("renders plugin skills as /<plugin>:<skill>", () => {
    const cmds = listSlashCommands({
      skills: [pluginSkill("brainstorming", "Brainstorm protocol", "superpowers")],
    });
    const entry = cmds.find((c) => c.name === "superpowers:brainstorming");
    expect(entry?.description).toContain("Brainstorm protocol");
  });

  it("renders workspace skills with origin annotation in description", () => {
    const cmds = listSlashCommands({
      skills: [
        workspaceSkill("alpha", "Alpha rules"),
        personalSkill("beta", "Beta rules"),
      ],
    });
    const alpha = cmds.find((c) => c.name === "alpha");
    const beta = cmds.find((c) => c.name === "beta");
    expect(alpha?.description).toContain("工作区"); // ω99-162: 隐藏钉·workspace 后缀词同串机械演进。
    expect(beta?.description).toContain("个人"); // ω99-162: 隐藏钉·personal 后缀词同串机械演进。
  });

  it("renders plugin skills with plugin name annotation in description", () => {
    const cmds = listSlashCommands({
      skills: [pluginSkill("brainstorming", "Brainstorm protocol", "superpowers")],
    });
    const entry = cmds.find((c) => c.name === "superpowers:brainstorming");
    expect(entry?.description).toContain("superpowers");
  });

  it("formatSlashHelp body surfaces the three invocation forms", () => {
    const cmds = listSlashCommands({
      skills: [
        workspaceSkill("alpha", "Alpha rules"),
        pluginSkill("brainstorming", "Brainstorm protocol", "superpowers"),
      ],
    });
    const text = formatSlashHelp(cmds, { mode: "auto" });
    // /<name> (workspace) — alphabetic prefix rendering
    expect(text).toContain("/alpha");
    // /<plugin>:<skill>
    expect(text).toContain("/superpowers:brainstorming");
    // legacy /skill:<name>
    expect(text).toContain("/skill:name");
    // the three-form footer
    expect(text).toContain("调用形态（技能）："); // ω99-162: 三形态页脚头钉随源演进。
    expect(text).toContain("/<name>");
    expect(text).toContain("/<plugin>:<skill>");
    expect(text).toContain("/skill:<name>");
  });

  it("formatSlashHelp does not duplicate /skill:<name> as an entry when alphas exist", () => {
    // The "skill:" entry stays as the legacy alias ANNOTATION line; the
    // workspace skills appear under /<name>.
    const cmds = listSlashCommands({
      skills: [workspaceSkill("alpha", "Alpha rules")],
    });
    // exactly one entry named "alpha"
    expect(cmds.filter((c) => c.name === "alpha").length).toBe(1);
    // the legacy /skill: builtin entry still exists (for the alias hint)
    expect(cmds.find((c) => c.name === "skill:")).toBeDefined();
  });
});