// ω99-20A — migration bundle v1 CONTENT PIN. This is NOT a mechanism test:
// ω99-18 (m81-mission-bundle.test.ts) already pins the mount machinery. This
// file pins the CONTENT of the repo's first campaign-scoped skill pack —
// docs/bundles/migration/ — a repo-level deliverable, so the path crossing
// out of packages/ into ../../../docs is INTENTIONAL. The bundle lives in
// the repo (versioned, greppable) and is installed by copying it to
// <ws>/.wudao/mission-bundles/migration/skills/ (README recipe); if the
// in-repo copy drifts out of loader-visible shape, every downstream
// install silently degrades — this pin catches that drift in CI.
// Zero real shell, zero network; read-only fs against the repo itself.
import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadSkillsUnderDir, parseSkillFrontmatter } from "../src/skills.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const BUNDLE_DIR = join(REPO_ROOT, "docs", "bundles", "migration");
const SKILLS_ROOT = join(BUNDLE_DIR, "skills");

/** The four skills of migration v1, pinned VERBATIM (loader returns dirs
 *  sorted; any rename/add/remove here is a deliberate content change that
 *  must re-run this pin, not silent drift). */
const PINNED_NAMES = ["acceptance-first", "code-map", "diff-replay", "repo-survey"] as const;

describe("ω99-20A C2 — the repo copy loads through the REAL loader", () => {
  it("exactly four skills, names pinned verbatim, zero loader warnings, non-empty descriptions", () => {
    expect(existsSync(SKILLS_ROOT), `bundle source root missing: ${SKILLS_ROOT}`).toBe(true);
    const warn: string[] = [];
    // the same seam production uses for a bundle root (origin "project",
    // see skills.ts loadSkills' bundleRoots tier)
    const skills = loadSkillsUnderDir(SKILLS_ROOT, REPO_ROOT, (m) => warn.push(m), undefined, "project");
    expect(warn).toEqual([]); // no skipped files, no unsupported-field complaints
    expect(skills.map((s) => s.name)).toEqual([...PINNED_NAMES]);
    for (const s of skills) {
      expect(s.description.length > 0, `${s.name}: description must be non-empty (the model picks skills by it)`).toBe(true);
      expect(s.filePath).toBe(join(SKILLS_ROOT, s.name, "SKILL.md"));
    }
  });
});

describe("ω99-20A — frontmatter contract (red line 2)", () => {
  it("each SKILL.md carries ONLY name + description — no mcp key, no extra fields", () => {
    for (const name of PINNED_NAMES) {
      const text = readFileSync(join(SKILLS_ROOT, name, "SKILL.md"), "utf8");
      const lines = text.split(/\r?\n/);
      expect(lines[0], `${name}: must open with a --- fence`).toBe("---");
      const close = lines.indexOf("---", 1);
      expect(close, `${name}: frontmatter must close`).toBeGreaterThan(0);
      const fmLines = lines.slice(1, close).filter((l) => l.trim() !== "");
      expect(fmLines.length, `${name}: exactly name + description lines`).toBe(2);
      for (const l of fmLines) {
        expect(
          /^name:[ \t]\S/.test(l) || /^description:[ \t]\S/.test(l),
          `${name}: stray frontmatter line "${l}"`,
        ).toBe(true);
      }
      // the REAL parser agrees the block parses to exactly these two fields
      const fm = parseSkillFrontmatter(text);
      expect(Object.keys(fm).sort(), `${name}: parser saw extra fields`).toEqual(["description", "name"]);
    }
  });
});

describe("ω99-20A — structural honesty (no bundle.json, clean skill dirs)", () => {
  it("the pack ships no bundle.json, so declare can never hit the mcp gate; each skill dir is exactly one SKILL.md", () => {
    expect(existsSync(join(BUNDLE_DIR, "bundle.json"))).toBe(false);
    for (const entry of readdirSync(SKILLS_ROOT, { withFileTypes: true })) {
      expect(entry.name, "only skill directories live under skills/").not.toBe("bundle.json");
      expect(entry.isDirectory(), `${entry.name}: expected a directory`).toBe(true);
      const files = readdirSync(join(SKILLS_ROOT, entry.name));
      expect(files, `${entry.name}: a skill dir is exactly one SKILL.md`).toEqual(["SKILL.md"]);
    }
  });
});

describe("ω99-20A — body budget (brief §2.1: each skill ≤ 120 lines)", () => {
  it("every SKILL.md stays within the 120-line cap", () => {
    for (const name of PINNED_NAMES) {
      const lineCount = readFileSync(join(SKILLS_ROOT, name, "SKILL.md"), "utf8").split(/\r?\n/).length;
      expect(lineCount, `${name}: ${lineCount} lines > 120`).toBeLessThanOrEqual(120);
    }
  });
});
