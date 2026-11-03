// Permission pipeline layers — module-level segment extracted from
// permission.ts (ω99 file-size discipline arc A): the M63-A PermissionRequest
// hook layer (the deterministic policy engine + ω99-21 immune-ask ceiling)
// and the M45 auto-mode sidecar audit layer. Pure layer builders — no IO.
import type { PermissionDecision } from "@wudao-org/core";
import type { Sidecar, SidecarVerdict } from "./sidecar.js";
import type { Mode } from "./permission-modes.js";
import { READ_TOOLS } from "./permission-modes.js";
import { ruleMatches, protectedSettingsFile, credentialMaterialPath } from "./permission-rules.js";
import type { PermissionSettings } from "./permission-settings.js";

// ---------------------------------------------------------------------------
// M63-A — the PermissionRequest hook layer: the deterministic policy engine.
// Pipeline position (spec §1, MANDATED): AFTER the deny rules, BEFORE the
// sidecar checks. The layer wraps the WHOLE remaining pipeline: it runs the
// STATIC decision itself (deny rules → protected writes → session allowlist
// → ask/allow rules → builtin modes), consults the hook when work remains,
// and only falls through to `classify` (the sidecar-wrapped layer, when one
// is present) when the hook has NO opinion:
//   • a settings DENY rule wins — the hook never fires for a denied call;
//   • the hook fires exactly when the remaining pipeline would still do work:
//     the static outcome is "ask" (a human would be prompted), or "allow" in
//     AUTO mode on a sidecar-gated tool (the classifier would run);
//   • hook DENY  → denied with the hook's reason; the sidecar never runs;
//   • hook ALLOW → allowed; BOTH the sidecar and the human ask are skipped
//     (the hook IS the policy engine at this layer) — EXCEPT on the three
//     bypass-immune ask layers (protected settings/hook-source writes,
//     operator settings.ask rules, credential material), where the ω99-21
//     immuneAsk ceiling downgrades the allow to "ask": only a human clears
//     those (immuneAskCeiling composes the predicate). Deny-only sources
//     (ω99-21: .wudao/extensions hooks, project plugins) never reach here
//     with an allow at all — their wrapper turns it into no opinion at the
//     composition seam;
//   • no decision / infra failure (timeout, spawn error) → the pipeline is
//     untouched (the fall-through re-runs the static layers inside the
//     sidecar wrapper — pure, at most double evaluation).
// ---------------------------------------------------------------------------

/** The seam type the layer consults — core's AgentHooks.onPermissionRequest
 *  (kept structural so tests can pass a bare function). */
export type PermissionRequestHookFn = (
  toolName: string,
  input: Record<string, unknown>,
) => import("@wudao-org/core").PermissionDecision | undefined | Promise<import("@wudao-org/core").PermissionDecision | undefined>;

/** ω99-21 — the shared opts of the two layer builders below. `immuneAsk` is
 *  the authorization-ceiling predicate: when a hook answers ALLOW and the
 *  predicate says the call sits in a bypass-immune ask layer, the layer
 *  returns "ask" instead (the human still rules). Deny and no-opinion never
 *  consult it. Absent = no ceiling (pre-ω99-21 behavior, byte-identical). */
export interface PermissionRequestHookOpts {
  readonly sidecarPresent?: boolean;
  readonly classify?: StaticRuleDecide;
  readonly immuneAsk?: (toolName: string, input: Record<string, unknown>) => boolean | Promise<boolean>;
}

/** ω99-21 — compose the immune-ask ceiling predicate over the LIVE settings:
 *  true when the call (a) targets a protected runtime-policy/hook-source
 *  file (protectedSettingsFile, incl. the .wudao/extensions|plugin trees),
 *  (b) hits an operator settings.ask rule (same ruleMatches the gate's layer
 *  4 uses), or (c) touches credential material (credentialMaterialPath).
 *  These are exactly the three ask layers whose semantics are "only a human
 *  may clear this" — a hook allow may not. Every hook-layer construction
 *  site (createPermissionGate, the REPL gate, the session-engine driver
 *  gate, the TUI gates) composes THIS factory, so the ceiling is identical
 *  everywhere and rides the watcher's hot reload. */
export function immuneAskCeiling(
  getSettings: () => Promise<PermissionSettings>,
): (toolName: string, input: Record<string, unknown>) => Promise<boolean> {
  return async (toolName, input) =>
    protectedSettingsFile(toolName, input) !== undefined
    || credentialMaterialPath(toolName, input) !== undefined
    || (await getSettings()).ask.some((rule) => ruleMatches(rule, toolName, input));
}

/** Wrap the static decision with the PermissionRequest hook layer. `getMode`
 *  is the LIVE mode (same contract as the sidecar layer's); `classify` is the
 *  sidecar-wrapped continuation (withSidecarLayer(seam, staticDecide)) when a
 *  sidecar is present — the path a no-opinion hook falls through to.
 *  `sidecarPresent` tells whether an auto-mode allow would actually be
 *  classified — without a sidecar the hook only fires on "ask" outcomes (there
 *  is nothing else left to decide). With NO hook this returns `classify ??
 *  staticDecide` — the pre-M63 gate, byte-identical behavior. */
export function withPermissionRequestHook(
  hook: PermissionRequestHookFn | undefined,
  getMode: () => Mode,
  staticDecide: StaticRuleDecide,
  opts?: PermissionRequestHookOpts,
): StaticRuleDecide {
  if (hook === undefined) return opts?.classify ?? staticDecide;
  return async (toolName, input) => {
    const d = await staticDecide(toolName, input);
    // Deny rules outrank the hook (mandated order): never consult it for a
    // call the static layers already denied.
    if (d !== "ask" && d.behavior === "deny") return d;
    // Fire only when remaining pipeline work exists: a human ask, or an
    // auto-mode allow the sidecar would still classify. A plain allow with
    // nothing behind it is already decided — no policy question to answer.
    const sidecarWouldGate = opts?.sidecarPresent === true && getMode() === "auto" && sidecarGatesTool(toolName);
    if (d !== "ask" && !sidecarWouldGate) return d;
    let decision: import("@wudao-org/core").PermissionDecision | undefined;
    try {
      decision = await hook(toolName, input);
    } catch {
      decision = undefined; // a throwing policy hook is infra failure → fall through
    }
    if (decision !== undefined) {
      // ω99-21 — the authorization ceiling: a hook ALLOW on a bypass-immune
      // ask (protected/hook-source write, operator ask rule, credential
      // material) downgrades to "ask" — the human still rules. Deny passes
      // (narrowing is always effective); the predicate is consulted ONLY on
      // allow decisions.
      if (decision.behavior === "allow" && opts?.immuneAsk !== undefined && (await opts.immuneAsk(toolName, input)) === true) {
        return "ask";
      }
      return decision; // allow or deny: the sidecar never runs
    }
    // No opinion: the pipeline continues exactly as it would have — through
    // the sidecar layer when one exists (it re-runs the static layers; pure).
    return opts?.classify !== undefined ? opts.classify(toolName, input) : d;
  };
}

/** cc-plugins A3 review fix (LOW): a PermissionRequest layer whose HOOK is
 *  read live. `withPermissionRequestHook` captures its hook argument once —
 *  correct for the boot-built gates, wrong for a surface whose hooks a
 *  rescanExtensions() swap replaces between turns (the REPL's `live.hooks`
 *  box): the boot hook would stay frozen in the layer until restart. This
 *  wrapper rebuilds the inner layer only when the hook REFERENCE changes —
 *  one field read per decision, and the layer stays exactly as absent/present
 *  as withPermissionRequestHook makes it (no hook → classify ?? staticDecide).
 */
export function livePermissionRequestHook(
  getHook: () => PermissionRequestHookFn | undefined,
  getMode: () => Mode,
  staticDecide: StaticRuleDecide,
  opts?: PermissionRequestHookOpts,
): StaticRuleDecide {
  let hook = getHook();
  let decide = withPermissionRequestHook(hook, getMode, staticDecide, opts);
  return async (toolName, input) => {
    const now = getHook();
    if (now !== hook) {
      hook = now;
      decide = withPermissionRequestHook(hook, getMode, staticDecide, opts);
    }
    return decide(toolName, input);
  };
}

// ---------------------------------------------------------------------------
// M45 — the auto-mode sidecar layer. Sits in the permission pipeline AFTER
// the static rules (settings deny/ask, protected writes, session allowlist,
// builtin modes) and BEFORE the final allow: a call that static rules would
// allow in AUTO mode is classified first (spec §1). Ask/workspace modes never
// trigger it (the human already gates what they gate). #452: the verdict is
// an AUDIT, not a gate — the tool runs regardless; the verdict decides only
// how loud the receipt is (low = quiet, high/error = the 托付 receipt).
// ---------------------------------------------------------------------------

/** Tools the sidecar never classifies: the read class (READ_TOOLS — always
 *  allowed everywhere, nothing to audit) plus the harness's own status
 *  meta-tools and agent_await (read-class: awaiting an already-spawned agent
 *  mutates nothing the classifier could audit — zero sidecar latency, zero
 *  breaker pressure). Everything else — write_file/edit/shell, the mcp__
 *  and ext_ prefixes, and any tool the harness does not know (unknown = in
 *  scope, fail-closed) — is audited. */
const SIDECAR_UNGATED = new Set([...READ_TOOLS, "agent_status", "agent_await"]);

/** Is this tool call inside the sidecar's audit scope (spec §1)? */
export function sidecarGatesTool(toolName: string): boolean {
  return !SIDECAR_UNGATED.has(toolName);
}

/** Why a sidecar verdict WOULD have escalated to the human: a high/error
 *  verdict's reason, or the open breaker (no classifier ran). #452: under
 *  auto 托付 the layer never escalates — the shape stays because the seam
 *  interface (and its five construction sites) still wires an escalate
 *  function, and the final static-ask wrapper reuses it ({circuitOpen:false}). */
export interface SidecarEscalation {
  /** The verdict's reason (or the error text); undefined on circuit-open. */
  readonly reason?: string;
  readonly circuitOpen: boolean;
}

/** The seams the shared sidecar layer needs from a frontend. */
export interface SidecarGateSeam {
  readonly sidecar: Sidecar;
  /** Live mode (never a startup snapshot — mid-run shift+tab counts). */
  readonly getMode: () => Mode;
  /** #452: VESTIGIAL in auto mode — the layer 托付-allows every verdict path
   *  and never calls this (the zero-escalation pins catch any regression).
   *  Kept wired at all five construction sites so the seam shape stays honest
   *  for a future non-auto consumer. */
  readonly escalate: (
    toolName: string,
    input: Record<string, unknown>,
    ctx: SidecarEscalation,
  ) => Promise<PermissionDecision>;
  /** One-line receipts/notices (sidecar:low, the breaker-open notice). */
  readonly receipt?: (line: string) => void;
  /** busyTools gating badge toggle (🛡 检查中, M45 §1.6). */
  readonly onGating?: (toolName: string, on: boolean) => void;
  /** M49 §4: taint probe — returns the taint source when the gated call's
   *  arguments embed taint-tracked content (user-file / MCP bytes); the
   *  classifier input then carries the [untrusted] provenance note. */
  readonly taintProbe?: (toolName: string, input: Record<string, unknown>) => string | undefined;
  /** M51 §3: live tool annotations from the session's Tool set — the
   *  classifier input gains the harness-computed tool_flags field and the
   *  verdict cache gains the tool's custom inputsEquivalent. Late-bound by
   *  construction (the gate is built before the tool array); absent → the
   *  classifier sees no flags and the cache stays byte-keyed. */
  readonly toolMeta?: SidecarToolMetaResolver;
  /** ω99-27 T2: the operator exemption lane — the live permissions.sidecarExempt
   *  rules (frontends wire the permission settings watcher's list here). A
   *  matching call skips the classifier AND the breaker accounting; static
   *  deny/ask short-circuit above the lane, so it can only narrow what the
   *  sidecar audits, never widen a static decision. Absent → no lane. */
  readonly sidecarExemptRules?: () => readonly string[] | Promise<readonly string[]>;
}

/** The M51 §3 annotation slice the sidecar layer consumes (from core's Tool). */
export interface SidecarToolMeta {
  readonly isDestructive?: (args: Record<string, unknown>) => boolean;
  readonly isOpenWorld?: (args: Record<string, unknown>) => boolean;
  /** ω99-27 T1: the closed-world read-only declaration — a tool whose
   *  isReadOnly(args) is true AND isOpenWorld(args) is not true is exempt
   *  from classification entirely (the harness already knows the call
   *  cannot mutate anything the classifier could audit). Fail-closed by
   *  construction: buildTool's TOOL_DEFAULTS read an UNANNOTATED tool as
   *  isReadOnly:false + isOpenWorld:true, so only an explicit honest pair
   *  ever matches. */
  readonly isReadOnly?: (args: Record<string, unknown>) => boolean;
  /** ω99-23: dispatch semantics — this tool's effects happen in CHILD calls
   *  that each pass the same permission gate (the task tool's children
   *  inherit the very gate this layer wraps, M45). True → the classifier
   *  input gains child_gated:true so the classifier judges THIS call's own
   *  effect instead of double-counting the downstream work its arguments
   *  describe. Absent → false (conservative: described work keeps being read
   *  as this call's own). */
  readonly isChildGated?: (args: Record<string, unknown>) => boolean;
  readonly inputsEquivalent?: (a: Record<string, unknown>, b: Record<string, unknown>) => boolean;
}

/** Resolve a tool's annotations by name (undefined = unknown tool → the
 *  classifier gets no flags, the cache stays byte-keyed). */
export type SidecarToolMetaResolver = (toolName: string) => SidecarToolMeta | undefined;

/** Build the resolver over a (possibly not-yet-built) tool array — the gate
 *  is constructed before the tool set at several frontends, so the resolver
 *  reads through a late-bound getter at CALL time. */
export function toolMetaResolverFor(
  getTools: () => readonly import("@wudao-org/core").Tool[] | undefined,
): SidecarToolMetaResolver {
  return (toolName) => getTools()?.find((t) => t.name === toolName);
}

/** The static layers below the sidecar: settings/session/modes. Returns
 *  "ask" when the human must be prompted WITHOUT any sidecar involvement
 *  (ask mode, static ask rules, protected writes). */
export type StaticRuleDecide = (
  toolName: string,
  input: Record<string, unknown>,
) => PermissionDecision | "ask" | Promise<PermissionDecision | "ask">;

/** Trip-notice state, per sidecar instance: the breaker-open notice fires
 *  ONCE per trip across every layer sharing the sidecar (a frontend's main
 *  gate AND its subagent gate). Re-armed whenever a layer observes the
 *  breaker closed — every classified call does — so a fresh trip after the
 *  run-boundary resetRun notices again. (#452: there is no manual-approval
 *  reset anymore; resetRun at submit is the only reset.) */
const sidecarTripNotified = new WeakMap<Sidecar, boolean>();

/** Wrap the static decision with the sidecar layer (spec §1 order):
 *  static rules → (auto + in-scope + would-allow) sidecar → verdict paths.
 *  #452 — auto 档 = 托付 + 审计，不打断: EVERY verdict path allows. low =
 *  allow with the quiet sidecar:low receipt; high/error = allow with the
 *  LOUD 托付 receipt (the audit rides stdout — never the human); breaker
 *  open = allow with NO classifier call (the breaker only saves the
 *  round-trip now) + a once-per-trip notice + a per-call (未分类) receipt;
 *  the only breaker reset is the run boundary (the driver's resetRun at
 *  submit — an allow is not a human approval). Static "ask"/deny pass
 *  through untouched: the bypass-immune human gates (protected settings
 *  writes 4.65, credential material, operator ask rules) sit in the static
 *  layer and keep asking even in auto. */
export function withSidecarLayer(
  seam: SidecarGateSeam,
  staticDecide: StaticRuleDecide,
): StaticRuleDecide {
  const { sidecar, getMode } = seam;
  return async (toolName, input) => {
    const d = await staticDecide(toolName, input);
    if (d === "ask" || d.behavior === "deny") return d;
    // `d` is allow here: the only decision the sidecar can tighten.
    if (getMode() !== "auto") return d;
    if (!sidecarGatesTool(toolName)) return d;
    // ω99-27 T1 — the closed-world read-only two-flag rule: a tool that
    // honestly declares isReadOnly:true + isOpenWorld:false (the list_agents
    // shape) never reaches the classifier — the harness has already verified
    // the call cannot mutate anything the audit exists to catch. Above the
    // breaker ON PURPOSE: during an open breaker the audit surface must not
    // go blind — read-only discovery ("look at the scene") stays available
    // while write-class calls still escalate. No verdict is produced, so no
    // breaker accounting happens either. Fail-closed: an unannotated tool
    // reads isReadOnly:false + isOpenWorld:true (TOOL_DEFAULTS) and never
    // matches; open-world read-only (web_fetch/web_search shapes) is
    // explicitly NOT exempt — it keeps auditing.
    const meta = seam.toolMeta?.(toolName);
    if (meta !== undefined && meta.isReadOnly?.(input) === true && meta.isOpenWorld?.(input) !== true) {
      seam.receipt?.("🛡 sidecar read-only (declared) — no audit needed");
      return d;
    }
    // ω99-27 T2 — the operator exemption lane: permissions.sidecarExempt
    // rules (same selector grammar as allow) are the operator's explicit,
    // receipt-leaving, hot-reloading takeover channel past the classifier —
    // the ω99-26 wall's "operator knew this edit should pass but had no
    // no-restart path" gap. Sits AFTER static deny/ask/protected (they
    // short-circuited above — the lane can never override them) and BEFORE
    // the breaker/classifier: a hit allows without a verdict, so it neither
    // pressures nor resets the breaker. Untrusted workspaces lose the
    // project tier's rules at the settings layer (same P1-5 surface as
    // allow/ask).
    if (seam.sidecarExemptRules !== undefined) {
      for (const r of await seam.sidecarExemptRules()) {
        if (ruleMatches(r, toolName, input)) {
          seam.receipt?.(`🛡 sidecar exempt — settings rule «${r}» (operator)`);
          return { behavior: "allow" };
        }
      }
    }
    // Breaker first (§3): an open breaker never calls the model. #452 — auto
    // 档是托付不是看守: the breaker only SAVES the round-trip now (no
    // classifier call while open); the call still auto-allows. 0.3.82（0.3.81
    // 凌乱反馈）: the per-call (未分类) receipt is RETIRED (one receipt per
    // tool call read as clutter beside the edit cards) — the allow COUNTS on
    // the sidecar instead, and the run's settle seam emits ONE aggregated
    // receipt, so the audit trail stays complete without the spam. The ONLY
    // reset is the run boundary (the driver's resetRun at submit) — an allow
    // is not a human approval, so nothing here resets the breaker.
    if (sidecar.breakerOpen()) {
      if (sidecarTripNotified.get(sidecar) !== true) {
        seam.receipt?.(
          `🛡 sidecar 连续高风险 ${sidecar.consecutiveHighs()} 次——auto 托付模式自动放行，暂停逐条分类（熔断中，本轮结束后恢复）`,
        );
        sidecarTripNotified.set(sidecar, true);
      }
      sidecar.noteBreakerAllow();
      return { behavior: "allow" };
    }
    sidecarTripNotified.set(sidecar, false); // observed closed → re-arm
    seam.onGating?.(toolName, true);
    // M49 §4: args embedding taint-tracked content (user-file / MCP bytes)
    // classify with the [untrusted] provenance note.
    const taintSource = seam.taintProbe?.(toolName, input);
    if (taintSource !== undefined) seam.receipt?.(`🛡 args carry ${taintSource} content — classifying as [untrusted]`);
    // M51 §3: harness-computed risk flags (tool_flags) + the custom cache
    // equivalence, resolved from the live Tool set at call time (the T1
    // hoist above already asked the resolver once — same pure lookup).
    // ω99-23: the dispatch-semantics flag (child_gated) resolves the same
    // way — `?? false` keeps the unannotated case conservative (no field).
    const childGated = meta?.isChildGated?.(input) ?? false;
    let verdict: SidecarVerdict;
    try {
      verdict = await sidecar.check(toolName, input, {
        untrusted: taintSource !== undefined,
        ...(meta !== undefined
          ? { flags: { destructive: meta.isDestructive?.(input) ?? true, openWorld: meta.isOpenWorld?.(input) ?? true } }
          : {}),
        ...(meta?.inputsEquivalent !== undefined ? { inputsEquivalent: meta.inputsEquivalent } : {}),
        ...(childGated ? { childGated: true } : {}),
      });
    } finally {
      seam.onGating?.(toolName, false);
    }
    if (verdict.kind === "low") {
      seam.receipt?.(`🛡 sidecar:low${verdict.reason ? ` — ${verdict.reason}` : ""}`);
      return { behavior: "allow" };
    }
    // high | error — #452: auto 档是托付+审计，不是看守。The verdict NEVER
    // interrupts: the call auto-allows and the audit rides a LOUD receipt
    // (stdout, and the session log through the frontend's notify seam). The
    // only human gates left in auto are the static, bypass-immune asks that
    // short-circuited far above (protected settings writes, credential
    // material, operator ask rules).
    seam.receipt?.(`🛡 sidecar:${verdict.kind} — auto 托付模式自动放行：${verdict.reason}`);
    return { behavior: "allow" };
  };
}
