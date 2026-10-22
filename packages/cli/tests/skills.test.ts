// M27 Skills — loader, frontmatter parsing, prompt tail manifest, and
// /skill:name expansion message. Byte-exact pins: the <available_skills> block
// format and the <skill> invocation envelope are part of the model-visible
// contract (changing them silently changes model behavior).
import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseSkillFrontmatter,
  loadSkills,
  skillsPromptSection,
  buildSkillInvocationMessage,
  findSkill,
  formatSkillError,
  type LoadedSkill,
} from "../src/skills.js";
import { buildSystemPrompt } from "../src/prompt.js";

function tmpWs(): { ws: string; cleanup: () => void } {
  const ws = mkdtempSync(join(tmpdir(), "skills-"));
  return { ws, cleanup: () => rmSync(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) };
}

/** Write <ws>/<root...>/<name>/SKILL.md with the given file text. */
function writeSkill(ws: string, root: string, name: string, text: string): string {
  const dir = join(ws, root, "skills", name);
  mkdirSync(dir, { recursive: true });
  const filePath = join(dir, "SKILL.md");
  writeFileSync(filePath, text, "utf8");
  return filePath;
}

function skillMd(name: string, description: string, body = "Do the thing."): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\n${body}\n`;
}

// ---------------------------------------------------------------------------
// Frontmatter (hand-parsed line format — no yaml dependency)
// ---------------------------------------------------------------------------

describe("parseSkillFrontmatter", () => {
  it("parses name and description from a well-formed block", () => {
    expect(parseSkillFrontmatter("---\nname: alpha\ndescription: Alpha style\n---\nbody")).toEqual({
      name: "alpha",
      description: "Alpha style",
    });
  });

  it("missing name → undefined (caller skips with a warning)", () => {
    expect(parseSkillFrontmatter("---\ndescription: no name\n---\nbody")).toEqual({ description: "no name" });
  });

  it("missing description → empty string (skill still loads)", () => {
    expect(parseSkillFrontmatter("---\nname: bare\n---\nbody")).toEqual({ name: "bare", description: "" });
  });

  it("no frontmatter fence → no name", () => {
    expect(parseSkillFrontmatter("# just a doc\nname: not-frontmatter\n")).toEqual({ description: "" });
    // The fence must lead the file (trailing whitespace/CRLF tolerated).
    expect(parseSkillFrontmatter("\n---\nname: buried\n---\n")).toEqual({ description: "" });
    expect(parseSkillFrontmatter("--- \r\nname: crlf\r\n---\r\nbody")).toEqual({ name: "crlf", description: "" });
  });

  it("bad lines are ignored (tolerant): unknown keys, no-colon lines, comments", () => {
    const fm = parseSkillFrontmatter(
      "---\n# a comment line\nunknown-key: value\nname: keepme\nthis line has no colon\ndescription: kept too\n---\nbody name: not-parsed",
    );
    expect(fm).toEqual({ name: "keepme", description: "kept too" });
  });

  it("unterminated frontmatter scans to EOF (only the --- fence closes)", () => {
    expect(parseSkillFrontmatter("---\nname: runaway\ndescription: d")).toEqual({ name: "runaway", description: "d" });
  });

  it("strips one matching pair of surrounding quotes from values", () => {
    expect(parseSkillFrontmatter('---\nname: "quoted"\ndescription: \'single\'\n---\nx')).toEqual({
      name: "quoted",
      description: "single",
    });
  });

  it("empty name: value counts as missing", () => {
    expect(parseSkillFrontmatter("---\nname:\ndescription: d\n---\nx")).toEqual({ description: "d" });
  });
});

// ---------------------------------------------------------------------------
// Discovery: two roots, first-wins on duplicate names
// ---------------------------------------------------------------------------

describe("loadSkills", () => {
  it("missing roots → no skills, silent", () => {
    const { ws, cleanup } = tmpWs();
    const warnings: string[] = [];
    try {
      expect(loadSkills(ws, (m) => warnings.push(m))).toEqual([]);
      expect(warnings).toEqual([]);
    } finally {
      cleanup();
    }
  });

  it("loads from .agents/skills and .wudao/skills (agents first, alphabetical within a root)", () => {
    const { ws, cleanup } = tmpWs();
    try {
      const wudaoA = writeSkill(ws, ".wudao", "zeta", skillMd("zeta", "Zeta skill"));
      const agentsB = writeSkill(ws, ".agents", "beta", skillMd("beta", "Beta skill"));
      const agentsA = writeSkill(ws, ".agents", "alpha", skillMd("alpha", "Alpha skill"));
      const skills = loadSkills(ws);
      expect(skills.map((s) => s.name)).toEqual(["alpha", "beta", "zeta"]);
      const alpha = skills[0];
      expect(alpha?.filePath).toBe(agentsA);
      expect(skills[1]?.filePath).toBe(agentsB);
      expect(skills[2]?.filePath).toBe(wudaoA);
      // relPath is the posix form relative to the workspace root — the exact
      // string that lands in the prompt manifest and that the model reads.
      expect(alpha?.relPath).toBe(".agents/skills/alpha/SKILL.md");
      // content is the FULL file text (frontmatter included) — identical to
      // what read_file returns for the same path.
      expect(alpha?.content).toBe(skillMd("alpha", "Alpha skill"));
    } finally {
      cleanup();
    }
  });

  it("duplicate name across roots → first (.agents) wins with a diagnostic warning", () => {
    const { ws, cleanup } = tmpWs();
    try {
      const winner = writeSkill(ws, ".agents", "dup", skillMd("dup", "agents copy"));
      const loser = writeSkill(ws, ".wudao", "other-dir", skillMd("dup", "wudao copy"));
      const warnings: string[] = [];
      const skills = loadSkills(ws, (m) => warnings.push(m));
      expect(skills.length).toBe(1);
      expect(skills[0]?.filePath).toBe(winner);
      expect(warnings.length).toBe(1);
      expect(warnings[0]).toContain("dup");
      expect(warnings[0]).toContain(winner);
      expect(warnings[0]).toContain(loser);
    } finally {
      cleanup();
    }
  });

  it("missing name → skipped with a warning; empty description still loads", () => {
    const { ws, cleanup } = tmpWs();
    try {
      writeSkill(ws, ".wudao", "nameless", "---\ndescription: but no name\n---\nbody");
      writeSkill(ws, ".wudao", "bare", "---\nname: bare\n---\nbody");
      const warnings: string[] = [];
      const skills = loadSkills(ws, (m) => warnings.push(m));
      expect(skills.map((s) => s.name)).toEqual(["bare"]);
      expect(skills[0]?.description).toBe("");
      expect(warnings.length).toBe(1);
      expect(warnings[0]).toContain("name");
    } finally {
      cleanup();
    }
  });

  it("a skills dir without SKILL.md is skipped silently; files at the root are ignored", () => {
    const { ws, cleanup } = tmpWs();
    try {
      mkdirSync(join(ws, ".wudao", "skills", "resources-only"), { recursive: true });
      writeFileSync(join(ws, ".wudao", "skills", "loose.md"), skillMd("loose", "not a skill dir"), "utf8");
      const warnings: string[] = [];
      expect(loadSkills(ws, (m) => warnings.push(m))).toEqual([]);
      expect(warnings).toEqual([]);
    } finally {
      cleanup();
    }
  });

  it("follows symlinked skill directories (README's install method)", () => {
    const { ws, cleanup } = tmpWs();
    try {
      // The real skill lives OUTSIDE the workspace (e.g. the repo's bundled
      // skills/ dir); a symlink inside .wudao/skills points at it.
      const outside = mkdtempSync(join(tmpdir(), "skills-outside-"));
      mkdirSync(join(ws, ".wudao", "skills"), { recursive: true });
      writeFileSync(join(outside, "SKILL.md"), skillMd("linked", "via symlink"), "utf8");
      symlinkSync(outside, join(ws, ".wudao", "skills", "linked"));
      const skills = loadSkills(ws);
      expect(skills.map((s) => s.name)).toEqual(["linked"]);
      expect(skills[0]?.relPath).toBe(".wudao/skills/linked/SKILL.md");
      rmSync(outside, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } finally {
      cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Prompt tail manifest — byte-exact
// ---------------------------------------------------------------------------

describe("skillsPromptSection", () => {
  const alpha: LoadedSkill = {
    name: "alpha",
    description: "Alpha does things",
    filePath: "/ws/.agents/skills/alpha/SKILL.md",
    relPath: ".agents/skills/alpha/SKILL.md",
    content: "irrelevant here",
  };
  const beta: LoadedSkill = {
    name: "beta",
    description: "Beta does other things",
    filePath: "/ws/.wudao/skills/beta/SKILL.md",
    relPath: ".wudao/skills/beta/SKILL.md",
    content: "irrelevant here",
  };

  it("no skills → empty string (zero prompt change)", () => {
    expect(skillsPromptSection([])).toBe("");
  });

  it("one skill per line in discovery order — byte-exact block", () => {
    expect(skillsPromptSection([alpha, beta])).toBe(
      "\n\n<available_skills>\n" +
        "Use read_file to load a skill's full instructions when a task matches.\n" +
        "- name: alpha — Alpha does things (path: .agents/skills/alpha/SKILL.md)\n" +
        "- name: beta — Beta does other things (path: .wudao/skills/beta/SKILL.md)\n" +
        "</available_skills>",
    );
  });

  it("empty description → dash omitted (no dangling separator)", () => {
    expect(skillsPromptSection([{ ...alpha, description: "" }])).toBe(
      "\n\n<available_skills>\n" +
        "Use read_file to load a skill's full instructions when a task matches.\n" +
        "- name: alpha (path: .agents/skills/alpha/SKILL.md)\n" +
        "</available_skills>",
    );
  });
});

// ---------------------------------------------------------------------------
// /skill:name expansion + lookup errors
// ---------------------------------------------------------------------------

describe("buildSkillInvocationMessage", () => {
  const skill: LoadedSkill = {
    name: "commit-msg",
    description: "d",
    filePath: "/ws/.wudao/skills/commit-msg/SKILL.md",
    relPath: ".wudao/skills/commit-msg/SKILL.md",
    content: "---\nname: commit-msg\n---\n\n# rules\n",
  };

  it("wraps the FULL file text with name and args", () => {
    expect(buildSkillInvocationMessage(skill, "fix the login bug")).toBe(
      `<skill name="commit-msg" args="fix the login bug">\n${skill.content}\n</skill>`,
    );
  });

  it("empty args keep the attribute (args=\"\")", () => {
    expect(buildSkillInvocationMessage(skill, "")).toBe(`<skill name="commit-msg" args="">\n${skill.content}\n</skill>`);
  });
});

describe("findSkill / formatSkillError", () => {
  const a: LoadedSkill = { name: "a", description: "A skill", filePath: "/a", relPath: ".agents/skills/a/SKILL.md", content: "" };
  const b: LoadedSkill = { name: "b", description: "", filePath: "/b", relPath: ".wudao/skills/b/SKILL.md", content: "" };

  it("findSkill matches by exact name", () => {
    expect(findSkill([a, b], "b")).toBe(b);
    expect(findSkill([a, b], "nope")).toBeUndefined();
    expect(findSkill([a, b], "A")).toBeUndefined(); // exact, case-sensitive
  });

  it("formatSkillError lists every loaded skill with its path", () => {
    expect(formatSkillError("nope", [a, b])).toBe(
      '⚠️ no skill named "nope". Available skills:\n' +
        "  - a — A skill (path: .agents/skills/a/SKILL.md)\n" +
        "  - b (path: .wudao/skills/b/SKILL.md)",
    );
  });

  it("formatSkillError with no skills loaded points at the discovery dirs", () => {
    expect(formatSkillError("nope", [])).toContain("no skills loaded");
    expect(formatSkillError("nope", [])).toContain(".wudao/skills");
  });
});

// ---------------------------------------------------------------------------
// M48 §3 — ghost-skill markers: the skill-read classifier feeding the loop's
// compaction seam, the pruned-marker detector, and the /skill: reload hint.
// ---------------------------------------------------------------------------

import { formatSkillPrunedMarker } from "@wudao/core";
import type { AgentMessage } from "@wudao/core";
import { createSkillReadClassifier, isSkillPruned } from "../src/skills.js";

describe("createSkillReadClassifier (M48 §3)", () => {
  const skill: LoadedSkill = {
    name: "commit-flow",
    description: "d",
    filePath: "/ws/.wudao/skills/commit-flow/SKILL.md",
    relPath: ".wudao/skills/commit-flow/SKILL.md",
    content: "---\nname: commit-flow\n---\n",
  };
  const classify = createSkillReadClassifier([skill]);

  it("matches read_file on the manifest relPath", () => {
    expect(classify("read_file", { path: ".wudao/skills/commit-flow/SKILL.md" }))
      .toEqual({ name: "commit-flow", path: ".wudao/skills/commit-flow/SKILL.md" });
  });

  it("matches the absolute path and ./-prefixed variants", () => {
    expect(classify("read_file", { path: "/ws/.wudao/skills/commit-flow/SKILL.md" })).toBeDefined();
    expect(classify("read_file", { path: "./.wudao/skills/commit-flow/SKILL.md" })).toBeDefined();
  });

  it("ignores other tools, other files, and junk args", () => {
    expect(classify("edit", { path: ".wudao/skills/commit-flow/SKILL.md" })).toBeUndefined();
    expect(classify("read_file", { path: "src/main.ts" })).toBeUndefined();
    expect(classify("read_file", {})).toBeUndefined();
    expect(classify("read_file", { path: 42 })).toBeUndefined();
  });

  it("an empty skill list classifies nothing", () => {
    const none = createSkillReadClassifier([]);
    expect(none("read_file", { path: ".wudao/skills/commit-flow/SKILL.md" })).toBeUndefined();
  });
});

describe("isSkillPruned (M48 §3)", () => {
  const messages: AgentMessage[] = [
    { role: "user", content: "go" },
    { role: "tool", toolCallId: "c1", name: "read_file", content: formatSkillPrunedMarker("commit-flow", ".wudao/skills/commit-flow/SKILL.md") },
    { role: "user", content: formatSkillPrunedMarker("other-skill", ".wudao/skills/other-skill/SKILL.md") },
  ];

  it("detects the marker for the named skill in any message", () => {
    expect(isSkillPruned(messages, "commit-flow")).toBe(true);
    expect(isSkillPruned(messages, "other-skill")).toBe(true);
    expect(isSkillPruned(messages, "unrelated")).toBe(false);
  });

  it("an ordinary transcript is never pruned", () => {
    const clean: AgentMessage[] = [{ role: "user", content: "hello" }, { role: "assistant", content: "hi" }];
    expect(isSkillPruned(clean, "commit-flow")).toBe(false);
  });
});

describe("buildSkillInvocationMessage — pruned hint (M48 §3)", () => {
  const skill: LoadedSkill = {
    name: "commit-flow",
    description: "d",
    filePath: "/ws/.wudao/skills/commit-flow/SKILL.md",
    relPath: ".wudao/skills/commit-flow/SKILL.md",
    content: "---\nname: commit-flow\n---\n",
  };

  it("appends the reload hint only when prunedFromContext is set", () => {
    const base = `<skill name="commit-flow" args="">\n${skill.content}\n</skill>`;
    expect(buildSkillInvocationMessage(skill, "")).toBe(base);
    const hinted = buildSkillInvocationMessage(skill, "", { prunedFromContext: true });
    expect(hinted.startsWith(base)).toBe(true);
    expect(hinted).toContain("pruned by context compaction");
    expect(hinted).toContain(`read_file ${skill.relPath}`);
  });
});

// ---------------------------------------------------------------------------
// Prompt assembly — the tail is purely additive and ALWAYS last
// ---------------------------------------------------------------------------

describe("buildSystemPrompt — skills trailing section (M27)", () => {
  const alpha: LoadedSkill = {
    name: "alpha",
    description: "Alpha does things",
    filePath: "/ws/.agents/skills/alpha/SKILL.md",
    relPath: ".agents/skills/alpha/SKILL.md",
    content: "x",
  };

  it("no skills → byte-identical to the pre-M27 prompt (pinned)", () => {
    expect(buildSystemPrompt("/tmp/ws", false, [])).toBe(buildSystemPrompt("/tmp/ws"));
    expect(buildSystemPrompt("/tmp/ws", true, [])).toBe(buildSystemPrompt("/tmp/ws", true));
  });

  it("skills section is appended at the ABSOLUTE end — after Environment and after MCP", () => {
    const base = buildSystemPrompt("/tmp/ws");
    const withSkills = buildSystemPrompt("/tmp/ws", false, [alpha]);
    // Purely additive: the whole base prompt is an exact byte prefix.
    expect(withSkills.startsWith(base)).toBe(true);
    expect(withSkills.slice(base.length)).toBe(skillsPromptSection([alpha]));
    // Absolute end: after the Environment section, and after the MCP section.
    const withBoth = buildSystemPrompt("/tmp/ws", true, [alpha]);
    expect(withBoth.indexOf("# Environment")).toBeLessThan(withBoth.indexOf("<available_skills>"));
    expect(withBoth.indexOf("# MCP tools")).toBeLessThan(withBoth.indexOf("<available_skills>"));
    expect(withBoth.endsWith("</available_skills>")).toBe(true);
  });
});

it("discovers skills from the upstream's native .claude/skills location", () => {
  const root = mkdtempSync(join(tmpdir(), "sk-"));
  try {
    mkdirSync(join(root, ".claude", "skills", "cc-skill"), { recursive: true });
    writeFileSync(join(root, ".claude", "skills", "cc-skill", "SKILL.md"), "---\nname: cc-skill\ndescription: from claude dir\n---\nBody", "utf8");
    const skills = loadSkills(root, () => {});
    expect(skills.some((s) => s.name === "cc-skill" && s.description === "from claude dir")).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

// ---------------------------------------------------------------------------
// cc-plugins D1 — the personal tier (~/.claude/skills) + the the upstream formatfrontmatter
// superset. Discovery order is now first-wins across FOUR roots:
//   .agents/skills > .wudao/skills > ~/.claude/skills (personal) > .claude/skills
// (the personal tier overrides the the upstream format-shaped PROJECT root only), then the
// ~/.wudao/skills global tier fills gaps (M57), then plugin skills.
// ---------------------------------------------------------------------------

import {
  loadSkillsUnderDir,
  personalSkillRoot,
  skillVisibleForPath,
  gateSkillsForPath,
} from "../src/skills.js";

/** An isolated personal home. WUDAO_GLOBAL_HOME keeps the production
 *  `<home>/.wudao` shape, so the personal tier derives to `<home>/.claude`
 *  (exactly the ~/.wudao → ~/.claude sibling rule of the real machine). */
function tmpHome(): { home: string; env: NodeJS.ProcessEnv; cleanup: () => void } {
  const home = mkdtempSync(join(tmpdir(), "sk-home-"));
  return {
    home,
    env: { WUDAO_GLOBAL_HOME: join(home, ".wudao") },
    cleanup: () => rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }),
  };
}

/** Write <root>/<name>/SKILL.md (root is the FULL skills dir path). */
function writeSkillDir(root: string, name: string, text: string): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  const filePath = join(dir, "SKILL.md");
  writeFileSync(filePath, text, "utf8");
  return filePath;
}

describe("personalSkillRoot (cc-plugins D1)", () => {
  it("derives from the global home's sibling: <home>/.wudao → <home>/.claude/skills", () => {
    expect(personalSkillRoot({ WUDAO_GLOBAL_HOME: join("/h", "x", ".wudao") })).toBe(join("/h", "x", ".claude", "skills"));
  });

  it("a BARE WUDAO_GLOBAL_HOME sandbox keeps the tier inside it (test isolation)", () => {
    // The vitest setup hook and the m57 tests override with a bare dir — the
    // personal tier must stay INSIDE that sandbox, never the real ~/.claude.
    expect(personalSkillRoot({ WUDAO_GLOBAL_HOME: join("/tmp", "sandbox-g") })).toBe(join("/tmp", "sandbox-g", ".claude", "skills"));
  });
});

describe("personal tier discovery (cc-plugins D1)", () => {
  it("a personal skill loads when no project root claims the name (origin personal, invoke-hint form)", () => {
    const { ws, cleanup: cleanupWs } = tmpWs();
    const { home, env, cleanup: cleanupHome } = tmpHome();
    try {
      const filePath = writeSkillDir(join(home, ".claude", "skills"), "mine", skillMd("mine", "my own skill"));
      const warnings: string[] = [];
      const skills = loadSkills(ws, (m) => warnings.push(m), env);
      expect(skills.map((s) => s.name)).toEqual(["mine"]);
      expect(skills[0]?.origin).toBe("personal");
      expect(skills[0]?.filePath).toBe(filePath);
      // Outside the workspace → the manifest advertises the invocation (M57).
      expect(skillsPromptSection(skills)).toContain("invoke: /skill:mine");
      expect(warnings).toEqual([]);
    } finally {
      cleanupWs();
      cleanupHome();
    }
  });

  it("priority matrix: .agents > .wudao > ~/.claude (personal) > .claude (project)", () => {
    const { ws, cleanup: cleanupWs } = tmpWs();
    const { home, env, cleanup: cleanupHome } = tmpHome();
    try {
      const agents = writeSkillDir(join(ws, ".agents", "skills"), "dup", skillMd("dup", "agents copy"));
      const wudao = writeSkillDir(join(ws, ".wudao", "skills"), "dup", skillMd("dup", "wudao copy"));
      const personal = writeSkillDir(join(home, ".claude", "skills"), "dup", skillMd("dup", "personal copy"));
      const claude = writeSkillDir(join(ws, ".claude", "skills"), "dup", skillMd("dup", "claude copy"));
      const load = (): { skills: readonly LoadedSkill[]; warnings: string[] } => {
        const warnings: string[] = [];
        return { skills: loadSkills(ws, (m) => warnings.push(m), env), warnings };
      };
      // 1. .agents beats everything below it.
      let r = load();
      expect(r.skills.length).toBe(1);
      expect(r.skills[0]?.filePath).toBe(agents);
      expect(r.warnings.length).toBe(3);
      rmSync(join(ws, ".agents", "skills", "dup"), { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      // 2. .wudao beats personal + the project the upstream formatroot.
      r = load();
      expect(r.skills[0]?.filePath).toBe(wudao);
      expect(r.warnings.length).toBe(2);
      rmSync(join(ws, ".wudao", "skills", "dup"), { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      // 3. personal overrides the the upstream format-shaped PROJECT root — the warning names
      //    both copies (first-wins diagnostic, same family as the roots).
      r = load();
      expect(r.skills[0]?.filePath).toBe(personal);
      expect(r.skills[0]?.origin).toBe("personal");
      expect(r.warnings.length).toBe(1);
      expect(r.warnings[0]).toContain(personal);
      expect(r.warnings[0]).toContain(claude);
      rmSync(join(home, ".claude", "skills", "dup"), { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      // 4. the project .claude root is last — and it IS project-origin.
      r = load();
      expect(r.skills[0]?.filePath).toBe(claude);
      expect(r.skills[0]?.origin).toBe("project");
      expect(r.warnings).toEqual([]);
    } finally {
      cleanupWs();
      cleanupHome();
    }
  });

  it("distinct names across the personal and project tiers coexist, each with its origin", () => {
    const { ws, cleanup: cleanupWs } = tmpWs();
    const { home, env, cleanup: cleanupHome } = tmpHome();
    try {
      writeSkillDir(join(home, ".claude", "skills"), "mine", skillMd("mine", "personal"));
      writeSkillDir(join(ws, ".wudao", "skills"), "ours", skillMd("ours", "project"));
      const skills = loadSkills(ws, () => {}, env);
      expect(skills.map((s) => [s.name, s.origin])).toEqual([
        ["ours", "project"],
        ["mine", "personal"],
      ]);
    } finally {
      cleanupWs();
      cleanupHome();
    }
  });

  it("the ~/.wudao global tier keeps its M57 semantics and also carries origin personal", () => {
    const { ws, cleanup: cleanupWs } = tmpWs();
    const { home, env, cleanup: cleanupHome } = tmpHome();
    try {
      writeSkillDir(join(home, ".wudao", "skills"), "g", skillMd("g", "global runbook"));
      const skills = loadSkills(ws, () => {}, env);
      expect(skills.map((s) => [s.name, s.origin])).toEqual([["g", "personal"]]);
    } finally {
      cleanupWs();
      cleanupHome();
    }
  });

  it("loadSkillsUnderDir defaults origin project; a plugin call tags origin plugin", () => {
    const { ws, cleanup } = tmpWs();
    try {
      writeSkill(ws, ".wudao", "p1", skillMd("p1", "d"));
      const root = join(ws, ".wudao", "skills");
      expect(loadSkillsUnderDir(root, ws)[0]?.origin).toBe("project");
      const tagged = loadSkillsUnderDir(root, ws, () => {}, "myplug");
      expect(tagged[0]?.origin).toBe("plugin");
      expect(tagged[0]?.plugin).toBe("myplug");
    } finally {
      cleanup();
    }
  });
});

describe("parseSkillFrontmatter — the upstream format superset (cc-plugins D1)", () => {
  it("argument-hint and when-to-use parse as scalars (both when-spellings share one field)", () => {
    expect(parseSkillFrontmatter("---\nname: a\ndescription: d\nargument-hint: <file> [mode]\nwhen-to-use: prose tasks\n---\nb")).toEqual({
      name: "a",
      description: "d",
      argumentHint: "<file> [mode]",
      whenToUse: "prose tasks",
    });
    expect(parseSkillFrontmatter("---\nname: a\ndescription: d\nwhen_to_use: snake form\n---\nb").whenToUse).toBe("snake form");
  });

  it("user-invocable: only the true/false literals count (junk = absent)", () => {
    expect(parseSkillFrontmatter("---\nname: a\nuser-invocable: false\n---\nb").userInvocable).toBe(false);
    expect(parseSkillFrontmatter("---\nname: a\nuser-invocable: true\n---\nb").userInvocable).toBe(true);
    expect(parseSkillFrontmatter("---\nname: a\nuser-invocable: maybe\n---\nb").userInvocable).toBeUndefined();
  });

  it("agent: carries the roster role name for the context:fork roster pick", () => {
    expect(parseSkillFrontmatter("---\nname: a\nagent: reviewer\n---\nb").agent).toBe("reviewer");
    expect(parseSkillFrontmatter("---\nname: a\nagent:\n---\nb").agent).toBeUndefined();
  });

  it("arguments: inline bracket / comma forms and indented - item blocks", () => {
    expect(parseSkillFrontmatter("---\nname: a\narguments: [topic, tone]\n---\nb").argumentsDecl).toEqual(["topic", "tone"]);
    expect(parseSkillFrontmatter("---\nname: a\narguments: topic, tone\n---\nb").argumentsDecl).toEqual(["topic", "tone"]);
    expect(parseSkillFrontmatter('---\nname: a\narguments:\n  - topic\n  - "two words"\n---\nb').argumentsDecl).toEqual(["topic", "two words"]);
  });

  it("paths / allowed-tools / disallowed-tools: inline lists, JSON-ish arrays, block lists", () => {
    expect(parseSkillFrontmatter("---\nname: a\npaths: docs/**, pkg/src/**\n---\nb").paths).toEqual(["docs/**", "pkg/src/**"]);
    expect(parseSkillFrontmatter('---\nname: a\npaths: ["docs/**", "pkg/src/**"]\n---\nb').paths).toEqual(["docs/**", "pkg/src/**"]);
    expect(parseSkillFrontmatter("---\nname: a\npaths:\n  - docs/**\n  - pkg/src/**\n---\nb").paths).toEqual(["docs/**", "pkg/src/**"]);
    expect(parseSkillFrontmatter("---\nname: a\nallowed-tools: Bash, Read\n---\nb").allowedTools).toEqual(["Bash", "Read"]);
    expect(
      parseSkillFrontmatter("---\nname: a\nallowed-tools:\n  - Bash(git:*)\n  - Read\ndisallowed-tools: Write\n---\nb"),
    ).toMatchObject({ allowedTools: ["Bash(git:*)", "Read"], disallowedTools: ["Write"] });
  });

  it("a literal empty list `paths: []` parses EMPTY ≡ absent (the skill is always listed)", () => {
    expect(parseSkillFrontmatter("---\nname: a\npaths: []\n---\nb").paths).toBeUndefined();
    expect(skillVisibleForPath({ name: "a", description: "", filePath: "/x", relPath: "x", content: "" }, "anything/x.ts")).toBe(true);
  });

  it("block items attach to the immediately preceding LIST key only; stray dashes ignored", () => {
    const fm = parseSkillFrontmatter("---\nname: a\ndescription: has a stray\n  - not-an-argument\narguments:\n  - one\n---\nb");
    expect(fm.description).toBe("has a stray");
    expect(fm.argumentsDecl).toEqual(["one"]);
    expect(parseSkillFrontmatter("---\nname: a\n  - dangling\n---\nb").argumentsDecl).toBeUndefined();
    // A hyphen-led prose word is not a list item (the dash needs its space).
    expect(parseSkillFrontmatter("---\nname: a\narguments:\n  -based prose\n  - real\n---\nb").argumentsDecl).toEqual(["real"]);
  });

  it("unknown fields are ignored silently (no degradation record)", () => {
    expect(parseSkillFrontmatter("---\nname: a\nlicense: MIT\nmetadata-whatever: x\n---\nb")).toEqual({ name: "a", description: "" });
  });

  it("model/effort/shell are recorded deduped (first-seen order) and otherwise ignored", () => {
    expect(parseSkillFrontmatter("---\nname: a\nmodel: sonnet\nmodel: opus\neffort: high\nshell: bash\n---\nb").unsupported).toEqual([
      "model",
      "effort",
      "shell",
    ]);
  });
});

describe("loadSkills — superset fields surface + one degradation warning per skill", () => {
  it("every superset field lands on LoadedSkill; model/effort/shell warn exactly once", () => {
    const { ws, cleanup } = tmpWs();
    try {
      writeSkill(
        ws,
        ".wudao",
        "full",
        [
          "---",
          "name: full",
          "description: full skill",
          "argument-hint: <topic>",
          "when-to-use: writing tasks",
          "user-invocable: false",
          "paths: docs/**",
          "allowed-tools: Read, Grep",
          "disallowed-tools: Write",
          "arguments: [topic, tone]",
          "agent: reviewer",
          "context: fork",
          "model: sonnet",
          "shell: bash",
          "---",
          "",
          "# full",
          "",
          "Body.",
        ].join("\n"),
      );
      const warnings: string[] = [];
      const skills = loadSkills(ws, (m) => warnings.push(m));
      expect(skills.length).toBe(1);
      expect(skills[0]).toMatchObject({
        name: "full",
        origin: "project",
        argumentHint: "<topic>",
        whenToUse: "writing tasks",
        userInvocable: false,
        paths: ["docs/**"],
        allowedTools: ["Read", "Grep"],
        disallowedTools: ["Write"],
        argumentsDecl: ["topic", "tone"],
        agent: "reviewer",
        context: "fork",
      });
      // ONE warning for the whole skill, naming every ignored field.
      expect(warnings.length).toBe(1);
      expect(warnings[0]).toContain("model");
      expect(warnings[0]).toContain("shell");
      expect(warnings[0]).not.toContain("effort");
    } finally {
      cleanup();
    }
  });

  it("a skill without unsupported fields stays warning-silent", () => {
    const { ws, cleanup } = tmpWs();
    try {
      writeSkill(ws, ".wudao", "clean", "---\nname: clean\ndescription: d\nargument-hint: [x]\n---\nb");
      const warnings: string[] = [];
      expect(loadSkills(ws, (m) => warnings.push(m)).map((s) => s.name)).toEqual(["clean"]);
      expect(warnings).toEqual([]);
    } finally {
      cleanup();
    }
  });
});

describe("skillsPromptSection — whenToUse merged into the description line (cc-plugins D1)", () => {
  const base: LoadedSkill = {
    name: "alpha",
    description: "Alpha does things",
    filePath: "/ws/.agents/skills/alpha/SKILL.md",
    relPath: ".agents/skills/alpha/SKILL.md",
    content: "x",
  };

  it("description + whenToUse share the dash line — byte-pinned", () => {
    expect(skillsPromptSection([{ ...base, whenToUse: "a prose task lands" }])).toBe(
      "\n\n<available_skills>\n" +
        "Use read_file to load a skill's full instructions when a task matches.\n" +
        "- name: alpha — Alpha does things — use when: a prose task lands (path: .agents/skills/alpha/SKILL.md)\n" +
        "</available_skills>",
    );
  });

  it("whenToUse alone fills the dash slot; absent keeps the legacy bytes", () => {
    expect(skillsPromptSection([{ ...base, description: "", whenToUse: "w" }])).toContain(
      "- name: alpha — use when: w (path: .agents/skills/alpha/SKILL.md)",
    );
    expect(skillsPromptSection([base])).toContain("- name: alpha — Alpha does things (path: .agents/skills/alpha/SKILL.md)");
  });

  it("user-invocable:false does NOT hide the skill from the MODEL manifest", () => {
    expect(skillsPromptSection([{ ...base, userInvocable: false }])).toContain("- name: alpha — Alpha does things");
  });
});

describe("paths gate — model-visible manifest only (cc-plugins D1)", () => {
  const dirGlob: LoadedSkill = {
    name: "docs",
    description: "d",
    filePath: "/ws/.wudao/skills/docs/SKILL.md",
    relPath: ".wudao/skills/docs/SKILL.md",
    content: "",
    paths: ["docs/**"],
  };
  const baseGlob: LoadedSkill = { ...dirGlob, name: "claude-md", paths: ["CLAUDE.md"] };
  const ungated: LoadedSkill = { ...dirGlob, name: "open", paths: undefined };

  it("no paths → always listed", () => {
    expect(skillVisibleForPath(ungated, "any/thing.ts")).toBe(true);
  });

  it("directory glob: docs/** matches docs/a/b.md, not src/a.md", () => {
    expect(skillVisibleForPath(dirGlob, "docs/a/b.md")).toBe(true);
    expect(skillVisibleForPath(dirGlob, "src/a.md")).toBe(false);
  });

  it("a slash-free glob also matches the basename (M62 friendly rule)", () => {
    expect(skillVisibleForPath(baseGlob, "pkg/foo/CLAUDE.md")).toBe(true);
    expect(skillVisibleForPath(baseGlob, "pkg/foo/README.md")).toBe(false);
  });

  it("gateSkillsForPath filters the list and is identity-stable when nothing gates out", () => {
    const list = [dirGlob, ungated];
    expect(gateSkillsForPath(list, "src/a.md")).toEqual([ungated]);
    expect(gateSkillsForPath(list, "docs/x.md")).toBe(list);
  });

  it("the gate never touches invocation: findSkill still finds a gated-out skill", () => {
    expect(findSkill([dirGlob], "docs")).toBeDefined();
  });
});
