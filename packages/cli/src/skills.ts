// Skills (M27) — progressive-disclosure capability packs, pi-style.
// A skill = <dir>/SKILL.md with a minimal line-style frontmatter (`name:` /
// `description:`, hand-parsed — zero yaml dependency). The body is plain
// markdown knowledge; it has NO runtime semantics.
//
// Discovery (first-wins on duplicate names, with a diagnostic warning):
//   <workspaceRoot>/.agents/skills/*/SKILL.md   (ecosystem location — Claude
//                                               Code / Codex / Anthropic skills
//                                               drop in unchanged)
//   <workspaceRoot>/.wudao/skills/*/SKILL.md    (project native)
//   ~/.claude/skills/*/SKILL.md                 (PERSONAL tier, cc-plugins D1 —
//                                               CC's own location; overrides the
//                                               project .claude root only)
//   <workspaceRoot>/.claude/skills/*/SKILL.md   (project CC location)
//   ~/.wudao/skills/*/SKILL.md                  (global, M57 — fills gaps)
//   <plugin>/skills/*/SKILL.md                  (M36 — tagged, never shadows)
//
// Prompt: when skills exist AND the agent has a read tool, the system prompt
// gains a trailing <available_skills> manifest (a couple of lines per skill).
// The model loads a full SKILL.md on demand via read_file — zero resident
// tokens. Without a read tool the manifest is suppressed (the model could not
// act on it). Explicit invocation: `/skill:name [args]` expands the whole file
// into a <skill> user message submitted through the normal prompt path.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, relative, sep } from "node:path";
import { parseSkillPrunedMarker } from "@wudao-org/core";
import type { AgentMessage } from "@wudao-org/core";
import { loadLayeredSettings, resolveGlobalHome } from "./settings-layer.js";
import { globMatchesPath, parseInlineList } from "./rules.js";
// cc-plugins D2 — the invocation-time preprocessor. skills.ts owns the
// envelope; skill-expand.ts owns the substitution/injection mechanics.
import { bodyIncludesInjection, createSkillInjectionExec, expandInjections, expandSubstitutions } from "./skill-expand.js";
import type { SkillInjectionDecide } from "./skill-expand.js";

/** cc-plugins D1 — which discovery tier a skill came from. This is the TRUST
 *  label D2 keys off (approval policy for activation-time injection, help
 *  annotations): "project" = a workspace-relative root (repo-carried content
 *  a clone can bring), "personal" = a user-home root (~/.claude/skills or the
 *  ~/.wudao/skills global tier — the user's own machine), "plugin" = a CC
 *  plugin's skills/ dir (trust decision = the install). */
export type SkillOrigin = "project" | "personal" | "plugin";

/** Discovery roots in priority order (first-wins). Workspace-relative arrays
 *  resolve under the workspace root; a LEADING "~" marks the personal tier,
 *  resolved against the user home via personalSkillRoot. The order encodes
 *  the cc-plugins D1 matrix: ecosystem + project-native roots beat the
 *  personal tier, which in turn beats CC's PROJECT location ("personal
 *  overrides project" for the CC-shaped roots only). */
const SKILL_ROOT_SEGMENTS: ReadonlyArray<readonly string[]> = [
  [".agents", "skills"],
  [".wudao", "skills"],
  ["~", ".claude", "skills"],
  [".claude", "skills"],
];

/** The personal skills tier `~/.claude/skills` (cc-plugins D1). Derived from
 *  resolveGlobalHome so WUDAO_GLOBAL_HOME sandboxes it: the production
 *  `<home>/.wudao` shape makes the tier its SIBLING `<home>/.claude` (the
 *  real ~/.claude/skills); a bare override dir keeps `<dir>/.claude` so a
 *  test sandbox never reaches the developer's actual home. */
export function personalSkillRoot(env: NodeJS.ProcessEnv = process.env): string {
  const global = resolveGlobalHome(env);
  const base = basename(global) === ".wudao" ? dirname(global) : global;
  return join(base, ".claude", "skills");
}

export interface LoadedSkill {
  readonly name: string;
  readonly description: string;
  /** Absolute path of the SKILL.md file (what /skill:name injects). */
  readonly filePath: string;
  /** Posix path relative to the workspace root (the manifest form the model reads). */
  readonly relPath: string;
  /** Full file text, frontmatter included — identical to what read_file returns. */
  readonly content: string;
  /** cc-plugins D1: the discovery/trust tier (see SkillOrigin). Loaders
   *  always set it; a hand-built literal without one reads as "project"
   *  (the conservative tier). */
  readonly origin?: SkillOrigin;
  /** M53 §4: `context: fork` runs the skill's invocation in an ISOLATED fork
   *  (read-only tools, bounded turns) with the result returned to the main
   *  line — instead of expanding the whole SKILL.md into the conversation.
   *  Absent = the default inline expansion. */
  readonly context?: "fork";
  /** cc-plugins D1: `agent:` — the roster ROLE name a `context: fork` skill
   *  runs as. Carried only; consumed at fork time (D3's invocation pass). */
  readonly agent?: string;
  /** ω99-56: `approval-gate: file-edits` — armed at /skill:<name>
   *  invocation (the driver's run gate enforces it for the session's
   *  remainder; /clear disarms). See approval-gate.ts. */
  readonly approvalGate?: "file-edits";
  /** M63-C §3: the skill-position hooks (frontmatter `hooks:` JSON). */
  readonly hooks?: Record<string, readonly unknown[]>;
  /** M58 §C#4: the skill is hidden from the MODEL-visible manifest (zero
   *  resident bytes) while staying invocable via `/skill:<name>`. Set from
   *  the SKILL.md frontmatter at parse time OR from the settings overlay at
   *  load time (see applySkillVisibility). */
  readonly disableModelInvocation?: true;
  /** cc-plugins D1: `when-to-use` — merged into the manifest's description
   *  line (skillsPromptSection); never shown to the model anywhere else. */
  readonly whenToUse?: string;
  /** cc-plugins D1: `argument-hint` — the `/` list's argument shape (D2/D3's
   *  user-facing rendering consumes it; nothing model-visible). */
  readonly argumentHint?: string;
  /** cc-plugins D1: `user-invocable: false` — hidden from the USER-facing
   *  list ONLY. Model visibility and `/skill:<name>` invocation are
   *  unchanged (formatSkillError keeps listing it too). */
  readonly userInvocable?: boolean;
  /** cc-plugins D1: `paths:` — glob gate for the MODEL-visible manifest: the
   *  skill lists only while the session works on a matching file
   *  (skillVisibleForPath). Absent/empty = always listed. */
  readonly paths?: readonly string[];
  /** cc-plugins D1: `allowed-tools:` — activation-time permission allowlist
   *  (D3's invocation pass wires it into the M8 pipeline; parsed + carried
   *  here only). */
  readonly allowedTools?: readonly string[];
  /** cc-plugins D1: `disallowed-tools:` — the disallow twin of allowedTools. */
  readonly disallowedTools?: readonly string[];
  /** cc-plugins D1: `arguments:` — declared argument names, for `$name`
   *  substitution at invocation (D3). Both the inline `[a, b]` and the
   *  indented `- item` forms parse here. */
  readonly argumentsDecl?: readonly string[];
  /** M36: set when the skill came from a CC plugin's skills/ dir (the fourth
   *  discovery source). Same list, same manifest — this tag is for `plugin
   *  list` accounting only. */
  readonly plugin?: string;
  /** cc-plugins D2: a plugin skill's INSTALL scope — "user" (the global
   *  plugins root; the install was the user's own trust decision) vs
   *  "project" (.wudao/plugins — repo-carried) vs "flag" (an explicit
   *  --plugin mount). Keys the dynamic-injection trust tier
   *  (skill-expand.skillInjectionTrusted); absent on non-plugin skills. */
  readonly pluginScope?: "project" | "user" | "flag";
}

export interface SkillFrontmatter {
  /** Undefined when absent/empty — the loader skips such files with a warning. */
  readonly name?: string;
  readonly description: string;
  /** M53 §4: `fork` = isolated-fork execution (see LoadedSkill.context). */
  readonly context?: "fork";
  /** M58 §C#4: `disable-model-invocation: true` — hidden from the model
   *  manifest, still `/skill:`-invocable. Only the literal `true` counts
   *  (tolerant: false/junk are ignored, same posture as unknown keys). */
  readonly disableModelInvocation?: true;
  /** M63-C §3: the skill-position hooks (event keys → entry lists, the
   *  settings hooks.* shape) — armed for the session's remainder at
   *  invocation, cleared by /clear and compaction. */
  readonly hooks?: Record<string, readonly unknown[]>;
  // cc-plugins D1 — the CC frontmatter superset. Everything below is parsed
  // and CARRIED; the fields with a runtime mechanism map at their consumer
  // (see LoadedSkill's field docs), the rest degrade gracefully.
  /** `argument-hint:` — the user-facing invocation shape. */
  readonly argumentHint?: string;
  /** `when-to-use:` / `when_to_use:` — merged into the manifest line. */
  readonly whenToUse?: string;
  /** `user-invocable:` — literal true/false only; false hides from the
   *  user-facing list alone. */
  readonly userInvocable?: boolean;
  /** `paths:` — the manifest glob gate. */
  readonly paths?: readonly string[];
  /** `allowed-tools:` — activation-time allowlist (carried; D3 wires it). */
  readonly allowedTools?: readonly string[];
  /** `disallowed-tools:` — activation-time disallow list (carried; D3). */
  readonly disallowedTools?: readonly string[];
  /** `arguments:` — declared argument names (carried; D3 substitutes them). */
  readonly argumentsDecl?: readonly string[];
  /** `agent:` — the roster role a `context: fork` skill runs as (carried). */
  readonly agent?: string;
  /** ω99-56: `approval-gate: file-edits` — invoking this skill arms the
   *  session's per-path file-edits approval gate (the deslop posture: an
   *  edit/write_file on a path the human has not approved this session asks
   *  instead of silently passing; `a`/`p` answers record the path-scoped
   *  receipt). Only the literal value "file-edits" parses; anything else is
   *  ignored (tolerant, same posture as unknown keys). */
  readonly approvalGate?: "file-edits";
  /** Fields with NO wudao mechanism (model/effort/shell) that were present,
   *  deduped in first-seen order — the loader warns once per skill, then
   *  ignores them (CC's own posture toward unknown fields). */
  readonly unsupported?: readonly string[];
}

/** Frontmatter keys recognized but intentionally inert (cc-plugins D1): wudao
 *  has no per-skill model/effort/shell override yet. Parsed, warned once per
 *  skill, ignored — never an error. */
const UNSUPPORTED_SKILL_FIELDS: ReadonlySet<string> = new Set(["model", "effort", "shell"]);

/** The list-valued frontmatter keys and their SkillFrontmatter field. A bare
 *  `key:` line opens a block list filled by the `- item` lines that follow;
 *  an inline value (`a, b` / `[a, b]` / JSON-ish array) closes it (YAML
 *  shape: block items only ever continue a bare key). */
const LIST_FIELDS: Readonly<Record<string, "paths" | "allowedTools" | "disallowedTools" | "argumentsDecl">> = {
  paths: "paths",
  "allowed-tools": "allowedTools",
  "disallowed-tools": "disallowedTools",
  arguments: "argumentsDecl",
};

/** `key: value` pairs between two `---` fences. Unknown keys and malformed
 *  lines are ignored (tolerant); only a closing `---` ends the block. Values
 *  are trimmed, with one matching pair of surrounding quotes stripped. List
 *  fields take an inline list or a `key:` + `- item` block (cc-plugins D1). */
export function parseSkillFrontmatter(text: string): SkillFrontmatter {
  const lines = text.split(/\r?\n/);
  if ((lines[0] ?? "").trim() !== "---") return { description: "" };
  let name: string | undefined;
  let description = "";
  let context: "fork" | undefined;
  let disableModelInvocation: true | undefined;
  let hooks: Record<string, unknown> | undefined;
  let argumentHint: string | undefined;
  let whenToUse: string | undefined;
  let userInvocable: boolean | undefined;
  let agent: string | undefined;
  let approvalGate: "file-edits" | undefined;
  let unsupported: string[] | undefined;
  const lists: {
    paths?: string[];
    allowedTools?: string[];
    disallowedTools?: string[];
    argumentsDecl?: string[];
  } = {};
  let openList: keyof typeof lists | undefined;
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    if (line.trim() === "---") break;
    const m = /^([A-Za-z0-9_-]+):[ \t]*(.*)$/.exec(line);
    if (!m) {
      // A `- item` line continues the last BARE list key; any other shapeless
      // line (comment, prose, stray dash with no list open) is ignored. The
      // dash needs its separating space (YAML shape) — a hyphen-led prose
      // word like "-based" is not an item.
      const item = /^-(?:[ \t]+(.*))?$/.exec(line.trim());
      if (item !== null && openList !== undefined) {
        const v = stripQuotes((item[1] ?? "").trim());
        if (v !== "") (lists[openList] ??= []).push(v);
      }
      continue;
    }
    openList = undefined; // any key line ends an open block list
    const key = m[1] ?? "";
    const raw = (m[2] ?? "").trim();
    if (UNSUPPORTED_SKILL_FIELDS.has(key)) {
      if (unsupported === undefined) unsupported = [key];
      else if (!unsupported.includes(key)) unsupported.push(key); // deduped
      continue;
    }
    const listField = LIST_FIELDS[key];
    if (listField !== undefined) {
      if (raw === "") {
        lists[listField] ??= []; // block list opens below
        openList = listField;
      } else {
        lists[listField] = parseInlineList(raw);
      }
      continue;
    }
    const value = stripQuotes(raw);
    if (key === "name") {
      if (value !== "") name = value;
    } else if (key === "description") {
      description = value;
    } else if (key === "context") {
      // M53 §4: only "fork" is meaningful; unknown values are ignored
      // (tolerant, same posture as unknown keys).
      if (value === "fork") context = "fork";
    } else if (key === "disable-model-invocation") {
      // M58 §C#4: only the literal `true` hides the skill from the model.
      if (value === "true") disableModelInvocation = true;
    } else if (key === "argument-hint") {
      if (value !== "") argumentHint = value;
    } else if (key === "when-to-use" || key === "when_to_use") {
      if (value !== "") whenToUse = value;
    } else if (key === "user-invocable") {
      if (value === "true") userInvocable = true;
      else if (value === "false") userInvocable = false;
    } else if (key === "agent") {
      if (value !== "") agent = value;
    } else if (key === "approval-gate") {
      // ω99-56: only the one recognized mode parses (tolerant — an unknown
      // gate value carries no mechanism and must not half-arm anything).
      if (value === "file-edits") approvalGate = "file-edits";
    } else if (key === "hooks") {
      // M63-C §3: the skill-position hooks — a JSON object of event keys →
      // entry lists (same shape as settings hooks.*). Tolerant: junk is
      // ignored (the loader's own validation re-checks every entry).
      if (value.startsWith("{")) {
        try {
          const parsed = JSON.parse(value) as unknown;
          if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
            hooks = parsed as Record<string, unknown>;
          }
        } catch {
          /* malformed JSON — ignored */
        }
      }
    }
    // anything else: an unknown key — ignored (tolerant, CC's own posture)
  }
  if (name === undefined) return { description };
  return {
    name,
    description,
    ...(hooks !== undefined ? { hooks: hooks as Record<string, readonly unknown[]> } : {}),
    ...(context !== undefined ? { context } : {}),
    ...(disableModelInvocation !== undefined ? { disableModelInvocation } : {}),
    ...(argumentHint !== undefined ? { argumentHint } : {}),
    ...(whenToUse !== undefined ? { whenToUse } : {}),
    ...(userInvocable !== undefined ? { userInvocable } : {}),
    ...(agent !== undefined ? { agent } : {}),
    ...(approvalGate !== undefined ? { approvalGate } : {}),
    ...(lists.paths !== undefined && lists.paths.length > 0 ? { paths: lists.paths } : {}),
    ...(lists.allowedTools !== undefined && lists.allowedTools.length > 0 ? { allowedTools: lists.allowedTools } : {}),
    ...(lists.disallowedTools !== undefined && lists.disallowedTools.length > 0
      ? { disallowedTools: lists.disallowedTools }
      : {}),
    ...(lists.argumentsDecl !== undefined && lists.argumentsDecl.length > 0
      ? { argumentsDecl: lists.argumentsDecl }
      : {}),
    ...(unsupported !== undefined ? { unsupported } : {}),
  };
}

function stripQuotes(v: string): string {
  if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) {
    return v.slice(1, -1);
  }
  return v;
}

function toPosix(p: string): string {
  return sep === "/" ? p : p.split(sep).join("/");
}

/** M57: the manifest path for a SKILL.md. Workspace files keep their
 *  workspace-relative posix form; files OUTSIDE the workspace (the global
 *  tier) keep the absolute path — `isOutsideWorkspace` keys off that. */
function skillRelPath(workspaceRoot: string, filePath: string): string {
  const rel = toPosix(relative(workspaceRoot, filePath));
  return rel.startsWith("../") || rel === ".." || /^[A-Za-z]:\//.test(rel) ? toPosix(filePath) : rel;
}

/** True when a skill's relPath is not workspace-relative (absolute or a
 *  Windows drive form) — the manifest renders the invoke hint for it. */
function isOutsideWorkspace(relPath: string): boolean {
  return relPath.startsWith("/") || /^[A-Za-z]:\//.test(relPath);
}

/** loadSkills' options (P1-5 trust gate): `trustSuppressed: true` drops the
 *  three PROJECT discovery roots from the walk (an untrusted workspace's
 *  repo-carried skills must not reach the manifest) — the personal and
 *  global USER tiers load as always. Absent = no gate (byte-stable default
 *  for every existing caller). ω99-18: `bundleRoots` adds the mission-bundle
 *  tier (campaign-scoped packs) between the project roots and the global
 *  fallback — workspace content, so the trust gate drops it with the project
 *  roots; absent/empty = the byte-stable default (no bundle tier at all). */
export interface LoadSkillsOptions {
  readonly trustSuppressed?: boolean;
  /** ω99-18 — mission-bundle skills roots (from mission.activeBundleSkillRoots;
   *  project > bundle > global on duplicate names, first-wins). */
  readonly bundleRoots?: readonly string[];
}

/** Load every skill under the personal tier, the global tier, and the three
 *  workspace discovery roots (first-wins on duplicate names, with a
 *  diagnostic warning that names the WINNING source). Discovery order
 *  (cc-plugins D1; M57 §1 kept for the global tier):
 *   <workspaceRoot>/.agents/skills, .wudao/skills  (project)
 *   ~/.claude/skills                                (personal — CC's location)
 *   <workspaceRoot>/.claude/skills                  (project CC location)
 *   <bundleRoots>                                   (ω99-18 mission bundles — campaign-scoped tier)
 *   ~/.wudao/skills/<name>/SKILL.md                 (global — fills gaps)
 *  A same-name skill in an EARLIER root claims the name; the global tier only
 *  fills gaps (M57). Missing roots are silent (skills are optional);
 *  unreadable/skill-less dirs are skipped. `warn` receives one message per
 *  skipped file, per duplicate name, and per skill carrying unsupported
 *  frontmatter fields (model/effort/shell). ω99-37: the static frontmatter
 *  defects (no name / unsupported fields) fire once per (skill path,
 *  process) — a rescan re-runs this loader, and a defect intrinsic to one
 *  file must not re-fire the same line ×N; duplicate-name and trust notices
 *  fire per pass as before. P1-5: with trustSuppressed the
 *  project roots are skipped with ONE warning naming how many were present. */
export function loadSkills(workspaceRoot: string, warn: (msg: string) => void = () => {}, env: NodeJS.ProcessEnv = process.env, opts: LoadSkillsOptions = {}): readonly LoadedSkill[] {
  const byName = new Map<string, LoadedSkill>();
  const suppressed = opts.trustSuppressed === true;
  let suppressedProjectRoots = 0;
  for (const segs of SKILL_ROOT_SEGMENTS) {
    const personal = segs[0] === "~";
    if (suppressed && !personal) {
      // count PRESENT roots so the single notice names a real surface, not
      // absent directories
      try {
        readdirSync(join(workspaceRoot, ...segs));
        suppressedProjectRoots += 1;
      } catch {
        /* absent — nothing suppressed there */
      }
      continue;
    }
    const root = personal ? personalSkillRoot(env) : join(workspaceRoot, ...segs);
    for (const s of loadSkillsUnderDir(root, workspaceRoot, warn, undefined, personal ? "personal" : "project")) {
      const existing = byName.get(s.name);
      if (existing) {
        warn(`skill name "${s.name}" already loaded from ${existing.filePath}; skipping ${s.filePath}`);
        continue;
      }
      byName.set(s.name, s);
    }
  }
  if (suppressed && suppressedProjectRoots > 0) {
    warn(`⚠️ ${suppressedProjectRoots} project skill root(s) skipped — workspace not trusted (/trust to review)`);
  }
  // ω99-18 — the mission-bundle tier: campaign-scoped packs mounted between
  // the project roots and the global fallback (project > bundle > global;
  // same first-wins byName dedup, the warn names the winner). Workspace
  // content, so trustSuppressed drops it with the project roots (one warn
  // naming how many were present). Missing roots stay silent (the standard
  // posture — a bundle dir deleted after declare degrades to "not mounted").
  const bundleRoots = opts.bundleRoots ?? [];
  if (bundleRoots.length > 0) {
    if (suppressed) {
      let presentBundleRoots = 0;
      for (const root of bundleRoots) {
        try {
          readdirSync(root);
          presentBundleRoots += 1;
        } catch {
          /* absent — nothing suppressed there */
        }
      }
      if (presentBundleRoots > 0) {
        warn(`⚠️ ${presentBundleRoots} mission-bundle skill root(s) skipped — workspace not trusted (/trust to review)`);
      }
    } else {
      for (const root of bundleRoots) {
        for (const s of loadSkillsUnderDir(root, workspaceRoot, warn, undefined, "project")) {
          const existing = byName.get(s.name);
          if (existing) {
            warn(`skill name "${s.name}" already loaded from ${existing.filePath}; skipping ${s.filePath}`);
            continue;
          }
          byName.set(s.name, s);
        }
      }
    }
  }
  for (const s of loadSkillsUnderDir(join(resolveGlobalHome(env), "skills"), workspaceRoot, warn, undefined, "personal")) {
    const existing = byName.get(s.name);
    if (existing) {
      warn(`skill "${s.name}": project ${existing.filePath} shadows global ${s.filePath} (project wins)`);
      continue;
    }
    byName.set(s.name, s);
  }
  return [...byName.values()];
}

// ω99-37 — diagnostic budget: a static frontmatter defect (no name /
// unsupported fields) is intrinsic to ONE file, so every rescan re-fires the
// byte-identical warning (mission boundaries re-run the boot assembly —
// campaign two logged the same line ×8): alert fatigue that drowns real
// signal. The warn channel is a budgeted resource: such defects fire ONCE
// per (skill path, process); the process lifetime is the budget's boundary
// (no reset, no TTL — a restart re-arms; cross-process persistence would be
// a different arc). NOT gated, deliberately: duplicate-name/shadow warnings
// are facts about file RELATIONS (the same loser path legitimately re-warns
// when the winning set changes — skills.test.ts's priority matrix), the
// trust-gate summaries ride mutable trust state and carry no path key, and
// dynamic one-shot events (EACCES-class) would keep firing — none exist on
// this walker today (absent roots are silent by design).
const warnedSkillPaths = new Set<string>();

/** Gate ONE static-defect warning through the per-path budget. `spend ===
 *  false` marks a receipt/predict walk (mission mount receipts): the message
 *  still reaches that walk's own sink, but the budget is untouched — a no-op
 *  sink there spending the budget would silence the real warn sink's walk
 *  that follows (zero lines instead of once). */
function warnStaticSkillDefectOnce(warn: (msg: string) => void, filePath: string, message: string, spend: boolean): void {
  if (!spend) {
    warn(message);
    return;
  }
  if (warnedSkillPaths.has(filePath)) return;
  warnedSkillPaths.add(filePath);
  warn(message);
}

/** ω99-37 — walker options. `skipWarningBudget: true` = a receipt/predict
 *  walk: same enumeration, same skip semantics, but the per-path static
 *  warning budget is neither spent nor gated (see warnStaticSkillDefectOnce).
 *  Absent = the default budgeting walk (loadSkills and every rescan).
 *  plugin-compat D1 — `frontmatterRewrite` 在解析前改写 SKILL.md 文本（仅
 *  解析层；LoadedSkill.content 保持磁盘原字节）：上游 CCB 家族技能的
 *  camelCase 键（whenToUse）靠它归一化成本装的连字符拼写。 */
export interface LoadSkillsUnderDirOptions {
  readonly skipWarningBudget?: boolean;
  readonly frontmatterRewrite?: (text: string) => string;
}

/** Load the skills under ONE root dir (each child directory = one skill).
 *  Missing root → [] (silent). M36: this is the seam the plugin loader uses
 *  for `<plugin>/skills/` — the fourth discovery source, feeding the same
 *  LoadedSkill list with a `plugin` tag (origin "plugin" follows it). A
 *  plugin tag always wins over the origin param. Name-dedup across sources
 *  belongs to the caller (loadSkills / appendPluginSkills). ω99-37: static
 *  frontmatter defects warn once per (skill path, process); receipt walks
 *  opt out via opts.skipWarningBudget. */
export function loadSkillsUnderDir(
  root: string,
  workspaceRoot: string,
  warn: (msg: string) => void = () => {},
  plugin?: string,
  origin?: SkillOrigin,
  opts: LoadSkillsUnderDirOptions = {},
): readonly LoadedSkill[] {
  const spendWarningBudget = opts.skipWarningBudget !== true;
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return []; // no such root → skills simply absent there
  }
  const out: LoadedSkill[] = [];
  for (const entry of [...entries].sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (!isDirectoryEntry(entry, join(root, entry.name))) continue;
    const filePath = join(root, entry.name, "SKILL.md");
    let text: string;
    try {
      text = readFileSync(filePath, "utf8");
    } catch {
      continue; // a skill dir without SKILL.md is not a skill (silent)
    }
    // plugin-compat D1：解析前改写（content 落盘原文，改写只影响解析结果）
    const fm = parseSkillFrontmatter(opts.frontmatterRewrite !== undefined ? opts.frontmatterRewrite(text) : text);
    if (fm.name === undefined) {
      warnStaticSkillDefectOnce(warn, filePath, `skill ${filePath} has no "name:" in its frontmatter; skipping it`, spendWarningBudget);
      continue;
    }
    // cc-plugins D1: fields with no wudao mechanism degrade with ONE warning
    // naming every ignored field, then the skill loads without them.
    if (fm.unsupported !== undefined) {
      warnStaticSkillDefectOnce(warn, filePath, `skill ${filePath}: ignoring unsupported frontmatter field(s): ${fm.unsupported.join(", ")} (no wudao mechanism yet)`, spendWarningBudget);
    }
    out.push({
      name: fm.name,
      description: fm.description,
      filePath,
      // M57: a skill outside the workspace (the global tier) has no sane
      // workspace-relative path — read_file is workspace-bounded, so the
      // manifest advertises the /skill:<name> invocation instead (see
      // skillsPromptSection). relPath carries the ABSOLUTE path there.
      relPath: skillRelPath(workspaceRoot, filePath),
      content: text,
      origin: plugin !== undefined ? "plugin" : (origin ?? "project"),
      ...(fm.hooks !== undefined ? { hooks: fm.hooks } : {}),
      ...(fm.context !== undefined ? { context: fm.context } : {}),
      ...(fm.disableModelInvocation !== undefined ? { disableModelInvocation: fm.disableModelInvocation } : {}),
      ...(fm.agent !== undefined ? { agent: fm.agent } : {}),
      ...(fm.approvalGate !== undefined ? { approvalGate: fm.approvalGate } : {}),
      ...(fm.whenToUse !== undefined ? { whenToUse: fm.whenToUse } : {}),
      ...(fm.argumentHint !== undefined ? { argumentHint: fm.argumentHint } : {}),
      ...(fm.userInvocable !== undefined ? { userInvocable: fm.userInvocable } : {}),
      ...(fm.paths !== undefined ? { paths: fm.paths } : {}),
      ...(fm.allowedTools !== undefined ? { allowedTools: fm.allowedTools } : {}),
      ...(fm.disallowedTools !== undefined ? { disallowedTools: fm.disallowedTools } : {}),
      ...(fm.argumentsDecl !== undefined ? { argumentsDecl: fm.argumentsDecl } : {}),
      ...(plugin !== undefined ? { plugin } : {}),
    });
  }
  return out;
}

function isDirectoryEntry(entry: { isDirectory(): boolean; isSymbolicLink(): boolean }, fullPath: string): boolean {
  if (entry.isDirectory()) return true;
  if (!entry.isSymbolicLink()) return false;
  try {
    return statSync(fullPath).isDirectory(); // follow symlinked skill dirs (README install method)
  } catch {
    return false; // dangling symlink
  }
}

// ---------------------------------------------------------------------------
// M58 §C#4 — model-invocation visibility. Two orthogonal sources can hide a
// skill from the model-visible manifest (zero resident bytes, /skill: keeps
// working): the SKILL.md frontmatter (`disable-model-invocation: true`) and
// the settings node `skills.overrides: {<name>: {disableModelInvocation:
// true}}` in EITHER tier (global ~/.wudao or project .wudao — the disables
// UNION across tiers). The overlay is applied ONCE at process start (load
// time): hiding mid-session would shift prompt bytes and break the prefix
// cache — the same session-static posture as project-context.
// ---------------------------------------------------------------------------

/** One skill's settings override (only the visibility flag exists in v1). */
export interface SkillOverride {
  readonly disableModelInvocation?: boolean;
}

/** Parsed `skills.overrides` node: name → override. Tolerant: non-object
 *  nodes → empty; a per-name value that is not an object or carries a
 *  non-boolean flag → that name is skipped, the rest kept. */
export function parseSkillOverrides(value: unknown): ReadonlyMap<string, SkillOverride> {
  const out = new Map<string, SkillOverride>();
  if (typeof value !== "object" || value === null || Array.isArray(value)) return out;
  for (const [name, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) continue;
    const rec = raw as Record<string, unknown>;
    const flag = rec["disableModelInvocation"];
    if (flag === undefined) continue;
    if (typeof flag !== "boolean") continue; // junk flag → ignore this name
    out.set(name, { disableModelInvocation: flag });
  }
  return out;
}

function skillOverridesNode(settings: Readonly<Record<string, unknown>> | undefined): unknown {
  const skills = settings?.["skills"];
  if (typeof skills !== "object" || skills === null || Array.isArray(skills)) return undefined;
  return (skills as Record<string, unknown>)["overrides"];
}

/** Both tiers' `skills.overrides`, with the disable flags UNIONed per name: a
 *  `true` in EITHER tier hides the skill (a project `false` cannot un-hide a
 *  global `true` — hiding is the conservative direction, and "两层并集" is
 *  the spec's word). Missing/malformed tiers → empty. */
export async function loadSkillOverrides(
  workspaceRoot: string,
  warn: (msg: string) => void = () => {},
  env: NodeJS.ProcessEnv = process.env,
): Promise<ReadonlyMap<string, SkillOverride>> {
  const layered = await loadLayeredSettings(workspaceRoot, warn, env);
  const global = parseSkillOverrides(skillOverridesNode(layered.global));
  const project = parseSkillOverrides(skillOverridesNode(layered.project));
  const out = new Map<string, SkillOverride>();
  for (const [name, o] of global) {
    const p = project.get(name);
    out.set(name, {
      disableModelInvocation: (o.disableModelInvocation ?? false) || (p?.disableModelInvocation ?? false) || undefined,
    });
  }
  for (const [name, p] of project) {
    if (out.has(name)) continue;
    out.set(name, p);
  }
  return out;
}

/** Overlay the settings overrides onto a loaded skill list: a skill named in
 *  the overrides with `disableModelInvocation: true` gains the
 *  `disableModelInvocation` flag (a copy — the input list is never mutated);
 *  everything else returns as-is (identity-stable, byte-stable). Frontmatter
 *  flags set at parse time are OR-ed in by construction. */
export function applySkillVisibility(
  skills: readonly LoadedSkill[],
  overrides: ReadonlyMap<string, SkillOverride>,
): readonly LoadedSkill[] {
  if (overrides.size === 0) return skills;
  return skills.map((s) =>
    s.disableModelInvocation !== true && overrides.get(s.name)?.disableModelInvocation === true
      ? { ...s, disableModelInvocation: true as const }
      : s,
  );
}

/** The system-prompt tail manifest. "" when there are no skills — callers
 *  append unconditionally and the prompt stays byte-identical to the
 *  no-skills baseline. M58 §C#4: skills carrying `disableModelInvocation`
 *  (frontmatter or the settings overlay) are dropped here — zero resident
 *  bytes; they stay `/skill:`-invocable (findSkill works on the UNGATED
 *  list). cc-plugins D1: `whenToUse` rides the description line (`use when:
 *  …`) — a skills-carrying skill without a current-path match is the CALLER's
 *  gate (see gateSkillsForPath), not this function's. Format (byte-pinned by
 *  tests + det-15):
 *
 *   <available_skills>
 *   Use read_file to load a skill's full instructions when a task matches.
 *   - name: <name> — <description> — use when: <whenToUse> (path: <relpath>)
 *   </available_skills>
 */
export function skillsPromptSection(skills: readonly LoadedSkill[]): string {
  const visible = skills.filter((s) => s.disableModelInvocation !== true);
  if (visible.length === 0) return "";
  const lines = [
    "<available_skills>",
    "Use read_file to load a skill's full instructions when a task matches.",
    ...visible.map((s) => {
      // M57: global-tier skills live outside the workspace — read_file is
      // workspace-bounded, so the manifest points at the invocation instead.
      const where = isOutsideWorkspace(s.relPath) ? `invoke: /skill:${s.name}` : `path: ${s.relPath}`;
      const about = [s.description, s.whenToUse ? `use when: ${s.whenToUse}` : ""].filter((p) => p !== "").join(" — ");
      return `- name: ${s.name}${about ? ` — ${about}` : ""} (${where})`;
    }),
    "</available_skills>",
  ];
  return `\n\n${lines.join("\n")}`;
}

/** cc-plugins D1 — the `paths:` glob gate for the MODEL-VISIBLE manifest: a
 *  paths-free skill is always listed; a paths-carrying skill lists only while
 *  the session's current file matches ANY of its globs (the M62 matcher
 *  family — a slash-free glob also matches the basename). The gate NEVER
 *  touches invocation (`/skill:<name>` keeps working while gated out) nor the
 *  user-facing list. Pure. */
export function skillVisibleForPath(skill: LoadedSkill, relPath: string): boolean {
  if (skill.paths === undefined || skill.paths.length === 0) return true;
  return skill.paths.some((glob) => globMatchesPath(glob, relPath));
}

/** The manifest-time form of the paths gate: the skill list filtered to what
 *  belongs in `<available_skills>` for the file the session is working on.
 *  Identity-stable when nothing gates out (byte- and reference-stable for
 *  legacy skill sets — the prefix-cache posture). The boot/prompt seam that
 *  tracks the "current file" and calls this lands with D3's invocation pass.
 */
export function gateSkillsForPath(skills: readonly LoadedSkill[], relPath: string): readonly LoadedSkill[] {
  return skills.some((s) => !skillVisibleForPath(s, relPath)) ? skills.filter((s) => skillVisibleForPath(s, relPath)) : skills;
}

/** Exact-name lookup for `/skill:name` (case-sensitive). */
export function findSkill(skills: readonly LoadedSkill[], name: string): LoadedSkill | undefined {
  return skills.find((s) => s.name === name);
}

/** cc-plugins D3: exact-name lookup for `/name` invocation — workspace and
 *  personal skills ONLY (no plugin skills; those route through `/plugin:skill`).
 *  The parse order is `builtin > /name (workspace/personal) > /plugin:skill`,
 *  so when a workspace skill and a plugin skill share a name, `/name` picks
 *  the workspace one (per the loaders' first-wins matrix in D1). */
export function findNonPluginSkill(skills: readonly LoadedSkill[], name: string): LoadedSkill | undefined {
  return skills.find((s) => s.name === name && s.plugin === undefined);
}

/** cc-plugins D3: lookup for `/<plugin>:<skill>` invocation — exact
 *  (plugin, skill) pair. Returns undefined when either side is wrong, so the
 *  caller falls through to a plain prompt (the slash-face never invents a
 *  skill match). */
export function findPluginSkill(
  skills: readonly LoadedSkill[],
  pluginName: string,
  skillName: string,
): LoadedSkill | undefined {
  return skills.find((s) => s.plugin === pluginName && s.name === skillName);
}

/** The user message `/skill:name args` submits: the full SKILL.md wrapped in a
 *  <skill> envelope naming the skill and the invocation args. Submitted through
 *  the normal prompt path, so onPromptSubmit hooks see it like any prompt.
 *  M48 §3: `prunedFromContext` appends the reload hint when the transcript
 *  shows this skill's earlier read was compacted away (the ghost-skill
 *  marker) — the model learns WHY it lost the instructions and how to get
 *  them back after the next compaction. */
export function buildSkillInvocationMessage(
  skill: LoadedSkill,
  args: string,
  opts: { readonly prunedFromContext?: boolean } = {},
): string {
  const base = `<skill name="${skill.name}" args="${args}">\n${skill.content}\n</skill>`;
  return opts.prunedFromContext
    ? `${base}\n[system note: this skill's earlier read was pruned by context compaction — the full instructions are re-injected above; if they drop out again, reload them with read_file ${skill.relPath}]`
    : base;
}

// ---------------------------------------------------------------------------
// cc-plugins D2 — invocation-time preprocessing (skill-expand.ts). The plain
// builder above stays byte-identical for its existing consumers (evals, the
// /loop envelope, byte pins); the two builders below are what /skill:
// frontends submit.
// ---------------------------------------------------------------------------

/** Shared option shape for the D2 builders. */
export interface SkillInvocationExpandOpts {
  readonly sessionId?: string;
  /** The agent working root: the injection cwd AND ${CLAUDE_PROJECT_DIR}. */
  readonly workspaceRoot?: string;
  /** Explicit ${CLAUDE_PROJECT_DIR} override (defaults to workspaceRoot). */
  readonly projectDir?: string;
  readonly prunedFromContext?: boolean;
}

function skillEnvelope(skill: LoadedSkill, args: string, body: string, pruned: boolean): string {
  const base = `<skill name="${skill.name}" args="${args}">\n${body}\n</skill>`;
  return pruned
    ? `${base}\n[system note: this skill's earlier read was pruned by context compaction — the full instructions are re-injected above; if they drop out again, reload them with read_file ${skill.relPath}]`
    : base;
}

/** D2: the SUBSTITUTION-ONLY envelope — every textual placeholder expanded,
 *  `!`cmd`` spans left LITERAL (never executed). The path for contexts with
 *  no approval surface: the /loop headless fire and the `context: fork`
 *  child envelope. Synchronous by construction (the substitution pass is
 *  pure). */
export function buildSubstitutedSkillMessage(
  skill: LoadedSkill,
  args: string,
  opts: SkillInvocationExpandOpts = {},
): string {
  const body = expandSubstitutions(skill.content, {
    args,
    skillDir: dirname(skill.filePath),
    projectDir: opts.projectDir ?? opts.workspaceRoot ?? "",
    sessionId: opts.sessionId ?? "",
    ...(skill.argumentsDecl !== undefined ? { argsDecl: skill.argumentsDecl } : {}),
  });
  return skillEnvelope(skill, args, body, opts.prunedFromContext === true);
}

/** D2: does this skill's body carry dynamic-injection syntax? Frontends use
 *  it to keep the (synchronous) substituted builder when no execution could
 *  ever happen. */
export function skillBodyNeedsInjection(skill: LoadedSkill): boolean {
  return bodyIncludesInjection(skill.content);
}

/** D2: the FULL invocation-time preprocessing — substitutions, then the
 *  `!`cmd` / ```! dynamic injections executed and inlined under the trust
 *  tiers (personal / user-scope-plugin free; everything else through the
 *  session's shell pipeline via `decide`). Rejects when an injection
 *  is denied or its exec fails — the caller surfaces the error and submits
 *  NOTHING (CC's fail-loud posture; a half-expanded envelope must never
 *  reach the model). */
export async function buildExpandedSkillMessage(
  skill: LoadedSkill,
  args: string,
  opts: SkillInvocationExpandOpts & {
    /** The session's permission gate (the same seam tools use). */
    readonly decide?: SkillInjectionDecide;
    /** shell parity: 30s default. */
    readonly timeoutMs?: number;
    /** disableSkillShellExecution posture: nothing runs; placeholders. */
    readonly disabled?: boolean;
  } = {},
): Promise<string> {
  const projectDir = opts.projectDir ?? opts.workspaceRoot ?? "";
  const substituted = expandSubstitutions(skill.content, {
    args,
    skillDir: dirname(skill.filePath),
    projectDir,
    sessionId: opts.sessionId ?? "",
    ...(skill.argumentsDecl !== undefined ? { argsDecl: skill.argumentsDecl } : {}),
  });
  const workspaceRoot = opts.workspaceRoot ?? process.cwd();
  const execFn = createSkillInjectionExec({
    ...(skill.origin !== undefined ? { origin: skill.origin } : {}),
    ...(skill.pluginScope !== undefined ? { pluginScope: skill.pluginScope } : {}),
    workspaceRoot,
    ...(dirname(skill.filePath) !== "" ? { skillDir: dirname(skill.filePath) } : {}),
    ...(projectDir !== "" ? { projectDir } : {}),
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    ...(opts.decide !== undefined ? { decide: opts.decide } : {}),
  });
  const body = await expandInjections(substituted, execFn, { disabled: opts.disabled });
  return skillEnvelope(skill, args, body, opts.prunedFromContext === true);
}

/** True when the transcript carries a pruned marker for this skill (M48 §3). */
export function isSkillPruned(messages: readonly AgentMessage[], name: string): boolean {
  return messages.some((m) => {
    const parsed = parseSkillPrunedMarker(m.content);
    return parsed !== undefined && parsed.name === name;
  });
}

/** M48 §3: the loop-side skill-read classifier. Feeds the ghost-skill marker
 *  seam — every successful `read_file` of a known skill's SKILL.md is recorded
 *  by toolCallId, so each compaction tier degrades that result to the
 *  canonical [SKILL_PRUNED: …] marker instead of losing the skill silently.
 *  Matches the model's own vocabulary: the manifest's relPath, the absolute
 *  path, and "./"-prefixed variants of either. Zero skills → always undefined
 *  (no classifier cost on skill-less workspaces). */
export function createSkillReadClassifier(
  skills: readonly LoadedSkill[],
): (toolName: string, args: Record<string, unknown>) => { name: string; path: string } | undefined {
  if (skills.length === 0) return () => undefined;
  const byPath = new Map<string, LoadedSkill>();
  for (const s of skills) {
    byPath.set(normalizeSkillPath(s.relPath), s);
    byPath.set(normalizeSkillPath(s.filePath), s);
  }
  return (toolName, args) => {
    if (toolName !== "read_file") return undefined;
    const raw = args["path"];
    if (typeof raw !== "string" || raw === "") return undefined;
    const skill = byPath.get(normalizeSkillPath(raw));
    return skill === undefined ? undefined : { name: skill.name, path: skill.relPath };
  };
}

function normalizeSkillPath(p: string): string {
  return p.replace(/^\.\//, "").replace(/\/+/g, "/").replace(/\/$/, "");
}

/** Error text for an unknown skill name: names every loaded skill + path so
 *  the user can retry without a listing command. */
export function formatSkillError(name: string, skills: readonly LoadedSkill[]): string {
  if (skills.length === 0) {
    return `⚠️ no skill named "${name}" (no skills loaded — add .wudao/skills/<name>/SKILL.md or .agents/skills/<name>/SKILL.md)`;
  }
  const list = skills
    .map((s) => `  - ${s.name}${s.description ? ` — ${s.description}` : ""} (path: ${s.relPath})`)
    .join("\n");
  return `⚠️ no skill named "${name}". Available skills:\n${list}`;
}
