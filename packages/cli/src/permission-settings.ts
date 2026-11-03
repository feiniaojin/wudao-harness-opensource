// Permission settings tiers — module-level segment extracted from
// permission.ts (ω99 file-size discipline arc A): the `permissions` node of
// .wudao/settings.json (parse / union / per-tier load) and the
// hot-reloading settings watcher. File IO only — no decision logic.
import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { ConfigChangePosition } from "@wudao-org/core";
import { loadLayeredSettings, globalSettingsPath } from "./settings-layer.js";

/** The `permissions` node of .wudao/settings.json (M33 §1). ω99-27 T2 adds
 *  the fourth list, sidecarExempt: operator rules exempting a call from the
 *  auto-mode sidecar classifier (same selector grammar as allow; consumed
 *  by the sidecar layer ONLY — the static decision never consults it). */
export interface PermissionSettings {
  readonly allow: readonly string[];
  readonly deny: readonly string[];
  readonly ask: readonly string[];
  readonly sidecarExempt: readonly string[];
}

export const EMPTY_PERMISSION_SETTINGS: PermissionSettings = { allow: [], deny: [], ask: [], sidecarExempt: [] };

export type PermissionWarn = (message: string) => void;

/** Tolerant parse of the `permissions` value: non-object → empty + warning;
 *  a non-string[] list → that list empty + warning, the others kept.
 *  `origin` labels the warnings (which tier's file is at fault). */
export function parsePermissionSettings(value: unknown, warn?: PermissionWarn, origin = ".wudao/settings.json"): PermissionSettings {
  if (value === undefined || value === null) return EMPTY_PERMISSION_SETTINGS;
  if (typeof value !== "object" || Array.isArray(value)) {
    warn?.(`⚠️ ${origin}: "permissions" must be an object {allow,deny,ask}; ignored`);
    return EMPTY_PERMISSION_SETTINGS;
  }
  const rec = value as Record<string, unknown>;
  const list = (key: "allow" | "deny" | "ask" | "sidecarExempt"): string[] => {
    const v = rec[key];
    if (v === undefined) return [];
    if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) {
      warn?.(`⚠️ ${origin}: permissions.${key} must be a string[]; ignored`);
      return [];
    }
    return v as string[];
  };
  return { allow: list("allow"), deny: list("deny"), ask: list("ask"), sidecarExempt: list("sidecarExempt") };
}

/** Union with global-first order and exact-string dedup — the same list the
 *  generic settings merge produced for permission arrays, kept as the one
 *  rule for the permission key so a type-confused node in ONE tier can never
 *  erase the other tier's guards (M57 fix). */
export function unionPermissionTiers(global: PermissionSettings, project: PermissionSettings): PermissionSettings {
  const cat = (a: readonly string[], b: readonly string[]): string[] => [...new Set([...a, ...b])];
  return {
    allow: cat(global.allow, project.allow),
    deny: cat(global.deny, project.deny),
    ask: cat(global.ask, project.ask),
    sidecarExempt: cat(global.sidecarExempt, project.sidecarExempt),
  };
}

/** Both tiers' permission rules, parsed SEPARATELY (fix-round M57): the gate
 *  consumes `effective` (the union); `/permissions` mutations consume
 *  `project` so a write never copies the global tier into the project file. */
export interface PermissionTiers {
  readonly global: PermissionSettings;
  readonly project: PermissionSettings;
  /** What the gate sees: union, global first, deduped. */
  readonly effective: PermissionSettings;
  /** The resolved global home (for notices naming the rule's home file). */
  readonly globalHome: string;
}

export async function loadPermissionTiers(
  workspaceRoot: string,
  warn?: PermissionWarn,
  opts: { readonly suppressUntrustedProject?: boolean } = {},
): Promise<PermissionTiers> {
  const layered = await loadLayeredSettings(workspaceRoot, warn ?? (() => {}), undefined, { suppressUntrustedProject: opts.suppressUntrustedProject });
  const global = parsePermissionSettings(layered.global["permissions"], warn, join(layered.globalHome, "settings.json"));
  const project = parsePermissionSettings(layered.project["permissions"], warn, join(workspaceRoot, ".wudao", "settings.json"));
  return { global, project, effective: unionPermissionTiers(global, project), globalHome: layered.globalHome };
}

/** Read the permissions rules the GATE consumes: the per-tier union of the
 *  global (~/.wudao) and project (.wudao) settings — allow/deny/ask
 *  concatenated global-first, deduped. Each tier is parsed on its own, so a
 *  malformed or type-confused node in one tier drops only THAT tier with a
 *  warning naming it. Missing tiers → empty rules (never fatal). */
export async function loadPermissionSettings(
  workspaceRoot: string,
  warn?: PermissionWarn,
  opts: { readonly suppressUntrustedProject?: boolean } = {},
): Promise<PermissionSettings> {
  return (await loadPermissionTiers(workspaceRoot, warn, opts)).effective;
}

/** Hot-reloading settings reader (M33 §1: "变更即时生效并打印回执").
 *  get() re-stats the file at most once per `revalidateMs` (default 1s —
 *  "immediate" for a human editing the file, while keeping the permission
 *  gate's hot path free of filesystem waits); within the window the cached
 *  rules return synchronously-ish (one microtask). A detected change re-parses
 *  and — when the rules actually differ from the previous cached value —
 *  prints a one-line receipt through `notify`. The FIRST load is silent
 *  (startup is not a reload). */
export interface PermissionSettingsWatcher {
  get(): Promise<PermissionSettings>;
}

export function createPermissionSettingsWatcher(
  workspaceRoot: string,
  notify?: (line: string) => void,
  opts?: {
    readonly revalidateMs?: number;
    /** M63-B: the ConfigChange consult — called with the positions whose
     *  files changed BEFORE the reload applies. Returning false VETOES the
     *  swap: the previously accepted rules stay cached (a blocking
     *  onConfigChange hook freezes the permission policy). */
    readonly configChange?: (positions: readonly ConfigChangePosition[]) => Promise<boolean>;
    /** P1-5 (96 队列): the workspace trust gate as a LIVE getter (trust.ts's
     *  effectiveSuppressed). True ⇒ the project+local tiers' allow/ask rules
     *  drop on every reload (deny always merges). The getter's CURRENT value
     *  joins the cache key, so a mid-session /trust accept|revoke re-loads
     *  without a settings-file touch. Absent = no gate (byte-stable default). */
    readonly trustSuppressed?: () => boolean;
    /** P1-7 (96 队列): the OPERATION root as a live getter — workspace-tier
     *  rules interpret by the root the agent currently works in (hard
     *  constraint 5: after a /worktree switch the worktree's settings.json
     *  is the project tier). The root string joins the cache key, so a
     *  switch re-loads without a file touch. Absent = the fixed boot root
     *  (byte-stable default — every existing caller). */
    readonly root?: () => string;
  },
): PermissionSettingsWatcher {
  const revalidateMs = opts?.revalidateMs ?? 1000;
  let cacheKey: string | null = null;
  let cached: PermissionSettings = EMPTY_PERMISSION_SETTINGS;
  let loaded = false;
  let lastStatAt = 0;
  // M57 §1: BOTH tiers' files stat into the cache key — a hot edit of either
  // the global or the project settings re-parses the union. M63-B: the LOCAL
  // tier joins the key (it feeds the same effective union), and each part
  // carries its ConfigChange position so the consult can name what changed.
  // P1-7: with a live root getter the project+local files re-derive from the
  // OPERATION root on every get() (the user tier stays global-home fixed).
  const filesAt = (): readonly { readonly position: ConfigChangePosition; readonly file: string }[] => {
    const root = opts?.root !== undefined ? opts.root() : workspaceRoot;
    return [
      { position: "user", file: globalSettingsPath() },
      { position: "project", file: join(root, ".wudao", "settings.json") },
      { position: "local", file: join(root, ".wudao", "settings.local.json") },
    ];
  };
  const positionChanged = (position: ConfigChangePosition, part: string): boolean => {
    if (cacheKey === null) return false;
    const prev = cacheKey.split("|").find((k) => k.startsWith(`${position}:`));
    return prev !== undefined && prev !== part;
  };
  return {
    async get(): Promise<PermissionSettings> {
      if (loaded && Date.now() - lastStatAt < revalidateMs) return cached;
      lastStatAt = Date.now();
      // P1-7: the live operation root (boot root when no getter).
      const liveRoot = opts?.root !== undefined ? opts.root() : workspaceRoot;
      const parts: string[] = [`root:${liveRoot}`];
      const changedPositions: ConfigChangePosition[] = [];
      for (const { position, file } of filesAt()) {
        let part: string;
        try {
          const st = await stat(file);
          part = `${position}:${st.mtimeMs}:${st.size}`;
        } catch {
          part = `${position}:missing`;
        }
        if (positionChanged(position, part)) changedPositions.push(position);
        parts.push(part);
      }
      const key = [...parts, `trust:${opts?.trustSuppressed?.() ?? false}`].join("|");
      if (loaded && key === cacheKey) return cached;
      const wasLoaded = loaded;
      // M63-B: the ConfigChange gate — consult BEFORE swapping. A veto keeps
      // the previously accepted RULES but pins the key to the OBSERVED state
      // (R1 fix): otherwise every revalidation window re-detects the same
      // change, re-runs the consult commands, and re-emits the BLOCKED notice
      // forever. Pinning means repetition happens only on an ACTUAL further
      // rewrite (a new key), which re-proposes.
      if (wasLoaded && changedPositions.length > 0 && opts?.configChange !== undefined) {
        const allowed = await opts.configChange(changedPositions);
        if (!allowed) {
          notify?.(`⚙️ ${changedPositions.join(", ")} 的配置变更被 configChange 钩子拦截——保持原有权限规则`); // ω99-166f-iii: #17-孪生（config-change.test:61 钉读此处；随 driver #17 演进）
          cacheKey = key;
          return cached;
        }
      }
      cacheKey = key;
      const warns: string[] = [];
      // P1-5: the trust gate rides the reload (live getter — see opts).
      const suppressed = opts?.trustSuppressed?.() === true;
      const next = await loadPermissionSettings(liveRoot, (m) => warns.push(m), { suppressUntrustedProject: suppressed || undefined });
      const prev = cached;
      cached = next;
      loaded = true;
      for (const w of warns) notify?.(w);
      if (wasLoaded && JSON.stringify(next) !== JSON.stringify(prev)) {
        notify?.(
          `⚙️ permissions reloaded — allow ${next.allow.length} · deny ${next.deny.length} · ask ${next.ask.length} · sidecarExempt ${next.sidecarExempt.length} (global + project settings)`,
        );
      }
      return cached;
    },
  };

}
