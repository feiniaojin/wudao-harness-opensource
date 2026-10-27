// M30 §A — the role roster: file-backed agent profiles under
// `.wudao/agents/<role>.json`, layered over built-in profiles (discovery
// order BuiltIn < Workspace; a workspace file with a builtin's id shadows it
// and the shadowing is REPORTED, never silent). Pure types + a loader — no
// provider knowledge lives here.

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { SubagentType } from "../subagent.js";
import type { WriteScopeDeclaration } from "./write-scope.js";
import { isWriteScopeDeclaration } from "./write-scope.js";

/** One agent role profile — the `<role>.json` schema (spec §A) plus the §D
 *  `worktree` switch. Every field except `id`/`description` is optional; the
 *  task tool resolves provider/model/effort at dispatch time (frozen roles
 *  refuse caller overrides — that check lives in the cli task tool, not
 *  here; ω99-93 removed the never-wired core copy). */
export interface AgentRoleProfile {
  readonly id: string;
  readonly description: string;
  readonly systemPrompt?: string;
  readonly toolNames?: readonly string[];
  readonly provider?: string;
  readonly model?: string;
  readonly reasoningEffort?: string;
  readonly maxTurns?: number;
  readonly sandbox?: boolean;
  readonly frozen?: boolean;
  /** M30 §D: run this role's children in a dedicated git worktree. */
  readonly worktree?: boolean;
  /** M31 §1: paths this role may WRITE (glob-prefix roots + exact files,
   *  workspace-relative). Enforced at the child's tool set, never here. */
  readonly writeScope?: WriteScopeDeclaration;
  /** M31 §1: exempt shell from the write-scope guard (an explicit,
   *  per-role trust decision; sandboxed sessions are exempt regardless). */
  readonly allowShell?: boolean;
  /** M64-B §B: this role's persistent memory tier — where its MEMORY.md
   *  lives and which lifecycle owns it (project expires with
   *  cleanupPeriodDays; local/user are never cleaned). Unset → "project". */
  readonly memory?: "project" | "local" | "user";
  /** M63-C §3: the subagent-position hooks — an opaque {event → entry list}
   *     map (the settings hooks.* shape) compiled by the CLI and armed for
   *     THIS role's child runs only. Core passes it through untouched. */
  readonly hooks?: Readonly<Record<string, readonly unknown[]>>;
}

/** A workspace profile that replaced a builtin with the same id. `by` is the
 *  shadowing file's workspace-relative path. */
export interface ShadowedProfile {
  readonly id: string;
  readonly by: string;
}

export interface LoadedRoster {
  readonly profiles: Map<string, AgentRoleProfile>;
  readonly shadowed: readonly ShadowedProfile[];
}

/** A plugin agent slot: the translated profile plus the provenance label used
 *  in the ShadowedProfile receipt when it shadows a builtin/workspace entry
 *  (e.g. `plugin demo: agents/reviewer.md`). */
export interface RosterPluginAgent {
  readonly profile: AgentRoleProfile;
  readonly source: string;
}

export interface LoadRosterOptions {
  /** Warn-not-crash channel: one message per skipped/invalid file. */
  readonly onWarning?: (message: string) => void;
  /** M40 §2: the plugin agent layer — slots BETWEEN the builtins and the
   *  workspace files (builtin < plugin < global < workspace). A workspace
   *  file with the same id reclaims the slot and chains its receipt. */
  readonly pluginAgents?: readonly RosterPluginAgent[];
  /** M57 §1: the GLOBAL tier's agents dir (`~/.wudao/agents`). The caller
   *  (cli) resolves WUDAO_GLOBAL_HOME — core stays env-free. Absent → no
   *  global tier. Same-name resolution: project wins, receipt annotated. */
  readonly globalAgentsDir?: string;
}

// Doctrine prompts. The three M9 types migrate verbatim (their prompts are
// load-bearing for existing behavior); the new roles adapt a reference harness's fleet
// doctrine (manager dispatches and never does the unit of work; adversarial
// reviewers must assume guilt and cite evidence) plus hive's
// identity-independent worker essence: the child's context is disposable and
// the final report is ALL the caller receives, so it must stand alone.
export const BUILTIN_ROLES: Record<string, AgentRoleProfile> = {
  "general-purpose": {
    id: "general-purpose",
    description: "Research and answer questions (read-only tools).",
    systemPrompt: `You are a focused research sub-agent. Your context is disposable — use it aggressively.
- READ EVERYTHING relevant to your brief: glob the area first, then read the files (you have plenty of turns; do not stop after one or two files).
- Be concrete: every finding cites file paths (and line numbers when useful).
- Finish with a structured report: findings ordered by importance, each with evidence. This report is ALL the caller receives — it must stand alone.`,
    toolNames: ["read_file", "glob", "grep"],
  },
  coder: {
    id: "coder",
    description: "Read, write, edit, and run commands.",
    systemPrompt: "You are a focused coding sub-agent. Use tools to implement the task, then summarize what you did.",
    toolNames: ["read_file", "write_file", "edit", "shell", "glob", "grep", "todo_write"],
  },
  // M24 B2 fork mode: instead of a fresh isolated context, the child REUSES
  // the parent conversation (system prompt + FULL tool array + message
  // snapshot) and appends one `[subagent task]` brief — its first request is
  // a byte-level extension of the parent's last request, so the shared
  // segment rides the parent's already-paid prefix cache. `toolNames` is
  // unused here (the fork takes the parent's array verbatim).
  fork: {
    id: "fork",
    description: "Fork the CURRENT conversation: sees the parent's full context and tools (read + write); use for research fan-out or parallel verification.",
    systemPrompt: "(fork mode reuses the parent conversation's system prompt verbatim)",
    toolNames: [],
  },
  manager: {
    id: "manager",
    description: "Decompose a brief and dispatch it to workers; integrates their reports. Does not do the units of work itself.",
    systemPrompt: `You are the manager of a worker fleet. You do NOT do the units of work yourself.
- Decompose the brief into small, independently checkable units and keep a todo_write board of them.
- Dispatch each unit with the task tool — one clear brief per worker: goal, scope, and the exact report you expect back. Workers are disposable and see only their brief, so every constraint must live in the brief itself.
- A worker that ends with [WORKER_REPORT] hit its budget mid-task: integrate what landed and, if the remainder is worth it, re-dispatch just that remainder with a higher budget.
- Verify receipts against the brief, not against worker optimism: a claim without evidence is an open item.
- Finish with your integrated report: what was dispatched, what each worker returned (key findings verbatim), and what remains open. Your report is ALL the caller receives.`,
    toolNames: ["task", "todo_write", "read_file", "glob", "grep"],
  },
  "adversarial-reviewer": {
    id: "adversarial-reviewer",
    description: "Tries to break a change: edge cases, error paths, security, spec violations. Read-only; every finding carries evidence.",
    systemPrompt: `You are an adversarial reviewer. Your job is to find what is WRONG, not to confirm what works.
- Assume the change is guilty. Hunt for edge cases, unhandled error paths, concurrency hazards, security holes, and spec violations — in that order of suspicion.
- READ the actual code and tests (glob the area, grep for call sites); never review from the description alone.
- Every finding states: severity, file path (and line when useful), and the concrete failure it causes. No finding without evidence.
- Say explicitly what you could NOT check (no tests executed, no access to X). An unmarked gap is a false clean bill.
- Finish with a verdict — approve / approve-with-changes / reject — and findings ordered by severity. Your report is ALL the caller receives.`,
    toolNames: ["read_file", "glob", "grep"],
  },
  consultant: {
    id: "consultant",
    description: "One hard question, answered deeply: constraints, trade-offs, options, and a grounded recommendation. Defaults to high reasoning effort.",
    reasoningEffort: "high",
    systemPrompt: `You are a senior consultant brought in for one hard question.
- Think the problem through BEFORE answering: the real constraints, the trade-offs, and at least two viable options with their costs.
- Ground every claim: read the relevant code and docs with your read-only tools and cite file paths. Speculation must be labeled as speculation.
- You have no agenda: if the honest answer is "the premise is wrong" or "not enough information to decide", say exactly that and what would settle it.
- Finish with a crisp recommendation: the answer, why, what you would do next, and the main risk with it. Your report is ALL the caller receives.`,
    toolNames: ["read_file", "glob", "grep"],
  },
};

/** Fallback prompt for a profile that declares no `systemPrompt` — the child
 *  still gets the stand-alone-report contract every worker shares. */
const DEFAULT_ROLE_SYSTEM_PROMPT =
  "You are a focused sub-agent. Complete the task with your tools, then return a standalone report with evidence — the report is ALL the caller receives.";

/** Adapt a role profile to the runSubagent child type. Pure. */
export function toSubagentType(profile: AgentRoleProfile): SubagentType {
  return {
    name: profile.id,
    description: profile.description,
    systemPrompt: profile.systemPrompt ?? DEFAULT_ROLE_SYSTEM_PROMPT,
    toolNames: profile.toolNames ?? [],
  };
}

const ROLE_ID_RE = /^[A-Za-z0-9_-]+$/;

type FieldCheck = (value: unknown) => boolean;
const isString: FieldCheck = (v) => typeof v === "string";
const isStringArray: FieldCheck = (v) => Array.isArray(v) && v.every((item) => typeof item === "string");
const isBool: FieldCheck = (v) => typeof v === "boolean";
const isMaxTurns: FieldCheck = (v) => typeof v === "number" && Number.isInteger(v) && v > 0;

/** M63-C §3: {event → entry list} with array values (opaque passthrough). */
const isHooksNode: FieldCheck = (v) =>
  typeof v === "object" && v !== null && !Array.isArray(v)
  && Object.values(v).every((item) => Array.isArray(item));

/** M64-B §B: the agent-memory tier enum (unset → "project" at the consumer). */
const isMemoryTier: FieldCheck = (v) => v === "project" || v === "local" || v === "user";

/** Known optional fields with their validators; unknown keys are ignored
 *  (forward compatible). A single bad field skips the whole file — the file,
 *  not the field, is the unit of trust. */
const OPTIONAL_FIELDS: Readonly<Record<string, FieldCheck>> = {
  systemPrompt: isString,
  toolNames: isStringArray,
  provider: isString,
  model: isString,
  reasoningEffort: isString,
  maxTurns: isMaxTurns,
  sandbox: isBool,
  frozen: isBool,
  worktree: isBool,
  writeScope: isWriteScopeDeclaration,
  allowShell: isBool,
  hooks: isHooksNode,
  memory: isMemoryTier,
};

function isAgentRoleProfile(id: string, value: unknown): value is AgentRoleProfile {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (typeof record.description !== "string" || record.description.length === 0) return false;
  for (const [field, check] of Object.entries(OPTIONAL_FIELDS)) {
    const v = record[field];
    if (v !== undefined && !check(v)) return false;
  }
  return ROLE_ID_RE.test(id);
}

/** Read one agents directory (`<dir>/*.json`) into the layer. `tierLabel`
 *  prefixes receipts/warnings so a displacement says WHICH tier won
 *  (".wudao/agents/x.json" vs "global agents/x.json"). Later layers win on
 *  id collisions (Map.set). */
async function loadAgentsDir(
  dir: string,
  tierLabel: (name: string) => string,
  profiles: Map<string, AgentRoleProfile>,
  shadowed: ShadowedProfile[],
  warn: (m: string) => void,
): Promise<void> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return; // tier absent — the common case
  }
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const id = name.slice(0, -5);
    const rel = tierLabel(name);
    let raw: string;
    try {
      raw = await readFile(join(dir, name), "utf8");
    } catch (err) {
      warn(`${rel}: unreadable (${err instanceof Error ? err.message : String(err)})`);
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch (err) {
      warn(`${rel}: invalid JSON (${err instanceof Error ? err.message : String(err)}) — skipped`);
      continue;
    }
    if (!isAgentRoleProfile(id, parsed)) {
      warn(`${rel}: not a valid role profile (need non-empty "description"; check field types) — skipped`);
      continue;
    }
    // The filename, not the body, is the id authority (explicit `id` last).
    const profile: AgentRoleProfile = { ...parsed, id };
    if (profiles.has(id)) shadowed.push({ id, by: rel });
    profiles.set(id, profile);
  }
}

/** Load the roster for a workspace: builtin profiles, then the plugin agent
 *  layer (M40), then the GLOBAL tier (M57: `~/.wudao/agents/*.json`), then
 *  `.wudao/agents/*.json` files — builtin < plugin < global < workspace,
 *  every displacement recorded as a ShadowedProfile receipt (source-
 *  annotated). Bad files are skipped with a warning (warn-not-crash) — one
 *  broken role file must never take the harness down. */
export async function loadRoleProfiles(
  workspaceRoot: string,
  options: LoadRosterOptions = {},
): Promise<LoadedRoster> {
  const warn = options.onWarning ?? ((m: string) => console.warn(`[roster] ${m}`));
  const profiles = new Map<string, AgentRoleProfile>();
  for (const [id, profile] of Object.entries(BUILTIN_ROLES)) profiles.set(id, profile);
  const shadowed: ShadowedProfile[] = [];

  // M40 §2: the plugin layer — between builtins and the global/workspace
  // files. The profiles arrive translated in-process (CC agents/*.md →
  // AgentRoleProfile in plugins.ts), so only the id shape is re-checked here.
  for (const { profile, source } of options.pluginAgents ?? []) {
    if (!ROLE_ID_RE.test(profile.id)) {
      warn(`${source}: plugin agent id "${profile.id}" is not a valid role id (letters/digits/_/-) — skipped`);
      continue;
    }
    if (profiles.has(profile.id)) shadowed.push({ id: profile.id, by: source });
    profiles.set(profile.id, profile);
  }

  // M57 §1: the global tier — user-level role profiles applying to every
  // project; a same-name workspace file wins (loaded last) and the receipt
  // chain shows both.
  if (options.globalAgentsDir !== undefined) {
    await loadAgentsDir(
      options.globalAgentsDir,
      (name) => `global agents/${name}`,
      profiles,
      shadowed,
      warn,
    );
  }

  await loadAgentsDir(
    join(workspaceRoot, ".wudao", "agents"),
    (name) => `.wudao/agents/${name}`,
    profiles,
    shadowed,
    warn,
  );
  return { profiles, shadowed };
}

/** Permissions are an intersection: a role only gets the tools it declares
 *  AND that exist in the session's available set (requested order kept). */
export function intersectToolNames(
  requested: readonly string[],
  available: readonly string[],
): string[] {
  const have = new Set(available);
  return requested.filter((name) => have.has(name));
}
