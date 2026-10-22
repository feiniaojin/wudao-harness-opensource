// M63-A §2 — hook matchers — module-level segment extracted from
// hooks-config.ts (ω99 file-size discipline arc A). Matcher compilation and
// per-event entry filtering: pure functions over the config types.
import type { HookCommandConfig, HookWarn } from "./hooks-config-types.js";

/** The "plain" spelling: pure alphanumerics, `_`, `-`, spaces, `,`, `|` —
 *  an exact value or a comma/pipe-separated list of them. Anything else
 *  (`.`, `*`, `^`, …) means JS RegExp, unanchored. */
const MATCHER_PLAIN = /^[A-Za-z0-9_\- ,|]+$/;

export interface CompiledHookMatcher {
  (value: string): boolean;
}

/** Compile a matcher per §2. Plain → exact/list membership (split on `,`/`|`
 *  around whitespace); anything else → `new RegExp(text)` UNANCHORED. An
 *  invalid RegExp warns and never matches (the entry is inert, never fatal).
 *  Absent/blank → matches every firing. */
export function compileHookMatcher(matcher: string | undefined, warn: HookWarn, command: string): CompiledHookMatcher {
  if (matcher === undefined || matcher.trim() === "") return () => true;
  const text = matcher.trim();
  if (MATCHER_PLAIN.test(text)) {
    const values = new Set(text.split(/[,|]/).map((v) => v.trim()).filter((v) => v !== ""));
    return (value: string): boolean => values.has(value);
  }
  try {
    const re = new RegExp(text);
    return (value: string): boolean => re.test(value);
  } catch {
    warn(`⚠️ hook '${command}'：matcher "${matcher}" 不是合法的 RegExp——该 hook 永不触发`);
    return () => false;
  }
}

/** One config entry with its matcher compiled (build-time, warn-once) plus
 *  the M63-C per-hook fields and a stable identity for once-tracking. */
export interface CompiledHook {
  /** Stable identity (command string / mcp spec) — the once-tracking key. */
  readonly identity: string;
  /** Undefined for the mcp_tool backend. */
  readonly command?: string;
  readonly timeoutMs?: number;
  /** Undefined = the config entry had no matcher (fires for every value). */
  readonly matcher?: string;
  /** cc-plugins E4: the plugin install dir for plugin-sourced entries —
   *  consumed at fire time (token substitution + child env). */
  readonly pluginRoot?: string;
  readonly match: CompiledHookMatcher;
  readonly once?: boolean;
  readonly modeIf?: readonly string[];
  readonly isAsync?: boolean;
  readonly asyncRewake?: boolean;
  readonly statusMessage?: string;
  readonly mcp?: { readonly server: string; readonly tool: string; readonly input: Record<string, unknown> };
  /** ω99-21: the source-trust flag carried through compilation (see
   *  HookCommandConfig.denyOnly — harness-stamped only). */
  readonly denyOnly?: boolean;
}

export function compileHookList(list: readonly HookCommandConfig[], warn: HookWarn, label = ""): readonly CompiledHook[] {
  return list.map((h, index) => {
    // R1 fix: the once-key is (event label, position, command/mcp spec) —
    // two different `once` entries with the SAME command no longer collide.
    const identity = `${label}#${index}:${h.command ?? `mcp:${h.server}/${h.tool}`}`;
    const modeIf = h.if !== undefined
      ? h.if.split(/[,|]/).map((v) => v.trim()).filter((v) => v !== "")
      : undefined;
    return {
      identity,
      ...(h.command !== undefined ? { command: h.command } : {}),
      ...(h.timeoutMs !== undefined ? { timeoutMs: h.timeoutMs } : {}),
      ...(h.matcher !== undefined ? { matcher: h.matcher } : {}),
      ...(h.pluginRoot !== undefined ? { pluginRoot: h.pluginRoot } : {}),
      match: compileHookMatcher(h.matcher, warn, identity),
      ...(h.once === true ? { once: true } : {}),
      ...(modeIf !== undefined && modeIf.length > 0 ? { modeIf } : {}),
      ...(h.async === true ? { isAsync: true } : {}),
      ...(h.asyncRewake === true ? { asyncRewake: true } : {}),
      ...(h.statusMessage !== undefined ? { statusMessage: h.statusMessage } : {}),
      ...(h.denyOnly === true ? { denyOnly: true } : {}),
      ...(h.type === "mcp_tool" && h.server !== undefined && h.tool !== undefined
        ? { mcp: { server: h.server, tool: h.tool, input: h.input ?? {} } }
        : {}),
    };
  });
}

/** The entries of this list that fire for matcherValue. Events WITHOUT a
 *  matcher dimension (UserPromptSubmit/PostToolBatch) pass undefined: only
 *  matcher-less entries run there — a matcher on a matcher-less event is
 *  inert by construction (there is nothing to match against). */
export function applicableHooks(list: readonly CompiledHook[], matcherValue: string | undefined): readonly CompiledHook[] {
  if (matcherValue === undefined) return list.filter((h) => h.matcher === undefined);
  return list.filter((h) => h.match(matcherValue));
}
