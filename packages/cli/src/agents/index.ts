// M30 — orchestration surface for the CLI (public seam; also exported as
// the `wudao-harness/agents` package subpath for evals). The registry,
// roster, and worktree implementations are core's (bound through
// core-bind.ts); what this module owns is the session-level composition:
// the validator injection, the provider model resolver, and the pilot probe.
import { createProvider, resolveProviderConfigResult, isOverloadClassFailure } from "@wudao-org/providers";
import type { ProviderConfig, AttachmentResolver } from "@wudao-org/providers";
import type { ModelClient, AgentMessage } from "@wudao-org/core";
import { AimdGate } from "@wudao-org/core";
import type { ConcurrencyGate } from "@wudao-org/core";
import { createAgentRegistry } from "./core-bind.js";
import type { AgentRegistry } from "./core-bind.js";
import { DEFAULT_MAX_CONCURRENT, HARD_MAX_CONCURRENT, ORCHESTRATION_TOOL_NAMES } from "./contract.js";
import { KERNEL_POLICY } from "../kernel-policy.js";
// Review R1 (M63 §B): the credentials-file fallback for this resolver.
import { readCredentialsFileSync } from "../credentials.js";
// Provider management: role/model pins may name registry customs — the
// resolver threads the effective view (one memoized read) into resolution.
import { loadEffectiveProfiles } from "../provider-registry.js";

export type {
  AgentRegistry, AgentRegistryOptions, AgentSpawnSpec, AgentRunStatus, AgentStatusInfo,
  RegistryResult, AwaitSpec, ReportValidator, SubsetSchema,
  AgentRoleProfile, LoadedRoster, ShadowedProfile, RosterPluginAgent, ChildWorktree,
} from "./core-bind.js";
export { createChildWorktree, BUILTIN_ROLES, loadRoleProfiles } from "./core-bind.js";
export type { AgentSessionRef, ModelOverrides, ModelResolution } from "./contract.js";
export { ORCHESTRATION_TOOL_NAMES, parseSessionParam, resolveRole, roleToolNames, DEFAULT_MAX_CONCURRENT, HARD_MAX_CONCURRENT } from "./contract.js";
export { createAgentsTaskTool } from "./task-tool.js";
// M41: the single policy-value source (re-exported for evals/frontends).
export { KERNEL_POLICY } from "../kernel-policy.js";
export type { KernelPolicy } from "../kernel-policy.js";
// 121 项 1: the AIMD gate re-export — frontends compose one gate across the
// registry (createSessionRegistry) and the resolver's onOverload threading.
export { AimdGate } from "@wudao-org/core";
export type { ConcurrencyGate, AimdGateOptions } from "@wudao-org/core";
import { validateJsonSchemaSubset } from "../workflow/structured-output.js";
export type { AgentsTaskToolOptions } from "./task-tool.js";
// M31 §1 — the write-scope tool guard (applied inside the task tool at child
// tool-set construction; exported for direct use by tests/frontends).
export { applyWriteScopeGuard } from "./write-scope-guard.js";
export type { WriteScopeGuardOptions } from "./write-scope-guard.js";
// M31 §2 — adaptive fan-out budget (per-role samples + anti-ratchet
// suggestion; .wudao/agents-stats.json).
export {
  suggestBudget, loadAgentStats, recordAgentSample, parseAgentStats,
  budgetsDisabled, defaultStatsPath, AGENT_STATS_KEEP,
} from "./budget.js";
export type { AgentBudgetSample, AgentStatsFile, BudgetSuggestion } from "./budget.js";
export { createAgentAwaitTool, createAgentStatusTool, createAgentCancelTool, createRegistryTools } from "./registry-tools.js";
// ω99-5b §B: the structured finishing tool injected into a schema'd child's
// tool set (tests/frontends may build it directly).
export { parseReportSchema, createFinalOutputTool, FINAL_OUTPUT_TOOL_NAME, FINAL_OUTPUT_OK } from "./report-schema.js";

/** Session registry: core's createAgentRegistry with the kernel-policy
 *  operating points applied (maxConcurrent clamped to [1, ceiling]) and the
 *  M29 JSON-Schema subset validator injected — core stays schema-lib-free, so
 *  without the injection every reportSchema spawn would fail closed.
 *  M41: core keeps no defaults; every operating point below comes from
 *  kernel-policy.ts, the single policy source.
 *  121 项 1（a reference harness 498490680 形）: an AIMD gate rides the registry by
 *  default — initial = the effective static cap, so the fresh gate behaves
 *  byte-identically to the pre-121 static cap until the first overload
 *  signal. Settlement feeds it (child ok → onSuccess; overload-class death →
 *  onThrottle via the injected isOverloadClassFailure). Pass `concurrencyGate`
 *  to share one gate with the model resolver's onOverload threading (the
 *  production composition in session-engine). */
export function createSessionRegistry(options: {
  maxConcurrent?: number;
  hardCap?: number;
  reportRepairRounds?: number;
  /** 121 项 1: an externally-owned gate (the composition site threads the
   *  resolver's onOverload to the same instance). Absent = an internal gate
   *  (settlement-only signals — still recovers, via child successes). */
  concurrencyGate?: ConcurrencyGate;
} = {}): AgentRegistry {
  const maxConcurrent = Math.max(1, Math.min(HARD_MAX_CONCURRENT, options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT));
  // 121 项 1: the gate's ceiling IS the effective static cap (zero behavior
  // change by construction — a caller's maxConcurrent: 8 keeps ceiling 8).
  const concurrencyGate = options.concurrencyGate ?? new AimdGate({ max: maxConcurrent });
  return createAgentRegistry({
    maxConcurrent,
    concurrencyGate,
    isThrottleFailure: isOverloadClassFailure,
    hardCap: options.hardCap ?? KERNEL_POLICY.registry.hardCap,
    childTurns: KERNEL_POLICY.registry.childTurns,
    graceTools: KERNEL_POLICY.registry.graceTools,
    strictOverlaps: KERNEL_POLICY.registry.strictOverlaps,
    // 波次8 #47 (OH#6): the wall-clock default every background child runs
    // under unless its spawn states a timeoutMs.
    defaultTimeoutMs: KERNEL_POLICY.registry.backgroundTimeoutMs,
    // ω99-5b §C: corrective repair rounds for schema'd reports (default 1 in
    // core, hard-capped there; 0 opts out).
    ...(options.reportRepairRounds !== undefined ? { reportRepairRounds: options.reportRepairRounds } : {}),
    validateReport: (report: string, schema) => {
      try {
        const parsed: unknown = JSON.parse(report);
        return validateJsonSchemaSubset(parsed, schema);
      } catch {
        return ["report is not valid JSON"];
      }
    },
  });
}

/** True when the visible conversation shows first-hand parent work (any tool
 *  result that is NOT an orchestration call) — the pilot-nudge probe. */
export function firstHandWorkProbe(contextProbe: () => readonly AgentMessage[]): boolean {
  return contextProbe().some((m) => m.role === "tool" && !ORCHESTRATION_TOOL_NAMES.includes(m.name));
}

/** Build the model resolver the frontends thread into the task tool: resolves
 *  caller/role overrides through the provider config, wraps the resulting
 *  client (cache tracking etc.), and reports the effective effort. */
export function createProviderModelResolver(opts: {
  readonly env?: NodeJS.ProcessEnv;
  /** M80: the session's attachment resolver, threaded to the built provider.
   *  Without it, ANY resolved child (caller/role provider pins, teammates)
   *  whose history carries an ImageBlock fails closed with
   *  no-attachment-store at request build — the exact gap the M80 audit
   *  found (children resolved here used to be the only models in a session
   *  without the image seam). */
  readonly attachments?: AttachmentResolver;
  /** ω99-315: the dual-tier idle watchdog budget fragment (streamIdleSoftMs /
   *  streamIdleHardMs), spread into every resolved child provider. */
  readonly streamIdle?: { streamIdleSoftMs: number; streamIdleHardMs: number };
  /** 121 项 1: the capacity observer threaded into every resolved child's
   *  retry ladder (fires on every overload-class failure the ladder sees —
   *  mid-flight 429s included, which settlement alone cannot observe). The
   *  production composition routes it to the registry gate's onThrottle. */
  readonly onOverload?: () => void;
  readonly wrap?: (model: ModelClient) => ModelClient;
}): (overrides: import("./contract.js").ModelOverrides) => import("./contract.js").ModelResolution {
  return (overrides) => {
    try {
      // Review R1 (M63 §B): the credentials file joins as the fallback key
      // source (env still wins) — sub-agents of a file-only-key user must
      // resolve exactly like their parent session.
      const env = opts.env ?? process.env;
      const r = resolveProviderConfigResult(env, {
        ...(overrides.provider !== undefined ? { provider: overrides.provider } : {}),
        ...(overrides.reasoningEffort !== undefined ? { reasoningEffort: overrides.reasoningEffort } : {}),
      }, readCredentialsFileSync(env), loadEffectiveProfiles());
      if (!r.ok) return { ok: false, error: r.reason };
      const config: ProviderConfig = {
        ...r.config,
        ...(overrides.model !== undefined ? { model: overrides.model } : {}),
      };
      // M80: the image seam rides the provider options — absent opts stays
      // the bare build (byte-identical construction for keyless tests).
      // ω99-315: the idle watchdog budget rides the same options fragment.
      // 121 项 1: the capacity observer rides it too (absent = bare build).
      const providerOptions = {
        ...(opts.attachments !== undefined ? { attachments: opts.attachments } : {}),
        ...(opts.streamIdle !== undefined ? { ...opts.streamIdle } : {}),
        ...(opts.onOverload !== undefined ? { onOverload: opts.onOverload } : {}),
      };
      const model = opts.wrap ? opts.wrap(createProvider(config, providerOptions)) : createProvider(config, providerOptions);
      return { ok: true, model, effectiveEffort: config.reasoningEffort ?? "off" };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  };
}
