// 夜移 029 — skill search (CCB DiscoverSkills TF-IDF 的阈值门控移植).
// The model-visible skill manifest (skillsPromptSection) is the only
// discovery channel today, and it is all-or-nothing resident prefix bytes.
// At plugin/marketplace scale the manifest stops being scannable long
// before it stops being affordable; this module is the on-demand search
// that takes over there — a pure scorer over the already-loaded
// LoadedSkill[], surfaced through the threshold-gated `discover_skills`
// tool (tools.ts registers it only when >= SKILL_SEARCH_MIN_SKILLS are
// visible; below that the toolset bytes are unchanged).
//
// Algorithm (CCB services/skillSearch/localSearch.ts, field-weighted
// TF-IDF): per-field max-normalized TF × FIELD_WEIGHT, max across fields;
// IDF log(N/df) over per-skill token sets; cosine similarity; a CJK
// bigram noise guard (a single accidental bigram without ascii support
// scores out — Chinese-first product, this guard matters MORE here); a
// name-in-query floor for exact-intent discovery.
//
// Wudao deltas over CCB (recorded in the ledger):
// - The shared tokenizer (M49 tokenize.ts) replaces CCB's private one —
//   no stop-word list: IDF is the principled filter (a term in every
//   skill weighs 0), and the whole lexical family segments identically.
// - No suffix stemmer: wudao's recall/session-search work unstemmed;
//   hand-rolled suffix chopping is an untested heuristic surface. The
//   one segmentation that IS load-bearing — hyphenated skill names
//   ("deploy-tool" must match the query "deploy") — is kept via
//   nameParts, CCB's splitHyphenatedName equivalent.
// - disableModelInvocation skills stay SEARCHABLE (CCB skips them): the
//   M58 flag hides a skill from the resident manifest, not from
//   existence — /skill: invocation stays open, so discovery may surface
//   it. The `paths:` gate is likewise manifest-time only.
// - No index cache: LoadedSkill[] is already in memory and small; CCB's
//   cwd-keyed cache exists because their index re-reads the filesystem.
export { tokenizeText } from "./tokenize.js";

import { buildTool, type Tool } from "@wudao-org/core";
import { hasCjk, tokenizeText } from "./tokenize.js";
import type { LoadedSkill } from "./skills.js";

/** Tool registration threshold: at fewer VISIBLE skills the manifest scans
 *  fine and `discover_skills` stays out of the toolset (zero byte change);
 *  at this many the search tool earns its schema bytes. Skills are
 *  session-static (live reload is restart-scoped), so the decision is
 *  boot-time and the tool-list prefix stays stable all session. */
export const SKILL_SEARCH_MIN_SKILLS = 12;
/** Results below this cosine are noise — dropped (CCB DISPLAY_MIN_SCORE). */
export const SKILL_DISPLAY_MIN_SCORE = 0.1;
/** CJK guard: fewer matching query bigrams than this (and no ascii match)
 *  is accidental overlap, not intent — scored out. */
export const CJK_MIN_BIGRAM_MATCHES = 2;
/** The query naming the skill outright is exact intent — the floor. */
export const SKILL_NAME_FLOOR = 0.75;
/** Names shorter than this never take the floor (CCB NAME_MATCH_MIN_LENGTH). */
export const SKILL_NAME_MATCH_MIN_LENGTH = 4;
/** Tool-face result cap (CCB DiscoverSkillsTool maxResults; default 5). */
export const SKILL_SEARCH_RESULT_LIMIT = 10;
export const SKILL_SEARCH_RESULT_DEFAULT = 5;

/** CCB FIELD_WEIGHT verbatim: where a term matches matters. */
export const FIELD_WEIGHT = {
  name: 3.0,
  whenToUse: 2.0,
  description: 1.0,
  allowedTools: 0.3,
} as const;

/** The manifest-line form — the model acts on a hit by read_file-ing the
 *  relPath or invoking /skill:<name>. */
export interface SkillSearchResult {
  readonly name: string;
  readonly relPath: string;
  readonly description: string;
  readonly score: number;
}

/** Hyphen/underscore parts of a name (>= 3 chars) — "deploy-tool" must
 *  match the query "deploy" even though tokenizeText keeps the hyphenated
 *  run as one token. CCB splitHyphenatedName equivalent. */
function nameParts(name: string): string[] {
  return name
    .toLowerCase()
    .split(/[-_]/)
    .filter((p) => p.length >= 3);
}

/** Per-field max-normalized TF × weight; MAX across fields (a term's weight
 *  is its best field, never summed). CCB computeWeightedTf verbatim. */
function computeWeightedTf(
  fields: ReadonlyArray<{ tokens: readonly string[]; weight: number }>,
): Map<string, number> {
  const weighted = new Map<string, number>();
  for (const field of fields) {
    const freq = new Map<string, number>();
    for (const t of field.tokens) freq.set(t, (freq.get(t) ?? 0) + 1);
    let max = 1;
    for (const v of freq.values()) if (v > max) max = v;
    for (const [term, count] of freq) {
      const val = (count / max) * field.weight;
      const existing = weighted.get(term) ?? 0;
      if (val > existing) weighted.set(term, val);
    }
  }
  return weighted;
}

function cosineSimilarity(
  query: ReadonlyMap<string, number>,
  doc: ReadonlyMap<string, number>,
): number {
  let dot = 0;
  let normQ = 0;
  let normD = 0;
  for (const [term, q] of query) {
    const d = doc.get(term) ?? 0;
    dot += q * d;
    normQ += q * q;
  }
  for (const d of doc.values()) normD += d * d;
  const denom = Math.sqrt(normQ) * Math.sqrt(normD);
  return denom === 0 ? 0 : dot / denom;
}

interface IndexedSkill {
  readonly skill: LoadedSkill;
  readonly tokens: ReadonlySet<string>;
  readonly vector: ReadonlyMap<string, number>;
  readonly normalizedName: string;
}

/** Search the loaded skills for a free-text task description. Pure: no fs,
 *  no cache, no state. Empty query/index → []. */
export function searchSkills(
  skills: readonly LoadedSkill[],
  query: string,
  limit = 5,
): SkillSearchResult[] {
  if (skills.length === 0 || !query.trim()) return [];
  const queryTokens = tokenizeText(query);
  if (queryTokens.length === 0) return [];

  // -- index side -----------------------------------------------------------
  const indexed: IndexedSkill[] = skills.map((skill) => {
    const nameTokens = [...tokenizeText(skill.name), ...nameParts(skill.name)];
    const whenTokens = tokenizeText(skill.whenToUse ?? "");
    const descTokens = tokenizeText(skill.description);
    const toolsTokens = tokenizeText((skill.allowedTools ?? []).join(" "));
    return {
      skill,
      tokens: new Set([...nameTokens, ...whenTokens, ...descTokens, ...toolsTokens]),
      vector: computeWeightedTf([
        { tokens: nameTokens, weight: FIELD_WEIGHT.name },
        { tokens: whenTokens, weight: FIELD_WEIGHT.whenToUse },
        { tokens: descTokens, weight: FIELD_WEIGHT.description },
        { tokens: toolsTokens, weight: FIELD_WEIGHT.allowedTools },
      ]),
      normalizedName: skill.name.toLowerCase().replace(/[-_]/g, " "),
    };
  });

  // IDF over per-skill token sets. Note the single-skill degeneracy:
  // log(N/df) = log(1) = 0 — a one-skill corpus carries no discrimination
  // information, everything scores 0, and only the name floor can fire.
  const df = new Map<string, number>();
  for (const entry of indexed) {
    for (const t of entry.tokens) df.set(t, (df.get(t) ?? 0) + 1);
  }
  const idf = new Map<string, number>();
  for (const [term, count] of df) idf.set(term, Math.log(indexed.length / count));

  for (const entry of indexed) {
    const vec = entry.vector as Map<string, number>;
    for (const [term, tf] of vec) vec.set(term, tf * (idf.get(term) ?? 0));
  }

  // -- query side -----------------------------------------------------------
  const qFreq = new Map<string, number>();
  for (const t of queryTokens) qFreq.set(t, (qFreq.get(t) ?? 0) + 1);
  let qMax = 1;
  for (const v of qFreq.values()) if (v > qMax) qMax = v;
  const queryVec = new Map<string, number>();
  for (const [term, count] of qFreq) {
    const w = (count / qMax) * (idf.get(term) ?? 0);
    if (w > 0) queryVec.set(term, w);
  }

  const queryCjk = queryTokens.filter((t) => hasCjk(t));
  const queryAscii = queryTokens.filter((t) => !hasCjk(t));
  const queryLower = query.toLowerCase().replace(/[-_]/g, " ");

  const out: SkillSearchResult[] = [];
  for (const entry of indexed) {
    let score = cosineSimilarity(queryVec, entry.vector);

    // CJK guard: one accidental bigram with no ascii support is noise.
    if (queryCjk.length > 0 && score > 0) {
      const matching = queryCjk.filter((t) => entry.tokens.has(t)).length;
      if (matching < CJK_MIN_BIGRAM_MATCHES) {
        const asciiHit = queryAscii.some((t) => entry.tokens.has(t));
        if (!asciiHit) score = 0;
      }
    }

    // Name floor: the query naming the skill is exact intent.
    if (entry.skill.name.length >= SKILL_NAME_MATCH_MIN_LENGTH) {
      if (queryLower.includes(entry.normalizedName)) {
        score = Math.max(score, SKILL_NAME_FLOOR);
      }
    }

    if (score >= SKILL_DISPLAY_MIN_SCORE) {
      out.push({
        name: entry.skill.name,
        relPath: entry.skill.relPath,
        description: entry.skill.description,
        score,
      });
    }
  }

  out.sort((a, b) => b.score - a.score);
  return out.slice(0, limit);
}

/** The threshold decision, ONE place: the tool registers when the
 *  model-visible manifest (the disableModelInvocation filter skillsPromptSection
 *  applies) has at least SKILL_SEARCH_MIN_SKILLS lines — the population whose
 *  scannability the tool exists to rescue. Pure. */
export function skillSearchEligible(skills: readonly LoadedSkill[]): boolean {
  let visible = 0;
  for (const s of skills) if (s.disableModelInvocation !== true) visible += 1;
  return visible >= SKILL_SEARCH_MIN_SKILLS;
}

/** 夜移 029 tool face — the read-only `discover_skills` search tool. Pure
 *  in-memory scoring (no fs, no state); the threshold gate lives in
 *  buildToolSet (present + eligible → registered at a fixed top-level
 *  position; else zero surface). The result lines carry the manifest-line
 *  form so a hit is directly actionable: read_file the path (workspace
 *  skills) or invoke /skill:<name> (global-tier, path outside the box). */
export function createDiscoverSkillsTool(skills: readonly LoadedSkill[]): Tool {
  return buildTool({
    name: "discover_skills",
    description:
      "Search installed skills by task description when the skill list is too long to scan. Returns the best-matching skills (name, description, path). Follow a hit by read_file-ing its path, or invoke /skill:<name> when the line says invoke. Read-only; CJK and latin both supported.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "What you are trying to do, free text." },
        limit: { type: "number", description: `Max results (1-${SKILL_SEARCH_RESULT_LIMIT}, default 5).` },
      },
      required: ["query"],
      additionalProperties: false,
    },
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    isDestructive: () => false,
    isOpenWorld: () => false,
    async execute(args) {
      const query = typeof args.query === "string" ? args.query.trim() : "";
      if (query === "") {
        return { content: "discover_skills invalid arguments: query must be a non-empty string", isError: true };
      }
      const limitRaw = args.limit;
      const limit =
        typeof limitRaw === "number" && Number.isFinite(limitRaw)
          ? Math.min(Math.max(Math.round(limitRaw), 1), SKILL_SEARCH_RESULT_LIMIT)
          : SKILL_SEARCH_RESULT_DEFAULT;
      const hits = searchSkills(skills, query, limit);
      if (hits.length === 0) {
        return { content: `(no skills match "${query}" — try the task's nouns, or the skill's name)` };
      }
      return {
        content: hits
          .map((h) => `${h.name} — ${h.description} (path: ${h.relPath})`)
          .join("\n"),
      };
    },
  });
}
