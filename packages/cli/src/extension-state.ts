// cc-plugins A3 — the re-entrant extension assembly + hot rescan seam.
//
// The boot-time extension assembly (plugins → plugin commands/agents → hooks
// settings → skills → merged MCP config) used to live inline in index.ts's
// main(), frozen at process start. It is now ONE function —
// buildExtensionState(cwd, argv) — that boot calls once and rescanExtensions()
// re-runs on demand (REPL/TUI fire it after a plugin install/uninstall), so a
// rescan reproduces the EXACT boot seams instead of a second, drifting copy.
//
// The swap contract:
//   • the fresh state lands in the module box (getExtensionState) — any later
//     consumer (e.g. loadMcpToolsFor's merged config) sees it;
//   • every registered frontend sink (REPL/TUI/ui register at startup) gets
//     the fresh state, isolated observer-style — one sink throwing never
//     blocks the others or the rescan;
//   • the CACHE INVARIANT, precisely stated (ω99-24): a rescan changes ONLY
//     the trailing <available_skills> manifest of the system prompt — skills
//     ride the ABSOLUTE tail of buildSystemPrompt, everything before it
//     (sections, project context, MCP section) is session-static, and the
//     JSONL history is never touched (append-only). But "only the tail
//     moves" is a BYTE statement, not a COST statement: providers key their
//     prefix cache on the FULL system header, so even a trailing-manifest
//     change makes them recompute from byte 0 and the whole message history
//     re-misses (dogfood: 123.2k on the mission-complete unmount). The swap
//     seam therefore DECLARES that cost — a rescan carrying a typed bundle
//     reason parks its M24 attribution (takePendingBundleColdAttribution) so
//     the next usage row reports cold-and-expected instead of an unexplained
//     ⚠️, and the mission TERMINAL unmounts skip the mid-run rescan entirely
//     (they land at the session boundary). Frontends rebuild the prompt via
//     buildSystemPrompt(root, <static hasMcpTools>, fresh.skills) — never
//     from anything else.
//
// Extensions (.wudao/extensions/*.mjs) are CODE and are NOT rescanned: their
// boot-time hooks object rides every rebuild (extensionsHooks below), because
// re-importing a module would double-register its state for zero benefit.
import type { AgentHooks } from "@wudao/core";
import { loadSkills, applySkillVisibility, loadSkillOverrides, skillsPromptSection } from "./skills.js";
import type { LoadedSkill } from "./skills.js";
// ω99-18 — the campaign-scoped bundle tier. extension-state imports
// mission.ts for EXACTLY this one pure-read function (mission.ts never
// imports extension-state — the cycle guard). One assembly point: boot,
// rescan and swap all re-run buildExtensionState, so a resumed mission's
// bundles remount with zero dedicated resume code.
// ω99-24 B — plus the TYPED lifecycle reason (type-only import; the cycle
// guard is unchanged): a reasoned rescan parks its M24 attribution below.
import { activeBundleSkillRoots, type BundlesChangeReason } from "./mission.js";
import { loadPlugins, appendPluginSkills, collectPluginCommands, collectPluginAgents, mergeMcpConfigs, mergeHooksSettings, countHookCommands, type PluginWarn, type PluginCommand } from "./plugins.js";
import type { LoadedPlugin } from "./plugins.js";
import { loadHooksSettings, buildConfiguredHooks, composeAgentHooks, denyOnlyPermissionRequest, fileChangeTargets, type NonNeverRuntime } from "./hooks-config.js";
import type { HooksSettings } from "./hooks-config.js";
import { loadMcpConfig } from "./mcp/config.js";
import type { McpConfig } from "./mcp/config.js";
import { parsePluginFlags } from "./args.js";
import type { RosterPluginAgent } from "@wudao/core";

/** The assembled extension surface — everything the boot entry feeds its
 *  frontends and everything a rescan swaps. */
export interface ExtensionState {
  readonly plugins: readonly LoadedPlugin[];
  readonly pluginCommands: readonly PluginCommand[];
  /** M40: the roster's plugin agent layer (builtin < plugin < workspace). */
  readonly pluginAgents: readonly RosterPluginAgent[];
  /** The raw user hooks settings (pre-merge) — the fileChangeTargets source. */
  readonly hooksSettings: HooksSettings;
  /** The composed fire runtime: config hooks → plugin hooks (→ boot extension
   *  hooks when attached via attachBootExtensions / opts.extensionsHooks). */
  readonly hooks: AgentHooks | undefined;
  /** M63-B: FileChanged watch targets from the merged hook config. */
  readonly fileWatchTargets: readonly string[];
  readonly skills: readonly LoadedSkill[];
  /** M36: the ONE MCP startup list (user mcp.json + plugin servers, the
   *  user's side winning conflicts). Rescan refreshes the CONFIG; spawned
   *  MCP tool sets are tool-list-prefix-sensitive and stay boot-static. */
  readonly mcpConfig: McpConfig;
  readonly counts: { readonly skills: number; readonly plugins: number; readonly hooks: number };
  /** P1-5: whether THIS build suppressed the untrusted project surface
   *  (skills roots / plugin scope / settings allow-ask + hooks). Diagnostic
   *  face for /trust status and boot notices. */
  readonly trustSuppressed: boolean;
}

/** buildExtensionState's injection seams (the settings-layer pattern): `env`
 *  isolates the global home in tests; `warn` sinks plugin/skill/mcp
 *  diagnostics; `hookWarn` sinks hook-compile diagnostics (the boot entry
 *  routes these to the live driver's notice channel); `hookRuntime` carries
 *  buildConfiguredHooks' live-context closures (mode/stdin fields/mcp
 *  backend/rewake) — the boot entry passes its module-level view so every
 *  rescan compiles against the SAME live boxes. */
export interface BuildExtensionOpts {
  readonly warn?: PluginWarn;
  readonly env?: NodeJS.ProcessEnv;
  readonly hookWarn?: (msg: string) => void;
  /** Boot-time .mjs extension hooks — composed LAST (composeAgentHooks:
   *  blocks short-circuit, rewrites chain). Extensions are code and are
   *  never rescanned; this object rides every rebuild. */
  readonly extensionsHooks?: AgentHooks;
  readonly hookRuntime?: NonNeverRuntime;
  /** P1-5 (96 队列) — the workspace trust gate, as a LIVE getter so every
   *  rescan re-evaluates it (a mid-session `/trust accept` re-runs this exact
   *  build through rescanExtensions). Returns trust.ts's
   *  `effectiveSuppressed`. Absent = no gate — the byte-stable default every
   *  existing caller/test keeps; index.ts passes
   *  `() => trustGateStatus(cwd, env).effectiveSuppressed` (short-circuited
   *  false by --trust-workspace). */
  readonly trustSuppressed?: () => boolean;
}

/** The one re-entrant boot assembly. Byte-parity with the pre-A3 inline code
 *  in index.ts is the contract: same loaders, same order, same merge seams.
 *  Never throws — every constituent loader is warn-not-crash by design. */
export async function buildExtensionState(cwd: string, argv: readonly string[], opts: BuildExtensionOpts = {}): Promise<ExtensionState> {
  const warn = opts.warn ?? (() => {});
  const env = opts.env ?? process.env;
  // P1-5: the trust gate — ONE evaluation per build (boot + every rescan);
  // absent seam = false = no gate (byte-stable default).
  const trustSuppressed = opts.trustSuppressed?.() ?? false;

  // M36 plugins: `.wudao/plugins/*` + `<globalHome>/plugins/*` + `--plugin`
  // mounts (A2 user scope + the enabledPlugins filter live inside loadPlugins).
  const plugins = loadPlugins(cwd, parsePluginFlags(argv), warn, { env, ...(trustSuppressed ? { trustSuppressed: true } : {}) });
  const pluginCommands = collectPluginCommands(plugins, warn);
  const pluginAgents = collectPluginAgents(plugins, warn);

  // .wudao/settings.json hooks (M19) + plugin hooks (M36, mapped event names
  // appended AFTER the user's per event) → the compiled fire runtime.
  const hooksSettings = await loadHooksSettings(cwd, warn, env, { suppressUntrustedProject: trustSuppressed || undefined });
  const merged = mergeHooksSettings(hooksSettings, plugins);
  // ω99-21: the boot extension hooks are composed DENY-ONLY — .wudao/
  // extensions/** is agent-writable code; its permission face may deny or
  // stay silent, never allow (self-authorization chain closed at the source).
  const hooks = composeAgentHooks(
    buildConfiguredHooks(merged, {
      workspaceRoot: cwd,
      ...(opts.hookWarn !== undefined ? { warn: opts.hookWarn } : { warn }),
      ...(opts.hookRuntime?.getMode !== undefined ? { getMode: opts.hookRuntime.getMode } : {}),
      ...(opts.hookRuntime?.common !== undefined ? { common: opts.hookRuntime.common } : {}),
      ...(opts.hookRuntime?.mcp !== undefined ? { mcp: opts.hookRuntime.mcp } : {}),
      ...(opts.hookRuntime?.rewake !== undefined ? { rewake: opts.hookRuntime.rewake } : {}),
    }),
    denyOnlyPermissionRequest(opts.extensionsHooks),
  );
  const fileWatchTargets = fileChangeTargets(merged);

  // M27 skills (three workspace roots + the global tier) + M36 plugin skills
  // (fourth source) + the M58 §C#4 visibility overlay (both tiers unioned).
  // P1-5: the trust gate drops the three PROJECT roots when suppressed.
  // ω99-18: mission bundles ride the campaign-scoped tier between the
  // project roots and the global fallback (fail-closed pure read — no/active
  // ledger/no bundles ⇒ [], the byte-stable default for bundle-less runs).
  const skills = applySkillVisibility(
    appendPluginSkills(
      loadSkills(cwd, warn, env, { trustSuppressed: trustSuppressed || undefined, bundleRoots: activeBundleSkillRoots(cwd) }),
      plugins,
      warn,
    ),
    await loadSkillOverrides(cwd, warn, env),
  );

  // M36: plugin MCP servers merge into the one startup list AFTER the user's
  // mcp.json (name conflicts keep the user's side — mergeMcpConfigs warns).
  const mcpConfig = mergeMcpConfigs(loadMcpConfig(cwd, warn), plugins, warn);

  return {
    plugins,
    pluginCommands,
    pluginAgents,
    hooksSettings,
    hooks,
    fileWatchTargets,
    skills,
    mcpConfig,
    counts: { skills: skills.length, plugins: plugins.length, hooks: countHookCommands(merged) },
    trustSuppressed,
  };
}

/** Compose the boot extensions' hooks over an already-built state — boot runs
 *  buildExtensionState BEFORE loadExtensions (the loader needs the plugin
 *  command names for precedence), then attaches. A rescan reaches the same
 *  composition by passing opts.extensionsHooks directly. ω99-21: the boot
 *  object is wrapped DENY-ONLY here too (same rule as buildExtensionState —
 *  the rescan path must not be the unwrapped door). */
export function attachBootExtensions(state: ExtensionState, extensionsHooks: AgentHooks | undefined): ExtensionState {
  if (extensionsHooks === undefined) return state;
  return { ...state, hooks: composeAgentHooks(state.hooks, denyOnlyPermissionRequest(extensionsHooks)) };
}

// ---------------------------------------------------------------------------
// The live runtime box + swap sinks
// ---------------------------------------------------------------------------

/** A frontend's swap handler: receives every fresh state a rescan produces.
 *  Observers — a throwing sink is isolated, never blocking the others. */
export type ExtensionSwapSink = (fresh: ExtensionState) => void;

interface ExtensionRuntimeBox {
  readonly cwd: string;
  readonly argv: readonly string[];
  readonly rebuild: BuildExtensionOpts;
  state: ExtensionState;
}

let runtime: ExtensionRuntimeBox | undefined;
const swapSinks = new Set<ExtensionSwapSink>();

// ω99-24 B — the M24 declaration park: when a rescan carries a TYPED
// bundle-lifecycle reason, the seam records the LAST one's attribution so
// the next main-call usage row can stamp itself cold-and-expected (cache.ts
// polls takePendingBundleColdAttribution). One-shot — consumed on read; a
// reason-LESS rescan (plugin install / trust change — the seam's other
// tenants) parks nothing and behaves exactly as before.
let pendingBundleColdAttribution: string | undefined;

/** Mint the M24 attribution string from a typed reason (`mission-bundle:
 *  <op> <names>`). Empty names (a start over a bundle-less ledger) mints
 *  nothing — no bytes moved, nothing to declare. */
const bundleColdAttributionOf = (reason: BundlesChangeReason): string | undefined =>
  reason.names.length > 0 ? `mission-bundle:${reason.op} ${reason.names.join(" ")}` : undefined;

/** ω99-33 rider — the reason-less declaration gap: a rescan with NO typed
 *  bundle reason could still move the trailing <available_skills> manifest
 *  (a skill dir added/removed, a SKILL.md description edit) and the seam
 *  parked nothing — the next row's header break read as an unexplained ⚠️.
 *  The manifest bytes are the ONLY prompt bytes a rescan may move (the
 *  byte invariant above), so comparing exactly them declares exactly that
 *  cost. A typed reason keeps its own (more specific) attribution. */
const manifestColdAttributionOf = (prev: ExtensionState | undefined, fresh: ExtensionState, reason: BundlesChangeReason | undefined): string | undefined => {
  if (reason !== undefined) return bundleColdAttributionOf(reason);
  if (prev === undefined) return undefined;
  return skillsPromptSection(prev.skills) !== skillsPromptSection(fresh.skills) ? "skills manifest changed (reason-less rescan)" : undefined;
};

/** One-shot take (the cache wrapper polls this on every usage row): the
 *  bundle-lifecycle attribution parked by the last reasoned rescan, or
 *  undefined. Reading consumes it — exactly ONE row declares the cost. */
export function takePendingBundleColdAttribution(): string | undefined {
  const attribution = pendingBundleColdAttribution;
  pendingBundleColdAttribution = undefined;
  return attribution;
}

/** Park the LAST attribution (ω99-24 B's one-slot discipline): an undefined
 *  candidate parks nothing — a byte-stable rescan owes no declaration. */
const parkColdAttribution = (attribution: string | undefined): void => {
  if (attribution !== undefined) pendingBundleColdAttribution = attribution;
};

/** Boot handoff: remember the assembly inputs (a rescan re-runs the SAME
 *  cwd/argv/seams — `--plugin` mounts and warn sinks stay the session's) and
 *  park the boot state as the live one. Idempotent per process; tests reset
 *  via resetExtensionRuntime. */
export function initExtensionRuntime(cwd: string, argv: readonly string[], state: ExtensionState, rebuild: BuildExtensionOpts = {}): void {
  runtime = { cwd, argv, rebuild, state };
}

/** The current state — the boot assembly's until the first rescan swaps it. */
export function getExtensionState(): ExtensionState | undefined {
  return runtime?.state;
}

/** Register a swap sink (REPL/TUI/ui at startup). Returns the unregister. */
export function registerExtensionSwapSink(sink: ExtensionSwapSink): () => void {
  swapSinks.add(sink);
  return () => {
    swapSinks.delete(sink);
  };
}

/** Drop the runtime box + every sink (the test seam; also safe for a
 *  re-boot). Idempotent. ω99-24 B: also clears any parked bundle
 *  attribution — a fresh runtime owes no declarations. */
export function resetExtensionRuntime(): void {
  runtime = undefined;
  swapSinks.clear();
  pendingBundleColdAttribution = undefined;
}

/** Re-run the boot assembly and swap the live state: the fresh state lands in
 *  the module box and reaches every registered frontend sink (isolated).
 *  Returns the fresh counts for the caller's notice (B1's /plugin install
 *  receipt). Before any initExtensionRuntime (a headless `wudao plugin`
 *  process), it still builds fresh counts from the process cwd — nothing to
 *  swap, no sink fires.
 *
 *  Cache invariant (asserted by tests/rescan.test.ts): the ONLY prompt bytes
 *  a rescan may move are the trailing <available_skills> manifest — sinks
 *  rebuild the prompt as buildSystemPrompt(root, <static hasMcpTools>,
 *  fresh.skills), never from anything else. ω99-24: that is the BYTE
 *  invariant (history append-only, prefix byte-equal); the provider-prefix
 *  COST of even a trailing change is declared, not denied — see the header
 *  comment and takePendingBundleColdAttribution. */
export async function rescanExtensions(): Promise<{ skills: number; plugins: number; hooks: number }> {
  if (runtime === undefined) {
    const fresh = await buildExtensionState(process.cwd(), process.argv);
    return fresh.counts;
  }
  const fresh = await buildExtensionState(runtime.cwd, runtime.argv, runtime.rebuild);
  parkColdAttribution(manifestColdAttributionOf(runtime.state, fresh, undefined));
  runtime.state = fresh;
  for (const sink of [...swapSinks]) {
    try {
      sink(fresh);
    } catch {
      /* observer isolation — one broken sink never blocks the rescan */
    }
  }
  return fresh.counts;
}

/** P1-7 (96 队列) — rescan rooted at an EXPLICIT cwd (a /worktree switch):
 * same swap contract as rescanExtensions (fresh state lands in the module
 * box + every registered sink), but the boot assembly re-runs against
 * `at` instead of runtime.cwd. runtime.cwd itself is NOT mutated — the
 * runtime's own rescans (/plugin installs) keep their boot-root footing;
 * only THIS op reads the switched operation root (hard constraint 5: the
 * extension face follows the operation root at the turn boundary). Without
 * a runtime box (headless/test) it behaves like rescanExtensions's fallback:
 * build at `at`, nothing to swap. Cache invariant unchanged — only the
 * trailing <available_skills> manifest may move (the BYTE invariant; the
 * provider-prefix COST of that move is declared, not denied — ω99-24).
 * ω99-24 B: an optional TYPED bundle-lifecycle reason parks its M24
 * attribution (takePendingBundleColdAttribution) — the swap seam itself is
 * untouched (same build, same sinks, same bytes); the reason only DECLARES
 * the cost the trailing-manifest move charges the provider prefix cache. */
export async function rescanExtensionsAt(at: string, reason?: BundlesChangeReason): Promise<{ skills: number; plugins: number; hooks: number }> {
  // ω99-24 B — record the LAST reasoned attribution BEFORE the swap (both
  // branches — with or without a runtime box, the declaration is owed). The
  // swap seam itself is untouched (same build, same sinks, same bytes); the
  // reason only DECLARES the cost the trailing-manifest move charges the
  // provider prefix cache. ω99-33 rider: a reason-LESS rescan that MOVES the
  // manifest declares too (manifestColdAttributionOf) — the declaration gap
  // that left a real manifest change reading as an unexplained ⚠️.
  // See takePendingBundleColdAttribution.
  const fresh = runtime === undefined
    ? await buildExtensionState(at, process.argv)
    : await buildExtensionState(at, runtime.argv, runtime.rebuild);
  parkColdAttribution(manifestColdAttributionOf(runtime?.state, fresh, reason));
  if (runtime === undefined) {
    return fresh.counts;
  }
  runtime.state = fresh;
  for (const sink of [...swapSinks]) {
    try {
      sink(fresh);
    } catch {
      /* observer isolation — one broken sink never blocks the rescan */
    }
  }
  return fresh.counts;
}
