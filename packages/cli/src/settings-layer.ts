// M57 §1 — the layered settings reader. ONE place knows that settings come
// from a GLOBAL tier (`~/.wudao/settings.json`, overridable via
// WUDAO_GLOBAL_HOME for tests/CI), a PROJECT tier
// (`<workspaceRoot>/.wudao/settings.json`), and — since M62 §3 — a LOCAL
// tier (`<workspaceRoot>/.wudao/settings.local.json`, the highest
// USER-EDITABLE layer); every loader (hooks / sidecar / longTask /
// writeVerify / longOutput / permissions watcher) asks it for the
// EFFECTIVE record instead of reading the project file directly.
//
// Merge semantics (docs/research/20-config-layering.md — real Claude Code):
//   - deep merge, more-specific tier wins on scalar conflicts;
//   - arrays CONCAT + DEDUP across tiers in tier order (permissions.allow,
//     hook lists — rules accumulate; CC settings.ts:529-547
//     `uniq([...a, ...b])`);
//   - precedence defaults < user(global) < project < local (M62 §3).
//
// TRUST GATE (CC RCE precedent, settings.ts:877-928): a PROJECT file is
// attacker-controllable content — a cloned repo must never be able to grant
// itself privileges. Privilege-escalation keys (bypass/auto-mode opt-ins,
// protected-path relaxations, env injection into every spawned process, and
// a project-tier `sidecar.enabled:false` = disarming the auto-mode safety
// classifier) are DROPPED from the project tier with a warning. Reading the
// same keys from the GLOBAL tier is fine — the user wrote those.
// M62 §3 ruling: the LOCAL tier is PHYSICALLY in the project directory, so a
// clone can carry it — LOCAL FOLLOWS PROJECT-TRUST and the same gate drops
// the same keys there (stricter than CC; README documents the choice).
//
// Credentials never live in settings — they live in `~/.wudao/.credentials.yaml`
// (0600, M63 §B; see credentials.ts). Settings keep non-secret preferences.
import { readFileSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** Where the global tier lives. `WUDAO_GLOBAL_HOME` overrides `~/.wudao`
 *  (tests/CI isolation — never read this into a persisted path). */
export function resolveGlobalHome(env: NodeJS.ProcessEnv = process.env): string {
  const raw = (env["WUDAO_GLOBAL_HOME"] ?? "").trim();
  return raw !== "" ? raw : join(homedir(), ".wudao");
}

export function globalSettingsPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(resolveGlobalHome(env), "settings.json");
}

export function projectSettingsPath(workspaceRoot: string): string {
  return join(workspaceRoot, ".wudao", "settings.json");
}

/** M62 §3 — the LOCAL tier: `.wudao/settings.local.json`, the highest
 *  USER-EDITABLE layer (global < project < local). Physically inside the
 *  project directory, so a cloned repo can carry it — LOCAL FOLLOWS
 *  PROJECT-TRUST: the same escalation-key gate applies (stricter than CC;
 *  see sanitizeUntrustedTier). */
export function localSettingsPath(workspaceRoot: string): string {
  return join(workspaceRoot, ".wudao", "settings.local.json");
}

// ---------------------------------------------------------------------------
// Trust gate — keys the PROJECT tier may never set or relax
// ---------------------------------------------------------------------------

/** Privilege-escalation key classes (spec §1 trust gate). Names cover the
 *  wudao schema plus the reserved spellings a future version might add —
 *  fail-closed: an unknown-but-privilege-shaped key is still listed here, so
 *  the gate does not silently open when the key ships. */
const PROJECT_FORBIDDEN_KEYS: ReadonlySet<string> = new Set([
  // bypass / auto-mode opt-ins (CC `skipDangerousModePermissionPrompt`,
  // `autoMode` — "a malicious project could otherwise auto-bypass … (RCE)")
  "bypassPermissions",
  "dangerouslyBypassPermissions",
  "skipDangerousModePermissionPrompt",
  "autoMode",
  "autoAccept",
  "autoApprove",
  // env injection — settings env applies to EVERY spawned process
  "env",
  // protected-path relaxations (the bypass-immune write gate's file set)
  "protectedPaths",
  "protectedPathsRelaxations",
  "additionalProtectedPaths",
  "allowProtectedPathWrites",
  // workspace trust
  "trust",
  "trustWorkspace",
  // remote-surface opening (M60 review F3): a project-tier `slack` node
  // (enabled + attacker-chosen allowlists) would let a cloned repo switch the
  // operator's daemon on and widen who may drive/approve sessions — the same
  // escalation class as bypass opt-ins. Slack config is global-tier only.
  "slack",
  // P2-15 (96 队列 #15): telemetry is remote-surface opening too — a
  // project-tier `telemetry.otlpEndpoint` would make a cloned repo beacon
  // the operator's session telemetry (session.id/model/tool names/tokens)
  // to an attacker-chosen collector. Same class as `slack`: global-tier only
  // (the operator's own machine, the operator's own endpoint).
  "telemetry",
  // P2-13 (96 队列 #13): the user constitution is user-global governance —
  // a project-tier `constitution` node would let a cloned repo write the
  // operator's constitution (model-visible BINDING rules: hand the agent
  // its own instructions). Same class as telemetry/slack: global-tier only.
  "constitution",
  // ω99-46: egress routing is remote-surface opening too — a project-tier
  // `network` node (proxy + proxyRoutes) would let a cloned repo reroute
  // ALL of the operator's outbound traffic (provider endpoints, web_fetch
  // targets — targets and SNI visible to the attacker-chosen proxy, and any
  // plain-http leg fully readable) through a proxy the operator never
  // configured. Same class as telemetry/slack: global-tier only (the
  // user's own machine, the user's own proxy).
  "network",
]);

export function isProjectForbiddenKey(key: string): boolean {
  return PROJECT_FORBIDDEN_KEYS.has(key);
}

export interface ProjectTierSanitizeResult {
  /** The project record with every escalation removed. */
  readonly record: Readonly<Record<string, unknown>>;
  /** One warning per dropped key/value. */
  readonly warnings: readonly string[];
  /** M61 §3: the dropped key NAMES (structured — consumers like the /goal
   *  availability check key on the flag, never on warning prose). */
  readonly dropped: readonly string[];
}

/** Strip privilege escalations from a PROJECT-tier record. Pure; never
 *  throws. Sub-key rules: `sidecar.enabled:false` disarms the M45 auto-mode
 *  classifier — a relaxation the project tier cannot make (`true` stays —
 *  tightening is always allowed); `permissions.defaultMode` (0.3.11) sets
 *  the starting permission tier — a cloneable tier may not move it at all
 *  (the node's allow/deny rules still merge cross-tier untouched). */
export function sanitizeProjectTier(record: Readonly<Record<string, unknown>>): ProjectTierSanitizeResult {
  return sanitizeUntrustedTier(record, ".wudao/settings.json");
}

/** M62 §3 — the trust gate over ANY cloneable tier (project OR local). The
 *  local file lives in the project directory, so it inherits exactly the
 *  project trust posture: escalation keys are refused with a warning naming
 *  the file, `sidecar.enabled:false` is a refused relaxation. Pure. */
export function sanitizeUntrustedTier(
  record: Readonly<Record<string, unknown>>,
  fileLabel: string,
): ProjectTierSanitizeResult {
  const warnings: string[] = [];
  const dropped: string[] = [];
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (isProjectForbiddenKey(key)) {
      dropped.push(key);
      warnings.push(
        `⚠️ ${fileLabel}："${key}" 是提权键——本层已忽略（如确有需要，请在全局层 settings.json 设置）`, // ω99-177: #10
      );
      continue;
    }
    if (key === "sidecar" && value !== null && typeof value === "object" && !Array.isArray(value)) {
      const sidecar = value as Record<string, unknown>;
      if (sidecar["enabled"] === false) {
        const kept = { ...sidecar };
        delete kept["enabled"];
        warnings.push(
          `⚠️ ${fileLabel}：sidecar.enabled:false 会解除 auto 模式分类器——本层已忽略（可克隆层只能收紧、不能放宽安全门）`, // ω99-177: #11
        );
        out[key] = kept;
        continue;
      }
    }
    // 0.3.11（用户反馈：权限档两入口 1:1 联动）— sub-key gate, the sidecar
    // precedent: `permissions` is an EXISTING cross-tier node (the allow/deny
    // rule lists merge across tiers by design), so the node itself is NOT
    // forbidden — but a cloneable tier may not set the STARTING permission
    // tier (a project defaulting the operator into `auto` is a bypass opt-in
    // with extra steps; even `default` would let a clone fight the operator's
    // global choice). Any value, any shape → dropped; rules pass untouched.
    if (key === "permissions" && value !== null && typeof value === "object" && !Array.isArray(value)) {
      const perms = value as Record<string, unknown>;
      if ("defaultMode" in perms) {
        const kept = { ...perms };
        delete kept["defaultMode"];
        warnings.push(
          `⚠️ ${fileLabel}：permissions.defaultMode 设置起始权限 tier——本层已忽略（如确有需要，请在全局层的 settings.json 设置）`, // ω99-207: #2
        );
        out[key] = kept;
        continue;
      }
    }
    out[key] = value;
  }
  return { record: out, warnings, dropped };
}

// ---------------------------------------------------------------------------
// P1-5 (96 队列) — the workspace-trust surface suppression. Applied by
// loadLayeredSettings ONLY when the caller passes suppressUntrustedProject
// (the trust DECISION is computed by the caller — extension-state /
// permission wiring read trust.ts; this module never reads trust.json, so
// its dozen other consumers keep byte-identical behavior by default).
// ---------------------------------------------------------------------------

/** The project-carried settings surface an UNTRUSTED workspace may not
 *  contribute: `permissions.allow`/`ask` rules (a clone could otherwise
 *  silence its own ask layer; DENY always merges — tightening is never
 *  gated), `permissions.sidecarExempt` rules (ω99-27 T2: an allow-class
 *  lane — a clone must not be able to exempt itself from the auto-mode
 *  classifier), and the `hooks` node (M63's command runner is
 *  event-triggered exec). Pure; never throws; warns once per dropped
 *  surface. */
export function suppressUntrustedProjectSurface(
  record: Readonly<Record<string, unknown>>,
  fileLabel: string,
): { readonly record: Readonly<Record<string, unknown>>; readonly warnings: readonly string[] } {
  const warnings: string[] = [];
  const out: Record<string, unknown> = { ...record };
  const perms = out["permissions"];
  if (perms !== null && typeof perms === "object" && !Array.isArray(perms)) {
    const rec = perms as Record<string, unknown>;
    if (Array.isArray(rec["allow"]) || Array.isArray(rec["ask"]) || Array.isArray(rec["sidecarExempt"])) {
      const kept = { ...rec };
      const parts: string[] = [];
      if (Array.isArray(kept["allow"]) || Array.isArray(kept["ask"])) parts.push("allow/ask");
      if (Array.isArray(kept["sidecarExempt"])) parts.push("sidecarExempt");
      delete kept["allow"];
      delete kept["ask"];
      delete kept["sidecarExempt"];
      out["permissions"] = kept;
      warnings.push(`⚠️ ${fileLabel}：permissions.${parts.join("/")} 规则已忽略——工作区未受信任（可用 /trust 审阅；deny 规则仍生效）`);
    }
  }
  if ("hooks" in out) {
    delete out["hooks"];
    warnings.push(`⚠️ ${fileLabel}：hooks 已忽略——工作区未受信任（可用 /trust 审阅）`);
  }
  return { record: out, warnings };
}

/** loadLayeredSettings' trust-gate options (P1-5). Absent = no gate — the
 *  byte-stable default every existing caller and test keeps. */
export interface LayeredTrustOptions {
  /** True = the workspace is UNTRUSTED (trust.ts's effectiveSuppressed):
   *  the project + local tiers' permissions.allow/ask and hooks nodes drop. */
  readonly suppressUntrustedProject?: boolean;
}

// ---------------------------------------------------------------------------
// Merge
// ---------------------------------------------------------------------------

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** 安全审计 2026-11 C1 — 原型污染净化。`JSON.parse('{"__proto__":{…}}')` 会
 *  把 `__proto__` 造成自有数据属性：own-key 循环（forbidden-key 黑名单、
 *  suppressUntrustedProjectSurface）都能看见它，但随后任何普通赋值
 *  （`out[key] = value`）都会触发 setter，把整个对象变成记录的
 *  [[Prototype]]——之后 `record["permissions"]` 等取值解析到注入的原型上，
 *  trust 门被静默洗白。与其加固每一处累加器，不如在解析边界递归剥掉这个
 *  键（settings 里它永远不可能合法出现）。纯函数；绝不抛出。 */
function stripProtoKeys(
  record: Record<string, unknown>,
  fileLabel: string,
  warn: ((m: string) => void) | undefined,
): Record<string, unknown> {
  let stripped = false;
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (!isPlainObject(node)) return node;
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node)) {
      if (key === "__proto__") {
        stripped = true;
        continue;
      }
      out[key] = walk(value);
    }
    return out;
  };
  const cleaned = walk(record) as Record<string, unknown>;
  if (stripped && warn !== undefined) {
    warn(`⚠️ ${fileLabel}："__proto__" 是原型污染键——已忽略（settings 中不可能合法出现）`);
  }
  return cleaned;
}

/** Stable canonical form for array dedup (member key order is normalized). */
function canonicalArrayItem(v: unknown): string {
  if (isPlainObject(v)) {
    const keys = Object.keys(v).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalArrayItem(v[k])}`).join(",")}}`;
  }
  if (Array.isArray(v)) return `[${v.map(canonicalArrayItem).join(",")}]`;
  return JSON.stringify(v) ?? "undefined";
}

/** Deep merge with CC semantics: objects recurse (project wins), arrays
 *  concat + dedup (global entries first — stable order), everything else
 *  project-wins. Pure; `global`/`project` are never mutated. */
export function deepMergeSettings(
  global: Readonly<Record<string, unknown>> | undefined,
  project: Readonly<Record<string, unknown>> | undefined,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const keys = new Set([...Object.keys(global ?? {}), ...Object.keys(project ?? {})]);
  for (const key of keys) {
    const g = global?.[key];
    const p = project?.[key];
    if (p === undefined) {
      out[key] = g;
      continue;
    }
    if (g === undefined) {
      out[key] = p;
      continue;
    }
    if (isPlainObject(g) && isPlainObject(p)) {
      out[key] = deepMergeSettings(g, p);
      continue;
    }
    if (Array.isArray(g) && Array.isArray(p)) {
      const merged = [...g, ...p];
      const seen = new Set<string>();
      const deduped: unknown[] = [];
      for (const item of merged) {
        const c = canonicalArrayItem(item);
        if (seen.has(c)) continue;
        seen.add(c);
        deduped.push(item);
      }
      out[key] = deduped;
      continue;
    }
    out[key] = p;
  }
  return out;
}

// ---------------------------------------------------------------------------
// The layered reader
// ---------------------------------------------------------------------------

/** Which tier supplied a top-level key (for /config source annotation). */
export type SettingsKeySource =
  | "global"
  | "project"
  | "local"
  | "global+project"
  | "global+local"
  | "project+local"
  | "global+project+local";

export interface LayeredSettings {
  /** The resolved global home (WUDAO_GLOBAL_HOME or ~/.wudao). */
  readonly globalHome: string;
  /** The global tier's record ({} when absent/malformed). */
  readonly global: Readonly<Record<string, unknown>>;
  /** The project tier's record AFTER the trust gate ({} when absent). */
  readonly project: Readonly<Record<string, unknown>>;
  /** M62 §3: the local tier's record AFTER the same trust gate ({} when
   *  absent) — `.wudao/settings.local.json`, the highest user-editable
   *  layer. Local follows project trust: escalation keys are refused. */
  readonly local: Readonly<Record<string, unknown>>;
  /** The effective merged record every loader consumes. */
  readonly effective: Readonly<Record<string, unknown>>;
  /** Top-level key → source tier(s) that set it. */
  readonly keySources: Readonly<Record<string, SettingsKeySource>>;
  /** Tier-tagged parse warnings + trust-gate rejections, in tier order. */
  readonly warnings: readonly string[];
  /** M61 §3: privilege-escalation keys an UNTRUSTED tier (project, and since
   *  M62 §3 also local) tried to set — the trust gate dropped them.
   *  Structured, prose-free. Non-empty ⇒ the workspace's settings are
   *  untrusted content (cloneable file). */
  readonly projectEscalations: readonly string[];
}

/** Parse one tier's settings.json. Missing/empty → {}; malformed → one
 *  warning + {} (the whole tier drops, never the process). */
async function readTier(path: string, tier: "global" | "project" | "local", warn: (m: string) => void): Promise<Record<string, unknown>> {
  let text: string | undefined;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return {}; // absent tier — silent (defaults)
  }
  if (!text.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    warn(`⚠️ ${path} 不是合法的 JSON（${err instanceof Error ? err.message : String(err)}）——${tier} settings 已忽略`);
    return {};
  }
  if (!isPlainObject(parsed)) {
    warn(`⚠️ ${path}：顶层应为对象——${tier} settings 已忽略`);
    return {};
  }
  return stripProtoKeys(parsed, path, warn);
}

/** Read all three tiers, apply the trust gate to the cloneable two, merge.
 *  The single entry point the settings loaders call (each takes `effective`
 *  / its node from here). Merge order (M62 §3): global < project < local —
 *  scalars local-wins, arrays concat + dedup global → project → local (the
 *  nested deepMergeSettings composition produces exactly that member
 *  order). */
export async function loadLayeredSettings(
  workspaceRoot: string,
  warn: (m: string) => void = () => {},
  env: NodeJS.ProcessEnv = process.env,
  opts: LayeredTrustOptions = {},
): Promise<LayeredSettings> {
  const globalHome = resolveGlobalHome(env);
  const warnings: string[] = [];
  const global = await readTier(globalSettingsPath(env), "global", (m) => { warnings.push(m); warn(m); });
  const rawProject = await readTier(projectSettingsPath(workspaceRoot), "project", (m) => { warnings.push(m); warn(m); });
  const sanitized = sanitizeProjectTier(rawProject);
  for (const w of sanitized.warnings) {
    warnings.push(w);
    warn(w);
  }
  // M62 §3: the local tier — same trust gate, own file label.
  const rawLocal = await readTier(localSettingsPath(workspaceRoot), "local", (m) => { warnings.push(m); warn(m); });
  const sanitizedLocal = sanitizeUntrustedTier(rawLocal, ".wudao/settings.local.json");
  for (const w of sanitizedLocal.warnings) {
    warnings.push(w);
    warn(w);
  }
  // P1-5: the workspace-trust surface suppression over BOTH cloneable tiers
  // (explicit opt-in param — the decision is the caller's, never read here).
  let projectRecord = sanitized.record;
  let localRecord = sanitizedLocal.record;
  if (opts.suppressUntrustedProject === true) {
    const p = suppressUntrustedProjectSurface(projectRecord, ".wudao/settings.json");
    projectRecord = p.record;
    for (const w of p.warnings) { warnings.push(w); warn(w); }
    const l = suppressUntrustedProjectSurface(localRecord, ".wudao/settings.local.json");
    localRecord = l.record;
    for (const w of l.warnings) { warnings.push(w); warn(w); }
  }
  // Escalations from EITHER cloneable tier mark the workspace untrusted
  // (fail-closed for the /goal availability check, M61 §3).
  const projectEscalations: readonly string[] = [...sanitized.dropped, ...sanitizedLocal.dropped];
  const effective = deepMergeSettings(deepMergeSettings(global, projectRecord), localRecord);
  const keySources: Record<string, SettingsKeySource> = {};
  const gk = new Set(Object.keys(global));
  const pk = new Set(Object.keys(projectRecord));
  const lk = new Set(Object.keys(localRecord));
  for (const key of new Set([...gk, ...pk, ...lk])) {
    const parts: string[] = [];
    if (gk.has(key)) parts.push("global");
    if (pk.has(key)) parts.push("project");
    if (lk.has(key)) parts.push("local");
    keySources[key] = parts.join("+") as SettingsKeySource;
  }
  return { globalHome, global, project: projectRecord, local: localRecord, effective, keySources, warnings, projectEscalations };
}

// ---------------------------------------------------------------------------
// M62 §3 — writing the local tier. First write auto-gitignores the file:
// settings.local.json is personal (and can carry personal paths/values), so
// it must not ride a git clone by accident — the inverse of the trust rule
// (the FILE may be carried; we just do not encourage it).
// ---------------------------------------------------------------------------

export interface SaveLocalSettingsResult {
  readonly path: string;
  readonly created: boolean;
  /** True when the .gitignore entry landed (or already existed). */
  readonly gitignored: boolean;
}

/** Atomically write `.wudao/settings.local.json`. On FIRST creation (the
 *  file did not exist) the writer appends the ignore entry to an existing
 *  `.gitignore`; with no `.gitignore` it warns and returns manual guidance
 *  (never creates one — inventing ignore files is the user's call). */
export async function saveLocalSettings(
  workspaceRoot: string,
  record: Readonly<Record<string, unknown>>,
  warn: (m: string) => void = () => {},
): Promise<SaveLocalSettingsResult> {
  const path = localSettingsPath(workspaceRoot);
  let existed = true;
  try {
    await readFile(path, "utf8");
  } catch {
    existed = false;
  }
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  await writeFile(tmp, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  await rename(tmp, path);
  let gitignored = false;
  if (!existed) {
    const entry = ".wudao/settings.local.json";
    const gitignore = join(workspaceRoot, ".gitignore");
    let text: string | undefined;
    try {
      text = await readFile(gitignore, "utf8");
    } catch {
      text = undefined;
    }
    if (text === undefined) {
      warn(`⚠️ 未找到 .gitignore——请手动将 "${entry}" 加入其中，以免本地 settings 被提交`);
    } else if (!text.split(/\r?\n/).some((l) => l.trim() === entry)) {
      const withEntry = `${text.replace(/\n*$/, "\n")}${entry}\n`;
      const tmpIg = `${gitignore}.tmp-${process.pid}`;
      await writeFile(tmpIg, withEntry, "utf8");
      await rename(tmpIg, gitignore);
      gitignored = true;
    } else {
      gitignored = true;
    }
  }
  return { path, created: !existed, gitignored };
}

// ---------------------------------------------------------------------------
// M63 §B — writing the GLOBAL tier. The settings page persists personal
// preferences (the 12 writable keys — ω99-237: #4 truth fix; see settingsSet's
// unknown-key error in driver/settings-ops.ts, the single source of truth —
// this mirror once drifted to "8" when the language pair landed uncounted)
// to `~/.wudao/settings.json`:
// user-authored, never clone-carried, so no trust gate applies — but the
// writer still refuses the escalation keys (fail-closed symmetry: nothing
// should be able to WRITE what the loader would only ever refuse to read).
// ---------------------------------------------------------------------------

/** Read the global tier's record ({} when absent/malformed). The sync
 *  counterpart below is the same read for sync loaders (plugin discovery). */
export async function readGlobalSettings(env: NodeJS.ProcessEnv = process.env): Promise<Record<string, unknown>> {
  return readGlobalSettingsSync(env);
}

/** The sync mirror of readGlobalSettings — ONE implementation of the global
 *  tier's tolerant read semantics (absent/malformed → {}), no duplication. */
export function readGlobalSettingsSync(env: NodeJS.ProcessEnv = process.env): Record<string, unknown> {
  try {
    const parsed = JSON.parse(readFileSync(globalSettingsPath(env), "utf8")) as unknown;
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      // 安全审计 2026-11 C1 — 与 readTier 同一净化（同步读取无 warn 通道，
      // 沿用本函数对损坏输入的静默容忍语义）。
      return stripProtoKeys({ ...(parsed as Record<string, unknown>) }, globalSettingsPath(env), undefined);
    }
  } catch {
    /* absent or malformed — a fresh record starts the file over */
  }
  return {};
}

/** 0.3.11 — the persisted default permission mode (the GLOBAL tier's read;
 * the project/local tiers' `permissions.defaultMode` sub-key is gated away
 * by sanitizeUntrustedTier, so a clone cannot move the starting tier).
 * Pure on a record so the boot and the ops reader share ONE validation: an
 * absent/corrupted node reads as undefined (the boot falls to "workspace").
 * 0.3.12: the shield-tier values renamed with the three-mode redesign —
 * legacy persisted values migrate on read (default→ask, acceptEdits→
 * workspace, auto→auto); junk (incl. the never-persistable "read-only")
 * reads as undefined. */
export function readGlobalDefaultPermissionMode(
  record: Readonly<Record<string, unknown>>,
): "workspace" | "ask" | "auto" | "plan" | undefined {
  const node = record["permissions"];
  if (typeof node !== "object" || node === null || Array.isArray(node)) return undefined;
  const mode = (node as Record<string, unknown>)["defaultMode"];
  if (mode === "workspace" || mode === "ask" || mode === "auto" || mode === "plan") return mode;
  // 0.3.12 legacy migration — the 0.3.11-and-earlier value set.
  if (mode === "acceptEdits") return "workspace";
  if (mode === "default") return "ask";
  return undefined;
}

/** Atomically write the global tier's record. Returns the written path.
 *  Review M1: the escalation-key refusal applies only to keys the write
 *  INTRODUCES — the GLOBAL tier legally holds escalation-class values the
 *  USER wrote by hand (M60's `slack` node, global `env`, `autoMode`), and a
 *  later preference write through this function must not strand those.
 *  Diffing against the on-disk record keeps the fail-closed posture for NEW
 *  escalations (this writer never adds one) while preserving existing ones
 *  verbatim; the settingsSet allowlist remains the actual entry gate.
 *  (0.3.11 note: `permissions.defaultMode` — the one escalation-shaped value
 *  an op legitimately writes — lives under a node that is NOT forbidden;
 *  the cloneable tiers' sub-key gate is sanitizeUntrustedTier's job.) */
export async function saveGlobalSettings(
  record: Readonly<Record<string, unknown>>,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const onDisk = await readGlobalSettings(env);
  for (const key of Object.keys(record)) {
    if (isProjectForbiddenKey(key) && !(key in onDisk)) {
      throw new Error(`"${key}" 是提权键——全局写入器拒绝引入`); // ω99-183: #1
    }
  }
  const path = globalSettingsPath(env);
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  await writeFile(tmp, `${JSON.stringify(record, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(tmp, path);
  return path;
}
