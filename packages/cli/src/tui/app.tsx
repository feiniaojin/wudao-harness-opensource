// WudaoApp — the Ink TUI shell. Static history (rendered once per entry) +
// live area (streaming answer, busy tools, permission prompt, input), plus
// append-only session persistence to the same JSONL store the one-shot CLI
// uses (<workspaceRoot>/.wudao/sessions).
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Box, Static, Text, render, useApp, useInput } from "ink";
import {
  applySummaryMarkers,
  createAskUserTool,
  createFileAttachmentStore,
  createFileHistory,
  createJsonlSessionStore,
  createTurnDiffTracker,
  repairOrphanedToolCalls,
  inspectToolInput,
  ASK_USER_TIMEOUT_MS,
  TODO_LINE_MARKS,
  type AgentHooks,
  type AgentMessage,
  type SessionStartSource,
  type AskUserOption,
  type FileHistory,
  type LoopEvent,
  type ModelClient,
  type TurnDiffTracker,
  type PermissionDecision,
  type Tool,
} from "@wudao/core";
// 125 项 1/项 2：预留感知触发线 + 水位线查询工具的装配缝与缺省锚。
import { compactionThresholdFields, DEFAULT_COMPACTION_SETTINGS } from "../misc-config.js";
// ω99-314: 文件级时光机——快照仓纯层。
import { createSnapshotStore } from "../snapshots.js";
import { createProvider, createLiveKeyPool, loadPersonaRegistry, withPersona } from "@wudao/providers";
import type { KeyPool, PersonaRegistry, PersonaRuntime, ProviderConfig, ResolvedPersona } from "@wudao/providers";
// ω99-320: the session's soft-warn slot (流式软警告的 driver 侧消费).
import { createSoftWarnSlot } from "../soft-warn-tracker.js";
import { asMutableConfig, applyModelSelection } from "../commands/model.js";
import type { ModelSelection, MutableProviderConfig } from "../commands/model.js";
// SDD 2026-08-23 persona Task 3: the persona construction sink — registry
// load at mount, the session runtime (current starts at the chain-resolved
// persona), and the provider-switch chain follow.
import {
  resolveActivePersona, resolveBootstrapPersona,
  applyPersonaChainAfterProviderSwitch, formatPersonaChainFollow, recordPersonaChange,
} from "../commands/persona.js";
import type { DriverPersonaContext } from "../driver/agent-driver.js";
// 0.3.15：耗时展示与 driver 同一格式器（一处定义，所有表面一致）。
import { formatMs } from "../driver/agent-driver.js";
import { resolveGlobalHome } from "../settings-layer.js";
// M63 §A: the /provider switch machinery (target-config derivation + the
// in-place config sync + the cold-cache receipt constants).
import { resolveProviderSwitch, applyProviderConfig, keyRefreshPending, configRefreshPending, PROVIDER_SWITCH_COLD_ATTRIBUTION } from "../commands/provider.js";
// M63 §C: a key saved mid-session ("wudao ui" settings/wizard) resolves from
// the credentials file on a TUI /provider switch too — env wins, same as boot.
import { readCredentialsFileSync } from "../credentials.js";
// Provider management §7: the window follows the LIVE config (I1).
import { resolveSessionWindowTokens } from "../provider-registry.js";
import { CostRegistry } from "../commands/cost.js";
import { persistAllowRule } from "../commands/permissions.js";
import { useAgent } from "./use-agent.js";
import type { AgentDriverOptions, HistoryEntry, LiveState, UseAgentResult } from "./use-agent.js";
import { FindPanel } from "./find.js";
import { FIND_COMMAND_INFO, parseFindCommand } from "./find-core.js";
import { RECALL_COMMAND_INFO } from "./recall-core.js";
import { RESTACK_COMMAND_INFO } from "../restack.js";
import { BG_COMMAND_INFO } from "./bg-core.js";
import { ENTRY_GAP_LINES, PROMPT, SEP, T } from "./theme.js";
// ω99-131: the deliverable file card — a make_xlsx/make_pptx/make_docx
// entry's `file` renders as a locate-and-open card, not the raw receipt.
import { FileCard } from "./file-card.js";
import { Spinner } from "./spinner.js";
import { StatusBar } from "./status-bar.js";
import { TextInput } from "./input.js";
import { createInputHistory } from "./input-state.js";
import { bindingMatches, DEFAULT_RESOLVED_KEYBINDINGS, DOUBLE_ESC_WINDOW_MS, loadKeybindings } from "./keybindings.js";
import type { ResolvedKeybindings } from "./keybindings.js";
import { PermissionPrompt } from "./permission.js";
import { AskUserPrompt } from "./ask-user.js";
import { Markdown } from "./markdown.js";
import { DiffView } from "./diff.js";
import { parseReplCommand } from "../repl.js";
import { listSlashCommands, formatSlashHelp } from "../slash-commands.js";
import { decideRichPermission, modeFromArgv, modeLabel, cycleMode, createSessionAllowlist, createPermissionSettingsWatcher, applyAskAnswer, recordAskRules, askAnswerToDecision, protectedSettingsFile, credentialAskWarning, withSidecarLayer, withPermissionRequestHook, immuneAskCeiling } from "../permission.js";
import type { AskAnswer, Mode, SessionAllowlist, SidecarEscalation } from "../permission.js";
import type { Sidecar } from "../sidecar.js";
import { buildSystemPrompt } from "../prompt.js";
// M64-A §A: the session's peer-messaging runtime (list_agents / send_message
// over the UDS inbox; deliveries ride the steering lane).
import type { PeerRuntime } from "../peer/runtime.js";
// M64-C §C: the team runtime (named teammates) + the in-process panel.
import { createTeamRuntime, type TeamRuntime } from "../teams/runtime.js";
import { TeamsPanel } from "./teams-panel.js";
import type { LoadedSkill } from "../skills.js";
import { registerExtensionSwapSink } from "../extension-state.js";
import { getContextRules, createContextRuleMatcher } from "../rules.js";
import { buildPluginCommandMessage, formatPluginCommandError } from "../plugins.js";
import type { PluginCommand } from "../plugins.js";
import { runExtensionCommand } from "../extensions/dispatch.js";
import type { ExtensionRuntime } from "../extensions/api.js";
import { parsePlanReviewInput } from "../plan.js";
import { gitRiskAskWarning } from "../git-safety.js";
import { askDigestPrefix } from "../ask-evidence.js";
import { askReviewIntroForRelay } from "../ask-reviewer.js";
import { createCacheTrackingModel, type CacheTrackingModel } from "../cache.js";
import { collectSessionRows, formatResumePickerLine, ensureSessionName, firstUserMessage, deriveSessionName, defaultSessionListFilter } from "../session-list.js";
import type { SessionRow } from "../session-list.js";
import { summarizeToolCall, truncate, modelLabel } from "../log.js";
import { selectMessagesToPersist } from "../persist.js";
import { buildToolSet } from "../tools.js";
import { maybeLoginShellEnv } from "../shell-snapshot.js";
import { appendSessionEntry, buildDeferredLoadedEntry, buildCompactBoundaryEntry, buildClearBoundaryEntry, countEntriesOfType, DEFERRED_LOADED_TYPE } from "../session-entry.js";
import { createProviderModelResolver, createSessionRegistry } from "../agents/index.js";
import type { AgentRegistry, RosterPluginAgent } from "../agents/index.js";
import { openSessionMemoryStore, createMemoryRuntime, surfacePendingReview } from "../memory/index.js";
import { createSessionSearchIndex } from "../session-search.js";
import { VERSION, maxTurns } from "../version.js";
import { appendPromptHistory, loadPromptHistory } from "../prompt-history.js";
import { parseBangCommand, runBangCommand, formatBangEcho, buildBangContextPrefix } from "../bang.js";
import { expandMentions } from "../mentions.js";
import { createGitStatusProber } from "../git-status-note.js";import { HINT, newSessionId, ClearConfirm, HistoryItem, LiveArea } from "./app-panels.js";
import { routeSubmit } from "./app-submit.js";
import { useSessionModel } from "./app-model.js";
import { usePermissionStack } from "./app-permissions.js";
import { usePersistCallbacks } from "./app-persist.js";
import { buildAgentOptions } from "./app-agent-opts.js";
import { handleAppKey } from "./app-keys.js";
import type { PendingAsk, PendingAskUser } from "./app-panels.js";
import type { WudaoAppProps } from "./app-props.js";
export { HistoryItem, LiveArea } from "./app-panels.js";
export type { WudaoAppProps } from "./app-props.js";

export function WudaoApp(props: WudaoAppProps): React.JSX.Element {
  const { config, workspaceRoot, contextWindowTokens, resumeHistory, modelOverride, hooks, streamIdle: streamIdleOpts } = props;
  const { exit } = useApp();

  // M42 §3 / M43-A: the permission mode is RUNTIME state owned by the driver —
  // shift+tab cycles it (workspace → ask → auto → plan); `api.mode` drives the render // ω99-191: #4
  // and the permission gate reads apiRef.current.getMode() at each tool call
  // (never a startup snapshot). apiRef is declared early because the gate and
  // the cache wrapper below only ever fire mid-run, after render committed.
  const apiRef = useRef<UseAgentResult | null>(null);

  // before useAgent returns; the handler only fires mid-run, after render.
  // Interactive UI → info-level equivalent: always shown, no gating.
  const notifyRef = useRef<(text: string) => void>(() => {});
  // 0.3.11: the boot chain rides the entry-resolved prop (flag > persisted
  // default); absent = argv-only, the hermetic direct-construction default.
  const initialMode = useRef<Mode>(props.initialPermissionMode ?? modeFromArgv(process.argv));

  const [sessionId, setSessionId] = useState(() => props.sessionId ?? newSessionId());
  const sessionRef = useRef(sessionId);
  const storeRef = useRef(createJsonlSessionStore(join(workspaceRoot, ".wudao", "sessions")));
  // M79 §2: the workspace attachment store — the provider's transient
  // data-URL resolver, so a resumed image-bearing session runs here exactly
  // like the REPL / one-shot / ui hosts (text-only models still gate
  // pre-IO).
  const attachmentsRef = useRef(createFileAttachmentStore(workspaceRoot));
  // Identity-correct persistence: starts as the resume history, grows with each
  // appended batch so the next run's selection excludes already-persisted messages.
  const loadedRef = useRef<AgentMessage[]>(resumeHistory ? [...resumeHistory] : []);
  const [ask, setAsk] = useState<PendingAsk | null>(null);
  const [askUserPending, setAskUserPending] = useState<PendingAskUser | null>(null);
  // ω99-59: the /find overlay's query (null = closed/idle). While open the
  // FindPanel owns the keyboard exactly like an ask overlay — and Esc from
  // the panel restores this null, which remounts the input below.
  const [findQuery, setFindQuery] = useState<string | null>(null);
  // M42 §4: a /clear awaiting its single-key y/N confirmation.
  const [clearPending, setClearPending] = useState(false);
  // M53 §1: an armed /edit — the driver's branch point is set; the original
  // text sits in the input for editing (nonce keys the buffer replacement).
  const [editDraft, setEditDraft] = useState<{ readonly text: string; readonly nonce: number } | null>(null);
  // M44 §2: the session's submitted-prompt history, held HERE (not inside
  // TextInput) so it survives the input's unmounts while a permission ask /
  // ask_user question / clear confirm owns the screen.
  const [inputHistory, setInputHistory] = useState(createInputHistory);
  // cc-plugins A3: the live extension overlay. Boot props stay the fallback;
  // a rescanExtensions() swap replaces skills/plugin commands/plugin agents/
  // hooks in place (React state re-derives the prompt/menus/routing), and the
  // effect below also lands the rebuilt system prompt on the DRIVER —
  // setOptions alone can never land a prompt (the loop reads STATE).
  const [extLive, setExtLive] = useState<{
    readonly skills: readonly LoadedSkill[];
    readonly pluginCommands: readonly PluginCommand[];
    readonly pluginAgents: readonly RosterPluginAgent[];
    readonly hooks: AgentHooks | undefined;
  } | null>(null);
  // M58 §C#12: a pending bang capture (the command+output context block
  // awaiting the next submitted prompt). A ref, not state: it is consumed at
  // submit time and never renders.
  const bangContextRef = useRef<string | null>(null);
  // M33 §3: the session's display name (kebab short name recorded in the
  // JSONL) and the /resume picker's candidate rows (null = picker closed).
  const [sessionName, setSessionName] = useState<string | undefined>(() => {
    const first = resumeHistory !== undefined && resumeHistory.length > 0 ? firstUserMessage(resumeHistory) : undefined;
    return first !== undefined ? deriveSessionName(first) : undefined;
  });
  const [resumePicker, setResumePicker] = useState<readonly SessionRow[] | null>(null);
  // M35 §2: how many deferred_loaded entries this session's JSONL carries —
  // seeded from the resumed file, incremented when this run's one load_tools
  // applies (the entry is appended at that moment).
  const [deferredLoaded, setDeferredLoaded] = useState(0);
  useEffect(() => {
    if (resumeHistory === undefined || sessionId === undefined) return;
    void storeRef.current
      .loadSessionEntries(sessionId)
      .then((entries) => setDeferredLoaded(countEntriesOfType(entries, DEFERRED_LOADED_TYPE)))
      .catch(() => {});
    // Seed once for the resumed session; /resume rotates through loadSession.
  }, []);

  // M58 §C#10: preload the up-arrow history with this project's cross-session
  // prompts (newest last). Only seeds an EMPTY history — a fast first submit
  // must not be clobbered by the async load landing late.
  useEffect(() => {
    let cancelled = false;
    void loadPromptHistory(workspaceRoot)
      .then((texts) => {
        if (cancelled || texts.length === 0) return;
        setInputHistory((cur) => (cur.entries.length > 0 ? cur : { entries: [...texts], pointer: texts.length, draft: null }));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
    // Load once per mount (workspace): a session does not re-read the file.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // M58 §C#8 (batch-B wiring of C's prober): the <git_status> block rides the
  // driver's MetaNote channel — projection-only, NEVER the stable prompt
  // prefix (the CC cache coupling the spec's hard rule rejects). Eager probe
  // at mount = the session-start snapshot (the first model call drains it);
  // every turn_finished re-checks the cheap fingerprint. A note pushed while
  // idle waits in the queue until the next model call — turn boundaries only,
  // never per keystroke. Fail-open: a git failure just injects nothing.
  const gitProbeRef = useRef<ReturnType<typeof createGitStatusProber> | null>(null);
  if (gitProbeRef.current === null) {
    gitProbeRef.current = createGitStatusProber({
      workspaceRoot,
      push: (t) => apiRef.current?.pushMetaNote(t),
    });
  }
  useEffect(() => {
    void gitProbeRef.current?.probe();
  }, []);

  // M39: bind the extension entry channel (appendEntry/readEntries) to THIS
  // App's session store + id — re-bound when /clear rotates the session id.
  useEffect(() => {
    props.extensions?.bindSession(storeRef.current, sessionRef.current);
  }, [props.extensions, sessionId]);


  // M30: the session's background agent registry — the task tool, the
  // agent_* tools, the bg status counter, and interrupt/exit cleanup all
  // share this one handle (spec §B: parent abort kills every in-flight agent).
  // M43-A: the counts poll into the driver's status channel (api.bg).
  const agentsRegistry = useMemo(() => props.agentsRegistry ?? createSessionRegistry(), [props.agentsRegistry]);

  // M62 §1: the gated context-rule matcher for this workspace (undefined
  // when there are no gated rules — the loop seam stays unwired).
  const gatedRuleMatcher = useMemo(() => {
    const gated = getContextRules(workspaceRoot, (w) => console.error(`[wudao] rules: ${w}`)).gated;
    return gated.length > 0 ? createContextRuleMatcher(workspaceRoot, gated) : undefined;
  }, [workspaceRoot]);

  // M49 §1: the session's memory runtime — the tool set's memory_write/
  // memory_search (top-level; children get search only) plus the recall seam
  // the driver projects through the MetaNote channel at every run start.
  // One-time startup surface: pending-review suggestions notify once.
  // M62 §7: the session-configured store (memoryEnabled/memoryDirectory);
  // undefined → zero memory surface (tools, recall, review all off).
  const memoryStore = useMemo(() => openSessionMemoryStore(workspaceRoot), [workspaceRoot]);
  const memoryRuntime = useMemo(() => createMemoryRuntime(workspaceRoot), [workspaceRoot]);
  // M49 §3: the session-search index (incremental on every persisted append;
  // /search and `wudao sessions search` read the same file).
  const searchIndexRef = useRef(createSessionSearchIndex(workspaceRoot));
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      await memoryRuntime.refresh();
      if (cancelled) return;
      const pending = await surfacePendingReview(workspaceRoot);
      if (!cancelled && pending !== undefined) notifyRef.current(pending);
    })().catch(() => {});
    return () => {
      cancelled = true;
    };
    // Once per mount (workspace): the pending prompt is the "next session"
    // rule — re-running on every session rotation would nag.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceRoot]);

  // 拆分运动 C：模型/persona 构造簇外提至 app-model.ts（useSessionModel）。
  const {
    model, wrapTracked, costRegistryRef, liveConfigRef, keyPoolRef, personaCtxRef,
    mandatoryRepairArmedRef, softWarnSlotRef, trackedModelRef, askReviewModelRef,
    liveModelMeta, liveWindowTokens, onModelSwitch, onProviderSwitch, resolveModel,
  } = useSessionModel({
    config,
    contextWindowTokens,
    readProviderPersonaBinding: props.readProviderPersonaBinding ?? (() => undefined),
    readGlobalDefaultPersonaId: props.readGlobalDefaultPersonaId ?? (() => undefined),
    modelOverride,
    streamIdleOpts,
    workspaceRoot,
    sessionId: props.sessionId,
    resolveWindowTokens: props.resolveWindowTokens,
    apiRef,
    notifyRef,
    attachmentsRef,
  });

  // A pending ask parks the loop until the PermissionPrompt resolves it. M33
  // §1: the answer is the y/a/N menu's; the raw tool input rides along so the
  // App can derive the path-scoped allowlist rule for an `a` answer — and so
  // a runtime-policy write (settings/mcp.json) can degrade to plain y/N.
  // design 70 §4: askReviewModelRef lives in useSessionModel (app-model.ts).
  const onPermissionAsk = useCallback(
    async (
      toolName: string,
      summary: string,
      input: Record<string, unknown>,
      ctx?: { readonly sidecarReason?: string; readonly askDigest?: string; readonly askReview?: string; readonly spoof?: import("@wudao/core").SpoofInspection },
    ): Promise<AskAnswer> => {
      const settingsFile = protectedSettingsFile(toolName, input);
      // M37 §3: a high-risk git shell upgrades the ask (never blocks).
      // 夜移 010: credential material outranks it (parity with the REPL gate).
      const warning = credentialAskWarning(toolName, input) ?? gitRiskAskWarning(toolName, input, workspaceRoot);
      const sidecar = ctx?.sidecarReason;
      // ω-4e debt retired here: the asker digest — the driver relays its own
      // copy when it routed this ask; the subagentGate path (TUI children,
      // which bypass the driver) computes it fresh from the live ALS context.
      // Undefined on top-level asks — byte-identical rendering.
      const digest = ctx?.askDigest ?? askDigestPrefix();
      // design 70: the advisory review line below the digest. Never
      // recomputed when the driver relayed a digest (it already ran this
      // ask's trigger matrix — a re-run would double-spend the model call);
      // driver-bypassing child asks compute here. Fail-closed: undefined →
      // the prompt renders exactly as before.
      const review = await askReviewIntroForRelay(ctx, askReviewModelRef.current, toolName, input);
      // ω99-318: the visual-spoof inspection — same relay-or-fresh pattern as
      // the digest (the driver computed it when it routed this ask; the
      // subagentGate bypass path computes here from the same core tables).
      // Null on clean input → no new key → byte-identical rendering.
      const spoof = ctx?.spoof ?? inspectToolInput(input);
      return new Promise<AskAnswer>((resolve) => {
        setAsk({
          toolName,
          summary,
          input,
          ...(settingsFile !== undefined ? { settingsFile } : {}),
          ...(warning !== undefined ? { warning } : {}),
          ...(sidecar !== undefined ? { sidecar } : {}),
          ...(digest !== undefined ? { askDigest: digest } : {}),
          ...(review !== undefined ? { askReview: review } : {}),
          ...(spoof !== null ? { spoof } : {}),
          resolve,
        });
      });
    },
    [workspaceRoot],
  );

  // M34 §1: the ask_user seam — park the question in state; AskUserPrompt
  // resolves it (numbered pick / free text) or rejects (dismiss). A timer
  // matching the tool's own timeout cleans the UI up if the user never
  // answers (the tool's race already decided the tool result by then).
  const onAskUser = useCallback(
    (question: string, options?: readonly AskUserOption[]) =>
      new Promise<string>((resolve, reject) => {
        const pending: PendingAskUser = { question, ...(options !== undefined ? { options } : {}), resolve, reject };
        setAskUserPending(pending);
        const timer = setTimeout(() => {
          setAskUserPending((cur) => (cur === pending ? null : cur));
          reject(new Error("user did not answer in time"));
        }, ASK_USER_TIMEOUT_MS);
        timer.unref?.();
      }),
    [],
  );

  // M27: the skills manifest rides the prompt tail only when the model has a
  // read tool to act on it (props.tools stubs the full set, which always has
  // read_file unless a test says otherwise). A3: these flow through the live
  // extension overlay — a rescan swaps them without a restart.
  const skills = extLive?.skills ?? props.skills ?? [];
  const pluginCommands = extLive?.pluginCommands ?? props.pluginCommands ?? [];
  const pluginAgents = extLive?.pluginAgents ?? props.pluginAgents;
  const liveHooks = extLive?.hooks ?? hooks;
  const hasReadTool = props.tools ? props.tools.some((t) => t.name === "read_file") : true;
  const hasMcpTools = (props.extraTools ?? []).some((t) => t.name.startsWith("mcp__"));
  // ω99-241: #7 — the computer strategy section rides the prompt iff the
  // session's tool set carries the computer octet (session-static like
  // hasReadTool; the rescan below reuses this same flag). computer_click
  // probes the octet: it mounts as a unit (tools.ts, zero-config top-level
  // only). No explicit tools prop → the standard builtin set, which includes
  // the octet.
  const hasComputerTools = props.tools ? props.tools.some((t) => t.name === "computer_click") : true;
  // M42 §2: the slash-command registry (builtin + skills + plugins +
  // extensions) — the suggestion menu's single data source.
  const slashCommands = useMemo(
    () => [
      ...listSlashCommands({
        skills,
        pluginCommands,
        extensionCommands: props.extensions?.commands ?? [],
      }),
      // ω99-59: /find is TUI-owned (intercepted below, before the shared
      // parseReplCommand routing), so its menu entry rides the TUI's own
      // aggregation — the REPL never advertises a name it does not route.
      FIND_COMMAND_INFO,
      RECALL_COMMAND_INFO,
      RESTACK_COMMAND_INFO,
      BG_COMMAND_INFO,
    ],
    [skills, pluginCommands, props.extensions],
  );
  const systemPrompt = useMemo(
    () => buildSystemPrompt(workspaceRoot, (props.extraTools ?? []).some((t) => t.name.startsWith("mcp__")), hasReadTool ? skills : [], props.peer !== undefined && props.peer.refusal === undefined, hasComputerTools),
    [workspaceRoot, props.extraTools, hasReadTool, skills, hasComputerTools],
  );

  // cc-plugins A3: the rescanExtensions() swap sink. Two halves on purpose:
  // React state (above) re-derives the menus/prompt/opts the next render
  // feeds setOptions, and driver.replaceExtensions lands the rebuilt prompt
  // on the DRIVER's state — the half setOptions can never do. Busy runs park
  // inside the driver; the swap lands at run settle.
  useEffect(
    () =>
      registerExtensionSwapSink((fresh) => {
        setExtLive({
          skills: fresh.skills,
          pluginCommands: fresh.pluginCommands,
          pluginAgents: fresh.pluginAgents,
          hooks: fresh.hooks,
        });
        apiRef.current?.driver.replaceExtensions({
          skills: fresh.skills,
          pluginCommands: fresh.pluginCommands,
          ...(fresh.pluginAgents.length > 0 ? { pluginAgents: fresh.pluginAgents } : {}),
          ...(fresh.hooks !== undefined ? { hooks: fresh.hooks } : {}),
          systemPrompt: buildSystemPrompt(workspaceRoot, (props.extraTools ?? []).some((t) => t.name.startsWith("mcp__")), hasReadTool ? fresh.skills : [], props.peer !== undefined && props.peer.refusal === undefined, hasComputerTools),
        });
      }),
    // The session-static facts (workspaceRoot, hasMcpTools, hasReadTool) are
    // captured once — the cache invariant depends on them never shifting.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  // 拆分运动 C：权限闸簇外提至 app-permissions.ts（usePermissionStack）。
  const { allowlistRef, watcherRef, richDecide, modeGate, subagentGate } = usePermissionStack({
    workspaceRoot,
    apiRef,
    notifyRef,
    initialMode,
    liveHooks,
    onPermissionAsk,
    sidecar: props.sidecar,
    webAllowDomains: props.webAllowDomains,
    trustSuppressed: props.trustSuppressed,
  });

  // Subagent activity reaches the history through the same notify seam the App
  // uses (dim notice lines). Ref indirection because the tools memo below runs
  const onSubagentEvent = useCallback((e: LoopEvent): void => {
    if (e.type === "tool_call_started") {
      notifyRef.current(`  ↳ subagent 🔧 ${e.toolName}: ${summarizeToolCall(e.toolName, e.input)}`);
    } else if (e.type === "tool_call_finished") {
      const preview = truncate(e.result, 200);
      notifyRef.current(`  ↳ subagent ↳ ${e.isError ? "[error] " : ""}${preview}`);
    }
  }, []);

  // M24: the tool set's probe/fork closures read the AgentState through this
  // handle at execution time (the state is created later, inside useAgent).
  const stateHandle = useRef<{ state?: import("@wudao/core").AgentState }>({});
  const spillDir = useMemo(() => join(workspaceRoot, ".wudao", "spill", sessionId), [workspaceRoot, sessionId]);
  // ω-4d: one login-shell snapshot provider per TUI session, keyed on the
  // workspace (stable identity — the buildToolSet memo below re-runs on
  // model/gate swaps WITHOUT re-capturing; the provider memoizes anyway).
  // undefined (kill switch / no $SHELL / unsupported shell) spreads nothing.
  const loginShellEnv = useMemo(() => maybeLoginShellEnv(workspaceRoot), [workspaceRoot]);
  // M37 §2: the session's file history — one per session id (rotates with
  // /clear), shared between the tool set (snapshots) and /rewind. The ref
  // keeps the /rewind handler on the CURRENT session's instance.
  const fileHistory = useMemo<FileHistory>(
    () => props.fileHistory ?? createFileHistory(join(workspaceRoot, ".wudao", "history", sessionId)),
    [props.fileHistory, workspaceRoot, sessionId],
  );
  // 夜移 032 stage-2: the session's net-change tracker — one instance for
  // the whole session (path-agnostic, so no /clear rotation), shared by the
  // tool set below and the driver opts (the fileHistory pattern minus the
  // path dependency).
  const turnDiff = useMemo<TurnDiffTracker>(
    () => props.turnDiff ?? createTurnDiffTracker(),
    [props.turnDiff],
  );
  // ω99-314: the workspace-global snapshot store — root-keyed (NOT session-
  // keyed, unlike fileHistory; content-addressed dedup makes sharing free).
  const snapshots = useMemo(() => createSnapshotStore(workspaceRoot), [workspaceRoot]);
  // ω99-82: the session's subagent-delta box (the session-engine shape —
  // stateHandle's single-slot object): the DRIVER arms box.sink at run start
  // and clears it at the run's finally seam (AgentDriverOptions below); the
  // task tool's loopOptions forward every child's identified delta (core
  // ω99-76, `sub:<childIdentity>:<rawId>`) onto it (tools.ts). ONE instance
  // for the session's whole life, held in a ref (the stateHandle rule — a
  // per-render rebuild would orphan an armed sink mid-run and drop every
  // child delta after the first re-render); injected into BOTH the tool set
  // memo and the useAgent opts below (the same instance, two seams).
  const subagentUpdateBox = useRef<{ sink?: (delta: import("@wudao/core").IdentifiedOutputDelta) => void }>({});
  // ω99-87 (86 主弧的 TUI 接线): the session's live-effort box — the READ
  // seam of the box below's write seam (82 同形复刻, the TUI-lane closing
  // pattern's third application: 79 主弧→82 TUI, 86 主弧→87 here). The
  // DRIVER arms box.get = () => modelLive.effort at run start (cleared at
  // the run's finally seam) and the task tool reads it AT SPAWN, so a child
  // dispatched mid-run carries the parent's live /effort level as its
  // effortSent trail (ω99-53). ONE instance for the session's whole life in
  // a ref (the stateHandle rule — a per-render rebuild would hand the task
  // tool a getter the driver never arms, silently dropping the child's
  // trail back to the session baseline); injected into BOTH the tool set
  // memo and the useAgent opts below (the same instance, two seams).
  const effortLiveBox = useRef<{ get?: () => string | undefined }>({});
  // M64-C §C: the LAZY team runtime — nothing exists until the model's
  // first `teammate:` spawn. One team per session (the runtime enforces
  // it); the task-tool seam resolves the LIVE task tool per spawn (the
  // cycle-breaker); effort inherits (/effort switches apply), the model
  // does NOT (frozen at team start).
  // m64c-fix-1: the team lives in `useState` (not `useRef`) so the panel-
  // tick effect's dep array flips from `false` to `true` when the first
  // teammate spawns — without this, `[teamPanelTick === 0]` was always
  // false, the effect ran once at mount (no team yet) → bailed, and never
  // re-ran; idle-row hide-after-30s never fired in the running TUI.
  const [team, setTeam] = useState<TeamRuntime | null>(null);
  // m64c-fix-2: IDENTITY lives in a ref, not in the closure. A run snapshots
  // its tool set at start, so a `getTeam` that reads the `team` STATE sees
  // `null` for the whole first run — a second teammate spawned in that SAME
  // run would create a second runtime and orphan the first (the panel, which
  // reads state, follows the newest runtime and the earlier teammates
  // vanish). The ref is read at CALL time: every caller — stale snapshot or
  // fresh render — resolves the one live runtime.
  const teamRef = useRef<TeamRuntime | null>(null);
  const teamName = props.teamName ?? "default";
  const getTeam = useCallback((): TeamRuntime => {
    const existing = teamRef.current;
    if (existing !== null) return existing;
    const created = createTeamRuntime({
      workspaceRoot,
      team: teamName,
      sessionId,
      model,
      tools: [],
      taskTool: () => toolsRef.current.find((t) => t.name === "task"),
      canUseTool: subagentGate,
      resolveModel,
      effort: () => config.reasoningEffort,
      hooks,
      notify: (line) => notifyRef.current(line),
    });
    teamRef.current = created;
    setTeam(created); // schedules a re-render; the panel mounts the next tick
    return created;
  }, [workspaceRoot, teamName, sessionId, model, subagentGate, resolveModel, config.reasoningEffort, hooks]);
  const toolsRef = useRef<readonly Tool[]>([]);
  // The panel's clock: a slow tick re-renders so idle rows can hide (the
  // panel itself is derived state, not animated). Started when (and only
  // when) the team runtime exists — a fresh mount has no team yet.
  const [teamPanelTick, setTeamPanelTick] = useState(Date.now());
  useEffect(() => {
    if (team === null) return undefined;
    const t = setInterval(() => setTeamPanelTick(Date.now()), 5_000);
    return () => clearInterval(t);
  }, [team !== null]);

  const tools = useMemo<Tool[]>(
    () => [...(props.tools ? props.tools : buildToolSet({
      workspaceRoot,
      model,
      canUseTool: subagentGate,
      // §7: the LIVE window (state — follows /model and /provider switches).
      contextWindowTokens: liveWindowTokens,
      onSubagentEvent,
      spillDir,
      ...(loginShellEnv !== undefined ? { loginShellEnv } : {}),
      turnDiff,
      // ω99-82: the subagent-delta box (the task tool forwards child deltas
      // onto it; the driver arms the SAME instance's sink at run start — the
      // session-engine isomorph, tools.ts :520).
      subagentUpdateBox: subagentUpdateBox.current,
      // ω99-87: the live-effort box (the task tool reads it at spawn; the
      // driver arms the SAME instance's getter at run start — 86's seam, the
      // TUI lane joining the session-engine isomorph).
      effortLiveBox: effortLiveBox.current,
      history: fileHistory,
      contextProbe: () => stateHandle.current.state?.messages ?? [],
      getForkContext: () => stateHandle.current.state,
      getSystemPrompt: () => stateHandle.current.state?.systemPrompt ?? "",
      // 125 项 2（codex get_context_remaining 形）：水位线查询工具的触发线
      // 缝——live 窗口（state）+ live config 的 ratio/headroom/reserve（项 1
      // 装配缝），/model //provider 切换后的下一次查询自然生效。
      contextRemaining: {
        getThreshold: () => ({
          windowTokens: liveWindowTokens,
          ...compactionThresholdFields(liveConfigRef.current, props.compactionSettings ?? DEFAULT_COMPACTION_SETTINGS),
        }),
      },
      ...(props.sandbox ? { sandbox: props.sandbox } : {}),
      ...(props.readState ? { readState: props.readState } : {}),
      ...(props.web !== undefined ? { web: props.web } : {}),
      // M49 §1: the memory store rides the tool set (write+search at top
      // level; the task tool's child sets draw memory_search only).
      ...(memoryStore !== undefined ? { memory: { store: memoryStore } } : {}),
      // M30 orchestration: the shared registry + per-session model overrides.
      // M31 §1: overlap warnings surface as dim notice lines (notifyRef is
      // assigned below; the closure only fires mid-run, after render).
      agents: {
        registry: agentsRegistry,
        runId: sessionId,
        resolveModel,
        defaultEffort: config.reasoningEffort ?? "off",
        onNotice: (text: string) => notifyRef.current(text),
        // M40 §2: plugin agents join the roster between builtins and workspace.
        ...(pluginAgents !== undefined ? { pluginAgents } : {}),
        // M63-B: the SubagentStart/Stop faces ride the task tool.
        ...(liveHooks !== undefined ? { hooks: liveHooks } : {}),
        // M63-C R1: the fire-runtime view rides the subagent position.
        ...(props.hookRuntime !== undefined ? { hookRuntime: props.hookRuntime } : {}),
        // M64-C §C: named subagents become teammates (lazy).
        teams: { getTeam },
      },
      // M64-A §A: list_agents + send_message at a fixed position.
      ...(props.peer !== undefined ? { peer: props.peer } : {}),
      // 夜移 029: the session's skills — threshold-gated discover_skills
      // (same live list the prompt manifest rides; a rescan swap rebuilds).
      ...(skills.length > 0 ? { skills } : {}),
    })), ...(props.extraTools ?? []),
    // M34 §1: ask_user rides the TOP-LEVEL set only (appended OUTSIDE the
    // pool the task tool draws child sets from). The TUI is interactive by
    // construction, so the seam is always wired.
    createAskUserTool({ askUser: onAskUser })],
    // m64c-fix-2: getTeam is in deps for completeness — with the runtime's
    // identity in a ref, getTeam's own deps no longer include the team state,
    // so its identity is stable across spawns and this dep rarely fires; when
    // it does (model/gate swap), the rebuilt set still resolves the ONE live
    // runtime through the ref.
    [props.tools, props.extraTools, pluginAgents, workspaceRoot, model, subagentGate, liveWindowTokens, onSubagentEvent, props.sandbox, spillDir, loginShellEnv, fileHistory, turnDiff, agentsRegistry, sessionId, resolveModel, config.reasoningEffort, props.readState, onAskUser, memoryStore, getTeam, skills],
  );
  toolsRef.current = tools;

  // 拆分运动 C：持久化回调簇外提至 app-persist.ts（usePersistCallbacks）。
  const { onCompacted, onCompactBoundary, onUserTurn, onRunComplete, onBeforeToolDispatch, onDeferLoaded, onHistoryReplaced, onSessionCleared } = usePersistCallbacks({
    storeRef,
    sessionRef,
    loadedRef,
    searchIndexRef,
    memoryRuntime,
    notifyRef,
    setDeferredLoaded,
    setSessionId,
    setSessionName,
    allowlistRef,
    trackedModelRef,
  });

  const api = useAgent(buildAgentOptions({
    props,
    workspaceRoot,
    setSessionName,
    model,
    tools,
    systemPrompt,
    modeGate,
    sessionId,
    skills,
    pluginCommands,
    pluginAgents,
    fileHistory,
    turnDiff,
    snapshots,
    sessionName,
    subagentUpdateBox,
    effortLiveBox,
    mandatoryRepairArmedRef,
    softWarnSlotRef,
    loadedRef,
    liveWindowTokens,
    liveConfigRef,
    gatedRuleMatcher,
    gitProbeRef,
    initialMode,
    agentsRegistry,
    memoryRuntime,
    onPermissionAsk,
    onUserTurn,
    onBeforeToolDispatch,
    onRunComplete,
    onCompacted,
    onCompactBoundary,
    onDeferLoaded,
    onHistoryReplaced,
    onSessionCleared,
    stateHandle,
    personaCtxRef,
    keyPoolRef,
    costRegistryRef,
    liveModelMeta,
    onModelSwitch,
    onProviderSwitch,
    liveHooks,
  }));
  apiRef.current = api;
  // 夜移 018 (延迟预取 wudao 适配): the deferred MCP load the caller started
  // before first paint lands HERE — the app is already interactive; the
  // typing window is the warm-init slot (real CC main.tsx:388-411 adapted:
  // the un-blocked boot replaces the warm-init, the seam replaces the
  // arrival). A run already in flight parks them at its settle boundary.
  useEffect(() => {
    if (props.deferredTools === undefined) return;
    let cancelled = false;
    void props.deferredTools.then(
      (tools) => { if (!cancelled && tools.length > 0) api.driver.addTools(tools); },
      () => { /* MCP load failed — mcpWarn already reported the server */ },
    );
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- api.driver is stable (ref-held); props.deferredTools is boot-once.
  }, [props.deferredTools, api.driver]);
  // 0.3.15（用户需求：执行过程耗时可见）：busy 时状态栏的活秒表。客户端节拍
  // （与 web 同律：1s 起表、1s 一跳——静默思考回合时间也在走，statusline 快照
  // 里没有时钟，也不该每秒推快照）。busy 起点记 ref；idle 清零；间隔只在
  // busy 期间存在（快回合零渲染成本）。
  const busySinceRef = useRef<number | null>(null);
  const [busyElapsed, setBusyElapsed] = useState<number | null>(null);
  useEffect(() => {
    if (!api.busy) {
      busySinceRef.current = null;
      setBusyElapsed(null);
      return undefined;
    }
    if (busySinceRef.current === null) busySinceRef.current = Date.now();
    const tick = (): void => setBusyElapsed(Math.floor((Date.now() - (busySinceRef.current ?? Date.now())) / 1000));
    const delay = setTimeout(tick, 1_000);
    const interval = setInterval(tick, 1_000);
    return () => {
      clearTimeout(delay);
      clearInterval(interval);
    };
  }, [api.busy]);
  // M53 §3: the bar renders FROM the driver's statusline snapshot (the same
  // single source `wudao statusline --json` serves).
  const statusline = api.driver.snapshotForStatusline();
  // keep the notify seam in sync after commit (not during render)
  useEffect(() => {
    notifyRef.current = api.notify;
  }, [api.notify]);

  // M35 §3: keybindings — an explicit prop (tests, alternative frontends) or
  // `.wudao/keybindings.json` loaded once at mount (defaults when absent;
  // warnings surface as dim notice lines, never a broken TUI).
  const [keybindings, setKeybindings] = useState<ResolvedKeybindings>(props.keybindings ?? DEFAULT_RESOLVED_KEYBINDINGS);
  useEffect(() => {
    if (props.keybindings !== undefined) return;
    let cancelled = false;
    void loadKeybindings(workspaceRoot, (w) => {
      if (!cancelled) apiRef.current?.notify(`⚠️ ${w}`);
    })
      .then((kb) => {
        if (!cancelled) setKeybindings(kb);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
    // Load once per mount: the file is read at startup, not hot-reloaded (v1).
  }, []);

  // Esc / Ctrl+C while busy → interrupt (aborts the in-flight fetch/tool via
  // the run's AbortSignal, so even a hung network call settles immediately);
  // Ctrl+C idle → exit. M30: interrupting the parent run also cancels every
  // in-flight background agent (spec §B — the parent abort kills all).
  // While a permission ask is pending, the PermissionPrompt owns the keyboard
  // — including Ctrl+C, which it resolves as deny (the run continues as a
  // denied tool); this handler must stand down so it does not also interrupt
  // or exit. M34: same stand-down while an ask_user question is pending
  // (its Esc means "dismiss the question", not "interrupt the run").
  // M35 §3: both branches consult the keybinding registry (app.exit /
  // app.abort; canonical order — exit checked first).
  // M42 §3: app.cycle-mode (shift+tab) is checked FIRST — the reverse-tab
  // sequence must be consumed before any Esc-interrupt interpretation (ink
  // delivers \x1b[Z as tab+shift, and bindingMatches also catches the raw
  // sequence, so it can never fall through to app.abort's escape).
  // M58 §C#6: two Esc presses within 400ms while IDLE run the /rewind last
  // path (M37 checkpoint machinery). The detector is never armed while busy —
  // busy Esc keeps its single-press abort semantics untouched. Review fix
  // (IMPORTANT): it also declines to arm on an Esc that TextInput's
  // suggestion menu just consumed (menu dismissal) — Ink delivers every
  // keypress to all hooks, and the App must not count that press.
  const escPressedAtRef = useRef(0);
  const escResetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const menuOpenRef = useRef(false);
  useEffect(() => {
    // Disarm any pending double-Esc window when the component goes away.
    return () => {
      if (escResetTimerRef.current !== null) clearTimeout(escResetTimerRef.current);
    };
  }, []);
  useInput((input, key) => {
    handleAppKey({ api, apiRef, ask, askUserPending, clearPending, findQuery, keybindings, agentsRegistry, exit, menuOpenRef, escPressedAtRef, escResetTimerRef }, input, key);
  });

  // M30: leaving the TUI cancels any background agents still in flight —
  // their reports would outlive the process otherwise.
  useEffect(() => {
    return () => {
      void agentsRegistry.abortAll();
    };
  }, [agentsRegistry]);

  // M33 §3: load a picked session — same projection the startup resume uses
  // (entries → messages → summary markers → orphan repair), rotated onto the
  // session id/name/loaded-base the persistence layer tracks.
  const loadSession = useCallback(async (id: string, knownName?: string) => {
    const entries = await storeRef.current.loadSessionEntries(id);
    const messages = repairOrphanedToolCalls(applySummaryMarkers(entries.filter((e): e is AgentMessage => "role" in e)));
    loadedRef.current = [...messages];
    sessionRef.current = id;
    setSessionId(id);
    // M35 §2: the loaded session's deferred_loaded count seeds the bar.
    setDeferredLoaded(countEntriesOfType(entries, DEFERRED_LOADED_TYPE));
    apiRef.current?.loadHistory(messages, id);
    try {
      const recorded = await ensureSessionName(storeRef.current, id);
      setSessionName(knownName ?? recorded?.name);
    } catch {
      setSessionName(knownName);
    }
    setResumePicker(null);
    apiRef.current?.notify(`↪ 已恢复 ${id.slice(0, 8)} · ${messages.length} 条消息`); // ω99-166f-iii: #20-孪生（app.test:531 钉读此处；随 driver #20 演进）
  }, []);

  // M42 §4 + ω99-38: the confirmed /clear rides the ROUTED /clear — the
  // driver's M80 rotation surface owns the semantics (wipe + fresh-segment id
  // + clear_boundary seal on the old id's tail + onSessionCleared, where the
  // TUI mirrors its React state and resets the cache wrapper, +
  // onHistoryReplaced, which empties loadedRef). What stays local is the
  // RENDERING-side transaction: the edit draft, the deferred_loaded bar, and
  // the deferred clear receipt — Static is append-only and tracks a
  // rendered-count, so a clear+append in ONE batch lands the notice under the
  // old count and never flushes; the deferred notify lets the emptied list
  // commit first, so the receipt actually renders. The outcome gate keeps the
  // receipt honest: a refused clear (the routed arm's busy check — unreachable
  // behind the confirm dialog, but guarded anyway) already receipted itself.
  const performClear = useCallback((): void => {
    const a = apiRef.current;
    if (!a) return;
    if (a.driver.submit("/clear") !== "cleared") return;
    setEditDraft(null);
    setDeferredLoaded(0);
    const timer = setTimeout(() => {
      // ω99-161: 清空回执中文化（「历史已清空」+159 确认框「开启全新会话」同族，破折号同主行）。
      apiRef.current?.notify("(历史已清空——开启全新会话)");
    }, 0);
    timer.unref?.();
  }, []);

  const onSubmit = useCallback((text: string): void => {
    routeSubmit({
      apiRef,
      exit,
      workspaceRoot,
      resumePicker,
      setResumePicker,
      setFindQuery,
      setClearPending,
      setEditDraft,
      setSessionName,
      sessionName,
      slashCommands,
      pluginCommands,
      extensionCommands: props.extensions?.commands ?? [],
      agentsRegistry,
      loadSession,
      storeRef,
      sessionRef,
      bangContextRef,
      initialMode,
    }, text);
  }, [exit, skills, agentsRegistry, workspaceRoot, resumePicker, loadSession, sessionName, slashCommands]);

  return (
    <Box flexDirection="column">
      {/* ω99-190: #3 */}
      <Text dimColor>{`wudao v${VERSION} · ${modelLabel(liveModelMeta)} · 模式 ${modeLabel(api.mode)} · session ${sessionName !== undefined ? `${sessionName} ` : ""}${sessionId.slice(0, 8)}`}</Text>
      <Static items={[...api.history]}>
        {(entry, index) => (
          <Box key={index} flexDirection="column" marginBottom={ENTRY_GAP_LINES}>
            <HistoryItem entry={entry} />
          </Box>
        )}
      </Static>
      {api.busy && !ask ? <LiveArea live={api.live} queued={api.queued} /> : null}
      {team !== null ? (
      <TeamsPanel
        team={team}
        now={teamPanelTick}
        focused={!api.busy && ask === null && askUserPending === null && api.planBoard === null && findQuery === null}
        onSend={(name, text) => {
          void getTeam().send("lead", name, text);
          notifyRef.current(`↳ sent to teammate ${name}`);
        }}
      />
      ) : null}
      {ask ? (
        <PermissionPrompt
          toolName={ask.toolName}
          summary={ask.summary}
          {...(ask.settingsFile !== undefined ? { settingsFile: ask.settingsFile } : {})}
          {...(ask.warning !== undefined ? { warning: ask.warning } : {})}
          {...(ask.sidecar !== undefined ? { sidecar: ask.sidecar } : {})}
          {...(ask.askDigest !== undefined ? { askDigest: ask.askDigest } : {})}
          {...(ask.askReview !== undefined ? { askReview: ask.askReview } : {})}
          {...(ask.spoof !== undefined ? { spoof: ask.spoof } : {})}
          onChoose={(answer) => {
            // `a` = allow AND record the session allowlist rule (tool, or
            // tool:path-prefix derived from this call's input) — except for a
            // runtime-policy write, where applyAskAnswer yields no rule (an
            // `a` there degrades to allow-once; the prompt already unbinds it).
            // 0.3.14 #1: `p` additionally persists the rule into the project
            // tier (the /permissions lane); the receipt rides notify.
            const { sessionRule, persistentRule } = applyAskAnswer(answer, ask.toolName, ask.input);
            // 夜移 009: shared recording seam — a session-only rule gets its
            // receipt on the same notify channel `p`'s receipt rides.
            const sessionNote = recordAskRules(allowlistRef.current, { sessionRule, persistentRule });
            if (sessionNote !== null) notifyRef.current(sessionNote);
            if (persistentRule !== null) {
              void persistAllowRule(workspaceRoot, persistentRule).then(
                (receipt) => notifyRef.current(receipt),
                (err) => notifyRef.current(`permissions：always-rule 写入失败（${String(err)}）——本会话规则仍然生效`), // ω99-166e-i: #2（TUI notify 臂同 #1 新串，无尾部 \n 结构不变）
              );
            }
            ask.resolve(answer);
            setAsk(null);
          }}
        />
      ) : null}
      {askUserPending ? (
        <AskUserPrompt
          question={askUserPending.question}
          {...(askUserPending.options !== undefined ? { options: askUserPending.options } : {})}
          onAnswer={(answer) => {
            askUserPending.resolve(answer);
            setAskUserPending(null);
          }}
          onDismiss={() => {
            askUserPending.reject(new Error("user dismissed the question"));
            setAskUserPending(null);
          }}
        />
      ) : null}
      {/* ω99-59: the /find result overlay — same slot and ownership as the
          ask overlays. A permission ask / ask_user question takes precedence
          (they unmount the panel; the query survives and the panel returns
          once they resolve). Esc from the panel restores the input row. */}
      {findQuery !== null && ask === null && askUserPending === null ? (
        <FindPanel query={findQuery} history={api.history} onClose={() => setFindQuery(null)} />
      ) : null}
      {/* Input stays live while busy so a submit mid-run steers the in-flight
          run (⏳ steering lines above, injected at the next model call); only
          a permission ask, an ask_user question, the /clear confirmation, or
          the /find overlay takes over. */}
      {!ask && !askUserPending && !clearPending && findQuery === null ? (
        <Box flexDirection="column">
          <TextInput
            onSubmit={onSubmit}
            keybindings={keybindings}
            suggestions={slashCommands}
            history={inputHistory}
            onHistoryChange={setInputHistory}
            menuOpenRef={menuOpenRef}
            {...(editDraft !== null ? { draft: editDraft } : {})}
          />
          <Text dimColor>{HINT}</Text>
        </Box>
      ) : null}
      {clearPending ? (
        <ClearConfirm
          onChoose={(yes) => {
            setClearPending(false);
            if (yes) performClear();
            // ω99-161: 取消回执中文化（与 REPL 侧 stdout 同串）。
            else apiRef.current?.notify("(已取消清空)");
          }}
        />
      ) : null}
      {/* M25-B4: the single bottom status bar replaces the scattered footer
          bits (the old hint-attached cache label and the live-area ▣ line).
          M30: `bg active/spawned` appears once the session spawned any
          background agent. */}
      <StatusBar snapshot={statusline} deferredLoaded={deferredLoaded} busyElapsed={api.busy ? busyElapsed : undefined} />
    </Box>
  );
}

export async function runTui(props: WudaoAppProps): Promise<void> {
  // exitOnCtrlC is disabled: the app intercepts ^C itself (interrupt while
  // busy, exit while idle) via useInput.
  const instance = render(<WudaoApp {...props} />, { exitOnCtrlC: false });
  await instance.waitUntilExit();
}
