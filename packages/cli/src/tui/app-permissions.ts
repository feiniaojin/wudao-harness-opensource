// 拆分运动弧 C：从 app.tsx 原样外提的权限闸簇（usePermissionStack）——
// M33 §1 会话允许清单 + 热载 settings 规则、分层判定 richDecide、M45 sidecar
// 层、ω99-21 免疫顶、M63-A PermissionRequest 钩子层、主闸 modeGate 与
// 子代理闸 subagentGate。hook 簇原序整体迁移；显式依赖对象。
import { useCallback, useEffect, useMemo, useRef } from "react";
import type { AgentHooks } from "@wudao-org/core";
import { summarizeToolCall } from "../log.js";
import {
  askAnswerToDecision,
  createSessionAllowlist,
  createPermissionSettingsWatcher,
  decideRichPermission,
  immuneAskCeiling,
  withPermissionRequestHook,
  withSidecarLayer,
  type AskAnswer,
  type Mode,
  type PermissionDecision,
  type SessionAllowlist,
  type SidecarEscalation,
} from "../permission.js";
import type { Sidecar } from "../sidecar.js";
import type { UseAgentResult } from "./use-agent.js";

/** usePermissionStack's explicit dependency slice. */
export interface PermissionStackDeps {
  readonly workspaceRoot: string;
  readonly apiRef: { readonly current: UseAgentResult | null };
  readonly notifyRef: { current: (text: string) => void };
  readonly initialMode: { readonly current: Mode };
  readonly liveHooks: AgentHooks | undefined;
  readonly onPermissionAsk: (toolName: string, summary: string, input: Record<string, unknown>, ctx?: { readonly sidecarReason?: string; readonly askDigest?: string; readonly askReview?: string; readonly spoof?: import("@wudao-org/core").SpoofInspection }) => Promise<AskAnswer>;
  readonly sidecar: Sidecar | undefined;
  readonly webAllowDomains: readonly string[] | undefined;
  readonly trustSuppressed: (() => boolean) | undefined;
}

export function usePermissionStack(P: PermissionStackDeps) {
// M33 §1: session allowlist (`a` answers) + hot-reloading settings rules
// (.wudao/settings.json permissions). Layered decision (session → settings →
// builtin mode) shared by the main gate and the subagent gate. Watcher
// receipts/warnings surface as dim notice lines via P.notifyRef (assigned
// below; the closure only fires mid-run, after render).
const allowlistRef = useRef<SessionAllowlist>(createSessionAllowlist());
// M63-B: the ConfigChange consult — a blocking onConfigChange hook vetoes
// the permission-rules swap (the previously accepted rules stay cached).
const watcherRef = useRef(createPermissionSettingsWatcher(P.workspaceRoot, (line) => P.notifyRef.current(line), {
  ...(P.trustSuppressed !== undefined ? { trustSuppressed: P.trustSuppressed } : {}),
  configChange: async (positions) => {
    for (const position of positions) {
      const decision = await P.liveHooks?.onConfigChange?.(position, {});
      if (typeof decision === "object" && decision.block) return false;
    }
    return true;
  },
}));
const richDecide = useCallback(
  async (toolName: string, input: Record<string, unknown>) =>
    decideRichPermission({
      // Live mode: a mid-run shift+tab takes effect on the very next tool
      // call (the gate reads the driver's live value, not a snapshot).
      mode: P.apiRef.current?.getMode() ?? P.initialMode.current,
      toolName,
      input,
      session: allowlistRef.current,
      settings: await watcherRef.current.get(),
      // M59 §2: web.allowDomains pre-approval (startup-loaded, v1-static).
      ...(P.webAllowDomains !== undefined && P.webAllowDomains.length > 0 ? { webAllowDomains: P.webAllowDomains } : {}),
    }),
  [],
);

// Warm the settings cache at mount so the first in-run gate call is
// filesystem-free (the watcher's revalidation window then keeps the gate's
// hot path clean — an ask never waits on, or races a keystroke with, fs I/O).
useEffect(() => {
  void watcherRef.current.get();
}, []);

// Subagent (task tool) gate: the layered rules first; asks surface in the
// same TUI permission prompt instead of raw stdin (Ink owns the terminal).
// M45 review: the SAME sidecar layer as the main gate covers child runs —
// subagents inherit the classifier and the breaker (one shared instance,
// so parent and child pressure ONE §1.5 breaker). Escalations park in the
// same TUI permission prompt, the sidecar reason riding the ask.
// M63-A: the PermissionRequest hook layer wraps the WHOLE remaining
// pipeline — static rules inside, the sidecar layer as the no-opinion
// fall-through (mandated order: after deny rules, before the sidecar) —
// shared by the main gate and the subagent gate below.
const subagentEscalate = useCallback(
  async (toolName: string, input: Record<string, unknown>, ctx: SidecarEscalation): Promise<PermissionDecision> =>
    askAnswerToDecision(
      await P.onPermissionAsk(toolName, summarizeToolCall(toolName, input), input, {
        sidecarReason: ctx.circuitOpen ? undefined : ctx.reason,
      }),
    ),
  [P.onPermissionAsk],
);
const subagentSidecarLayer = useMemo(
  () =>
    P.sidecar !== undefined
      ? withSidecarLayer(
          {
            sidecar: P.sidecar,
            getMode: () => P.apiRef.current?.getMode() ?? P.initialMode.current,
            escalate: subagentEscalate,
            receipt: (line) => P.notifyRef.current(line),
            // M49 §4: subagent calls classify with the same taint probe.
            taintProbe: (toolName, input) => P.apiRef.current?.driver.taintProbe(input),
            // ω99-27 T2: the operator exemption lane (hot-reloaded
            // permission settings; same watcher the static rules read).
            sidecarExemptRules: async () => (await watcherRef.current.get()).sidecarExempt,
          },
          richDecide,
        )
      : undefined,
  [P.sidecar, subagentEscalate, richDecide],
);
// ω99-21: the immune-ask ceiling for BOTH TUI gates — a hook allow never
// clears the three bypass-immune ask layers. Stable identity (refs only),
// so neither gate's memo/callback deps move.
const immuneAsk = useMemo(() => immuneAskCeiling(() => watcherRef.current.get()), []);
const hookedDecide = useCallback(
  (toolName: string, input: Record<string, unknown>) =>
    withPermissionRequestHook(
      P.liveHooks?.onPermissionRequest,
      () => P.apiRef.current?.getMode() ?? P.initialMode.current,
      richDecide,
      { sidecarPresent: P.sidecar !== undefined, immuneAsk, ...(subagentSidecarLayer !== undefined ? { classify: subagentSidecarLayer } : {}) },
    )(toolName, input),
  [P.liveHooks, P.sidecar, richDecide, subagentSidecarLayer, immuneAsk],
);
const subagentGate = useCallback(
  async (toolName: string, input: Record<string, unknown>): Promise<PermissionDecision> => {
    const d = await hookedDecide(toolName, input);
    if (d !== "ask") return d;
    return askAnswerToDecision(await P.onPermissionAsk(toolName, summarizeToolCall(toolName, input), input));
  },
  [hookedDecide, P.onPermissionAsk],
);

// M33 §1: the mode gate is the layered decision (session allowlist →
// settings rules → builtin mode); "ask" flows to P.onPermissionAsk in useAgent.
// M45: with a sidecar, auto-mode write/exec calls classify BETWEEN the
// static rules and the allow — high/error verdicts and the open breaker
// escalate through the driver's ask (the parked prompt carries the reason);
// low allows with a receipt; the 🛡 检查中 badge rides busyTools.
// M63-A: the main gate mirrors the subagent gate — the sidecar layer
// becomes the hook layer's no-opinion fall-through (mandated order: after
// deny rules, before the sidecar checks).
const sidecarGate = useCallback(
  (toolName: string, input: Record<string, unknown>, ctx: SidecarEscalation): Promise<import("@wudao-org/core").PermissionDecision> =>
    P.apiRef.current?.driver.ask(toolName, input, { sidecarReason: ctx.circuitOpen ? undefined : ctx.reason }) ??
    Promise.resolve({ behavior: "deny" as const, reason: "driver unavailable" }),
  [],
);
const mainSidecarLayer = P.sidecar !== undefined
  ? withSidecarLayer(
      {
        sidecar: P.sidecar,
        getMode: () => P.apiRef.current?.getMode() ?? P.initialMode.current,
        escalate: sidecarGate,
        receipt: (line) => P.notifyRef.current(line),
        onGating: (toolName, on) => P.apiRef.current?.driver.setGating(toolName, on),
        // M49 §4: args embedding taint-tracked content classify [untrusted].
        taintProbe: (toolName, input) => P.apiRef.current?.driver.taintProbe(input),
        // ω99-27 T2: the operator exemption lane (hot-reloaded permission
        // settings; same watcher the static rules read).
        sidecarExemptRules: async () => (await watcherRef.current.get()).sidecarExempt,
      },
      richDecide,
    )
  : undefined;
const modeGate = withPermissionRequestHook(P.liveHooks?.onPermissionRequest, () => P.apiRef.current?.getMode() ?? P.initialMode.current, richDecide, {
  sidecarPresent: P.sidecar !== undefined,
  immuneAsk, // ω99-21: the immune-ask ceiling (see hookedDecide above)
  ...(mainSidecarLayer !== undefined ? { classify: mainSidecarLayer } : {}),
});
  return { allowlistRef, watcherRef, richDecide, modeGate, subagentGate };
}
