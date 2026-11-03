// ω99 拆分运动 弧 B：session-engine 的权限闸门族外提（原 createDriverSession
// 体内 allowlist→subagentGate 连续段，闭包体逐字保留——props/hooks/workspaceRoot/
// agentRootBox/driverBox/toolsBox/initialMode 收进 ctx 显式线程；watcher/
// richDecide/sidecarLayer/permissionLayer 变为构造器内部实现细节）。
import type { PermissionDecision, Tool } from "@wudao-org/core";
import { decideRichPermission, createSessionAllowlist, createPermissionSettingsWatcher, withSidecarLayer, withPermissionRequestHook, toolMetaResolverFor, applyAskAnswer, recordAskRules, immuneAskCeiling } from "../permission.js";
import type { Mode, AskAnswer, SessionAllowlist } from "../permission.js";
import { persistAllowRule } from "../commands/permissions.js";
import type { AgentDriver } from "./agent-driver.js";
import type { DriverSessionOptions } from "./session-engine-types.js";

/** The permission gate stack's closure context (verbatim free variables). */
export interface SessionGateCtx {
  readonly props: DriverSessionOptions;
  readonly workspaceRoot: string;
  readonly agentRootBox: { current: string };
  readonly driverBox: { current: AgentDriver | null };
  /** M51 §3: the sidecar's tool-annotation resolver reads the tool set through
   *  this late-bound box (the gate is built before the tools). */
  readonly toolsBox: { current?: readonly Tool[] };
  readonly initialMode: Mode;
}

/** The gate stack the engine keeps: the session allowlist (`a` answers record
 *  here), the main gate (driver's canUseTool), the task tool's subagent gate,
 *  and the frontend-owned ask relay adapter (absent → undefined → asks park). */
export interface SessionPermissionGate {
  readonly allowlist: SessionAllowlist;
  readonly gate: import("../permission.js").StaticRuleDecide;
  readonly subagentGate: (toolName: string, input: Record<string, unknown>) => Promise<PermissionDecision>;
  /** Present only when props.askRelay is (absent → asks park in the driver). */
  readonly onPermissionAsk?: (toolName: string, summary: string, input: Record<string, unknown>, ctx?: { readonly sidecarReason?: string; readonly askDigest?: string; readonly askReview?: string; readonly spoof?: import("@wudao-org/core").SpoofInspection }) => Promise<AskAnswer>;
}

export async function createSessionPermissionGate(ctx: SessionGateCtx): Promise<SessionPermissionGate> {
  const { props, workspaceRoot, agentRootBox, driverBox, toolsBox, initialMode } = ctx;
  const hooks = props.hooks;
  const allowlist = createSessionAllowlist();
  // M63-B: the ConfigChange consult rides the watcher — a blocking
  // onConfigChange hook vetoes the rules swap (the previously accepted rules
  // stay cached).
  const configChangeConsult = async (positions: readonly import("@wudao-org/core").ConfigChangePosition[]): Promise<boolean> => {
    for (const position of positions) {
      const decision = await hooks?.onConfigChange?.(position, {});
      if (typeof decision === "object" && decision.block) return false;
    }
    return true;
  };
  const watcher = createPermissionSettingsWatcher(workspaceRoot, () => {}, {
    ...(props.trustSuppressed !== undefined ? { trustSuppressed: props.trustSuppressed } : {}),
    configChange: configChangeConsult,
    // P1-7 (96 队列): workspace-tier permission rules interpret by the
    // OPERATION root — the shared agentRootBox applyAgentRoot moves (a
    // /worktree enter/exit re-roots the project+local tiers at the next
    // turn boundary, same as the extension face's rescan).
    root: () => agentRootBox.current,
  });
  await watcher.get(); // warm the cache: the first in-run gate call is fs-free
  const richDecide = async (toolName: string, input: Record<string, unknown>): Promise<PermissionDecision | "ask"> =>
    decideRichPermission({
      mode: driverBox.current?.getMode() ?? initialMode,
      toolName,
      input,
      session: allowlist,
      settings: await watcher.get(),
      // M59 §2: web.allowDomains pre-approval (startup-loaded, v1-static).
      ...(props.webAllowDomains !== undefined && props.webAllowDomains.length > 0 ? { webAllowDomains: props.webAllowDomains } : {}),
    });
  // M60: the frontend-owned ask relay — the driver routes its askPermission
  // through onPermissionAsk, which both records the session rule (the exact
  // applyAskAnswer path the TUI's prompt handler uses — a protected-path
  // `session` answer degrades to allow-once and records nothing) and hands the
  // raw answer back for askAnswerToDecision.
  const askRelay = props.askRelay;
  const onPermissionAsk = askRelay !== undefined
    ? (toolName: string, summary: string, input: Record<string, unknown>, ctx?: { readonly sidecarReason?: string; readonly askDigest?: string; readonly askReview?: string; readonly spoof?: import("@wudao-org/core").SpoofInspection }): Promise<AskAnswer> =>
        askRelay(toolName, summary, input, ctx).then((answer) => {
          const { sessionRule, persistentRule } = applyAskAnswer(answer, toolName, input);
          // 夜移 009: shared recording seam — a session-only rule's receipt
          // rides the same notify as the persistent receipt below.
          const sessionNote = recordAskRules(allowlist, { sessionRule, persistentRule });
          if (sessionNote !== null) driverBox.current?.notify(sessionNote);
          // 0.3.14 #1: an `always` answer persists through the /permissions
          // lane; the receipt rides the driver's notify (web: a notice line).
          if (persistentRule !== null) {
            void persistAllowRule(workspaceRoot, persistentRule).then(
              (receipt) => driverBox.current?.notify(receipt),
              (err) => driverBox.current?.notify(`permissions：always-rule 写入失败（${String(err)}）——本会话规则仍然生效`), // ω99-166e-i: #3（session-engine ask 臂同 #1 新串）
            );
          }
          return answer;
        })
    : undefined;
  // The driver's rule gate: an "ask" decision parks as pendingPermission.
  // M45: with a sidecar, the classifier layer sits between the static rules
  // and the allow; its escalations park through the same ask seam with the
  // sidecar reason riding the pending ask. M45 review: the task tool's
  // children inherit the SAME layer (subagents classify and pressure the
  // one shared breaker too) — one construction, two gates.
  // M63-A: the PermissionRequest hook layer wraps the WHOLE remaining
  // pipeline — the static rules run inside it, and a no-opinion hook falls
  // through to the sidecar layer (the mandated order: after deny rules,
  // before the sidecar checks). One construction covers the main gate AND
  // the subagent gate.
  const sidecarLayer = props.sidecar !== undefined
    ? withSidecarLayer(
        {
          sidecar: props.sidecar,
          getMode: () => driverBox.current?.getMode() ?? initialMode,
          escalate: (toolName, input, ctx) =>
            driverBox.current?.ask(toolName, input, { sidecarReason: ctx.circuitOpen ? undefined : ctx.reason }) ??
            Promise.resolve({ behavior: "deny" as const, reason: "driver unavailable" }),
          receipt: (line) => driverBox.current?.notify(line),
          // M49 §4: args embedding taint-tracked content classify [untrusted].
          taintProbe: (toolName, input) => driverBox.current?.taintProbe(input),
          // M51 §3: harness-computed tool_flags + the custom cache equivalence.
          toolMeta: toolMetaResolverFor(() => toolsBox.current),
          // ω99-27 T2: the operator exemption lane over the hot-reloaded
          // permission settings (same watcher the static rules read).
          sidecarExemptRules: async () => (await watcher.get()).sidecarExempt,
        },
        richDecide,
      )
    : undefined;
  const permissionLayer = withPermissionRequestHook(
    props.hooks?.onPermissionRequest,
    () => driverBox.current?.getMode() ?? initialMode,
    richDecide,
    {
      sidecarPresent: props.sidecar !== undefined,
      // ω99-21: the immune-ask ceiling — a hook allow never clears the three
      // bypass-immune ask layers (same predicate every gate composes).
      immuneAsk: immuneAskCeiling(() => watcher.get()),
      ...(sidecarLayer !== undefined ? { classify: sidecarLayer } : {}),
    },
  );
  const gate = permissionLayer;
  // The task tool's subagent gate must resolve to a decision — its asks go
  // through the same parked channel explicitly.
  const subagentGate = async (toolName: string, input: Record<string, unknown>): Promise<PermissionDecision> => {
    const d = await permissionLayer(toolName, input);
    return d !== "ask" ? d : driverBox.current?.ask(toolName, input) ?? { behavior: "deny", reason: "driver unavailable" };
  };
  return { allowlist, gate, subagentGate, onPermissionAsk };
}
