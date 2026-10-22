import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadProjectContext,
  getProjectContext,
  getProjectContextSection,
  resetProjectContextCacheForTests,
  PROJECT_CONTEXT_HEADING,
  MAX_PROJECT_CONTEXT_FILE_BYTES,
  MAX_PROJECT_CONTEXT_SECTION_BYTES,
  NO_PROJECT_CONTEXT_ENV,
  USER_GLOBAL_DISPLAY_PATH,
} from "../src/project-context.js";
import {
  buildSystemPrompt,
  SYSTEM_PREAMBLE,
  CORE_PRINCIPLES_SECTION,
  TOOL_USAGE_SECTION,
  TASK_DISCIPLINE_SECTION,
  LONG_TASKS_SECTION,
  BEHAVIORAL_CONTRACTS_SECTION,
  environmentSection,
  MCP_PROMPT_SECTION,
} from "../src/prompt.js";

let dirs: string[] = [];

function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "wudao-ctx-"));
  dirs.push(dir);
  return dir;
}

/** The pre-M54 prompt assembly — the byte-identity baseline. */
function baselinePrompt(root: string): string {
  return [
    SYSTEM_PREAMBLE,
    CORE_PRINCIPLES_SECTION,
    TOOL_USAGE_SECTION,
    TASK_DISCIPLINE_SECTION,
    LONG_TASKS_SECTION,
    BEHAVIORAL_CONTRACTS_SECTION,
    environmentSection(root),
  ].join("\n\n");
}

/** An EMPTY home: the default stub for every test so the user-global tier is
 *  deterministic regardless of the machine running the suite. */
let prevHome: string | undefined;

beforeEach(() => {
  resetProjectContextCacheForTests();
  prevHome = process.env.HOME;
  process.env.HOME = workspace();
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  for (const d of dirs) rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  dirs = [];
});

describe("loadProjectContext — reference-aligned discovery (M54b §1)", () => {
  it("concatenates the user-global baseline FIRST, then root files in ALPHABETICAL order", () => {
    const home = process.env.HOME!;
    mkdirSync(join(home, ".wudao"), { recursive: true });
    writeFileSync(join(home, ".wudao", "WUDAO.md"), "personal baseline\n", "utf8");
    const root = workspace();
    writeFileSync(join(root, "WUDAO.md"), "native rules here\n", "utf8");
    writeFileSync(join(root, "AGENTS.md"), "standard rules here\n", "utf8");
    writeFileSync(join(root, "CLAUDE.md"), "compat rules here\n", "utf8");

    const r = loadProjectContext(root);
    expect(r.files.map((f) => f.displayPath)).toEqual([
      USER_GLOBAL_DISPLAY_PATH,
      "AGENTS.md",
      "CLAUDE.md",
      "WUDAO.md",
    ]);
    expect(r.section.startsWith(`\n\n${PROJECT_CONTEXT_HEADING}\n`)).toBe(true);
    const iG = r.section.indexOf("personal baseline");
    const iA = r.section.indexOf("standard rules here");
    const iC = r.section.indexOf("compat rules here");
    const iW = r.section.indexOf("native rules here");
    expect(iG).toBeGreaterThan(-1);
    expect(iG).toBeLessThan(iA);
    expect(iA).toBeLessThan(iC);
    expect(iC).toBeLessThan(iW);
    expect(r.section).toContain(`## ${USER_GLOBAL_DISPLAY_PATH}\npersonal baseline`);
    expect(r.section).toContain("## AGENTS.md\nstandard rules here");
    expect(r.section).toContain("## CLAUDE.md\ncompat rules here");
    expect(r.section).toContain("## WUDAO.md\nnative rules here");
    expect(r.warnings).toEqual([]);
  });

  it("git-bounded walk: a parent file inside the .git root loads BEFORE the cwd files (cwd LAST = highest priority)", () => {
    const parent = workspace();
    mkdirSync(join(parent, ".git"));
    writeFileSync(join(parent, "CLAUDE.md"), "parent-level rules\n", "utf8");
    const child = join(parent, "sub");
    mkdirSync(child);
    writeFileSync(join(child, "WUDAO.md"), "child rules\n", "utf8");

    const r = loadProjectContext(child);
    expect(r.files.map((f) => f.displayPath)).toEqual(["CLAUDE.md", "sub/WUDAO.md"]);
    expect(r.section.indexOf("parent-level rules")).toBeLessThan(r.section.indexOf("child rules"));
    // Display paths are project-root-relative (the upstream formatrelativeDisplay).
    expect(r.section).toContain("## CLAUDE.md\nparent-level rules");
    expect(r.section).toContain("## sub/WUDAO.md\nchild rules");
  });

  it("multi-level chain loads root → cwd; the cwd file lands LAST and carries a root-relative path", () => {
    const base = workspace();
    mkdirSync(join(base, ".git"));
    mkdirSync(join(base, "mid", "ws"), { recursive: true });
    writeFileSync(join(base, "AGENTS.md"), "repo-root rules\n", "utf8");
    writeFileSync(join(base, "mid", "CLAUDE.md"), "mid-level rules\n", "utf8");
    writeFileSync(join(base, "mid", "ws", "WUDAO.md"), "cwd rules\n", "utf8");

    const r = loadProjectContext(join(base, "mid", "ws"));
    expect(r.files.map((f) => f.displayPath)).toEqual(["AGENTS.md", "mid/CLAUDE.md", "mid/ws/WUDAO.md"]);
    const order = ["repo-root rules", "mid-level rules", "cwd rules"].map((s) => r.section.indexOf(s));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(r.section.indexOf("cwd rules")).toBeGreaterThan(r.section.indexOf("mid-level rules"));
  });

  it("walk stops AT the nearest .git — files ABOVE the git root never load (never walks to fs root)", () => {
    const base = workspace();
    writeFileSync(join(base, "CLAUDE.md"), "ABOVE GIT ROOT: must never load\n", "utf8");
    const gitRoot = join(base, "repo");
    mkdirSync(join(gitRoot, ".git"), { recursive: true });
    const ws = join(gitRoot, "ws");
    mkdirSync(ws);
    writeFileSync(join(gitRoot, "CLAUDE.md"), "inside git root\n", "utf8");
    writeFileSync(join(ws, "WUDAO.md"), "cwd file\n", "utf8");

    const r = loadProjectContext(ws);
    expect(r.section).not.toContain("ABOVE GIT ROOT");
    expect(r.files.map((f) => f.displayPath)).toEqual(["CLAUDE.md", "ws/WUDAO.md"]);
  });

  it("no .git anywhere above → fallback to root-only: parent files are NOT loaded", () => {
    const parent = workspace();
    writeFileSync(join(parent, "CLAUDE.md"), "parent-level rules\n", "utf8");
    const child = join(parent, "sub");
    mkdirSync(child);
    const r = loadProjectContext(child);
    expect(r.files).toHaveLength(0);
    expect(r.section).toBe("");
  });

  it("a worktree-style .git FILE also bounds the walk (cwd is its own project root)", () => {
    const parent = workspace();
    writeFileSync(join(parent, "CLAUDE.md"), "parent outside worktree: must not load\n", "utf8");
    const wt = join(parent, "wt");
    mkdirSync(wt);
    writeFileSync(join(wt, ".git"), "gitdir: ../.git/worktrees/wt\n", "utf8");
    writeFileSync(join(wt, "WUDAO.md"), "worktree rules\n", "utf8");

    const r = loadProjectContext(wt);
    expect(r.files.map((f) => f.displayPath)).toEqual(["WUDAO.md"]);
    expect(r.section).not.toContain("parent outside worktree");
  });

  it("sanity bound: a .git more than 10 levels up is not reached (root-only fallback)", () => {
    const base = workspace();
    mkdirSync(join(base, ".git"));
    writeFileSync(join(base, "CLAUDE.md"), "DEEP GIT ROOT: beyond the walk bound\n", "utf8");
    // 12 nested dirs below base — the marker sits MORE than 10 levels above ws.
    let deep = base;
    for (let i = 0; i < 12; i++) deep = join(deep, `d${i}`);
    mkdirSync(deep, { recursive: true });
    writeFileSync(join(deep, "WUDAO.md"), "shallow fallback file\n", "utf8");

    const r = loadProjectContext(deep);
    expect(r.section).not.toContain("DEEP GIT ROOT");
    expect(r.files.map((f) => f.displayPath)).toEqual(["WUDAO.md"]);
  });

  it("accepts lowercase agents.md (open-standard case compatibility)", () => {
    const root = workspace();
    writeFileSync(join(root, "agents.md"), "lowercase standard\n", "utf8");
    const r = loadProjectContext(root);
    expect(r.files).toHaveLength(1);
    // On case-insensitive filesystems (APFS default) the AGENTS.md probe
    // already resolves this file, so either spelling may be reported — and
    // exactly ONE file is loaded either way.
    expect(r.files[0]?.displayPath.toLowerCase()).toBe("agents.md");
    expect(r.files[0]?.content).toBe("lowercase standard");
  });

  it("per-directory dedup: an identical sibling (AGENTS.md == CLAUDE.md) collapses to one load", () => {
    const root = workspace();
    const shared = "identical rules body\n";
    writeFileSync(join(root, "AGENTS.md"), shared, "utf8");
    writeFileSync(join(root, "CLAUDE.md"), `  ${shared}  \n`, "utf8"); // whitespace-trimmed equal
    const r = loadProjectContext(root);
    // Alphabetical-first sibling (AGENTS.md) wins; CLAUDE.md collapses.
    expect(r.files.map((f) => f.displayPath)).toEqual(["AGENTS.md"]);
    expect(r.section).toContain("## AGENTS.md");
    expect(r.section).not.toContain("## CLAUDE.md");
  });

  it("cross-directory dedup: identical content loads ONCE, keeping the MORE-SPECIFIC copy's position", () => {
    const base = workspace();
    mkdirSync(join(base, ".git"));
    writeFileSync(join(base, "CLAUDE.md"), "shared repo-wide rules\n", "utf8");
    const ws = join(base, "ws");
    mkdirSync(ws);
    writeFileSync(join(ws, "AGENTS.md"), "ws agents rules\n", "utf8");
    writeFileSync(join(ws, "CLAUDE.md"), "shared repo-wide rules\n", "utf8");

    const r = loadProjectContext(ws);
    // The root-level copy is dropped; the ws copy keeps its slot (after
    // ws/AGENTS.md — alphabetical within the dir, cwd tier LAST).
    expect(r.files.map((f) => f.displayPath)).toEqual(["ws/AGENTS.md", "ws/CLAUDE.md"]);
    expect(r.section.split("shared repo-wide rules")).toHaveLength(2); // header line + exactly one body
    expect(r.section.indexOf("shared repo-wide rules")).toBeGreaterThan(r.section.indexOf("ws agents rules"));
  });

  it("cross-directory dedup applies to the user-global tier too (project copy wins)", () => {
    const home = process.env.HOME!;
    mkdirSync(join(home, ".wudao"), { recursive: true });
    writeFileSync(join(home, ".wudao", "WUDAO.md"), "same everywhere\n", "utf8");
    const root = workspace();
    writeFileSync(join(root, "WUDAO.md"), "same everywhere\n", "utf8");
    const r = loadProjectContext(root);
    expect(r.files.map((f) => f.displayPath)).toEqual(["WUDAO.md"]);
  });

  it("never reads .claude/CLAUDE.md anywhere in the chain (root-level candidates only)", () => {
    const base = workspace();
    mkdirSync(join(base, ".git"));
    mkdirSync(join(base, ".claude"));
    writeFileSync(join(base, ".claude", "CLAUDE.md"), "nested secret\n", "utf8");
    const ws = join(base, "ws");
    mkdirSync(join(ws, ".claude"), { recursive: true });
    writeFileSync(join(ws, ".claude", "CLAUDE.md"), "deeper nested secret\n", "utf8");
    const r = loadProjectContext(ws);
    expect(r.section).toBe("");
    expect(r.files).toHaveLength(0);
  });
});

describe("loadProjectContext — budget (M54b §4)", () => {
  it("drops broadest-first with an omission notice when the section budget is exceeded", () => {
    const base = workspace();
    mkdirSync(join(base, ".git"));
    // Each file ≈ 45% of the budget → three blocks are over, two fit.
    const big = "p".repeat(Math.floor(MAX_PROJECT_CONTEXT_SECTION_BYTES * 0.45));
    writeFileSync(join(base, "CLAUDE.md"), big, "utf8"); // broadest project tier
    const ws = join(base, "ws");
    mkdirSync(ws);
    const w = "w".repeat(Math.floor(MAX_PROJECT_CONTEXT_SECTION_BYTES * 0.45));
    const a = "a".repeat(Math.floor(MAX_PROJECT_CONTEXT_SECTION_BYTES * 0.45));
    writeFileSync(join(ws, "WUDAO.md"), w, "utf8");
    writeFileSync(join(ws, "AGENTS.md"), a, "utf8");

    const r = loadProjectContext(ws);
    // ~135% of budget → the repo-root file drops, the two cwd files (~90%)
    // stay.
    expect(r.omitted).toEqual(["CLAUDE.md"]);
    expect(r.files.map((f) => f.displayPath)).toEqual(["ws/AGENTS.md", "ws/WUDAO.md"]);
    expect(r.section).toContain("[project context: omitted CLAUDE.md (budget)]");
    expect(r.section).not.toContain(big.slice(0, 100));
    expect(r.section).toContain(a.slice(0, 100));
    expect(r.section).toContain(w.slice(0, 100));
    expect(r.warnings.join(" ")).toContain("budget");
  });

  it("evicts global and root tiers before the cwd file; the cwd file is never dropped", () => {
    const home = process.env.HOME!;
    mkdirSync(join(home, ".wudao"), { recursive: true });
    writeFileSync(join(home, ".wudao", "WUDAO.md"), "g".repeat(Math.floor(MAX_PROJECT_CONTEXT_SECTION_BYTES * 0.45)), "utf8");
    const base = workspace();
    mkdirSync(join(base, ".git"));
    writeFileSync(join(base, "CLAUDE.md"), "p".repeat(Math.floor(MAX_PROJECT_CONTEXT_SECTION_BYTES * 0.45)), "utf8");
    const ws = join(base, "mid", "ws");
    mkdirSync(ws, { recursive: true });
    writeFileSync(join(base, "mid", "AGENTS.md"), "m".repeat(Math.floor(MAX_PROJECT_CONTEXT_SECTION_BYTES * 0.45)), "utf8");
    const w = "w".repeat(Math.floor(MAX_PROJECT_CONTEXT_SECTION_BYTES * 0.45));
    writeFileSync(join(ws, "WUDAO.md"), w, "utf8");

    const r = loadProjectContext(ws);
    // 4 tiers × ~45% → global and the repo-root file drop, mid + cwd stay.
    expect(r.omitted).toEqual([USER_GLOBAL_DISPLAY_PATH, "CLAUDE.md"]);
    expect(r.files.map((f) => f.displayPath)).toEqual(["mid/AGENTS.md", "mid/ws/WUDAO.md"]);
    expect(r.section).toContain(`[project context: omitted ${USER_GLOBAL_DISPLAY_PATH} (budget)]`);
    expect(r.section).toContain("[project context: omitted CLAUDE.md (budget)]");
    expect(r.section).toContain(w.slice(0, 100));
  });

  it("a section within budget stays intact (no notices, no warnings)", () => {
    const root = workspace();
    writeFileSync(join(root, "WUDAO.md"), "x".repeat(Math.floor(MAX_PROJECT_CONTEXT_SECTION_BYTES / 4)), "utf8");
    writeFileSync(join(root, "AGENTS.md"), "y".repeat(Math.floor(MAX_PROJECT_CONTEXT_SECTION_BYTES / 4)), "utf8");
    const r = loadProjectContext(root);
    expect(r.omitted).toEqual([]);
    expect(r.files).toHaveLength(2);
    expect(r.section).not.toContain("(budget)");
    expect(r.warnings).toEqual([]);
  });
});

describe("loadProjectContext — robustness (M54 §1/§3, kept)", () => {
  it("truncates a >64KB file and warns", () => {
    const root = workspace();
    const big = "x".repeat(MAX_PROJECT_CONTEXT_FILE_BYTES + 1000);
    writeFileSync(join(root, "WUDAO.md"), big, "utf8");
    const r = loadProjectContext(root);
    expect(r.files[0]?.truncated).toBe(true);
    expect(r.files[0]?.bytes).toBe(MAX_PROJECT_CONTEXT_FILE_BYTES + 1000);
    expect(r.files[0]?.content.startsWith("x".repeat(1000))).toBe(true);
    expect(r.files[0]?.content).toContain("truncated");
    expect(r.warnings.join(" ")).toContain("truncated");
  });

  it("keeps a ≤64KB file verbatim (boundary)", () => {
    const root = workspace();
    writeFileSync(join(root, "WUDAO.md"), "y".repeat(MAX_PROJECT_CONTEXT_FILE_BYTES), "utf8");
    const r = loadProjectContext(root);
    expect(r.files[0]?.truncated).toBe(false);
    expect(r.files[0]?.content.length).toBe(MAX_PROJECT_CONTEXT_FILE_BYTES);
    expect(r.warnings).toEqual([]);
  });

  it("skips a dead symlink with a warning instead of failing", () => {
    const root = workspace();
    symlinkSync(join(root, "nowhere-at-all.md"), join(root, "WUDAO.md"));
    const r = loadProjectContext(root);
    expect(r.files).toHaveLength(0);
    expect(r.warnings.join(" ")).toContain("dead symlink");
  });

  it("ignores a directory that happens to carry a candidate name", () => {
    const root = workspace();
    mkdirSync(join(root, "WUDAO.md"));
    expect(loadProjectContext(root).files).toHaveLength(0);
  });

  it("a .git DIRECTORY that is a dead symlink does not become a project root", () => {
    const base = workspace();
    symlinkSync(join(base, "no-such-git"), join(base, ".git"));
    writeFileSync(join(base, "CLAUDE.md"), "should not load via dead .git marker\n", "utf8");
    const ws = join(base, "sub");
    mkdirSync(ws);
    const r = loadProjectContext(ws);
    // statSync follows the dead link → marker probe fails → root-only.
    expect(r.files).toHaveLength(0);
  });
});

describe("buildSystemPrompt — Project context tail section (M54 §2)", () => {
  it("empty workspace → prompt stays byte-identical to the pre-M54 assembly", () => {
    const root = workspace();
    expect(getProjectContextSection(root)).toBe("");
    expect(buildSystemPrompt(root)).toBe(baselinePrompt(root));
  });

  it("section order: Environment → Project context → MCP → skills", () => {
    const root = workspace();
    writeFileSync(join(root, "WUDAO.md"), "conventions live here\n", "utf8");
    const skill = {
      name: "demo",
      description: "a demo skill",
      filePath: "/nowhere/SKILL.md",
      relPath: ".wudao/skills/demo/SKILL.md",
      content: "# demo\n",
    };
    const p = buildSystemPrompt(root, true, [skill]);
    const iEnv = p.indexOf("# Environment");
    const iProject = p.indexOf(PROJECT_CONTEXT_HEADING);
    const iMcp = p.indexOf("# MCP tools");
    const iSkills = p.indexOf("<available_skills>");
    expect(iEnv).toBeGreaterThan(-1);
    expect(iProject).toBeGreaterThan(iEnv);
    expect(iMcp).toBeGreaterThan(iProject);
    expect(iSkills).toBeGreaterThan(iMcp);
  });

  it("project context is purely additive — the no-file prompt is a strict prefix", () => {
    const empty = workspace();
    const full = workspace();
    writeFileSync(join(full, "WUDAO.md"), "extra bytes\n", "utf8");
    const pEmpty = buildSystemPrompt(empty);
    const pFull = buildSystemPrompt(full);
    // Same static prefix up to and including Environment; the section (and
    // nothing else) is appended after it.
    const cut = (s: string): string => s.slice(0, s.indexOf("# Environment"));
    expect(cut(pFull)).toBe(cut(pEmpty));
    expect(pFull).toContain(`\n\n${PROJECT_CONTEXT_HEADING}\n## WUDAO.md\nextra bytes`);
    expect(pFull.endsWith("extra bytes")).toBe(true);
  });

  it("MCP/skills tails stay additive after the project section (prefix-cache)", () => {
    const root = workspace();
    writeFileSync(join(root, "AGENTS.md"), "agents rules\n", "utf8");
    const without = buildSystemPrompt(root);
    const withMcp = buildSystemPrompt(root, true);
    expect(withMcp.startsWith(without)).toBe(true);
    expect(withMcp.slice(without.length)).toBe(MCP_PROMPT_SECTION);
  });

  it("exposes the section through /context's heading split (M52 contract)", () => {
    const root = workspace();
    writeFileSync(join(root, "WUDAO.md"), "alpha conventions\n", "utf8");
    writeFileSync(join(root, "CLAUDE.md"), "beta conventions\n", "utf8");
    const p = buildSystemPrompt(root);
    // Same split M52's context-report uses: `#`/`##` lines head a section.
    const headings = [...p.matchAll(/^(#{1,2} .*)$/gm)].map((m) => m[1] ?? "");
    expect(headings).toContain(PROJECT_CONTEXT_HEADING);
    expect(headings).toContain("## WUDAO.md");
    expect(headings).toContain("## CLAUDE.md");
    expect(headings.indexOf(PROJECT_CONTEXT_HEADING)).toBeGreaterThan(headings.indexOf("# Environment"));
  });
});

describe("getProjectContext — session-static loading (M54 §2: no hot reload)", () => {
  it("is memoized per root: editing the file mid-session changes nothing", () => {
    const root = workspace();
    writeFileSync(join(root, "WUDAO.md"), "first version\n", "utf8");
    expect(getProjectContext(root).files[0]?.content).toBe("first version");
    writeFileSync(join(root, "WUDAO.md"), "second version\n", "utf8");
    expect(getProjectContext(root).files[0]?.content).toBe("first version");
    // A restart (= cache reset) picks up the new bytes.
    resetProjectContextCacheForTests();
    expect(getProjectContext(root).files[0]?.content).toBe("second version");
  });

  it("WUDAO_NO_PROJECT_CONTEXT disables loading entirely — including the user-global baseline", () => {
    const home = process.env.HOME!;
    mkdirSync(join(home, ".wudao"), { recursive: true });
    writeFileSync(join(home, ".wudao", "WUDAO.md"), "personal baseline\n", "utf8");
    const root = workspace();
    writeFileSync(join(root, "WUDAO.md"), "should not appear\n", "utf8");
    const prev = process.env[NO_PROJECT_CONTEXT_ENV];
    process.env[NO_PROJECT_CONTEXT_ENV] = "1";
    try {
      expect(getProjectContextSection(root)).toBe("");
      expect(buildSystemPrompt(root)).toBe(baselinePrompt(root));
    } finally {
      if (prev === undefined) delete process.env[NO_PROJECT_CONTEXT_ENV];
      else process.env[NO_PROJECT_CONTEXT_ENV] = prev;
    }
  });
});

// ---------------------------------------------------------------------------
// M58 §C#2 — the standing compact-instructions rider.
// ---------------------------------------------------------------------------

import {
  extractCompactInstructions,
  getCompactInstructionsRider,
  COMPACT_INSTRUCTIONS_HEADING,
  MAX_COMPACT_INSTRUCTIONS_CHARS,
} from "../src/project-context.js";

describe("extractCompactInstructions (M58 §C#2, pure)", () => {
  it("extracts the section body: heading stripped, trimmed, ends at the next #/## heading", () => {
    const md = [
      "# Project notes",
      "intro line",
      "",
      COMPACT_INSTRUCTIONS_HEADING,
      "always preserve file paths verbatim",
      "keep the repro steps",
      "",
      "## Other section",
      "not part of the rider",
    ].join("\n");
    expect(extractCompactInstructions(md)).toBe("always preserve file paths verbatim\nkeep the repro steps");
  });

  it("a ### sub-heading belongs to the section body (only #/## end it)", () => {
    const md = `${COMPACT_INSTRUCTIONS_HEADING}\nouter\n### sub detail\nmore\n`;
    expect(extractCompactInstructions(md)).toBe("outer\n### sub detail\nmore");
  });

  it("absent section or empty body → undefined", () => {
    expect(extractCompactInstructions("# no section here\n")).toBeUndefined();
    expect(extractCompactInstructions(`${COMPACT_INSTRUCTIONS_HEADING}\n\n## next\n`)).toBeUndefined();
  });

  it("caps the rider at the limit on a line boundary with the truncation marker", () => {
    const lines: string[] = [];
    let total = 0;
    let i = 0;
    while (total < MAX_COMPACT_INSTRUCTIONS_CHARS + 500) {
      const line = `line ${i++} ${"x".repeat(40)}`;
      lines.push(line);
      total += line.length + 1;
    }
    const rider = extractCompactInstructions(`${COMPACT_INSTRUCTIONS_HEADING}\n${lines.join("\n")}`) ?? "";
    expect(rider.length).toBeLessThanOrEqual(MAX_COMPACT_INSTRUCTIONS_CHARS + 100);
    expect(rider).toContain("[… compact instructions truncated …]");
    expect(rider.endsWith("[… compact instructions truncated …]")).toBe(true);
  });
});

describe("getCompactInstructionsRider (M58 §C#2, loader-backed)", () => {
  it("a WUDAO.md Compact Instructions section is honored (heading stripped)", () => {
    const root = workspace();
    writeFileSync(
      join(root, "WUDAO.md"),
      `# Notes\nprose\n\n${COMPACT_INSTRUCTIONS_HEADING}\nalways preserve file paths verbatim\n`,
      "utf8",
    );
    expect(getCompactInstructionsRider(root)).toBe("always preserve file paths verbatim");
  });

  it("project tier over global: the workspace file wins when both carry a section", () => {
    const root = workspace();
    const home = workspace();
    mkdirSync(join(home, ".wudao"), { recursive: true });
    writeFileSync(join(home, ".wudao", "WUDAO.md"), `${COMPACT_INSTRUCTIONS_HEADING}\nglobal rider\n`, "utf8");
    writeFileSync(join(root, "WUDAO.md"), `${COMPACT_INSTRUCTIONS_HEADING}\nproject rider\n`, "utf8");
    process.env.HOME = home;
    expect(getCompactInstructionsRider(root)).toBe("project rider");
  });

  it("a global-only section is used when the project has none", () => {
    const root = workspace();
    const home = workspace();
    mkdirSync(join(home, ".wudao"), { recursive: true });
    writeFileSync(join(home, ".wudao", "WUDAO.md"), `${COMPACT_INSTRUCTIONS_HEADING}\nglobal rider\n`, "utf8");
    process.env.HOME = home;
    expect(getCompactInstructionsRider(root)).toBe("global rider");
  });

  it("no section anywhere → undefined; the kill switch disables the rider too", () => {
    const root = workspace();
    writeFileSync(join(root, "WUDAO.md"), "just prose\n", "utf8");
    expect(getCompactInstructionsRider(root)).toBeUndefined();
    writeFileSync(join(root, "AGENTS.md"), `${COMPACT_INSTRUCTIONS_HEADING}\nagents rider\n`, "utf8");
    resetProjectContextCacheForTests();
    expect(getCompactInstructionsRider(root)).toBe("agents rider");
    const prev = process.env[NO_PROJECT_CONTEXT_ENV];
    process.env[NO_PROJECT_CONTEXT_ENV] = "1";
    try {
      expect(getCompactInstructionsRider(root)).toBeUndefined();
    } finally {
      if (prev === undefined) delete process.env[NO_PROJECT_CONTEXT_ENV];
      else process.env[NO_PROJECT_CONTEXT_ENV] = prev;
    }
  });
});
