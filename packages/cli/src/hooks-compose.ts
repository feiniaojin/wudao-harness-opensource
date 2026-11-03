// AgentHooks layer composition — module-level segment extracted from
// hooks-config.ts (ω99 file-size discipline arc A): the deny-only wrapper
// for agent-writable hook sources and the two-layer sequential composer.
// Pure functions over @wudao-org/core's AgentHooks contract.
import type {
  AgentHooks,
  AgentMessage,
  AgentState,
  PermissionDecision,
  StopHookDecision,
} from "@wudao-org/core";

/** ω99-21 — wrap an AGENT-WRITABLE source's AgentHooks deny-only: the
 *  permission face may DENY or stay silent, but its ALLOW is downgraded to
 *  no opinion (the pipeline decides — an ask stays an ask; that is more
 *  honest than denying: silence preserves the original outcome). Used for
 *  the boot .mjs extensions (`.wudao/extensions/**` — code the agent can
 *  plant with a write) at BOTH composition seams in extension-state.ts.
 *  Every other event face passes through untouched (same function refs —
 *  they have no allow-shaped decision to cap). undefined → undefined. */
export function denyOnlyPermissionRequest(hooks: AgentHooks | undefined): AgentHooks | undefined {
  if (hooks === undefined) return undefined;
  const orig = hooks.onPermissionRequest;
  if (orig === undefined) return hooks;
  return {
    ...hooks,
    onPermissionRequest: async (toolName: string, input: Record<string, unknown>): Promise<PermissionDecision | undefined> => {
      const d = await orig(toolName, input);
      if (d === undefined || d.behavior === "deny") return d;
      return undefined; // allow from a deny-only source = no opinion
    },
  };
}

// M39: layer two AgentHooks objects into one — the CLI composes the CONFIG
// hooks (settings.json + plugin hooks) first and the EXTENSION hooks
// (ExtensionAPI on()) second, so both ride the same loop seam. Chaining
// semantics mirror the within-layer chain: a prompt rewrite feeds forward,
// and any block short-circuits (later layers never run). Both layers are
// expected to isolate their own failures (the config bridge and the
// extension bridge each degrade internally), so this composer is plain
// sequential delegation — the loop's own try/catch stays the last resort.
export function composeAgentHooks(first: AgentHooks | undefined, second: AgentHooks | undefined): AgentHooks | undefined {
  if (first === undefined) return second;
  if (second === undefined) return first;
  const hooks: AgentHooks = {};
  if (first.onRunStart || second.onRunStart) {
    hooks.onRunStart = async (state: AgentState): Promise<void> => {
      await first.onRunStart?.(state);
      await second.onRunStart?.(state);
    };
  }
  if (first.onRunStop || second.onRunStop) {
    hooks.onRunStop = async (state: AgentState): Promise<StopHookDecision> => {
      const a = await first.onRunStop?.(state);
      if (a !== undefined && a !== "allow") return a;
      const b = await second.onRunStop?.(state);
      if (b !== undefined && b !== "allow") return b;
      return "allow";
    };
  }
  if (first.onPromptSubmit || second.onPromptSubmit) {
    hooks.onPromptSubmit = async (prompt: string): Promise<string | { block: true; reason: string }> => {
      const a = await first.onPromptSubmit?.(prompt);
      if (a !== undefined && typeof a === "object") return a; // config block short-circuits
      const current = typeof a === "string" ? a : prompt;
      const b = await second.onPromptSubmit?.(current);
      if (b !== undefined && typeof b === "object") return b;
      return typeof b === "string" ? b : current;
    };
  }
  if (first.onPreToolUse || second.onPreToolUse) {
    hooks.onPreToolUse = async (
      toolName: string,
      input: Record<string, unknown>,
    ): Promise<import("@wudao-org/core").PreToolUseDecision> => {
      const a = await first.onPreToolUse?.(toolName, input);
      if (a !== undefined) return a;
      return second.onPreToolUse?.(toolName, input);
    };
  }
  if (first.onPostToolUse || second.onPostToolUse) {
    hooks.onPostToolUse = async (toolName: string, input: Record<string, unknown>, result: string): Promise<void | string> => {
      // M62 §5: additionalContext strings CHAIN across layers (config then
      // extensions, joined with a blank line); no layer's context blocks
      // another's.
      const a = await first.onPostToolUse?.(toolName, input, result);
      const b = await second.onPostToolUse?.(toolName, input, result);
      const parts = [a, b].filter((v): v is string => typeof v === "string" && v !== "");
      return parts.length === 0 ? undefined : parts.join("\n\n");
    };
  }
  if (first.onPreCompact || second.onPreCompact) {
    // M63-A: trigger forwarded; a defer from EITHER layer wins (the first
    // one seen — same short-circuit as the other gate compositions).
    hooks.onPreCompact = async (messages: readonly AgentMessage[], trigger: "manual" | "auto"): Promise<import("@wudao-org/core").PreCompactDecision> => {
      const a = await first.onPreCompact?.(messages, trigger);
      if (typeof a === "object" && a.defer) return a;
      const b = await second.onPreCompact?.(messages, trigger);
      if (typeof b === "object" && b.defer) return b;
      return "compact";
    };
  }
  if (first.onPostCompact || second.onPostCompact) {
    hooks.onPostCompact = async (messages: readonly AgentMessage[], trigger: "manual" | "auto"): Promise<void> => {
      await first.onPostCompact?.(messages, trigger);
      await second.onPostCompact?.(messages, trigger);
    };
  }
  // M63-A: the failure/batch tool faces.
  if (first.onPostToolUseFailure || second.onPostToolUseFailure) {
    hooks.onPostToolUseFailure = async (toolName: string, input: Record<string, unknown>, result: string): Promise<void> => {
      await first.onPostToolUseFailure?.(toolName, input, result);
      await second.onPostToolUseFailure?.(toolName, input, result);
    };
  }
  if (first.onPostToolBatch || second.onPostToolBatch) {
    hooks.onPostToolBatch = async (batch: readonly import("@wudao-org/core").PostToolBatchCall[]): Promise<import("@wudao-org/core").PostToolBatchDecision> => {
      const a = await first.onPostToolBatch?.(batch);
      if (typeof a === "object") return a; // {continue:false} short-circuits
      return (await second.onPostToolBatch?.(batch)) ?? "allow";
    };
  }
  // M63-A: the session-surface events. Observers compose sequentially; the
  // permission policy composes deny-and-allow-decisively: the FIRST definite
  // decision (either direction) answers — later layers never override it.
  if (first.onSessionStart || second.onSessionStart) {
    hooks.onSessionStart = async (source: import("@wudao-org/core").SessionStartSource, info: { readonly sessionId?: string }): Promise<void | string> => {
      // cc-plugins E4: SessionStart contexts CHAIN across layers (the same
      // rule as the M62 §5 onPostToolUse composition).
      const a = await first.onSessionStart?.(source, info);
      const b = await second.onSessionStart?.(source, info);
      const parts = [a, b].filter((v): v is string => typeof v === "string" && v !== "");
      return parts.length === 0 ? undefined : parts.join("\n\n");
    };
  }
  if (first.onNotification || second.onNotification) {
    hooks.onNotification = async (kind: import("@wudao-org/core").NotificationKind, info: { readonly sessionId?: string }): Promise<void> => {
      await first.onNotification?.(kind, info);
      await second.onNotification?.(kind, info);
    };
  }
  if (first.onPermissionRequest || second.onPermissionRequest) {
    hooks.onPermissionRequest = async (toolName: string, input: Record<string, unknown>): Promise<PermissionDecision | undefined> => {
      const a = await first.onPermissionRequest?.(toolName, input);
      if (a !== undefined) return a;
      return second.onPermissionRequest?.(toolName, input);
    };
  }
  // M63-B: the batch-B faces. Gate decisions short-circuit (the first block
  // wins — config veto, task refusal, subagent continuation); observers run
  // sequentially.
  if (first.onTaskCreated || second.onTaskCreated) {
    hooks.onTaskCreated = async (items, board) => {
      const a = await first.onTaskCreated?.(items, board);
      if (typeof a === "object" && a.block) return a;
      return (await second.onTaskCreated?.(items, board)) ?? "allow";
    };
  }
  if (first.onTaskCompleted || second.onTaskCompleted) {
    hooks.onTaskCompleted = async (items, board) => {
      const a = await first.onTaskCompleted?.(items, board);
      if (typeof a === "object" && a.block) return a;
      return (await second.onTaskCompleted?.(items, board)) ?? "allow";
    };
  }
  if (first.onSubagentStart || second.onSubagentStart) {
    hooks.onSubagentStart = async (agentType, info) => {
      await first.onSubagentStart?.(agentType, info);
      await second.onSubagentStart?.(agentType, info);
    };
  }
  if (first.onSubagentStop || second.onSubagentStop) {
    hooks.onSubagentStop = async (agentType, state) => {
      const a = await first.onSubagentStop?.(agentType, state);
      if (typeof a === "object") return a; // {continue:false}/{block} wins
      return (await second.onSubagentStop?.(agentType, state)) ?? "allow";
    };
  }
  if (first.onFileChanged || second.onFileChanged) {
    hooks.onFileChanged = async (path) => {
      await first.onFileChanged?.(path);
      await second.onFileChanged?.(path);
    };
  }
  if (first.onConfigChange || second.onConfigChange) {
    hooks.onConfigChange = async (position, info) => {
      const a = await first.onConfigChange?.(position, info);
      if (typeof a === "object" && a.block) return a;
      return (await second.onConfigChange?.(position, info)) ?? "allow";
    };
  }
  if (first.onInstructionsLoaded || second.onInstructionsLoaded) {
    hooks.onInstructionsLoaded = async (source, info) => {
      await first.onInstructionsLoaded?.(source, info);
      await second.onInstructionsLoaded?.(source, info);
    };
  }
  if (first.onSessionEnd || second.onSessionEnd) {
    hooks.onSessionEnd = async (source, info) => {
      await first.onSessionEnd?.(source, info);
      await second.onSessionEnd?.(source, info);
    };
  }
  if (first.onStopFailure || second.onStopFailure) {
    hooks.onStopFailure = async (kind, info) => {
      await first.onStopFailure?.(kind, info);
      await second.onStopFailure?.(kind, info);
    };
  }
  return hooks;
}
