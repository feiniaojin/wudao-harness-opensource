// useAgent — the React adapter over AgentDriver (M43-A Task 2). All logic
// lives in the framework-agnostic driver (src/driver/agent-driver.ts); this
// hook subscribes via useSyncExternalStore (status channel + history channel)
// and re-exposes the exact public API the TUI grew up on, so behavior — and
// the tests that pin it — are unchanged. Pure logic (no JSX): the App renders
// history/live and wires onPermissionAsk to the PermissionPrompt component.
import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import { createAgentDriver } from "../driver/agent-driver.js";
import type { AgentDriver, AgentDriverOptions, DriverStatus, HistoryEntry, LiveState, RuleGate } from "../driver/agent-driver.js";
import type { AgentHooks, AgentMessage, AgentState, LoopEvent, ModelClient, ReadStateTable, Tool } from "@wudao-org/core";
import type { AskAnswer } from "../permission.js";
import type { Mode } from "../permission.js";
import type { AgentRegistry } from "../agents/index.js";
import type { LoadedSkill } from "../skills.js";
import type { PluginCommand } from "../plugins.js";

export type { HistoryEntry, LiveState, RuleGate, DriverStatus, PendingPermission, AgentDriverOptions, SubmitOutcome } from "../driver/agent-driver.js";

export interface UseAgentOptions {
  model: ModelClient;
  tools: Tool[];
  systemPrompt: string;
  canUseTool?: RuleGate;
  maxTurns?: number;
  /** ω-long-2 弧 C 续跑：撞 maxTurns 只重置预算窗。缺省由
   *  defaultMaxSlices() 给（无上限）；0 = 关掉切片（退化为硬停）。 */
  maxSlices?: number;
  // Seeds state.messages (resume): identities must match the caller's loaded
  // history so identity-based persistence selection stays correct.
  initialMessages?: AgentMessage[];
  // M25: session id of the resumed history — heads the initial history as the
  // `resumed <id8> · N messages` divider.
  sessionId?: string;
  // Forwarded to runAgentLoop (microcompact + tier-2 compaction thresholds).
  compaction?: AgentDriverOptions["compaction"];
  // M62 §1: forwarded to runAgentLoop — path-gated context rules.
  contextRules?: AgentDriverOptions["contextRules"];
  // Forwarded to runAgentLoop — .wudao/settings.json-configured hooks (M19).
  hooks?: AgentHooks;
  // M63-A: the SessionStart source at driver creation ("fork" for
  // --fork-session); absent → derived from initialMessages.
  sessionStartSource?: AgentDriverOptions["sessionStartSource"];
  // M63-C §3: the asyncRewake sink holder.
  rewakeSink?: AgentDriverOptions["rewakeSink"];
  // ω99-82: forwarded to the driver VERBATIM (zero logic — createAgentDriver
  // and setOptions below pass this opts object whole) — the session's
  // subagent-delta box (AgentDriverOptions.subagentUpdateBox, ω99-79's shape:
  // a single-slot object the App owns; the driver arms box.sink at run start
  // and clears it at the run's finally seam; the task tool's loopOptions
  // forward every child's identified delta onto it). The App injects the SAME
  // instance into its tool set — identity-stable across renders by contract.
  // Absent → no key (every other useAgent caller stays byte-identical).
  subagentUpdateBox?: AgentDriverOptions["subagentUpdateBox"];
  // ω99-87: forwarded to the driver VERBATIM (zero logic — the
  //  subagentUpdateBox discipline above) — the session's live-effort box
  //  (AgentDriverOptions.effortLiveBox, ω99-86's shape): the driver arms
  //  box.get = () => modelLive.effort at run start and clears it at the
  //  run's finally seam; the task tool reads it at spawn so a child's
  //  effortSent trail follows the parent's live /effort level. The App
  //  injects the SAME instance into its tool set — identity-stable across
  //  renders by contract. Absent → no key (every other useAgent caller
  //  stays byte-identical).
  effortLiveBox?: AgentDriverOptions["effortLiveBox"];
  // ω99-83: forwarded to the driver VERBATIM (zero logic — createAgentDriver
  // and setOptions below pass this opts object whole, the subagentUpdateBox
  // discipline) — the session's mandatory-reasoning repair holder
  //  (AgentDriverOptions.mandatoryRepairArmed, repl.ts:861's verbatim
  //  shape): the App's model constructions write it via the provider's
  //  onMandatoryRepairApplied callback; the driver's /status reads it (the
  //  ω99-42 reasoning line). Absent → no key, /status bytes unchanged.
  mandatoryRepairArmed?: AgentDriverOptions["mandatoryRepairArmed"];
  // ω99-320: forwarded to the driver VERBATIM (zero logic — the
  //  subagentUpdateBox discipline above) — the session's soft-warn slot
  //  (AgentDriverOptions.softWarnSlot): the App's model constructions carry
  //  slot.forward as the provider's onStreamIdleWarning; the driver arms the
  //  listener at run start (soft-idle count + first-warn live notice) and
  //  clears it at the run's finally seam. Absent → no key, zero behavior
  //  change.
  softWarnSlot?: AgentDriverOptions["softWarnSlot"];
  // M63-C R1: the fire-runtime view + prompt_id box.
  hookRuntime?: AgentDriverOptions["hookRuntime"];
  // M64-A §A: the peer-messaging runtime (steering delivery + hold dialog +
  // dispose-time socket teardown ride the driver).
  peer?: AgentDriverOptions["peer"];
  promptIdBox?: AgentDriverOptions["promptIdBox"];
  sessionIdBox?: AgentDriverOptions["sessionIdBox"];
  hookWarnSink?: AgentDriverOptions["hookWarnSink"];
  // P1-5 (96 队列): boot notices → the driver's history at construction.
  bootNotices?: AgentDriverOptions["bootNotices"];
  // Forwarded to runAgentLoop — M23 long-task stop gates (todo/verify).
  gates?: AgentDriverOptions["gates"];
  // Fired once when a run settles (complete, interrupted, or failed) with the
  // final state.messages — the App persists the new tail from here.
  onRunComplete?: (messages: readonly AgentMessage[]) => void;
  /** 夜移 017 (#31): forwarded to the driver — fired right after the user's
   *  own turn lands in state (before the first model call); the App persists
   *  it to the session JSONL immediately (crash-safety for the prompt). */
  onUserTurn?: AgentDriverOptions["onUserTurn"];
  /** 波次8 #45 (dsh session-checkpoint-policy): forwarded to the driver —
   *  fired once per tool-carrying turn AFTER the assistant(tool_use) lands in
   *  state and BEFORE any tool body runs; the App persists the ordered prefix
   *  here. A rejection fails closed at the loop (no tool body runs — the model
   *  sees PERSIST_FAILED_TOOL_RESULT). */
  onBeforeToolDispatch?: AgentDriverOptions["onBeforeToolDispatch"];
  /** M24: fired once when the AgentState is created, so the App can hand the
   *  tool set's contextProbe / getForkContext closures a live reference. */
  onStateReady?: (state: AgentState) => void;
  /** M58 §C#8: raw loop-event observation, forwarded to the driver verbatim —
   *  the App's git-status prober re-checks its fingerprint at turn_finished
   *  (turn boundaries only, never per keystroke). */
  onEvent?: (event: LoopEvent) => void;
  // Fired when tier-2 compaction freezes a summary marker — the App appends it
  // to the session JSONL immediately (append-only store stays authoritative).
  onCompacted?: (summaryMessage: AgentMessage) => void;
  /** M52 §1: persist the compact_boundary session entry (chain continuation).
   *  125 项 1/项 2: windowIndex/worldState ride as the entry's additive fields. */
  onCompactBoundary?: (info: {
    readonly firstKeptEntryId: string;
    readonly reason: string;
    readonly tier: 0 | 1 | 2 | 3;
    readonly windowIndex?: number;
    readonly worldState?: import("@wudao-org/core").WorldState;
  }) => void;
  // cli log.ts summarizeToolCall
  summarize: (toolName: string, input: Record<string, unknown>) => string;
  // When set, write_file calls diff against the current on-disk content
  // (same containment rules as the real tool). Absent → preview behavior.
  workspaceRoot?: string;
  /** M32: the session's read-state table (the same instance the tool set
   *  uses). Present → each model call probes it for externally changed files
   *  and injects <file_changed> notes through the MetaNote channel. */
  readState?: ReadStateTable;
  // wired to PermissionPrompt by the App. M33 §1: the answer is the y/a/N
  // menu's — `session` means the App already recorded the allowlist rule, and
  // the raw tool input rides along so path-scoped rules can be derived.
  // ω-4e: the optional ctx carries the asker digest when the ask is
  // child-originated (structural widening — backward-compatible; the App's
  // render wiring is the deferred follow-up).
  onPermissionAsk: (
    toolName: string,
    summary: string,
    input: Record<string, unknown>,
    ctx?: { readonly sidecarReason?: string; readonly askDigest?: string; readonly askReview?: string; readonly spoof?: import("@wudao-org/core").SpoofInspection },
  ) => Promise<AskAnswer>;
  /** M35 §1/§2: fired when the run's one load_tools call applied — the App
   *  records a deferred_loaded session entry and bumps the status-bar count. */
  onDeferLoaded?: (names: readonly string[]) => void;
  /** M42 §3 / M43-A: the initial runtime permission mode (the driver owns the
   *  live value from here on; shift+tab cycles it through setMode). */
  mode?: Mode;
  /** M30: the session's background-agent registry (shared with the task tool)
   *  — its counts poll into the status channel's `bg`. */
  agentsRegistry?: AgentRegistry;
  /** M45: the session's sidecar instance — its counters/breaker ride the
   *  status channel and every run start resets its run state. */
  sidecar?: import("../sidecar.js").Sidecar;
  /** M43-A Task 3: the loaded skills — driver-level /skill: routing and the
   *  listSlashCommands() data face. The UNGATED list (the prompt-tail manifest
   *  keeps its own read-tool gate). */
  skills?: readonly LoadedSkill[];
  /** Registered plugin/extension commands (parse routing + the data face). */
  pluginCommands?: readonly PluginCommand[];
  extensionCommands?: readonly { readonly name: string; readonly extension?: string }[];
  /** M37 §2: the session's file history (the SAME instance the tool set wires
   *  into write_file/edit) — drives the driver-level /rewind. */
  fileHistory?: import("@wudao-org/core").FileHistory;
  /** 夜移 032 stage-2: the session's net-change tracker (the SAME instance
   *  the tool set wires into write_file/edit) — the driver resets it at run
   *  start and lands the net-change receipt notice at settle (ahead of the
   *  run-stats receipt). */
  turnDiff?: import("@wudao-org/core").TurnDiffTracker;
  /** ω99-314: 文件级时光机——workspace 全局快照仓（驱动接管写前捕获 +
   *  settle 索引 + fileRevert）。 */
  snapshots?: import("../snapshots.js").SnapshotStore;
  /** M49 §1: bounded auto-recall at run start — forwarded to the driver's
   *  memoryRecall seam (MetaNote channel, projection-only). */
  memoryRecall?: (prompt: string) => string | undefined;
  /** M49 §2: forwarded to the driver — spawn the background memory-review
   *  fork after a successful ≥3-tool-call run (🧠 receipt notice). */
  backgroundReview?: boolean;
  /** M53 §1: forwarded to the driver — fired when /switch replaces the
   * conversation wholesale, so the persistence base follows the new chain. */
  onHistoryReplaced?: AgentDriverOptions["onHistoryReplaced"];
  /** ω99-38: forwarded to the driver — fired when the ROUTED /clear rotated
   *  the session (M80's onSessionCleared seam). The App mirrors the fresh id
   *  into its React state, seals the old id's JSONL with a clear_boundary
   *  (the App owns the store — the driver holds none here), and resets its
   *  cache-tracking wrapper at the same seam (ω99-34's rotate()). */
  onSessionCleared?: AgentDriverOptions["onSessionCleared"];
  /** M53 §3: forwarded to the driver — identity meta for the statusline
   *  snapshot (model label, provider, session name, version). M56 §1: `keys`
   *  adds the pool's `keys n/m` segment. */
  statusline?: AgentDriverOptions["statusline"];
  /** M56 §3: forwarded to the driver — the session's cost registry (/cost's
   *  `$` summary + the unpriced≠free note). */
  costRegistry?: AgentDriverOptions["costRegistry"];
  /** M55 §A2: forwarded to the driver — /status display labels. M55 §B7:
   *  `effort` joins the labels (the /effort current marker). */
  sessionMeta?: { readonly provider?: string; readonly model?: string; readonly effort?: string };
  /** M55 §A4: forwarded to the driver — fires after a successful /rename
   *  (the App refreshes its header's session name). */
  onSessionRenamed?: (name: string) => void;
  /** M55 §B7: forwarded to the driver — the /model //effort switch seam
   *  (apply to the live provider config + refresh labels). */
  onModelSwitch?: AgentDriverOptions["onModelSwitch"];
  /** M63 §A: forwarded to the driver — the /provider switch seam (pure
   *  resolve + deferred client build; see AgentDriverOptions). */
  onProviderSwitch?: AgentDriverOptions["onProviderSwitch"];
  /** SDD 2026-08-23 persona: forwarded to the driver — the /persona seam
   *  (registry + runtime + chain/wire live views; see DriverPersonaContext).
   *  The app passes ONE identity-stable object; the driver installs
   *  clearManualLayer onto it at creation. */
  persona?: AgentDriverOptions["persona"];
  /** M55 §B12: forwarded to the driver — the plugin agent layer (/agents). */
  pluginAgents?: AgentDriverOptions["pluginAgents"];
  /** M59 §3: forwarded to the driver — the /doctor web node (search
   *  provider state; routedSubmit is sync so it rides as data). */
  webDoctor?: AgentDriverOptions["webDoctor"];
}

export interface UseAgentResult {
  history: readonly HistoryEntry[];
  live: LiveState;
  busy: boolean;
  /** M23: the last board's N/M (the ▣ progress source); null before any board. */
  boardProgress: { done: number; total: number } | null;
  /** M25 §A5: context watermark — occupancy vs the configured window, refreshed
   *  at every model-call boundary and usage event. used mirrors the loop's own
   *  occupancy measure (max(estimate, last usage.promptTokens) — the real
   *  number beats the estimate once the provider reported one); nearLimit flips
   *  at ≥ 0.8×window (the same threshold the compaction trigger uses). Null
   *  before the first model call of the session. */
  ctxTokens: { used: number | null; window: number; nearLimit: boolean } | null;
  // Steering queue: submits while busy are injected into the in-flight run at
  // the next model-call boundary (M18). A steer that lands after the final
  // model call falls back to the M14 auto-start (new run) at run end.
  // Snapshot state so React re-renders on change.
  queued: readonly string[];
  /** M37 §1: `opts.plan` runs THIS submission in plan mode — the read-only
   *  whitelist rides the permission gate and the plan gate rides the stop
   *  gates (a stop is legitimate once a todo board exists). Absent → normal.
   *  M43-A Task 3: the call routes through the driver's seam (commands,
   *  plan review, @-mentions); `expand: false` submits a pre-built envelope
   *  verbatim (plugin/extension invocations). */
  submit: (text: string, opts?: { readonly plan?: boolean; readonly expand?: boolean }) => void;
  interrupt: () => void;
  clear: () => void;
  /** M33 §3: swap the whole conversation (the /resume picker's load): seeds
   *  state.messages with the resumed history, resets the render-side history
   *  to the resumed index projection, and zeroes the watermarks. Idle-only —
   *  the App guards busy runs before calling. */
  loadHistory: (messages: readonly AgentMessage[], sessionId: string) => void;
  // App-level notice (help text, /clear feedback) appended to history.
  notify: (text: string) => void;
  /** M37 §2: queue a system-class note for the MODEL — it rides the loop's
   *  MetaNote channel at the next model call (projection-only: the persisted
   *  history stays clean). Used by /rewind's files-rewound notice. */
  pushMetaNote: (text: string) => void;
  /** M42 §3 / M43-A: the runtime permission mode (the driver owns it; the
   *  status bar renders this and the permission gate reads getMode()). */
  mode: Mode;
  setMode: (mode: Mode) => void;
  /** Live mode read for the permission gate (never a startup snapshot). */
  getMode: () => Mode;
  /** M24: the cache-tracking model reports the session-cumulative hit percent
   *  (rounded; null under the noise floor) — the status-bar `cache N%` source. */
  setCachePercent: (percent: number | null) => void;
  cachePercent: number | null;
  /** M30: background-agent counts (status-bar `bg active/spawned` source). */
  bg: { active: number; spawned: number };
  /** M45: the sidecar's run state (status-bar `sidecar N` / breaker `🛡✕`
   *  source); null when this session has no sidecar. */
  sidecar: { checks: number; breakerOpen: boolean } | null;
  /** M37 §1 / M43-A: the plan board awaiting review (the driver routes `ok` /
   *  `改 …` review inputs while this is set; the TUI also consults it to skip
   *  session-naming side effects for a consumed review input). */
  planBoard: string | null;
  /** Submit through the driver's routing seam (see AgentDriver.submit). */
  submitRouted: AgentDriver["submit"];
  /** The /resume picker's data face (driver-level sessions()). */
  sessions: AgentDriver["sessions"];
  /** Driver-level session load (the /resume picker's engine). */
  resume: AgentDriver["resume"];
  /** Rotate the driver's session id (the /clear + fresh-id convention). */
  setSessionId: (sessionId: string) => void;
  /** The underlying driver (escape hatch for non-React seams). */
  driver: AgentDriver;
}

export function useAgent(opts: UseAgentOptions): UseAgentResult {
  // The driver is the single owner of run/state logic; React holds it in a ref
  // (stable identity across renders) and re-reads immutable snapshots below.
  const driverRef = useRef<AgentDriver | null>(null);
  if (driverRef.current === null) {
    driverRef.current = createAgentDriver(opts);
  }
  const driver = driverRef.current;

  // Latest-opts refresh (the old optsRef): a run reads model/gates/hooks at
  // ITS start, so mid-session swaps take effect on the next submit.
  driver.setOptions(opts);

  // Two channels, two useSyncExternalStore subscriptions: the status snapshot
  // is rebuilt only on change (reference equality holds between changes), the
  // history array only on append/clear/load — deltas never reship history.
  const subscribeStatus = useCallback((cb: () => void) => driver.subscribe(cb), [driver]);
  const subscribeHistory = useCallback((cb: () => void) => driver.onHistory(() => cb()), [driver]);
  const status: DriverStatus = useSyncExternalStore(subscribeStatus, driver.getStatus, driver.getStatus);
  const history: readonly HistoryEntry[] = useSyncExternalStore(subscribeHistory, driver.getHistory, driver.getHistory);

  // Unmount cleanup: flip the driver inactive and unwind the in-flight run so
  // a late tool resolution can neither notify a dead tree nor leak an
  // unhandled rejection. The flag resets on (re)mount for StrictMode safety.
  useEffect(() => {
    driver.setActive(true);
    return () => {
      driver.setActive(false);
    };
  }, [driver]);

  const submit = useCallback(
    (text: string, submitOpts?: { readonly plan?: boolean; readonly expand?: boolean }): void => {
      driver.submit(text, submitOpts);
    },
    [driver],
  );
  const clear = useCallback((): void => {
    driver.clear();
  }, [driver]);
  const loadHistory = useCallback(
    (messages: readonly AgentMessage[], sessionId: string): void => {
      driver.loadHistory(messages, sessionId);
    },
    [driver],
  );
  const notify = useCallback(
    (text: string): void => {
      driver.notify(text);
    },
    [driver],
  );

  return {
    history,
    live: status.live,
    busy: status.busy,
    queued: status.queued,
    boardProgress: status.boardProgress,
    ctxTokens: status.ctxTokens,
    submit,
    interrupt: driver.interrupt,
    clear,
    loadHistory,
    notify,
    pushMetaNote: driver.pushMetaNote,
    mode: status.mode,
    setMode: driver.setMode,
    getMode: driver.getMode,
    setCachePercent: driver.setCachePercent,
    cachePercent: status.cachePercent,
    bg: status.bg,
    sidecar: status.sidecar,
    planBoard: status.planBoard,
    submitRouted: driver.submit,
    sessions: driver.sessions,
    resume: driver.resume,
    setSessionId: driver.setSessionId,
    driver,
  };
}
