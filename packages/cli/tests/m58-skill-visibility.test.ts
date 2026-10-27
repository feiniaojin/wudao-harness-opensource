// M58 §C#4 — skill visibility: `disable-model-invocation: true` (frontmatter
// or the settings `skills.overrides` overlay, both tiers unioned) hides a
// skill from the MODEL-visible manifest entirely (zero resident bytes) while
// `/skill:<name>` keeps resolving it. The warn-on-shadow attribution the M57
// loader prints is untouched.
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseSkillFrontmatter,
  loadSkills,
  skillsPromptSection,
  findSkill,
  buildSkillInvocationMessage,
  parseSkillOverrides,
  loadSkillOverrides,
  applySkillVisibility,
  type LoadedSkill,
} from "../src/skills.js";

const GLOBAL_ENV_KEY = "WUDAO_GLOBAL_HOME";

let savedEnv: string | undefined;
function setGlobalHome(path: string): void {
  savedEnv = process.env[GLOBAL_ENV_KEY];
  process.env[GLOBAL_ENV_KEY] = path;
}
function clearGlobalHome(): void {
  if (savedEnv === undefined) delete process.env[GLOBAL_ENV_KEY];
  else process.env[GLOBAL_ENV_KEY] = savedEnv;
}

function tmpDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** Write <ws>/.wudao/skills/<name>/SKILL.md with the given file text. */
function writeSkill(ws: string, name: string, text: string): string {
  const dir = join(ws, ".wudao", "skills", name);
  mkdirSync(dir, { recursive: true });
  const filePath = join(dir, "SKILL.md");
  writeFileSync(filePath, text, "utf8");
  return filePath;
}

function skillMd(name: string, extra = "", body = "Do the thing."): string {
  return `---\nname: ${name}\ndescription: ${name} desc${extra ? `\n${extra}` : ""}\n---\n\n# ${name}\n\n${body}\n`;
}

afterEach(() => {
  clearGlobalHome();
});

// ---------------------------------------------------------------------------
// Frontmatter
// ---------------------------------------------------------------------------

describe("parseSkillFrontmatter — disable-model-invocation (M58 §C#4)", () => {
  it("literal true parses onto the frontmatter", () => {
    expect(parseSkillFrontmatter(skillMd("hidden", "disable-model-invocation: true"))).toEqual({
      name: "hidden",
      description: "hidden desc",
      disableModelInvocation: true,
    });
  });
  it("false / junk values are ignored (tolerant, same posture as unknown keys)", () => {
    expect(parseSkillFrontmatter(skillMd("shown", "disable-model-invocation: false")).disableModelInvocation).toBeUndefined();
    expect(parseSkillFrontmatter(skillMd("shown", "disable-model-invocation: yes")).disableModelInvocation).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Loader + manifest
// ---------------------------------------------------------------------------

describe("disable-model-invocation — zero resident cost", () => {
  it("the loader carries the flag; skillsPromptSection drops the skill entirely", () => {
    const ws = tmpDir("wudao-skill-vis-");
    try {
      writeSkill(ws, "hidden", skillMd("hidden", "disable-model-invocation: true"));
      writeSkill(ws, "shown", skillMd("shown"));
      const skills = loadSkills(ws);
      expect(skills.find((s) => s.name === "hidden")?.disableModelInvocation).toBe(true);
      const section = skillsPromptSection(skills);
      expect(section).not.toContain("hidden");
      expect(section).toContain("shown");
      // All hidden → the section vanishes byte-for-byte ("" baseline).
      expect(skillsPromptSection(skills.filter((s) => s.name === "hidden"))).toBe("");
    } finally {
      rmSync(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("a hidden skill stays /skill:-invocable (findSkill + envelope on the UNGATED list)", () => {
    const ws = tmpDir("wudao-skill-inv-");
    try {
      writeSkill(ws, "hidden", skillMd("hidden", "disable-model-invocation: true"));
      const skills = loadSkills(ws);
      const skill = findSkill(skills, "hidden");
      expect(skill).toBeDefined();
      expect(buildSkillInvocationMessage(skill as LoadedSkill, "")).toContain("<skill name=\"hidden\"");
    } finally {
      rmSync(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
});

// ---------------------------------------------------------------------------
// Settings overlay (skills.overrides, two tiers, union)
// ---------------------------------------------------------------------------

describe("parseSkillOverrides — tolerant shapes", () => {
  it("parses name → {disableModelInvocation}", () => {
    const map = parseSkillOverrides({ alpha: { disableModelInvocation: true }, beta: { disableModelInvocation: false } });
    expect(map.get("alpha")).toEqual({ disableModelInvocation: true });
    expect(map.get("beta")).toEqual({ disableModelInvocation: false });
  });
  it("non-object nodes / non-boolean flags / non-object per-name values are skipped", () => {
    expect(parseSkillOverrides(undefined).size).toBe(0);
    expect(parseSkillOverrides("nope").size).toBe(0);
    expect(parseSkillOverrides([1, 2]).size).toBe(0);
    const map = parseSkillOverrides({ junk: "string", arr: [1], bad: { disableModelInvocation: "yes" }, empty: {} });
    expect(map.size).toBe(0);
  });
});

describe("loadSkillOverrides — two-tier union", () => {
  it("disables UNION across the global and project tiers; a project false cannot un-hide a global true", async () => {
    const global = tmpDir("wudao-skill-g-");
    const ws = tmpDir("wudao-skill-ws-");
    try {
      mkdirSync(join(global), { recursive: true });
      writeFileSync(join(global, "settings.json"), JSON.stringify({
        skills: { overrides: { fromGlobal: { disableModelInvocation: true }, bothTiers: { disableModelInvocation: true } } },
      }), "utf8");
      mkdirSync(join(ws, ".wudao"), { recursive: true });
      writeFileSync(join(ws, ".wudao", "settings.json"), JSON.stringify({
        skills: { overrides: { fromProject: { disableModelInvocation: true }, bothTiers: { disableModelInvocation: false } } },
      }), "utf8");
      setGlobalHome(global);
      const overrides = await loadSkillOverrides(ws);
      expect(overrides.get("fromGlobal")?.disableModelInvocation).toBe(true);
      expect(overrides.get("fromProject")?.disableModelInvocation).toBe(true);
      expect(overrides.get("bothTiers")?.disableModelInvocation).toBe(true); // union, not project-wins
    } finally {
      rmSync(global, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      rmSync(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("missing/malformed tiers → empty map (never fatal)", async () => {
    const ws = tmpDir("wudao-skill-none-");
    try {
      setGlobalHome(join(ws, "no-such-global"));
      expect((await loadSkillOverrides(ws)).size).toBe(0);
    } finally {
      rmSync(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
});

describe("applySkillVisibility — the overlay sets the load-time flag", () => {
  const base = (name: string): LoadedSkill => ({
    name,
    description: `${name} desc`,
    filePath: `/x/${name}/SKILL.md`,
    relPath: `.wudao/skills/${name}/SKILL.md`,
    content: skillMd(name),
  });

  it("an overridden skill gains the flag (copy, input untouched); others keep identity", () => {
    const a = base("alpha");
    const b = base("beta");
    const out = applySkillVisibility([a, b], new Map([["alpha", { disableModelInvocation: true }]]));
    expect(out[0]?.disableModelInvocation).toBe(true);
    expect(out[1]).toBe(b); // identity-stable
    expect(a.disableModelInvocation).toBeUndefined(); // input never mutated
  });

  it("end to end: overridden hidden + frontmatter hidden + visible → the manifest names only the visible one", () => {
    const skills = applySkillVisibility(
      [base("frontHidden"), base("overHidden"), base("shown")],
      new Map([["overHidden", { disableModelInvocation: true }]]),
    ).map((s) => (s.name === "frontHidden" ? { ...s, disableModelInvocation: true as const } : s));
    const section = skillsPromptSection(skills);
    expect(section).not.toContain("frontHidden");
    expect(section).not.toContain("overHidden");
    expect(section).toContain("shown");
    expect(findSkill(skills, "overHidden")).toBeDefined(); // still invocable
  });
});
