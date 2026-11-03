// 夜移 029 — skill search (CCB DiscoverSkills TF-IDF, threshold-gated) contract
// tests. The core is a pure scorer over LoadedSkill[]: field-weighted TF-IDF
// (name 3.0 / whenToUse 2.0 / description 1.0 / allowedTools 0.3), cosine
// similarity, a CJK bigram noise guard, and a name-in-query score floor. The
// tool registration is threshold-gated (>= SKILL_SEARCH_MIN_SKILLS visible
// skills) — below the threshold the toolset bytes are unchanged.
//
// Test-corpus discipline: idf = log(N/df), so a term EVERY skill mentions
// weighs 0 (no rank information), and a single-skill corpus makes EVERY term
// weigh 0 (only the name floor can fire). Scoring tests therefore carry a
// `garden` diluent so matched terms keep df < N.
import { describe, expect, test } from "vitest";
import {
  searchSkills,
  skillSearchEligible,
  createDiscoverSkillsTool,
  FIELD_WEIGHT,
  SKILL_SEARCH_MIN_SKILLS,
  SKILL_DISPLAY_MIN_SCORE,
} from "../src/skill-search.js";
import type { LoadedSkill } from "../src/skills.js";
import { buildToolSet } from "../src/tools.js";
import type { ModelClient, ModelInput, AssistantMessage, PermissionDecision, Tool } from "@wudao-org/core";

function skill(partial: Partial<LoadedSkill> & { name: string }): LoadedSkill {
  return {
    description: "",
    filePath: `/w/${partial.name}/SKILL.md`,
    relPath: `.wudao/skills/${partial.name}/SKILL.md`,
    content: "",
    ...partial,
  };
}

/** Non-matching diluent: keeps the matched terms' df < N so idf > 0. */
const garden = (over: Partial<LoadedSkill> = {}): LoadedSkill =>
  skill({ name: "garden", description: "种花浇水 planting flowers", ...over });

describe("searchSkills", () => {
  test("A field-weight priority: a name hit outranks a description hit for the same term", () => {
    // Controlled experiment: "deploy" lives in widget's description (weight
    // 1.0) and in deploy-tool's name (weight 3.0, via hyphen parts); all
    // other text is identical. The name-field hit must rank higher.
    const skills = [
      skill({ name: "widget", description: "deploy helper utilities" }),
      skill({ name: "deploy-tool", description: "helper utilities" }),
      garden(),
    ];
    const out = searchSkills(skills, "deploy");
    expect(out.length).toBeGreaterThan(0);
    expect(out[0]!.name).toBe("deploy-tool");
    const widget = out.find((r) => r.name === "widget");
    if (widget) expect(out[0]!.score).toBeGreaterThan(widget.score);
    expect(FIELD_WEIGHT.name).toBeGreaterThan(FIELD_WEIGHT.whenToUse);
    expect(FIELD_WEIGHT.whenToUse).toBeGreaterThan(FIELD_WEIGHT.description);
    expect(FIELD_WEIGHT.description).toBeGreaterThan(FIELD_WEIGHT.allowedTools);
  });

  test("B the name-in-query floor: query containing the skill name ranks it first", () => {
    const skills = [
      skill({ name: "release-checklist", description: "long generic text about shipping software carefully" }),
      skill({ name: "ship", description: "release checklist" }),
    ];
    const out = searchSkills(skills, "run the release-checklist process");
    expect(out[0]!.name).toBe("release-checklist");
    expect(out[0]!.score).toBeGreaterThanOrEqual(0.75);
  });

  test("C CJK guard: one accidental bigram match without ascii support scores out", () => {
    // 「数据」bigram 命中且 idf>0（score 本可为正），但仅此一个 bigram、
    // 无 ascii 命中 → 守卫归零。这是守卫（而非 idf 退化）在起作用。
    const skills = [
      skill({ name: "db-migrate", description: "数据库 schema 迁移工具" }),
      garden(),
    ];
    // 「清理」「理数」「据脚」「脚本」不命中 —— 单 bigram 无 ascii 支撑
    const out = searchSkills(skills, "清理数据脚本");
    expect(out.length).toBe(0);
  });

  test("D CJK guard: two matching bigrams pass (real Chinese query finds the skill)", () => {
    const skills = [
      skill({ name: "db-migrate", description: "数据库 schema 迁移工具" }),
      garden(),
    ];
    // 「数据」「据库」「迁移」多个 bigram 命中
    const out = searchSkills(skills, "数据库迁移");
    expect(out.length).toBe(1);
    expect(out[0]!.name).toBe("db-migrate");
  });

  test("E CJK guard: an ascii match redeems a single bigram hit", () => {
    const skills = [
      skill({ name: "db-migrate", description: "数据库 schema migration tool" }),
      garden(),
    ];
    // 「数据」单 bigram 命中 + 「schema」ascii 命中 → 守卫放行
    const out = searchSkills(skills, "数据 schema 清理");
    expect(out.length).toBe(1);
    expect(out[0]!.name).toBe("db-migrate");
  });

  test("F display floor: below SKILL_DISPLAY_MIN_SCORE is dropped", () => {
    expect(SKILL_DISPLAY_MIN_SCORE).toBe(0.1);
    const skills = [
      skill({ name: "guitar", description: "play the guitar loudly" }),
      garden(),
    ];
    const out = searchSkills(skills, "deploy kubernetes cluster");
    expect(out.length).toBe(0);
  });

  test("G limit caps the result count (highest scores first)", () => {
    const skills = [
      skill({ name: "deploy-a", description: "deploy things" }),
      skill({ name: "deploy-b", description: "deploy widgets" }),
      skill({ name: "deploy-c", description: "deploy gadgets" }),
      garden(),
    ];
    const out = searchSkills(skills, "deploy", 2);
    expect(out.length).toBe(2);
    expect(out[0]!.score).toBeGreaterThanOrEqual(out[1]!.score);
  });

  test("H empty query or whitespace returns nothing", () => {
    const skills = [skill({ name: "deploy", description: "deploy things" })];
    expect(searchSkills(skills, "")).toEqual([]);
    expect(searchSkills(skills, "   ")).toEqual([]);
  });

  test("I empty index returns nothing", () => {
    expect(searchSkills([], "deploy")).toEqual([]);
  });

  test("J case-insensitive: uppercase query matches lowercase skill text", () => {
    const skills = [
      skill({ name: "terraform-plan", description: "plan infrastructure" }),
      garden(),
    ];
    const out = searchSkills(skills, "TERRAFORM PLAN");
    expect(out.length).toBe(1);
    expect(out[0]!.name).toBe("terraform-plan");
  });

  test("K result shape carries the manifest-line form (relPath + description)", () => {
    const skills = [
      skill({ name: "deploy", description: "ship it", relPath: ".wudao/skills/deploy/SKILL.md" }),
      garden(),
    ];
    const [r] = searchSkills(skills, "deploy");
    expect(r).toBeDefined();
    expect(r!.name).toBe("deploy");
    expect(r!.relPath).toBe(".wudao/skills/deploy/SKILL.md");
    expect(r!.description).toBe("ship it");
    expect(typeof r!.score).toBe("number");
  });

  test("L disableModelInvocation skills stay searchable (the tool is the discovery channel, not the manifest)", () => {
    const skills = [
      skill({ name: "hidden-deploy", description: "deploy things", disableModelInvocation: true }),
      garden(),
    ];
    const out = searchSkills(skills, "deploy");
    expect(out.length).toBe(1);
    expect(out[0]!.name).toBe("hidden-deploy");
  });

  test("M SKILL_SEARCH_MIN_SKILLS pin", () => {
    expect(SKILL_SEARCH_MIN_SKILLS).toBe(12);
  });
});

// 夜移 029 registration — the threshold gate in buildToolSet. Present AND
// enough model-visible skills → discover_skills joins the TOP-LEVEL set at a
// fixed position; below the threshold the tool stays out and the tool-list
// BYTES are unchanged (the pin that guards the absolute tool-list fixtures,
// det-25's wantFirst included).
const fakeModel: ModelClient = {
  async generate(_input: ModelInput): Promise<AssistantMessage> {
    return { role: "assistant", content: "" };
  },
};
const allowAll = async (): Promise<PermissionDecision> => ({ behavior: "allow" });

function build(skills?: readonly LoadedSkill[]): readonly Tool[] {
  return buildToolSet({
    workspaceRoot: "/w/e2e-root",
    model: fakeModel,
    canUseTool: allowAll,
    contextWindowTokens: 64_000,
    ...(skills !== undefined ? { skills } : {}),
  });
}

function nVisible(n: number, over: Partial<LoadedSkill> = {}): LoadedSkill[] {
  // Distinct discriminators per skill (alpha/beta/… + zero-padded number
  // tokens): a shared-word-only corpus saturates idf (df=N → 0) and NOTHING
  // discriminates — the scorer's honest answer to a degenerate corpus.
  const families = ["alpha", "beta", "gamma", "delta"] as const;
  return Array.from({ length: n }, (_, i) => {
    const padded = String(i).padStart(2, "0");
    return skill({ name: `skill-${padded}`, description: `fixture ${families[i % 4]!} descriptor ${padded}`, ...over });
  });
}

describe("skillSearchEligible + discover_skills registration", () => {
  test("N eligible at >= 12 MODEL-VISIBLE skills (disableModelInvocation does not count)", () => {
    expect(skillSearchEligible(nVisible(11))).toBe(false);
    expect(skillSearchEligible(nVisible(12))).toBe(true);
    // 13 loaded but 1 hidden from the manifest → 12 visible → eligible.
    const twelvePlusHidden = [...nVisible(12), skill({ name: "hidden", description: "", disableModelInvocation: true })];
    expect(skillSearchEligible(twelvePlusHidden)).toBe(true);
    // 12 loaded but 2 hidden → 10 visible → not eligible.
    const tenVisible = [...nVisible(10), skill({ name: "hidden-a", description: "", disableModelInvocation: true }), skill({ name: "hidden-b", description: "", disableModelInvocation: true })];
    expect(skillSearchEligible(tenVisible)).toBe(false);
  });

  test("O at threshold: discover_skills registers top-level at a fixed position (after web_fetch, before task)", () => {
    const tools = build(nVisible(12));
    const names = tools.map((t) => t.name);
    expect(names).toContain("discover_skills");
    const at = names.indexOf("discover_skills");
    expect(at).toBeGreaterThan(names.indexOf("web_fetch"));
    expect(at).toBeLessThan(names.indexOf("task"));
  });

  test("P below threshold: discover_skills ABSENT and the tool-list bytes are unchanged", () => {
    const baseline = build().map((t) => t.name);
    const below = build(nVisible(11)).map((t) => t.name);
    expect(below).not.toContain("discover_skills");
    expect(below).toEqual(baseline);
  });

  test("Q tool executes: manifest-line results, empty-case hint, query validation", async () => {
    const tools = build(nVisible(12));
    const t = tools.find((x) => x.name === "discover_skills")!;
    // skill-01 is the beta family; "01" is its unique number token.
    const hits = await t.execute({ query: "beta descriptor 01" });
    expect(hits.isError).toBeFalsy();
    expect(hits.content).toContain("skill-01");
    expect(hits.content).toContain("(path: .wudao/skills/skill-01/SKILL.md)");
    const none = await t.execute({ query: "guitar solo" });
    expect(none.isError).toBeFalsy();
    expect(none.content).toContain("no skills match");
    const bad = await t.execute({ query: "   " });
    expect(bad.isError).toBe(true);
    // limit clamp: the alpha family has 3 members; limit 1 keeps one line.
    const one = await t.execute({ query: "alpha descriptor", limit: 1 });
    expect(one.isError).toBeFalsy();
    expect(one.content!.split("\n").length).toBe(1);
    expect(one.content).toContain("skill-0");
  });

  test("R the factory answers over the UNGATED list (hidden skills stay discoverable)", async () => {
    const skills = [...nVisible(12), skill({ name: "secret-deploy", description: "deploy things quietly", disableModelInvocation: true })];
    const t = createDiscoverSkillsTool(skills);
    const res = await t.execute({ query: "deploy" });
    expect(res.isError).toBeFalsy();
    expect(res.content).toContain("secret-deploy");
  });
});
