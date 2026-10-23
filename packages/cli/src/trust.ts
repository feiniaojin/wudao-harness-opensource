// P1-5 (96 队列) — the WORKSPACE TRUST GATE's decision store + status math.
// pi core/trust-manager lineage, adapted to wudao's surfaces:
//   • decisions live in the USER global tier (`~/.wudao/trust.json`, keyed by
//     the CANONICAL workspace path — realpath so a symlinked clone can never
//     dodge its own record);
//   • lookup is NEAREST-ANCESTOR: accepting `/repo` covers `/repo/sub` (a
//     deeper entry shadows a shallower one);
//   • `hasTrustRequiringProjectResources` detects the project-carried
//     surfaces the gate suppresses (settings files, the three project skill
//     roots, project plugins). The USER global tiers (~/.wudao, ~/.claude)
//     NEVER count — the user's own machine is not repo-carried content;
//   • fail-closed: no decision + resources present ⇒ suppressed. A first
//     entry into a new repo costs one `/trust accept`; a clone can never
//     inject itself.
//
// The gate's four drop points live elsewhere (this module only DECIDES):
//   skills.ts (project roots) · plugins.ts (project scope) ·
//   settings-layer.ts (project+local permissions.allow/ask + hooks nodes) —
// each takes the suppression as an EXPLICIT caller-passed param (default =
// no gate, byte-stable for every existing caller/test). The one production
// assembly that computes the status is extension-state.buildExtensionState
// (+ index.ts's permission-gate wiring).
//
// Never crashes a boot: a missing/corrupt store reads as {} (warn once on
// corrupt) — which is exactly the no-decision, fail-closed posture.
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { resolveGlobalHome } from "./settings-layer.js";

/** `~/.wudao/trust.json` (WUDAO_GLOBAL_HOME-sandboxed like every global-tier
 *  file — tests isolate it without touching the operator's real store). */
export function trustStorePath(env: NodeJS.ProcessEnv = process.env): string {
  return join(resolveGlobalHome(env), "trust.json");
}

/** The canonical spelling of a workspace path: realpath when it resolves
 *  (symlinks, macOS /var vs /private/var, worktrees), the resolved input
 *  when it does not (a deleted/phantom root must still compare/serialize,
 *  never throw). Same semantics as plugins.normalizeWorkspaceRoot — kept
 *  local because plugins.ts imports THIS module for its gate param, and an
 *  import back would close a cycle. */
export function canonicalizeWorkspacePath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/** The decision store: canonical path → trusted (true/false). Absent key =
 * no decision. Decision `null` on write DELETES the key (pi's shape). */
export type TrustStore = Readonly<Record<string, boolean>>;

/** Read the store. Missing → {}; malformed → one warning + {} (fail-closed:
 *  a corrupt store must read as "no decisions", never crash the boot). */
export function readTrustStore(env: NodeJS.ProcessEnv = process.env, warn: (m: string) => void = () => {}): TrustStore {
  let text: string;
  try {
    text = readFileSync(trustStorePath(env), "utf8");
  } catch {
    return {};
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      warn(`⚠️ ${trustStorePath(env)} must be a JSON object { "<workspace>": true|false }; treating every workspace as untrusted until fixed`);
      return {};
    }
    const out: Record<string, boolean> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (value === true || value === false) out[key] = value;
    }
    return out;
  } catch (err) {
    warn(`⚠️ ${trustStorePath(env)} is not valid JSON (${err instanceof Error ? err.message : String(err)}) — treating every workspace as untrusted until fixed`);
    return {};
  }
}

/** Write one decision. `decision: null` deletes the key (back to fail-closed
 *  for that workspace). Atomic (tmp + rename), mkdir-on-demand; a write
 *  failure propagates to the caller (the /trust face surfaces it — silently
 *  swallowing a failed accept would leave the user BELIEVING they trusted). */
export function setTrustDecision(workspaceRoot: string, decision: boolean | null, env: NodeJS.ProcessEnv = process.env): void {
  const path = trustStorePath(env);
  const store = { ...readTrustStore(env) };
  const key = canonicalizeWorkspacePath(workspaceRoot);
  if (decision === null) delete store[key];
  else store[key] = decision;
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(store, null, 2)}\n`, "utf8");
  renameSync(tmp, path);
}

/** The decision covering this workspace: NEAREST-ANCESTOR lookup over the
 *  store's canonical keys (`/repo/sub` uses `/repo`'s decision; a deeper
 *  entry shadows a shallower one). No covering entry → null (no decision). */
export function getTrustDecision(workspaceRoot: string, env: NodeJS.ProcessEnv = process.env): boolean | null {
  const store = readTrustStore(env);
  let dir = canonicalizeWorkspacePath(workspaceRoot);
  for (;;) {
    if (dir in store) return store[dir] ?? null;
    const parent = dirname(dir);
    if (parent === dir) return null; // reached the root — no covering decision
    dir = parent;
  }
}

/** The project-carried surfaces the gate suppresses, as display labels.
 *  Four classes (96 队列 P1-5 brief): project settings files, the three
 *  project skill roots, project plugins — ANY one makes the workspace
 *  trust-requiring. The USER global tiers never appear here by construction
 *  (they are not workspace-relative paths). */
export function detectTrustRequiringProjectResources(workspaceRoot: string): readonly string[] {
  const found: string[] = [];
  const dirExists = (rel: string): boolean => {
    try {
      return statSync(join(workspaceRoot, rel)).isDirectory();
    } catch {
      return false;
    }
  };
  const fileExists = (rel: string): boolean => existsSync(join(workspaceRoot, rel));
  if (fileExists(join(".wudao", "settings.json"))) found.push("project settings (.wudao/settings.json)");
  if (fileExists(join(".wudao", "settings.local.json"))) found.push("project settings (.wudao/settings.local.json)");
  for (const rel of [join(".agents", "skills"), join(".wudao", "skills"), join(".claude", "skills")]) {
    if (dirExists(rel)) found.push(`project skills (${rel.split(/[\\/]/).join("/")})`);
  }
  if (dirExists(join(".wudao", "plugins"))) found.push("project plugins (.wudao/plugins)");
  return found;
}

/** True when ANY trust-requiring project resource exists. */
export function hasTrustRequiringProjectResources(workspaceRoot: string): boolean {
  return detectTrustRequiringProjectResources(workspaceRoot).length > 0;
}

/** The gate's full status. `effectiveSuppressed` is THE boolean every drop
 *  point keys off: resources present AND no explicit accept ⇒ suppressed
 *  (fail-closed — a `false` decision is an explicit distrust and suppresses
 *  exactly like no decision). */
export interface TrustGateStatus {
  /** The covering decision (nearest ancestor); null = none recorded. */
  readonly decision: boolean | null;
  readonly hasResources: boolean;
  /** The detected trust-requiring project resources (display labels). */
  readonly resources: readonly string[];
  /** hasResources && decision !== true. */
  readonly effectiveSuppressed: boolean;
}

export function trustGateStatus(workspaceRoot: string, env: NodeJS.ProcessEnv = process.env): TrustGateStatus {
  const resources = detectTrustRequiringProjectResources(workspaceRoot);
  const decision = getTrustDecision(workspaceRoot, env);
  return {
    decision,
    hasResources: resources.length > 0,
    resources,
    effectiveSuppressed: resources.length > 0 && decision !== true,
  };
}

/** The single suppression notice text every frontend shares (driver
 *  appendHistory / REPL stdout / boot diagnostics — brief's 统一文案). */
export function formatTrustGateNotice(status: TrustGateStatus): string {
  return "⚠️ workspace not trusted — project skills/plugins/permission-allow/hooks suppressed; /trust to review";
}
