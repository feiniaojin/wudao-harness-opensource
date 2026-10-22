// ω99-56 — the deslop skill asset: the repo's bundled skills/deslop/SKILL.md
// (installed into a workspace's .wudao/skills, the README's copy/symlink
// convention) parses through the existing frontmatter machinery, arms the
// approval gate (approval-gate: file-edits), and lists in the model-visible
// <available_skills> manifest. Unknown approval-gate values stay ignored.
import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, rm, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadSkills, parseSkillFrontmatter, skillsPromptSection } from "../src/skills.js";

const BUNDLED = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "skills", "deslop");

describe("ω99-56 — deslop skill asset", () => {
  it("the bundled skills/deslop/SKILL.md installs and loads from a project root", async () => {
    const ws = await mkdtemp(join(tmpdir(), "wudao-deslopskill-"));
    try {
      await mkdir(join(ws, ".wudao", "skills"), { recursive: true });
      await cp(BUNDLED, join(ws, ".wudao", "skills", "deslop"), { recursive: true });
      const skills = loadSkills(ws, () => {});
      const deslop = skills.find((s) => s.name === "deslop");
      expect(deslop).toBeDefined();
      expect(deslop?.description.length ?? 0).toBeGreaterThan(10);
      // The gate posture rides the frontmatter into LoadedSkill — the driver
      // arms off exactly this field.
      expect(deslop?.approvalGate).toBe("file-edits");
      // The manifest lists it for the model (path form, workspace-relative).
      const manifest = skillsPromptSection(skills);
      expect(manifest).toContain("- name: deslop");
      expect(manifest).toContain("path: .wudao/skills/deslop/SKILL.md");
    } finally {
      await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("approval-gate parses ONLY the recognized mode — junk values carry nothing (fail-closed)", () => {
    const base = (value: string): string =>
      ["---", "name: t", "description: d", `approval-gate: ${value}`, "---", "body"].join("\n");
    expect(parseSkillFrontmatter(base("file-edits")).approvalGate).toBe("file-edits");
    expect(parseSkillFrontmatter(base("file-edits ")).approvalGate).toBe("file-edits"); // trimmed
    expect(parseSkillFrontmatter(base("nonsense")).approvalGate).toBeUndefined();
    expect(parseSkillFrontmatter(base("")).approvalGate).toBeUndefined();
    expect(parseSkillFrontmatter(base('"file-edits"')).approvalGate).toBe("file-edits"); // quoted form
    expect(parseSkillFrontmatter(["---", "name: t", "description: d", "---", "b"].join("\n")).approvalGate).toBeUndefined();
  });
});
