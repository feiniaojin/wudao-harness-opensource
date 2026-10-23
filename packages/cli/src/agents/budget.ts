// M31 §2 — adaptive fan-out budget (hive 3, anti-ratchet). Every finished
// child appends a per-role sample to `.wudao/agents-stats.json` (persists
// across sessions, last 50 samples per role). Suggestions use ONLY
// successful, non-grace samples: estimate = median(success turns), ceiling
// = 1.25 × max(success turns) — a budget can never ratchet above what has
// actually been observed to succeed. Fewer than 3 qualifying samples → the
// default (role maxTurns ?? 20). `WUDAO_AGENT_BUDGETS=off` disables the
// whole feature. Turns only; the token dimension is deliberately out of
// scope for M31.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { join } from "node:path";

/** One finished-child observation. Censored samples (budgetLimited) and
 *  failures carry zero force on the estimate — they are kept for history,
 *  never for suggestions. */
export interface AgentBudgetSample {
  /** Model turns the child consumed. */
  readonly turns: number;
  /** True iff the child reached a final answer. */
  readonly ok: boolean;
  /** True iff the grace fuse fired (a budget-LIMITED run). */
  readonly budgetLimited: boolean;
  /** Optional provider-reported total tokens. */
  readonly tokens?: number;
}

/** The on-disk shape. */
export interface AgentStatsFile {
  readonly version: 1;
  readonly roles: Readonly<Record<string, readonly AgentBudgetSample[]>>;
}

/** Samples retained per role (spec §2). */
export const AGENT_STATS_KEEP = 50;

/** `<workspaceRoot>/.wudao/agents-stats.json`. */
export function defaultStatsPath(workspaceRoot: string): string {
  return join(workspaceRoot, ".wudao", "agents-stats.json");
}

function emptyStats(): AgentStatsFile {
  return { version: 1, roles: {} };
}

function isSample(v: unknown): v is AgentBudgetSample {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.turns === "number" && Number.isFinite(r.turns) &&
    typeof r.ok === "boolean" &&
    typeof r.budgetLimited === "boolean" &&
    (r.tokens === undefined || typeof r.tokens === "number")
  );
}

/** Parse raw file text; corrupt/malformed content resets to empty stats
 *  (warn-not-crash: budget telemetry must never take a spawn down). */
export function parseAgentStats(raw: string | undefined): AgentStatsFile {
  if (raw === undefined) return emptyStats();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return emptyStats();
  }
  if (typeof parsed !== "object" || parsed === null) return emptyStats();
  const rolesRaw = (parsed as Record<string, unknown>).roles;
  if (typeof rolesRaw !== "object" || rolesRaw === null || Array.isArray(rolesRaw)) return emptyStats();
  const roles: Record<string, AgentBudgetSample[]> = {};
  for (const [role, list] of Object.entries(rolesRaw as Record<string, unknown>)) {
    if (!Array.isArray(list)) continue;
    const samples = list.filter(isSample);
    if (samples.length > 0) roles[role] = samples;
  }
  return { version: 1, roles };
}

export async function loadAgentStats(path: string): Promise<AgentStatsFile> {
  try {
    return parseAgentStats(await readFile(path, "utf8"));
  } catch {
    return emptyStats(); // missing file — the common case
  }
}

/** Append one sample, keep the last AGENT_STATS_KEEP per role, persist. */
export async function recordAgentSample(path: string, role: string, sample: AgentBudgetSample): Promise<void> {
  const stats = await loadAgentStats(path);
  const kept = [...(stats.roles[role] ?? []), sample].slice(-AGENT_STATS_KEEP);
  const roles: Record<string, readonly AgentBudgetSample[]> = { ...stats.roles, [role]: kept };
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify({ version: 1, roles }, null, 2)}\n`, "utf8");
}

/** True iff the adaptive-budget feature is off (`WUDAO_AGENT_BUDGETS=off`,
 *  exact value — anything else stays on). */
export function budgetsDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.WUDAO_AGENT_BUDGETS === "off";
}

export interface BudgetSuggestion {
  /** The turn budget to dispatch with. */
  readonly suggested: number;
  /** True when fewer than 3 qualifying samples existed and the fallback was used. */
  readonly defaulted: boolean;
  readonly successSamples: number;
  readonly median: number;
  readonly max: number;
  /** 1.25 × max(success turns), floored — raises can never top this. */
  readonly ceiling: number;
}

/** The suggestion: median of successful uncensored turns, clamped to the
 *  1.25×max ceiling, floor 1; <3 qualifying samples → `fallback`. (The
 *  median of a set can never exceed its max, so the clamp is latent for the
 *  median estimate — it exists to bound ANY future estimate to observed
 *  evidence, the anti-ratchet invariant.) */
export function suggestBudget(samples: readonly AgentBudgetSample[], fallback: number): BudgetSuggestion {
  const successes = samples.filter((s) => s.ok && !s.budgetLimited).map((s) => s.turns).sort((a, b) => a - b);
  if (successes.length < 3) {
    return { suggested: fallback, defaulted: true, successSamples: successes.length, median: 0, max: 0, ceiling: 0 };
  }
  const mid = Math.floor(successes.length / 2);
  const median =
    successes.length % 2 === 1
      ? (successes[mid] ?? 0)
      : Math.round(((successes[mid - 1] ?? 0) + (successes[mid] ?? 0)) / 2);
  const max = successes[successes.length - 1] ?? 0;
  const ceiling = Math.max(1, Math.floor(1.25 * max));
  const suggested = Math.max(1, Math.min(median, ceiling));
  return { suggested, defaulted: false, successSamples: successes.length, median, max, ceiling };
}
