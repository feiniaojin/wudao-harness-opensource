// M55 §B8 — /permissions: the interactive face of the settings.json
// permission rules. View (bare) + add/remove of allow/deny/ask entries; the
// write goes through the same .wudao/settings.json the hot-reloading watcher
// (createPermissionSettingsWatcher) re-reads on mtime change, so a mutation
// is live at the next permission gate — no restart, no separate channel.
//
// HARD RULE (the immunity layer): rules whose scope touches the
// runtime-policy files (.wudao/settings.json, .wudao/mcp.json) can NOT be
// added or relaxed through this command. Adding an allow/ask for a write tool
// whose path prefix covers a policy file would (try to) silence the
// bypass-immune ask; REMOVING a deny that guards the same files relaxes an
// operator's protection. Both are refused here — the runtime pipeline stays
// immune regardless (decideRichPermission checks protected writes BEFORE the
// settings allow layer), but the file must not carry rules that pretend
// otherwise. Tightening (adding a deny, removing an allow) is always allowed.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { loadPermissionTiers, normalizePath, EMPTY_PERMISSION_SETTINGS, PROTECTED_SETTINGS_FILES, PROTECTED_HOOK_SOURCE_DIRS } from "../permission.js";
import type { PermissionSettings } from "../permission.js";

export type PermList = "allow" | "deny" | "ask";

export type PermissionsCommand =
  | { readonly kind: "view" }
  | { readonly kind: "add"; readonly list: PermList; readonly rule: string }
  | { readonly kind: "remove"; readonly list: PermList; readonly rule: string }
  | { readonly kind: "usage"; readonly error: string };

const LISTS: readonly PermList[] = ["allow", "deny", "ask"];

/** Parse `/permissions` args: bare = view; `add|remove <allow|deny|ask>
 *  <rule>` mutates. Anything else is a usage error naming the grammar. */
export function parsePermissionsArgs(args: string): PermissionsCommand {
  const parts = args.trim().split(/\s+/).filter((p) => p !== "");
  if (parts.length === 0) return { kind: "view" };
  const [verb, listName, ...rest] = parts;
  if (verb !== "add" && verb !== "remove") {
    return { kind: "usage", error: `用法：/permissions [add|remove <allow|deny|ask> <rule>]——收到 "${args.trim()}"` }; // ω99-166d-i: #18
  }
  if (!LISTS.includes(listName as PermList)) {
    return { kind: "usage", error: `用法：/permissions ${verb} <allow|deny|ask> <rule>——列表必须是 allow|deny|ask 之一，收到 "${listName ?? ""}"` }; // ω99-166d-i: #19
  }
  const rule = rest.join(" ").trim();
  if (rule === "" || /[\r\n]/.test(rule)) {
    return { kind: "usage", error: `用法：/permissions ${verb} ${listName} <rule>——规则是单行 "tool" 或 "tool:path-prefix" 形式` }; // ω99-166d-i: #20
  }
  return verb === "add" ? { kind: "add", list: listName as PermList, rule } : { kind: "remove", list: listName as PermList, rule };
}

/** ω99-22 — single source of truth: the targets the immunity guard checks
 *  are the SAME lists the runtime gate enforces (permission.ts's
 *  protectedSettingsFile). The hand-copied mirror that lived here had
 *  drifted: ω99-21 widened the runtime side (.mcp.json, the
 *  .wudao/extensions|plugins hook trees) and this display side never heard —
 *  the runtime refused writes the /permissions view let you "allow".
 *  SEMANTIC DIFFERENCE, pinned: the runtime predicate asks "is THIS concrete
 *  path protected" (exact/suffix match, see protectedSettingsFile); this
 *  guard asks "could the RULE's path prefix cover a protected target" —
 *  segment-prefix match against the same canonical targets. A rule scoped
 *  deeper INSIDE a tree (edit:.wudao/extensions/hooks) covers no canonical
 *  target and is not refused here, but the runtime immune-ask still fires
 *  first, so no protection is actually relaxed. Lists shared; predicates
 *  differ by design. Concatenated inside the function, not at module level:
 *  permission.ts has a documented function-level import cycle with this
 *  module, and its bindings must never be read at module-eval time. */
function protectedPaths(): readonly string[] {
  return [...PROTECTED_SETTINGS_FILES, ...PROTECTED_HOOK_SOURCE_DIRS];
}

function splitRule(rule: string): { tool: string; suffix: string | undefined } {
  const trimmed = rule.trim();
  const colon = trimmed.indexOf(":");
  return colon === -1
    ? { tool: trimmed, suffix: undefined }
    : { tool: trimmed.slice(0, colon), suffix: trimmed.slice(colon + 1) };
}

function pathCoversProtected(suffix: string): boolean {
  const p = normalizePath(suffix).toLowerCase();
  if (p === "" || p === ".") return true; // ".": matches everything (incl. policy files)
  return protectedPaths().some((f) => f === p || f.startsWith(`${p}/`));
}

/** Does this rule's scope touch the settings-file immunity layer? Only
 *  write-class tools with a path lane can; a bare tool name covers every
 *  path, a path-suffixed rule covers the policy files when its prefix does. */
export function ruleTouchesImmunity(rule: string): boolean {
  const { tool, suffix } = splitRule(rule);
  if (tool !== "write_file" && tool !== "edit") return false;
  if (suffix === undefined || suffix.trim() === "") return true;
  return pathCoversProtected(suffix);
}

/** Would this command RELAX protection on the immunity layer? add-to-
 *  allow/ask and remove-from-deny both widen what the settings layer lets
 *  through; anything touching the policy files via those lanes is refused. */
export function refusesMutation(cmd: Extract<PermissionsCommand, { kind: "add" | "remove" }>): boolean {
  if (cmd.kind === "add") {
    if (cmd.list === "deny") return false; // tightening
    return ruleTouchesImmunity(cmd.rule);
  }
  if (cmd.list === "deny") return ruleTouchesImmunity(cmd.rule); // removing a guard
  return false; // removing an allow/ask only tightens
}

// ω99-158: refusal 整句中文化（用户可见；「策略文件」词表与权限面一致）。
export const IMMUNITY_REFUSAL =
  "已拒绝：该规则的作用域触及设置文件豁免层（.wudao/settings.json / .wudao/mcp.json） — 写入策略文件永远需要人工确认，任何设置规则都无法放宽；确有需要请手工编辑该文件";

/** Pure mutation of the three lists: add (dedup, appended last) / remove
 *  (exact match). Returns the next settings; unchanged when the rule was
 *  already present/absent. */
export function mutatePermissionSettings(
  current: PermissionSettings,
  cmd: Extract<PermissionsCommand, { kind: "add" | "remove" }>,
): PermissionSettings {
  if (cmd.kind === "add") {
    if (current[cmd.list].includes(cmd.rule)) return current;
    return { ...current, [cmd.list]: [...current[cmd.list], cmd.rule] };
  }
  if (!current[cmd.list].includes(cmd.rule)) return current;
  return { ...current, [cmd.list]: current[cmd.list].filter((r) => r !== cmd.rule) };
}

/** The bare view: the three lists + the reload + immunity notes. When tier
 *  attribution is supplied (M57 fix-round), rules the GLOBAL tier owns are
 *  tagged with their source — the view shows the UNION the gate enforces,
 *  and says which file each rule lives in. */
export function formatPermissionsTable(
  settings: PermissionSettings,
  opts: {
    readonly file?: string;
    /** Per-rule tier attribution (the two tiers' parsed nodes + the global
     *  home path). Absent → single-file rendering (pre-M57 callers). */
    readonly tiers?: { readonly global: PermissionSettings; readonly project: PermissionSettings; readonly globalHome: string };
  } = {},
): string {
  const tiers = opts.tiers;
  const header = tiers === undefined
    ? `permissions (${opts.file ?? ".wudao/settings.json"} — hot-reloaded at the next gate):`
    : `permissions (union of ${join(tiers.globalHome, "settings.json")} (global) and .wudao/settings.json (project) — hot-reloaded at the next gate):`;
  const origin = (list: PermList, rule: string): string => {
    if (tiers === undefined) return "";
    const inGlobal = tiers.global[list].includes(rule);
    const inProject = tiers.project[list].includes(rule);
    if (inGlobal && inProject) return "  (global+project)";
    if (inGlobal) return "  (global)";
    return "  (project)";
  };
  const block = (list: PermList): string[] => {
    const rules = settings[list];
    if (rules.length === 0) return [`  ${list}: (none)`];
    return [`  ${list}:`, ...rules.map((r) => `    ${r}${origin(list, r)}${ruleTouchesImmunity(r) && list === "deny" ? "  (guards the policy files)" : ""}`)];
  };
  // ω99-27 T2: the exemption lane rides the view ONLY when non-empty (the
  // empty case stays byte-identical to the pre-ω99-27 table). Not mutable
  // via /permissions — an operator takeover is authored in the file itself.
  const exemptBlock =
    settings.sidecarExempt.length === 0
      ? []
      : [
          "  sidecarExempt:",
          ...settings.sidecarExempt.map((r) => `    ${r}`),
          "    (operator sidecar-exemption lane — file-edited only, trusted workspace required)",
        ];
  return [
    header,
    ...block("deny"),
    ...block("ask"),
    ...block("allow"),
    ...exemptBlock,
    `  layer order: settings deny → protected policy writes (always ask) → session allowlist → settings ask/allow → mode`,
    `  /permissions add|remove <allow|deny|ask> <rule> — mutations write the PROJECT tier only (global-tier rules: edit ${tiers === undefined ? "the global settings" : join(tiers.globalHome, "settings.json")}); rules touching .wudao/settings.json or .wudao/mcp.json cannot be added or relaxed here`,
  ].join("\n");
}

/** The full command: parse → guard → read/mutate/write .wudao/settings.json.
 *  The permissions NODE is replaced; every other top-level key (hooks,
 *  longTask, …) is preserved byte-shape via JSON round-trip (2-space indent).
 *  A missing file/node is created on the first mutation.
 *
 *  M57 fix-round: mutations operate on the PROJECT tier's node ONLY — the
 *  global tier's rules are never copied into the committable project file
 *  (a union write would both leak user-global rules into the repo and leave
 *  stale copies after the global file changes). Removing a rule whose home
 *  is the global tier writes nothing and says where the rule lives. */
export async function runPermissionsCommand(args: {
  readonly workspaceRoot: string;
  readonly args: string;
}): Promise<string> {
  const cmd = parsePermissionsArgs(args.args);
  const file = join(args.workspaceRoot, ".wudao", "settings.json");
  if (cmd.kind === "usage") return cmd.error;
  if (cmd.kind === "view") {
    const tiers = await loadPermissionTiers(args.workspaceRoot);
    return formatPermissionsTable(tiers.effective, { tiers });
  }
  if (refusesMutation(cmd)) return IMMUNITY_REFUSAL;

  let root: Record<string, unknown> = {};
  try {
    const text = await readFile(file, "utf8");
    if (text.trim() !== "") root = JSON.parse(text) as Record<string, unknown>;
  } catch {
    // missing file (or unreadable) → start from an empty document
  }
  if (typeof root !== "object" || root === null || Array.isArray(root)) root = {};
  // The PROJECT tier's node is the mutation base (fix-round M57) — parsed
  // straight from the project record, NOT the gate's union.
  const tiers = await loadPermissionTiers(args.workspaceRoot);
  const current = tiers.project;
  if (cmd.kind === "remove" && !current[cmd.list].includes(cmd.rule) && tiers.effective[cmd.list].includes(cmd.rule)) {
    const globalFile = join(tiers.globalHome, "settings.json");
    return `permissions: cannot remove — rule "${cmd.rule}" lives in the GLOBAL tier (${globalFile}, per WUDAO_GLOBAL_HOME); edit that file to change it (the project file cannot shadow it away)`;
  }
  const next = mutatePermissionSettings(current, cmd);
  const redundantGlobalNote =
    cmd.kind === "add" && tiers.global[cmd.list].includes(cmd.rule) ? " (already effective from the global tier — the project copy is redundant)" : "";
  if (next === current) {
    return `permissions: rule "${cmd.rule}" was already ${cmd.kind === "add" ? "present" : "absent"} in ${cmd.list} — nothing written`;
  }
  // ω99-27 T2: the node write PRESERVES sidecarExempt — a /permissions
  // add/remove must never delete an operator's hand-authored exemption
  // rules (the lane is not mutable here, but it must survive here). Empty
  // list → the key stays absent (legacy write shape byte-identical).
  const node = next.sidecarExempt.length > 0
    ? { allow: next.allow, deny: next.deny, ask: next.ask, sidecarExempt: next.sidecarExempt }
    : { allow: next.allow, deny: next.deny, ask: next.ask };
  const out = { ...root, permissions: node };
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(out, null, 2)}\n`, "utf8");
  const verb = cmd.kind === "add" ? "added" : "removed";
  return `permissions: ${verb} ${cmd.list} rule "${cmd.rule}"${redundantGlobalNote} — allow ${next.allow.length} · deny ${next.deny.length} · ask ${next.ask.length} (written to .wudao/settings.json; hot-reloads at the next gate)`;
}

/** 0.3.14 #1 — the `p` (always) ask answer's persistence lane: the SAME write
 *  path `/permissions add allow` uses (project tier only, immunity-guarded,
 *  hot-reloaded). Returns the human receipt; the caller surfaces it. */
export async function persistAllowRule(workspaceRoot: string, rule: string): Promise<string> {
  return runPermissionsCommand({ workspaceRoot, args: `add allow ${rule}` });
}

export { EMPTY_PERMISSION_SETTINGS };
