import { stdin, stdout } from "node:process";
import type { PermissionDecision } from "@wudao-org/core";
import { domainMatchesAllowlist, inspectToolInput, formatSpoofLine } from "@wudao-org/core";
import { summarizeToolCall, truncate } from "./log.js";
import { gitRiskAskWarning } from "./git-safety.js";
import { askDigestPrefix, currentAskContext } from "./ask-evidence.js";
// 0.3.14 #1: the `p` answer's persistence lane. A function-level cycle with
// commands/permissions.ts (it imports the rule types above) — safe: both
// directions use each other's bindings only inside function bodies, never at
// module-eval time.
import { persistAllowRule } from "./commands/permissions.js";
import type { Sidecar } from "./sidecar.js";
import { Mode, READ_TOOLS, PLAN_DENY_REASON, decidePermission, safeWorkspaceCommand, modeFromArgv } from "./permission-modes.js";
import {
  ruleMatches,
  protectedSettingsFile,
  credentialMaterialPath,
  credentialAskWarning,
  isDefaultAskCall,
  parseAskAnswer,
  applyAskAnswer,
  recordAskRules,
  createSessionAllowlist,
} from "./permission-rules.js";
import type { AskAnswer, SessionAllowlist } from "./permission-rules.js";
import { EMPTY_PERMISSION_SETTINGS } from "./permission-settings.js";
import type { PermissionSettings } from "./permission-settings.js";
import { createPermissionSettingsWatcher } from "./permission-settings.js";
import {
  immuneAskCeiling,
  withPermissionRequestHook,
  withSidecarLayer,
} from "./permission-gates.js";
import type { PermissionRequestHookFn, SidecarEscalation, SidecarToolMetaResolver } from "./permission-gates.js";

// Re-export the gate's decision type: this module is the public
// `wudao-harness/permission` subpath, and consumers of its gate signatures
// need `PermissionDecision` importable from here, not just from @wudao-org/core.
export type { PermissionDecision } from "@wudao-org/core";

// ω99 file-size discipline arc A — this module keeps the layered rich
// decision (decideRichPermission) and the interactive gate builders
// (createPermissionGate + askApprove + the durable non-interactive tiers);
// the extracted module-level segments live beside it and are re-exported
// below so the public face is unchanged:
//   permission-modes.ts    — Mode + tool-class rosters + builtin-tier decision
//   permission-rules.ts    — ask-menu answers, session/protected/credential
//                            rule matching, session allowlist
//   permission-settings.ts — settings `permissions` node tiers + hot watcher
//   permission-gates.ts    — M63-A PermissionRequest hook layer + M45 sidecar
//                            audit layer
export type { Mode } from "./permission-modes.js";
export {
  META_TOOLS, READ_TOOLS, FILE_EDIT_TOOLS, FILENAME_KEY_TOOLS, WORKSPACE_TOOLS,
  modeFromArgv, resolveInitialMode, modeLabel, cycleMode, safeWorkspaceCommand,
  PLAN_DENY_REASON, decidePermission,
} from "./permission-modes.js";
export type { AskAnswer, AskAnswerOutcome, SessionAllowlist } from "./permission-rules.js";
export {
  parseAskAnswer, askRuleFor, askAnswerToDecision,
  PROTECTED_SETTINGS_FILES, PROTECTED_HOOK_SOURCE_DIRS, protectedSettingsFile,
  credentialMaterialPath, credentialAskWarning,
  applyAskAnswer, sessionRuleReceipt, recordAskRules,
  normalizePath, ruleMatches, DEFAULT_ASK_TOOLS, isDefaultAskCall, createSessionAllowlist,
} from "./permission-rules.js";
export type { PermissionSettings, PermissionTiers, PermissionSettingsWatcher, PermissionWarn } from "./permission-settings.js";
export {
  EMPTY_PERMISSION_SETTINGS, parsePermissionSettings, unionPermissionTiers,
  loadPermissionTiers, loadPermissionSettings, createPermissionSettingsWatcher,
} from "./permission-settings.js";
export type {
  PermissionRequestHookFn, PermissionRequestHookOpts,
  SidecarEscalation, SidecarGateSeam, SidecarToolMeta, SidecarToolMetaResolver,
  StaticRuleDecide,
} from "./permission-gates.js";
export {
  immuneAskCeiling, withPermissionRequestHook, livePermissionRequestHook,
  sidecarGatesTool, toolMetaResolverFor, withSidecarLayer,
} from "./permission-gates.js";

// ---------------------------------------------------------------------------
// M33 §1 — permission richness: the y/a/N ask menu, session-level allowlist
// rules, and .wudao/settings.json permission rules layered above the builtin
// modes. Layer order (first match wins; security fix — deny-first):
//   1. settings deny      (an operator's hot-added deny outranks everything,
//                          including an `a` answered earlier this session)
//   1.5 plan read-only fence (0.3.14: 非 READ_TOOLS 一律 deny 带 reason——
//                          早前的 a/p 规则不得在 plan 下放大权限)
//   2. protected settings writes (bypass-immune — see protectedSettingsFile)
//   3. session allowlist  (the human pressed `a` for this tool[:path] earlier
//                          in this session)
//   4. settings ask       (project policy — the strict side of 4.5/4.6)
//   4.5 web.allowDomains  (M59: operator pre-approval for web_fetch by domain)
//   4.6 settings allow
//   4.7 workspace-safe commands (0.3.14: accept 档只读命令类免问 — shell)
//   5. builtin modes      (workspace/ask/auto/plan, unchanged)  // ω99-195: #11（191 两类词表：注释层 raw 真值）
// ---------------------------------------------------------------------------

/** The layered decision (pure). See the layer order at the top of this block:
 *  settings deny → protected settings writes → session allowlist → settings
 *  ask/allow → builtin modes. */
// Array.isArray can't narrow a readonly string[] out of this union; a structural
// probe on the method can.
const isRuleList = (s: SessionAllowlist | readonly string[]): s is readonly string[] => !("rules" in s);

export function decideRichPermission(args: {
  readonly mode: Mode;
  readonly toolName: string;
  readonly input: Record<string, unknown>;
  /** The session allowlist (instance or rule list); absent = no session layer. */
  readonly session?: SessionAllowlist | readonly string[];
  /** Settings rules; absent = no settings layer. */
  readonly settings?: PermissionSettings;
  /** M59 §2: web.allowDomains (exact or *.suffix) — operator pre-approval for
   *  web_fetch BY DOMAIN. Sits after settings ask (an explicit ask rule still
   *  forces the human) and before settings allow; deny rules outrank it above.
   *  Private-network targets remain refusable by the TOOL regardless. */
  readonly webAllowDomains?: readonly string[];
}): PermissionDecision | "ask" {
  const { mode, toolName, input } = args;
  const settings = args.settings ?? EMPTY_PERMISSION_SETTINGS;
  // 1. settings deny — an operator's deny outranks everything, including an
  //    `a` answered earlier this session (hot-reload can add it mid-run).
  for (const r of settings.deny) {
    if (ruleMatches(r, toolName, input)) return { behavior: "deny", reason: `settings deny rule "${r}"` };
  }
  // 1.5 plan-mode read-only fence (0.3.14 #3): denies every non-read tool
  //     OUTRIGHT — above session/settings allow so an earlier `a`/`p` can
  //     never widen plan. shell keeps the accept tier's safe read-only
  //     class (same safeWorkspaceCommand) and is DECIDED here — the builtin
  //     layer below knows no safe class and would deny it. Never asks: plan
  //     must not interrupt the run (the deny reason teaches the way out).
  if (mode === "plan" && !READ_TOOLS.has(toolName)) {
    if (toolName !== "shell") return { behavior: "deny", reason: PLAN_DENY_REASON };
    const cmd = input["command"];
    if (typeof cmd !== "string" || !safeWorkspaceCommand(cmd)) return { behavior: "deny", reason: PLAN_DENY_REASON };
    return { behavior: "allow" };
  }
  // 2. protected settings writes — bypass-immune: every mode (auto included)
  //    hands the decision to the human. 0.3.12: the retired read-only tier's
  //    outright deny is gone — settings deny rules (layer 1) still hard-deny.
  const protectedFile = protectedSettingsFile(toolName, input);
  if (protectedFile !== undefined) {
    return "ask";
  }
  const sessionRules: readonly string[] =
    args.session === undefined ? [] : isRuleList(args.session) ? args.session : args.session.rules();
  // 3. session allowlist
  for (const r of sessionRules) {
    if (ruleMatches(r, toolName, input)) return { behavior: "allow" };
  }
  // 4. settings ask
  for (const r of settings.ask) {
    if (ruleMatches(r, toolName, input)) return "ask";
  }
  // 4.5 web.allowDomains (M59) — web_fetch on an allowlisted host pre-approved.
  //     web_search stays ask (its "domain" is the provider backend, not the
  //     query target; pre-approving search is permissions.allow's job).
  if (toolName === "web_fetch" && (args.webAllowDomains?.length ?? 0) > 0) {
    const url = input["url"];
    if (typeof url === "string") {
      try {
        const host = new URL(url).hostname.replace(/^\[|\]$/g, "").toLowerCase();
        if (host !== "" && domainMatchesAllowlist(host, args.webAllowDomains ?? [])) return { behavior: "allow" };
      } catch {
        // unparseable URL: no pre-approval — fall through to ask
      }
    }
  }
  // 4.6 settings allow
  for (const r of settings.allow) {
    if (ruleMatches(r, toolName, input)) return { behavior: "allow" };
  }
  // 4.68 ω99-112 — browser default-ask: submission-class browser/computer
  //     actions with NO prior rule hit hand the decision to the human (the
  //     109 pet confirmation card; an `a`/`p` rule above — or an operator
  //     deny/ask — already decided). ω99-226: #1 — auto 档跳过本层（产品
  //     裁定，0.3.59 验装回执第三报「像是开了假的auto模式」）：显式切到
  //     auto = 显式托付，八件套跟随档位落内建模式 → allow，sidecar 分类
  //     器照跑（九名不在 SIDECAR_UNGATED，auto 放行后必过分类器——托付但有
  //     审计；#452 起 high/error/熔断判决也自动放行，审计走响亮回执，不再
  //     升级人工）。workspace/ask 档照旧问；plan
  //     档只读栅栏（层 1.5 在本层之前）照旧拒。212/220 的「every mode
  //     included」姿态自此被本裁定推翻。Everything not in the class falls
  //     through unchanged.
  if (mode !== "auto" && isDefaultAskCall(toolName, input)) return "ask";
  // 4.65 夜移 010: credential material — bypass-immune vs MODE (auto can no
  //     longer read key material silently) but not vs explicit human grants:
  //     a session `a` rule (layer 3) and an operator's settings allow (4.6)
  //     both returned above, so what reaches here carries no pre-approval →
  //     ask. OH-Py hard-denies at this tier; wudao asks (capability≠policy).
  //     Plan mode included: the read-only fence is about mutation, not secrets.
  if (credentialMaterialPath(toolName, input) !== undefined) {
    return "ask";
  }
  // 4.7 workspace-safe commands (0.3.14 #2): in accept (workspace) mode a
  //     curated read-only command class runs without asking — verb-listed,
  //     workspace-scoped args only (safeWorkspaceCommand). Sits BELOW the rule
  //     layers: an operator deny/ask still forces the human (the class never
  //     widens policy), and everything else in shell keeps the ask.
  if (mode === "workspace" && toolName === "shell") {
    const cmd = input["command"];
    if (typeof cmd === "string" && safeWorkspaceCommand(cmd)) return { behavior: "allow" };
  }
  // 5. builtin modes
  return decidePermission(mode, toolName);
}

// ---------------------------------------------------------------------------
// M45 review — the shared argv gate builder (extracted from index.ts so the
// REPL's buildTools gate — which is ALSO the gate the task tool's children
// inherit — is the same tested unit the one-shot path uses).
// ---------------------------------------------------------------------------

// Prompt the human on stdin for a y/a/N approval of a non-read tool call
// (default mode only). M33 §1: y = once, a = this session (allowlist rule),
// n [reason] = deny with a reason fed back to the model. Security fix: a
// runtime-policy write (settingsFile set) prompts plain [y/N] naming the
// file — `a` is not offered (applyAskAnswer degrades one to allow-once).
// M37 §3: a high-risk git shell upgrades the ask with a warning block
// (informational only — the pipeline still decides). M45: a sidecar
// escalation prefixes its note (`🔑 (sidecar: <reason>)` / the breaker
// notice). Fail-closed: with no TTY there is nobody to ask — deny rather
// than allow.
/** M61 §4 — the REAL fail-closed ask posture for non-interactive input: no
 *  TTY ⇒ nobody to ask ⇒ deny. A durable scheduled run (WUDAO_SCHEDULE_RUN=1,
 *  spawned by the wudao ui daemon) is headless BY DESIGN — the ask tier's
 *  timeout is zero: deny now, naming the scheduled-run posture in the reason.
 *  Exported so det-48 and the unit suite execute the actual decision, not a
 *  reimplementation of its wording. */
/** M61 §4 (re-review ruling) — the durable scheduled-run permission tier.
 *  Read-only tools still consult the DENY layer (settings deny rules via
 *  `staticDeny` + the tool's own checkPermissions) before auto-allowing —
 *  only the ASK layer is bypassed for them, so a user deny rule on a
 *  read-only tool (e.g. a secrets read) is never silently ignored. Every
 *  non-read-only tool denies outright: an ask with no human present, with
 *  persisted allow rules and any bypass opt-in NEVER consulted. */
export function createDurableAskTierGate(deps: {
  /** Live tool set (name -> isReadOnly/checkPermissions). */
  readonly getTools: () => readonly {
    readonly name: string;
    isReadOnly?(input: Record<string, unknown>): boolean;
    checkPermissions?(input: Record<string, unknown>): Promise<PermissionDecision> | PermissionDecision;
  }[];
  /** The static deny-rule layer: a deny decision when one matches, else
   *  undefined (ask/allow outcomes do NOT deny here — the ask layer is
   *  bypassed for read-only tools in this tier). */
  readonly staticDeny: (toolName: string, input: Record<string, unknown>) => Promise<PermissionDecision | undefined>;
}): (toolName: string, input: Record<string, unknown>) => Promise<PermissionDecision> {
  return async (toolName, input) => {
    const tool = deps.getTools().find((t) => t.name === toolName);
    if (tool?.isReadOnly?.(input) === true) {
      const denied = await deps.staticDeny(toolName, input);
      if (denied !== undefined) return denied;
      const cp = await tool.checkPermissions?.(input);
      if (cp !== undefined && cp.behavior === "deny") return cp;
      return { behavior: "allow" };
    }
    return { behavior: "deny", reason: "scheduled run: ask tier with no human — deny" };
  };
}

export function nonInteractiveAskDecision(toolName: string, env: NodeJS.ProcessEnv = process.env): AskAnswer {
  const scheduled = env.WUDAO_SCHEDULE_RUN === "1";
  return scheduled
    ? { kind: "deny", reason: "scheduled run: ask with no human → deny", scheduledRun: true }
    : { kind: "deny", reason: "non-interactive" };
}

function askApprove(toolName: string, summary: string, settingsFile?: string, warning?: string, sidecarNote?: string, reviewLine?: string, spoofLine?: string): Promise<AskAnswer> {
  if (stdin.isTTY !== true) {
    const decision = nonInteractiveAskDecision(toolName);
    const scheduled = (decision as { scheduledRun?: boolean }).scheduledRun === true;
    // ω99-158: 非交互拒中文化（#7/#8 同形两处，另一处在 askHuman 内）。
    stdout.write(`🔑 非交互输入${scheduled ? "（定时运行——无人在场）" : ""} — 正在拒绝 ${toolName}\n`);
    return Promise.resolve(decision);
  }
  return new Promise((resolve) => {
    // ω99-158: askApprove 标题中文化 — 行尾空格是 golden 字节（ask-evidence
    // T11 / o99-43 MENU 逐字镜像），保留。
    const ask = settingsFile === undefined
      ? `🔑 允许 ${toolName}${summary ? "：" + truncate(summary, 100) : ""}？ [y/a/p/N] `
      : `🔑 允许 ${toolName}：策略文件 ${settingsFile}${summary && summary !== settingsFile ? ` (${truncate(summary, 100)})` : ""}？ [y/N] `;
    // ω-4e: the asker digest (child-originated asks only — undefined renders
    // the pre block byte-identical to today). First block, before the
    // warning/sidecar lines.
    const digest = askDigestPrefix();
    // design 70 Phase 2b (funnel-1 wiring): the optional review line sits
    // ABOVE the digest in `pre`, so the most-advisory content is on top
    // (consistent with tui/permission.tsx line 104-105 — digest first, then
    // review inside the prompt body). Fail-closed: undefined/absent = no
    // extra bytes — byte-identical to today.
    // ω99-318: the spoof reveal line joins the pre block after the sidecar —
    // same additive-undefined discipline (clean input renders byte-identical).
    const pre = `${reviewLine !== undefined ? `${reviewLine}\n` : ""}${digest !== undefined ? `${digest}\n` : ""}${warning !== undefined ? `${warning}\n` : ""}${sidecarNote !== undefined ? `${sidecarNote}\n` : ""}${spoofLine !== undefined ? `${spoofLine}\n` : ""}`;
    stdout.write(pre === "" ? ask : `${pre}${ask}`);
    const onData = (chunk: Buffer | string): void => {
      const line = String(chunk).split("\n")[0] ?? "";
      process.stdin.removeListener("data", onData);
      process.stdin.pause();
      resolve(parseAskAnswer(line));
    };
    process.stdin.once("data", onData);
    process.stdin.resume();
  });
}

// Build the canUseTool gate from argv. M33 §1 layering (security fix —
// deny-first): .wudao/settings.json deny rules (hot-reloaded, receipt to
// stdout) → protected settings writes (always the human) → session allowlist
// (from `a` answers) → settings ask/allow → builtin modes (auto → allow all;
// workspace → allow the workspace file class, ask for the rest; ask → ask
// for every tool). M45: a sidecar instance adds the auto-mode classifier
// layer between the static rules and the allow (high verdicts / the open
// breaker escalate the ask with the reason; non-TTY denies fail-closed).
// The one-shot main gate, the REPL main gate, and the REPL's buildTools gate
// (the task tool's child gate) all come from here — one sidecar instance in,
// the same classifier + breaker everywhere.
export function createPermissionGate(argv: string[], sidecar?: Sidecar, taintProbe?: (toolName: string, input: Record<string, unknown>) => string | undefined, toolMeta?: SidecarToolMetaResolver, webAllowDomains?: readonly string[], permissionHook?: PermissionRequestHookFn, askReview?: (toolName: string, input: Record<string, unknown>) => Promise<string | undefined>, bootMode?: Mode, trustSuppressed?: () => boolean): (toolName: string, input: Record<string, unknown>) => Promise<PermissionDecision> {
  // 0.3.11: `bootMode` — the entry-resolved initial mode (resolveInitialMode:
  //  CLI flag > persisted permissions.defaultMode). Absent (tests, legacy
  //  callers) the gate stays argv-only, hermetic against the real global
  //  home; the gate itself never reads settings tiers.
  // P1-5: `trustSuppressed` — the live workspace-trust getter feeding the
  //  watcher (absent = no gate; index.ts passes trust.ts's status, pinned
  //  false by --trust-workspace).
  const mode = bootMode ?? modeFromArgv(argv);
  const session = createSessionAllowlist();
  const watcher = createPermissionSettingsWatcher(process.cwd(), (line) => process.stdout.write(`${line}\n`), trustSuppressed === undefined ? {} : { trustSuppressed });
  // M59: web.allowDomains rides the static layers (startup-loaded — the
  // permissions node hot-reloads above it, the web node is v1-static).
  const staticDecide = async (toolName: string, input: Record<string, unknown>) =>
    decideRichPermission({ mode, toolName, input, session, settings: await watcher.get(), ...(webAllowDomains !== undefined && webAllowDomains.length > 0 ? { webAllowDomains } : {}) });
  // M63-A: the PermissionRequest hook layer (below, AFTER askHuman — the
  // sidecar seam's escalate closes over it; vestigial under #452 but kept
  // wired) wraps the whole remaining pipeline: static rules inside, the
  // sidecar layer as the no-opinion fall-through. Mandated order: after
  // deny rules, before the sidecar.
  // The human ask — static "ask" decisions only (#452: the sidecar never
  // routes here; the esc param is vestigial, always {circuitOpen:false}).
  // Non-TTY is fail-closed: a static ask denies as "non-interactive".
  const askHuman = async (toolName: string, input: Record<string, unknown>, esc: SidecarEscalation): Promise<PermissionDecision> => {
    // ω99-43: replay-before-decision. A session'd child carrying durable
    // approval receipts answers THIS exact (tool, input) with the recorded
    // human decision — no new ask (this runs BEFORE the TTY check on
    // purpose: the decision is already the human's, so a headless resume
    // child replays it instead of hitting the fail-closed deny). The key is
    // content-addressed (callFingerprint), so different input or a
    // different tool never matches; an absent face — every top-level ask,
    // every sessionless child — falls through to today's path unchanged.
    const approvals = currentAskContext()?.approvals;
    const recorded = approvals?.lookup(toolName, input);
    if (recorded !== undefined) return recorded;
    if (stdin.isTTY !== true) {
      // ω99-158: 非交互拒中文化（askHuman 车道，与 askApprove 的 #7 同形）。
      stdout.write(`🔑 非交互输入 — 正在拒绝 ${toolName}\n`);
      return {
        behavior: "deny",
        reason: esc.circuitOpen
          ? "sidecar circuit-open"
          : esc.reason !== undefined
            ? `sidecar: ${esc.reason}`
            : "non-interactive",
      };
    }
    // M37 §3: a high-risk git command upgrades the ask text (never blocks).
    // 夜移 010: credential material outranks it — a key read is the ask the
    // human most needs context for.
    const warning = credentialAskWarning(toolName, input) ?? gitRiskAskWarning(toolName, input, process.cwd());
    const note = esc.circuitOpen
      ? `🛡 sidecar 连续拒绝 ${sidecar?.consecutiveHighs() ?? 0} 次,已切换人工确认`
      : esc.reason !== undefined
        ? `🔑 (sidecar: ${esc.reason})`
        : undefined;
    // design 70 Phase 2b — funnel-1 wiring (funnels 3/4 already wired in
    // Phase 1). When an askReview callable is supplied, await it BEFORE the
    // pre block renders, then thread the resulting line into askApprove's
    // 6th param. Fail-closed on every failure path:
    //   - the callable throws (e.g. cyclic audited input inside the reviewer
    //     is caught upstream by ask-reviewer.ts's own try, but we belt-and-
    //     brace here too)
    //   - returns undefined (trigger miss / no-evidence / no-verdict /
    //     unarmed)
    //   - absent (the byte-identical fail-closed default; tests pin this)
    // so the prompt is byte-equivalent to today on every non-armed, every
    // fail-closed, and every reviewer-disabled path.
    let reviewLine: string | undefined;
    if (askReview !== undefined) {
      try {
        reviewLine = await askReview(toolName, input);
      } catch {
        reviewLine = undefined;
      }
    }
    // ω99-318: the visual-spoof reveal line — same pre-block lane as the
    // warning/review (reveal-not-block; the y/a/p/N semantics are untouched).
    // Absent on clean input → the pre block stays byte-identical (T11/o99-43
    // golden bytes unaffected).
    const spoofLine = formatSpoofLine(inspectToolInput(input));
    const answer = await askApprove(toolName, summarizeToolCall(toolName, input), protectedSettingsFile(toolName, input), warning, note, reviewLine, spoofLine);
    const { decision: final, sessionRule, persistentRule } = applyAskAnswer(answer, toolName, input);
    // 夜移 009: one shared recording seam — the session rule's receipt rides
    // stdout (mirroring the persistent receipt below it).
    const sessionNote = recordAskRules(session, { sessionRule, persistentRule });
    if (sessionNote !== null) stdout.write(`${sessionNote}\n`);
    // 0.3.14 #1: `p` persists through the /permissions lane (receipt to
    // stdout once the write lands).
    if (persistentRule !== null) {
      void persistAllowRule(process.cwd(), persistentRule).then(
        (receipt) => stdout.write(`${receipt}\n`),
        (err) => stdout.write(`permissions：always-rule 写入失败（${String(err)}）——本会话规则仍然生效\n`), // ω99-166e-i: #1（always-rule 写失败回执中文化；repl :1402 字节孪生）
      );
    }
    // ω99-43: fail-closed commit — the receipt lands on the child's
    // sidechain BEFORE the decision takes effect. A failed append means the
    // decision is not replayable, so it never happened: block execution
    // (the honest chain — a decision without evidence must not silently
    // pass). Sessionless/top-level asks (no face) return verbatim.
    if (approvals === undefined) return final;
    try {
      await approvals.commit(toolName, input, final);
    } catch {
      return { behavior: "deny", reason: "approval evidence could not be committed; tool execution was blocked" };
    }
    return final;
  };
  const sidecarLayer = sidecar !== undefined
    ? withSidecarLayer(
        {
          sidecar,
          getMode: () => mode,
          escalate: askHuman,
          // 134: --answer-only 抑制 sidecar 回执
          receipt: (line: string) => { if (!argv.includes("--answer-only")) process.stdout.write(`${line}\n`); },
          // M49 §4: the caller's taint probe (one-shot main gate).
          ...(taintProbe !== undefined ? { taintProbe } : {}),
          // M51 §3: the caller's tool-annotation resolver (late-bound).
          ...(toolMeta !== undefined ? { toolMeta } : {}),
          // ω99-27 T2: the operator exemption lane over the hot-reloaded
          // permission settings (same watcher the static rules read).
          sidecarExemptRules: async () => (await watcher.get()).sidecarExempt,
        },
        staticDecide,
      )
    : undefined;
  // ω99-21: the immune-ask ceiling — composed HERE (both argv entrypoints and
  // every test share this one builder), so callers stay zero-diff. A hook
  // allow can never clear the three bypass-immune ask layers.
  const layered = withPermissionRequestHook(permissionHook, () => mode, staticDecide, {
    sidecarPresent: sidecar !== undefined,
    immuneAsk: immuneAskCeiling(() => watcher.get()),
    ...(sidecarLayer !== undefined ? { classify: sidecarLayer } : {}),
  });
  return async (toolName: string, input: Record<string, unknown>): Promise<PermissionDecision> => {
    const decision = await layered(toolName, input);
    return decision !== "ask" ? decision : askHuman(toolName, input, { circuitOpen: false });
  };
}
