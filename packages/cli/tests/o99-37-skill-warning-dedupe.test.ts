// ω99-37 — skills rescan warning dedupe: a static frontmatter defect (no
// name / unsupported fields) is an intrinsic property of ONE file, and every
// mission boundary re-runs the boot assembly (buildExtensionState →
// loadSkills) — the campaign-two log carried the byte-identical warning ×8,
// alert fatigue that drowns real signal. Contract under test: a static-defect
// warning fires ONCE per (skill path, process); skip/mount semantics, the
// warn channel, and the message bytes are otherwise unchanged. NOT deduped
// (deliberately): duplicate-name/shadow warnings (facts about file
// RELATIONS — the same loser path legitimately re-warns when the winning set
// changes) and the trust-gate summaries (mutable state, no path key).
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSkills, loadSkillsUnderDir } from "../src/skills.js";
import {
  buildExtensionState,
  initExtensionRuntime,
  resetExtensionRuntime,
  rescanExtensions,
  getExtensionState,
} from "../src/extension-state.js";

interface Sandbox {
  readonly ws: string;
  readonly env: NodeJS.ProcessEnv;
  cleanup: () => void;
}

/** Fresh workspace + a BARE WUDAO_GLOBAL_HOME sandbox (the personal/global
 * tiers stay empty INSIDE it — the real ~/.claude never enters the walk). */
function tmpSandbox(): Sandbox {
  const ws = mkdtempSync(join(tmpdir(), "o9937-ws-"));
  const home = mkdtempSync(join(tmpdir(), "o9937-home-"));
  return {
    ws,
    env: { ...process.env, WUDAO_GLOBAL_HOME: home },
    cleanup: () => {
      rmSync(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    },
  };
}

/** One skill under <ws>/.wudao/skills/<name>/SKILL.md with the given
 * frontmatter body (no trailing newline needed — added here). */
function writeSkill(ws: string, name: string, frontmatter: string): string {
  const dir = join(ws, ".wudao", "skills", name);
  mkdirSync(dir, { recursive: true });
  const filePath = join(dir, "SKILL.md");
  writeFileSync(filePath, `---\n${frontmatter}\n---\n\nthe ${name} body\n`, "utf8");
  return filePath;
}

const frontmatterWarns = (warnings: readonly string[]): string[] =>
  warnings.filter((w) => w.includes('has no "name:" in its frontmatter'));
const unsupportedWarns = (warnings: readonly string[]): string[] =>
  warnings.filter((w) => w.includes("ignoring unsupported frontmatter field(s)"));

describe("ω99-37: static frontmatter warnings dedupe per (skill path, process)", () => {
  it("two full loads of one nameless SKILL.md → the warning fires EXACTLY once (baseline was ×2)", () => {
    const s = tmpSandbox();
    try {
      const filePath = writeSkill(s.ws, "noname", "description: no name here");
      const first: string[] = [];
      const one = loadSkills(s.ws, (m) => first.push(m), s.env);
      const second: string[] = [];
      const two = loadSkills(s.ws, (m) => second.push(m), s.env);
      // Skip semantics unchanged on BOTH loads: the nameless skill never mounts.
      expect(one).toEqual([]);
      expect(two).toEqual([]);
      // THE dedupe: exactly one line across both loads, on the first, and the
      // bytes are the SAME shape the channel always carried.
      expect(frontmatterWarns(first)).toEqual([
        `skill ${filePath} has no "name:" in its frontmatter; skipping it`,
      ]);
      expect(frontmatterWarns(second)).toEqual([]);
    } finally {
      s.cleanup();
    }
  });

  it("distinct bad files each keep their own single line (the budget keys by path)", () => {
    const s = tmpSandbox();
    try {
      const a = writeSkill(s.ws, "noname-a", "description: a has no name");
      const b = writeSkill(s.ws, "noname-b", "description: b has no name");
      const warnings: string[] = [];
      loadSkills(s.ws, (m) => warnings.push(m), s.env);
      loadSkills(s.ws, (m) => warnings.push(m), s.env);
      const lines = frontmatterWarns(warnings);
      expect(lines).toHaveLength(2);
      expect(lines[0]).toContain(a);
      expect(lines[1]).toContain(b);
      // Neither ever mounts (two loads, both empty).
      expect(loadSkills(s.ws, () => {}, s.env)).toEqual([]);
    } finally {
      s.cleanup();
    }
  });

  it("the unsupported-fields family dedupes the same way — and the skill STILL loads every time", () => {
    const s = tmpSandbox();
    try {
      const filePath = writeSkill(s.ws, "supset", "name: supset\ndescription: extra fields\nmodel: glm\nshell: bash");
      const first: string[] = [];
      const one = loadSkills(s.ws, (m) => first.push(m), s.env);
      const second: string[] = [];
      const two = loadSkills(s.ws, (m) => second.push(m), s.env);
      // Load semantics unchanged: it mounts on both walks, identically.
      expect(one.map((x) => x.name)).toEqual(["supset"]);
      expect(two).toEqual(one);
      // ONE degradation warning for the whole skill, first load only.
      expect(unsupportedWarns(first)).toEqual([
        `skill ${filePath}: ignoring unsupported frontmatter field(s): model, shell (no wudao mechanism yet)`,
      ]);
      expect(unsupportedWarns(second)).toEqual([]);
    } finally {
      s.cleanup();
    }
  });

  it("a receipt walk (skipWarningBudget) enumerates WITHOUT spending the budget — the real walk after it still warns once", () => {
    const s = tmpSandbox();
    try {
      const root = join(s.ws, ".wudao", "skills");
      const filePath = writeSkill(s.ws, "noname", "description: no name here");
      // The mission-mount receipt shape: no-op sink, budget skipped.
      expect(loadSkillsUnderDir(root, s.ws, () => {}, undefined, "project", { skipWarningBudget: true })).toEqual([]);
      // The real warn sink's walk is NOT silenced by that receipt walk.
      const warnings: string[] = [];
      loadSkills(s.ws, (m) => warnings.push(m), s.env);
      expect(frontmatterWarns(warnings)).toEqual([
        `skill ${filePath} has no "name:" in its frontmatter; skipping it`,
      ]);
    } finally {
      s.cleanup();
    }
  });
});

describe("ω99-37: the rescan seam (the ×N mission-boundary driver)", () => {
  let s: Sandbox;
  beforeEach(() => {
    s = tmpSandbox();
    resetExtensionRuntime();
  });
  afterEach(() => {
    resetExtensionRuntime();
    s.cleanup();
  });

  it("boot → rescan ×2 with a nameless skill: the warning lands ONCE; counts and the mounted set stay put", async () => {
    writeSkill(s.ws, "noname", "description: no name");
    writeSkill(s.ws, "good", "name: good\ndescription: fine");
    const warnings: string[] = [];
    const sink = { warn: (m: string) => warnings.push(m), env: s.env };
    const boot = await buildExtensionState(s.ws, [], sink);
    initExtensionRuntime(s.ws, [], boot, sink);
    const r1 = await rescanExtensions();
    const r2 = await rescanExtensions();
    // Rescan semantics zero-change: same counts each pass, bad skill never
    // mounts, good skill always does.
    expect(boot.counts).toEqual({ skills: 1, plugins: 0, hooks: 0 });
    expect(r1).toEqual(boot.counts);
    expect(r2).toEqual(boot.counts);
    expect(boot.skills.map((x) => x.name)).toEqual(["good"]);
    expect(getExtensionState()?.skills.map((x) => x.name)).toEqual(["good"]);
    // THE ×N driver, deduped: three full assemblies, one warning line.
    expect(frontmatterWarns(warnings)).toHaveLength(1);
  });
});
