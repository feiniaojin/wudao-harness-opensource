// det-74-night-porting-17 — the deterministic behavior pins for 夜移 029
// (skill search, CCB DiscoverSkills TF-IDF ported threshold-gated). The
// model-visible skill manifest is the only discovery channel today, and it
// is all-or-nothing resident prefix bytes; at plugin scale the manifest
// stops being scannable long before it stops being affordable. This suite
// pins the ported scorer through the PUBLIC export
// (`wudao-harness/skill-search`): the CCB constants (field weights, display
// floor, CJK guard threshold, name floor), the field-weight discrimination
// (a name hit outranks a description hit for the same term), the CJK bigram
// noise guard matrix (single accidental bigram scored out, ≥2 pass, an
// ascii match redeems), the name-in-query floor (exact intent), the idf
// saturation law (a term every skill mentions weighs 0 — the reason the
// wudao port needs no stop-word list), and the threshold gate over the
// model-visible population (disableModelInvocation does not count). Zero
// fs, zero network, zero state — the scorer is pure.
import type { EvalDefinition } from "../runner.js";
import {
  searchSkills,
  skillSearchEligible,
  createDiscoverSkillsTool,
  FIELD_WEIGHT,
  SKILL_SEARCH_MIN_SKILLS,
  SKILL_DISPLAY_MIN_SCORE,
  CJK_MIN_BIGRAM_MATCHES,
  SKILL_NAME_FLOOR,
  SKILL_NAME_MATCH_MIN_LENGTH,
  SKILL_SEARCH_RESULT_LIMIT,
} from "wudao-harness/skill-search";
import type { LoadedSkill } from "wudao-harness/skills";

function mk(partial: Partial<LoadedSkill> & { name: string }): LoadedSkill {
  return {
    description: "",
    filePath: `/w/${partial.name}/SKILL.md`,
    relPath: `.wudao/skills/${partial.name}/SKILL.md`,
    content: "",
    ...partial,
  };
}

/** Non-matching diluent: keeps matched terms' df < N so idf > 0. */
const garden = (over: Partial<LoadedSkill> = {}): LoadedSkill =>
  mk({ name: "garden", description: "种花浇水 planting flowers", ...over });

export interface NightPorting17Evidence {
  // ① the CCB constants arrive unrounded: weights 3/2/1/0.3, floor 0.10,
  //    CJK guard at 2 bigrams, name floor 0.75 from length 4, cap 10
  readonly constants: boolean;
  // ② field-weight discrimination: same term, name field beats description
  readonly fieldWeightPriority: boolean;
  // ③ CJK guard: one accidental bigram (idf>0, score would be positive)
  //    without ascii support scores OUT; two bigrams pass; ascii redeems
  readonly cjkGuardMatrix: boolean;
  // ④ name-in-query floor: the query naming the skill is exact intent (0.75)
  readonly nameFloor: boolean;
  // ⑤ idf saturation: a term EVERY skill mentions weighs 0 (the principled
  //    stop-word filter — why the wudao port drops CCB's hand-rolled list)
  readonly idfSaturation: boolean;
  // ⑥ threshold gate counts MODEL-VISIBLE skills only (the manifest
  //    population, disableModelInvocation excluded)
  readonly thresholdGate: boolean;
  // ⑦ tool face: manifest-line results over the UNGATED list, empty-case
  //    hint, query validation, limit clamp
  readonly toolFace: boolean;
}

export const det74Eval: EvalDefinition<Record<string, never>, NightPorting17Evidence> = {
  name: "det-74-night-porting-17",
  kind: "deterministic",
  async setup() {
    return {};
  },
  async run() {
    // ① constants.
    const constants = SKILL_SEARCH_MIN_SKILLS === 12
      && SKILL_DISPLAY_MIN_SCORE === 0.1
      && FIELD_WEIGHT.name === 3.0
      && FIELD_WEIGHT.whenToUse === 2.0
      && FIELD_WEIGHT.description === 1.0
      && FIELD_WEIGHT.allowedTools === 0.3
      && CJK_MIN_BIGRAM_MATCHES === 2
      && SKILL_NAME_FLOOR === 0.75
      && SKILL_NAME_MATCH_MIN_LENGTH === 4
      && SKILL_SEARCH_RESULT_LIMIT === 10;

    // ② field-weight discrimination: "deploy" in deploy-tool's name (3.0)
    // vs widget's description (1.0); everything else identical.
    const priorityCorpus = [
      mk({ name: "widget", description: "deploy helper utilities" }),
      mk({ name: "deploy-tool", description: "helper utilities" }),
      garden(),
    ];
    const ranked = searchSkills(priorityCorpus, "deploy");
    const widget = ranked.find((r) => r.name === "widget");
    const fieldWeightPriority = ranked.length > 0
      && ranked[0]!.name === "deploy-tool"
      && (widget === undefined || ranked[0]!.score > widget.score);

    // ③ CJK guard matrix (diluent keeps 数据/schema idf > 0, so the
    //    guard — not idf degeneracy — is what zeroes the single bigram).
    const cjkCorpus = [
      mk({ name: "db-migrate", description: "数据库 schema 迁移工具" }),
      garden(),
    ];
    const accidental = searchSkills(cjkCorpus, "清理数据脚本").length === 0;
    const real = searchSkills(cjkCorpus, "数据库迁移");
    const redeemCorpus = [
      mk({ name: "db-migrate", description: "数据库 schema migration tool" }),
      garden(),
    ];
    const redeemed = searchSkills(redeemCorpus, "数据 schema 清理");
    const cjkGuardMatrix = accidental
      && real.length === 1 && real[0]!.name === "db-migrate"
      && redeemed.length === 1 && redeemed[0]!.name === "db-migrate";

    // ④ name floor.
    const floorCorpus = [
      mk({ name: "release-checklist", description: "long generic text about shipping software carefully" }),
      mk({ name: "ship", description: "release checklist" }),
    ];
    const floored = searchSkills(floorCorpus, "run the release-checklist process");
    const nameFloor = floored.length > 0
      && floored[0]!.name === "release-checklist"
      && floored[0]!.score >= 0.75;

    // ⑤ idf saturation: every skill mentions "deploy" → zero hits for a
    //    deploy-only query (no rank information in a saturated corpus).
    const saturated = [
      mk({ name: "deploy-a", description: "deploy things" }),
      mk({ name: "deploy-b", description: "deploy widgets" }),
      mk({ name: "deploy-c", description: "deploy gadgets" }),
    ];
    const idfSaturation = searchSkills(saturated, "deploy").length === 0;

    // ⑥ threshold gate over the model-visible population.
    const nVisible = (n: number, over: Partial<LoadedSkill> = {}): LoadedSkill[] =>
      Array.from({ length: n }, (_, i) => mk({ name: `skill-${String(i).padStart(2, "0")}`, description: `fixture skill ${i}`, ...over }));
    const thresholdGate = !skillSearchEligible(nVisible(11))
      && skillSearchEligible(nVisible(12))
      && skillSearchEligible([...nVisible(12), mk({ name: "hidden", description: "", disableModelInvocation: true })])
      && !skillSearchEligible([...nVisible(10), mk({ name: "hidden-a", description: "", disableModelInvocation: true }), mk({ name: "hidden-b", description: "", disableModelInvocation: true })]);

    // ⑦ tool face: the manifest-line result form over the UNGATED list,
    //    empty-case hint, blank-query refusal, limit clamp at the cap.
    const toolCorpus = [...nVisible(12), mk({ name: "secret-deploy", description: "deploy things quietly", disableModelInvocation: true })];
    const tool = createDiscoverSkillsTool(toolCorpus);
    const hit = await tool.execute({ query: "deploy" });
    const lines = typeof hit.content === "string" ? hit.content.split("\n") : [];
    const overCap = await tool.execute({ query: "deploy", limit: 99 });
    const overCapLines = typeof overCap.content === "string" ? overCap.content.split("\n") : [];
    const empty = await tool.execute({ query: "guitar solo" });
    const blank = await tool.execute({ query: "   " });
    const toolFace = hit.isError !== true
      && lines.some((l) => l.includes("secret-deploy") && l.includes("(path: .wudao/skills/secret-deploy/SKILL.md)"))
      && overCap.isError !== true && overCapLines.length <= SKILL_SEARCH_RESULT_LIMIT
      && empty.isError !== true && typeof empty.content === "string" && empty.content.includes("no skills match")
      && blank.isError === true;

    return { constants, fieldWeightPriority, cjkGuardMatrix, nameFloor, idfSaturation, thresholdGate, toolFace };
  },
  assertions(e) {
    const errs: string[] = [];
    const need = (ok: boolean, msg: string) => {
      if (!ok) errs.push(msg);
    };

    need(e.constants, "① the CCB constants must arrive unrounded (weights 3/2/1/0.3, floor 0.10, CJK guard 2, name floor 0.75/4, cap 10)");
    need(e.fieldWeightPriority, "② a name-field hit must outrank a description-field hit for the same term");
    need(e.cjkGuardMatrix, "③ the CJK guard must zero a single accidental bigram without ascii support, pass ≥2 bigrams, and let an ascii match redeem");
    need(e.nameFloor, "④ a query containing the skill name must rank it first at ≥0.75 (exact intent)");
    need(e.idfSaturation, "⑤ a term every skill mentions must weigh 0 (idf saturation — the principled stop-word filter)");
    need(e.thresholdGate, "⑥ the threshold gate must count MODEL-VISIBLE skills only (12; disableModelInvocation excluded)");
    need(e.toolFace, "⑦ the tool face must answer in manifest-line form over the ungated list, hint on empty, refuse blank queries, clamp the limit");

    return errs;
  },
};
