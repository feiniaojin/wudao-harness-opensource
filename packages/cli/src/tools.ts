// Shared tool-set builder for all frontends (one-shot CLI, readline REPL, Ink
// TUI). Extracted from index.ts so the TUI builds the exact same tool surface
// without an import cycle.
import {
  createCronTools,
  createMonitorTools,
  createReadFileTool,
  createWriteFileTool,
  createEditTool,
  createShellTool,
  createRunScriptTool,
  createPythonKernelTool,
  createGlobTool,
  createGrepTool,
  createTodoTool,
  createSleepTool,
  createNotebookTool,
  createParentMessageTool,
  createMessageChildTool,
  createReadStateTable,
  createCtxInspectTool,
  createContextRemainingTool,
  createSessionResultTool,
  createSearchHistoryTool,
  createNotesTools,
  createNewContextTool,
  createWebFetchTool,
  createWebSearchTool,
  resolveWorkspacePath,
  toModelToolDefinition,
  createPendingWriteGate,
  type AgentMessage,
  type FileHistory,
  type IdentifiedOutputDelta,
  type TurnDiffTracker,
  type ForkContext,
  type LoopEvent,
  type ModelClient,
  type PermissionDecision,
  type LongOutputConfig,
  type LogSlimmingPorts,
  type ReadStateTable,
  type Tool,
  type WebFetchOptions,
  type WebSearchConfig,
  type WriteVerifyConfig,
  type DiagnosticsLayer,
  type CronTask,
  type MonitorRegistry,
} from "@wudao/core";
// ω99-112: the browser sextet (static import is deliberate — this module is
// tiny; the heavy playwright-core driver sits behind the runtime's dynamic
// import and never enters this graph).
import { browserToolsFor } from "@wudao/browser";
import { createAgentsTaskTool, createRegistryTools, createSessionRegistry, firstHandWorkProbe } from "./agents/index.js";
import type { AgentRegistry, ModelResolution, ModelOverrides } from "./agents/index.js";
// ω99-57: the parent-side child-mail lane (task tool sink + driver drain).
import type { ChildMailLane } from "./agents/child-mail.js";
// M64-A §A: the peer-messaging pair (list_agents / send_message) — built over
// the session's peer runtime; a fixed tool-array position (session-start
// registration, prefix stability).
import { createPeerTools } from "./peer/tools.js";
import type { PeerRuntime } from "./peer/runtime.js";
import { createMemoryWriteTool, createMemorySearchTool } from "./memory/tools.js";
// 夜移 029: the skill-search scorer + its threshold-gated tool face.
import { createDiscoverSkillsTool, skillSearchEligible } from "./skill-search.js";
import type { LoadedSkill } from "./skills.js";
import { createDiagnosticsLayer } from "./diagnostics.js";
import { createConstitutionSuggestTool } from "./constitution/tools.js";
// ω99-212: the computer octet (screen_capture / computer_type / computer_key /
// computer_click / app_activate / app_list / computer_scroll / computer_drag)
// — macOS 电脑操作面（截屏/打字/按键/点击/切应用/滚轮/拖拽）。纯层在
// computer/exec.ts（注入防线/键码白名单/长文分块/滚动与拖拽 argv 构造）；
// ask 姿态在 permission.ts 的 DEFAULT_ASK_TOOLS。
import { createComputerTools } from "./computer/tools.js";
// ω99-236: #2 — the doc trio (make/read/append/replace × xlsx/docx/pptx, the
// twelve faces) rides its ROSTER module now (src/doc-suite.ts — 单一描述清
// 单: 构造序 + 读册 + 写册 + 回执册 + 摘要器映射). The twelve per-face
// static imports and their comment chain (ω99-123/124/126/221/222/223/228/
// 229/231) migrated there wholesale; this seam consumes the roster with ONE
// construction call, split around the computer octet's historical slot so the
// tool-list bytes are UNCHANGED in the default state (宪法切片 +
// ω99-221..231 邻接钉的命). The settings gate (docSuite.enabled, opt-out —
// misc-config.resolveDocSuiteEnabled → setDocSuiteRuntimeEnabled at boot)
// lives in the roster's constructor head: off → [] (off = 新会话生效).
import { createDocSuiteTools, DOC_SUITE_MAKE_COUNT } from "./doc-suite.js";
import { createScheduleWakeupTool } from "./commands/loop.js";
import type { LoopController } from "./commands/loop.js";
// ω99-118: the page-watch trio (thin shell over the cron runtime).
import { createWatchTools } from "./watch.js";
import type { CronRuntime } from "./cron.js";
// ω99-15: the mission tool quartet (late-bound controller box, same pattern
// as schedule_wakeup above).
import { createMissionTools } from "./mission.js";
import type { MissionController } from "./mission.js";
// ω99-313: the durable schedule trio (schedule_add / schedule_list /
// schedule_remove) over the resident daemon's face.
import { createScheduleTools } from "./schedules.js";
import type { ScheduleToolFace } from "./schedules.js";
// 127 项 1: the cross-session chain handoff tool (continue_task) over the
// same daemon face + the live session id seam.
import { createContinueTaskTool } from "@wudao/core";
// ω99-249: #8 — the goal query tool (late-bound GoalState runtime box).
import { createGoalTools } from "./goal-runtime.js";
import type { GoalRuntime } from "./goal-runtime.js";
import { createContextDoctorTool } from "./context-doctor.js";
import type { ContextDoctorBox } from "./context-doctor.js";
import { createReadSessionTool } from "./read-session.js";
import type { SessionReadBox } from "./read-session.js";
import { createCriticReviewTool } from "@wudao/core";
import { isFeatureAblated } from "./args.js";
import { serializePrompt } from "@wudao/providers";

/** M30 orchestration wiring (optional — omitted keeps a self-sufficient set). */
export interface AgentsTooling {
  /** Shared background registry; created (default 3, ceiling 16) when absent.
   *  Pass one when a frontend needs the same handle for TUI counts/lifecycle. */
  readonly registry?: AgentRegistry;
  /** Session id: namespaces worktree paths and the roster cache. */
  readonly runId?: string;
  /** Resolves task tool provider/model/effort overrides to a child model. */
  readonly resolveModel?: (overrides: ModelOverrides) => ModelResolution;
  /** Session-level reasoning effort — the receipt baseline. */
  readonly defaultEffort?: string;
  /** Registry concurrency (default 3, hard ceiling 16). */
  readonly maxConcurrent?: number;
  /** M31 §1: dim-notice channel for write-scope overlap warnings (TUI). */
  readonly onNotice?: (text: string) => void;
  /** M40 §2: the plugin agent layer for the task tool's roster
   *  (builtin < plugin < workspace). Built by collectPluginAgents. */
  readonly pluginAgents?: readonly import("./agents/core-bind.js").RosterPluginAgent[];
  /** M63-B: the session's hook object — the task tool derives its
   *  SubagentStart/Stop faces from it (children stay otherwise hookless). */
  readonly hooks?: import("@wudao/core").AgentHooks;
  /** M63-C R1: the fire-runtime view — the subagent-position compile is
   *  contract-complete (common fields incl. the live prompt_id, `if` mode
   *  gating, mcp_tool entries, asyncRewake). The view references the
   *  PARENT's session context — the right context for a child-position
   *  hook. */
  readonly hookRuntime?: import("./hooks-config.js").NonNeverRuntime;
  /** M64-C §C: the session's team runtime, LAZY — no team machinery exists
   *  until the model's first `teammate:` spawn; the task tool routes named
   *  subagents there (roster role reuse, mailboxes, plan flow). */
  readonly teams?: { readonly getTeam: () => import("./teams/runtime.js").TeamRuntime };
}

// ---------------------------------------------------------------------------
// M35 §1 — deferred tool loading. The builtin DEFER CANDIDATES are the
// orchestration tools (task / agent_*): big definitions, rarely needed, and
// already excluded from every child set (so children never defer). MCP tools
// are NEVER deferred — they arrive as extraTools from operator config, and
// deferring them would hide operator-provided surface behind a model decision.
// WUDAO_DEFER_TOOLS=off disables the marking entirely → full load (the loop
// then sees no shouldDefer tools and requests are byte-identical to pre-M35).
// ---------------------------------------------------------------------------

export const DEFER_CANDIDATE_TOOL_NAMES: ReadonlySet<string> = new Set([
  "task",
  "agent_await",
  "agent_status",
  "agent_cancel",
]);

// ---------------------------------------------------------------------------
// M62 §6 — defer mode with the AUTO threshold. settings `tools.defer`:
//   "auto" (default) — at startup, estimate the defer candidates' schema
//                      bytes with the canonical serializer (/4 ≈ tokens);
//                      total ≤ 10% of contextWindowTokens → load EVERYTHING
//                      eagerly (skip the load_tools round trip); otherwise
//                      keep deferring.
//   "on"              — always defer (the M35 behavior).
//   "off"             — always eager.
// The WUDAO_DEFER_TOOLS=off env kill switch keeps winning over everything
// (it is the ablation surface; explicit settings "on" does not resurrect
// deferral against the env ablation).
// ---------------------------------------------------------------------------

export type DeferMode = "auto" | "on" | "off";

let sessionDeferMode: DeferMode | undefined;

/** Set the session's tools.defer mode (startup-only, from settings). */
export function setSessionDeferMode(mode: DeferMode | undefined): void {
  sessionDeferMode = mode;
}

/** Resolve the effective mode: settings value (tolerant) under the env
 *  ablation. Pure. */
export function resolveDeferMode(
  settingsValue: unknown,
  env: NodeJS.ProcessEnv = process.env,
): DeferMode {
  if ((env.WUDAO_DEFER_TOOLS ?? "").trim().toLowerCase() === "off") return "off";
  if (settingsValue === "auto" || settingsValue === "on" || settingsValue === "off") {
    return settingsValue;
  }
  return "auto";
}

/** Canonical-serializer bytes of the defer candidates' tool definitions
 *  (the same serialization every byte-prefix assertion uses). Pure. */
export function estimateDeferCandidateBytes(tools: readonly Tool[]): number {
  const candidates = tools.filter((t) => DEFER_CANDIDATE_TOOL_NAMES.has(t.name));
  if (candidates.length === 0) return 0;
  return Buffer.byteLength(
    serializePrompt({ systemPrompt: "", tools: candidates.map(toModelToolDefinition), messages: [] }),
    "utf8",
  );
}

/** The AUTO verdict: defer-candidate schema tokens (bytes / 4) fit within
 *  10% of the context window → eager. Pure. */
export function deferCandidatesFitWindow(tools: readonly Tool[], contextWindowTokens: number): boolean {
  return estimateDeferCandidateBytes(tools) / 4 <= 0.1 * contextWindowTokens;
}

/** The session-resolved defer switch buildToolSet applies: env ablation →
 *  off; unset → on (legacy default); auto → the threshold verdict. */
export function sessionDeferEnabled(tools: readonly Tool[], contextWindowTokens: number, env: NodeJS.ProcessEnv = process.env): boolean {
  if ((env.WUDAO_DEFER_TOOLS ?? "").trim().toLowerCase() === "off") return false;
  const mode = sessionDeferMode ?? "on";
  if (mode === "off") return false;
  if (mode === "on") return true;
  return !deferCandidatesFitWindow(tools, contextWindowTokens);
}

/** M59 §3: the web tool runtime injected into buildToolSet — fetch caps and
 *  the optional search provider config. */
export interface WebToolsRuntime {
  readonly fetch?: Pick<WebFetchOptions, "maxChars" | "allowedPorts">;
  readonly search?: WebSearchConfig;
}

export function deferToolsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.WUDAO_DEFER_TOOLS ?? "").trim().toLowerCase() !== "off";
}

/** Mark the defer candidates with shouldDefer (pure — returns new objects).
 *  The builtin whitelist WINS over buildTool's fail-closed `() => false`
 *  default (per-tool defer policy is deliberately out of scope: candidate
 *  status is a property of the builtin set, not a caller knob). */
export function markDeferCandidates(
  tools: readonly Tool[],
  enabled: boolean = deferToolsEnabled(),
): Tool[] {
  return tools.map((t) =>
    enabled && DEFER_CANDIDATE_TOOL_NAMES.has(t.name)
      ? { ...t, shouldDefer: () => true }
      : t,
  );
}

// Read tools + coding tools + the task (subagent) tool. `canUseTool` gates the
// SUBAGENT's internal tool calls; `onSubagentEvent` is threaded through so each
// frontend can render task-tool events at its own log level.
export function buildToolSet(opts: {
  readonly workspaceRoot: string;
  /** workspace-ux B2: the switchable agent-root box, SHARED with the driver
   *  (AgentDriverOptions.agentRootBox — applyAgentRoot writes it). Present →
   *  the builtin file tools (read_file/glob/grep/write_file/edit), shell,
   *  and run_script's child cwd read the root through it AT EXECUTION TIME, so
   *  an agentRootSwitch re-roots mid-session without rebuilding the tool array
   *  (definitions stay byte-identical — the tool-list prefix, and therefore
   *  the prompt cache, is untouched). Absent → a private box pinned to
   *  workspaceRoot: identical behavior for every existing caller. */
  readonly agentRootBox?: { current: string };
  readonly model: ModelClient;
  readonly canUseTool: (toolName: string, input: Record<string, unknown>) => Promise<PermissionDecision>;
  readonly contextWindowTokens: number;
  readonly onSubagentEvent?: (e: LoopEvent) => void;
  /** ω99-8: every child (subagent) model call's usage → cost attribution.
   *  Observational seam on the task tool (both spawn paths); recorder
   *  failures are isolated, never affect the child. Absent → the task tool's
   *  event lane is untouched (bytes identical). */
  readonly onSubagentUsage?: (info: { readonly childId?: string; readonly model: string; readonly usage: import("@wudao/core").ModelUsage }) => void;
  /** Sandbox shell (M21). Applied to shell ONLY — file tools stay host-side (v1 boundary). */
  readonly sandbox?: { readonly image?: string; readonly dockerPath?: string };
  /** ω99-57: the parent-side child-mail lane. Present → the task tool's
   *  isolated/worktree children draw the global message_parent tool and
   *  their mid-run sends land on this lane (the driver drains it between
   *  the peer and monitor lanes). Absent → children draw no mail tool and
   *  every dispatch stays byte-identical to pre-ω99-57. */
  readonly childMail?: ChildMailLane;
  /** ω99-79: the session's subagent-delta box. The DRIVER arms its sink at
   *  run start (AgentDriverOptions.subagentUpdateBox, cleared at run end);
   *  the task tool's loopOptions forward every child's identified delta
   *  (core ω99-76 namespaces them `sub:<childIdentity>:<rawId>`) onto it.
   *  Absent → the task tool's loopOptions stay byte-identical (no key, no
   *  wrapper) and child deltas stay unobserved. */
  readonly subagentUpdateBox?: { sink?: (delta: IdentifiedOutputDelta) => void };
  /** ω99-86 (53 停泊债清偿): the session's live-effort box — the DRIVER arms
   *  its getter at run start (AgentDriverOptions.effortLiveBox, the ω99-79
   *  subagentUpdateBox discipline) and the task tool reads it AT SPAWN: the
   *  parent's live /effort level becomes the child's effortSent trail
   *  (ω99-53's persistence-only stamp — never a wire field). Absent box or
   *  unarmed slot (idle, or a driver-less frontend) ⇒ no key ⇒ the task
   *  tool's loopOptions stay byte-identical (the documented degradation,
   *  same semantics as 79's idle-spawn deltas). */
  readonly effortLiveBox?: { get?: () => string | undefined };
  /** MCP tools (mcp__*) — appended AFTER the builtin set; NOT handed to the
   *  subagent `task` tool's child set (v1: subagents stay builtin-only). */
  readonly extraTools?: readonly Tool[];
  /** M24 B1: live view of the model-visible messages, so read_file can elide
   *  re-reads whose exact bytes are already in context. Also the M30 pilot
   *  nudge probe (first-hand parent work). */
  readonly contextProbe?: () => readonly AgentMessage[];
  /** M24 B2: parent conversation exposure for shareContext/fork subagents
   *  (undefined while the caller's state is not wired up yet). */
  readonly getForkContext?: () => ForkContext | undefined;
  /** M52 §3: live system-prompt getter — with contextProbe this enables the
   *  ctx_inspect tool (the model seeing its own occupancy). Late-bound: tools
   *  are built before the AgentState exists. */
  readonly getSystemPrompt?: () => string;
  /** 125 项 2（the upstream projectget_context_remaining 形）：上下文水位线查询工具的
   *  触发线输入缝 — present（且 ctx_inspect 的两缝在场）→ 只读的
   *  context_remaining 工具挂进 TOP-LEVEL 集，紧随 ctx_inspect（同族定位，
   *  跨版本一次性冷点）。getThreshold 在调用时重读（live 窗口 + 项 1 的
   *  ratio/headroom/reserve——/model //provider 切换自然生效）。缺省 →
   *  零新表面（子代理集、无驱动前端、测试夹具的字节不变）。 */
  readonly contextRemaining?: {
    readonly getThreshold: () => {
      readonly windowTokens: number;
      readonly thresholdRatio?: number;
      readonly headroomTokens?: number;
      readonly outputReserveTokens?: number;
    };
  };
  /** M24: per-session spill directory for shell outputs truncated past
   *  the inline cap (<root>/.wudao/spill/<sessionId>). */
  readonly spillDir?: string;
  /** ω-4d: the session's login-shell snapshot provider (the frontends build
   *  it with maybeLoginShellEnv(workspaceRoot) beside their spillDir lines).
   *  Rides the TOP-LEVEL shell AND the worktree children's — the same
   *  session, user, and shell, ONE shared capture (the provider memoizes).
   *  Absent → the pre-ω-4d env (every eval site, defaultChildToolsFor, and
   *  non-CLI embedders — the documented boundary). run_script needs nothing:
   *  its inner call() re-enters these same tool instances. */
  readonly loginShellEnv?: () => Promise<Readonly<Record<string, string>> | undefined>;
  /** M30-β: orchestration (roles, background registry). */
  readonly agents?: AgentsTooling;
  /** M32: the session's read-state table — read_file records, edit/write_file
   *  gate fail-closed, and the external-change prober diffs against it. Pass
   *  the SAME instance the frontend hands to the prober; absent → a private
   *  table (freshness still works inside this set, the prober just can't see it). */
  readonly readState?: ReadStateTable;
  /** M37 §2: the session's file history (write_file/edit snapshots) — the
   *  SAME instance the frontend drives /rewind with. Absent → no snapshots.
   *  Rides the TOP-LEVEL coding tools only (worktree children write a
   *  different tree; their changes are git-diffable instead). */
  readonly history?: FileHistory;
  /** 夜移 032 (the upstream projectturn-diff): the per-run net file-change ledger — the
   *  SAME instance the frontend hands to the driver (reset at run start,
   *  receipt at run settle); absent → no ledger, unchanged behavior. Rides
   *  the TOP-LEVEL coding tools only (child sidechains write their own
   *  trees; the upstream projectmerges environments, wudao v1 does not). */
  readonly turnDiff?: TurnDiffTracker;
  /** M46 §1: write-verify config (settings.json writeVerify + env), injected
   *  so core stays settings-unaware. Absent → tools return the pre-M46
   *  results (tests pin that boundary). Rides the TOP-LEVEL coding tools AND
   *  the worktree children (checkers are session-free). */
  readonly writeVerify?: WriteVerifyConfig;
  /** M51 §2: diagnostic baseline-diff layer (new-only lines after the verify
   *  output). Rides wherever writeVerify rides; absent → M46 results. */
  readonly diagnostics?: DiagnosticsLayer;
  /** M46 §2: long-output shaping (settings.json longOutput + env). Rides the
   *  TOP-LEVEL shell only — it needs the per-session spillDir seam the
   *  worktree children don't carry. */
  readonly longOutput?: LongOutputConfig;
  /** 借鉴弧 C1（the upstream project C3）：超长诊断日志的证据保全瘦身端口（廉价档
   *  ModelClient + 可选阈值覆盖）。缺省不注入 = shell 字节同 pre-C1。
   *  Rides the TOP-LEVEL shell only（与 longOutput 同界——需要 spill 缝）。 */
  readonly logSlimming?: LogSlimmingPorts;
  /** 114 取证弧：python_kernel 的会话旋钮（settings pythonKernel 节点，
   * 前端 boot 时解析注入——misc-config.loadPythonKernelSettings）。缺省
   * 缺席 = core 工厂缺省（idle 15min）。 */
  readonly pythonKernel?: { readonly idleTimeoutMs?: number };
  /** M49 §1: the session's memory store. Present → memory_write +
   *  memory_search join the TOP-LEVEL set, and read-only children gain
   *  memory_search (children never write memory). Absent → zero memory
   *  surface (the pre-M49 tool set, tests pin that boundary). */
  readonly memory?: { readonly store: import("./memory/store.js").MemoryStore };
  /** M59 §3: web runtime — fetch caps (maxChars/allowedPorts; the tool itself
   *  is zero-config ALWAYS registered) and the optional search provider
   *  config (present → web_search registered; absent → search stays out of
   *  the tool list). allowDomains lives in the permission gate, not here. */
  readonly web?: WebToolsRuntime;
  /** ω99-112: the session's browser runtime — present → the six browser_*
   *  tools join the TOP-LEVEL set at ONE fixed position (after the web face,
   *  before the scheduler trio; prefix stability), registered at session
   *  start like every builtin so the tool-list prefix stays byte-stable all
   *  session. Absent → zero browser surface (tests pin the byte-identical
   *  boundary). The runtime's construction is zero-IO; playwright-core loads
   *  only inside its default port's launch() (a dynamic import — the heavy
   *  driver never rides this module's static graph). Subagents never see
   *  them (top-level only, v1). */
  readonly browser?: import("@wudao/browser").BrowserRuntime;
  /** ω99-138: the browser_see vision materials — present → the screenshot
   *  sink is injected into browserToolsFor (PNG bytes → the workspace
   *  AttachmentStore → a durable ImageBlock on the tool result, the SAME
   *  channel as `--image`). `modelAcceptsImages` is read AT EVERY
   *  browser_see call (a live getter, so /model switches take effect at call
   *  time): false → the sink declines → browser_see degrades to its honest
   *  text table — one browser_see on a text-only main model must NEVER
   *  poison every later request with a typed image refusal (the arc's #1 UX
   *  trap). Absent → no sink (browser_see's no-channel degradation). */
  readonly browserVision?: {
    readonly store: import("@wudao/core").AttachmentStore;
    readonly modelAcceptsImages: () => boolean;
  };
  /** ω99-212: the computer sextet's vision materials — screen_capture 的图片
   * 附件缝（与 browserVision 同形同纪律：字节只经 AttachmentStore 落
   *  .wudao/attachments；modality 每次调用时读，文本主模型 typed 拒——绝不
   *  给后续请求喂图像拒绝）。缺席 → screen_capture typed 拒（其余五工具
   *  不受影响），REPL 等未接线前端同 browser_see 的无 sink 降级。 */
  readonly computerVision?: {
    readonly store: import("@wudao/core").AttachmentStore;
    readonly modelAcceptsImages: () => boolean;
  };
  /** M61 §1: the session's scheduler runtime — present → the cron_create /
   *  cron_list / cron_delete trio joins the TOP-LEVEL set (session-scoped,
   *  registered at startup like every other builtin, so the tool-list prefix
   *  segment stays byte-stable all session). Absent → zero scheduling
   *  surface (tests pin that boundary). Subagents never see them.
   *  ω99-118: `runtime` (the live CronRuntime itself, carrying createTask)
   *  gates the page-watch trio — and ONLY together with `browser` (a watch
   *  without the browser face can never look; fail-closed absent). The
   *  table-only seam (the pre-118 shape every fixture pins) registers no
   *  watch tools — those bytes stay frozen. */
  readonly cron?: {
    readonly table: { list(): readonly CronTask[]; add(task: CronTask): Promise<void>; remove(id: string): Promise<boolean> };
    readonly sessionId?: string;
    readonly env?: NodeJS.ProcessEnv;
    readonly runtime?: CronRuntime;
  };
  /** ω-4a: the session's monitor runtime — present → the monitor_start /
   *  monitor_list / monitor_stop trio joins the TOP-LEVEL set beside the
   *  scheduler trio (fixed position, registered at session start like every
   *  builtin so the tool-list prefix stays byte-stable). An INERT runtime
   *  (kill switch) still registers the trio — the tools answer with the
   *  refusal (fail-closed; same posture as cron). Subagents never see them. */
  readonly monitor?: {
    readonly registry: MonitorRegistry;
    readonly refusal?: string;
  };
  /** M61 §2: the late-bound /loop controller seam — present → the
   *  schedule_wakeup model tool joins the top-level set (session-start
   *  registration; the dynamic /loop's self-scheduling surface). */
  readonly loop?: { readonly getController: () => LoopController | undefined };
  /** ω99-15: the late-bound mission controller seam — present → the
   *  mission_plan / mission_next / mission_complete / mission_fail quartet
   *  joins the TOP-LEVEL set (session-start registration, fixed position;
   *  the task-campaign surface over the .wudao/mission.json ledger).
   *  Subagents never see them (top-level only, v1). */
  readonly mission?: { readonly getController: () => MissionController | undefined };
  /** ω99-249: the late-bound GoalState runtime seam — present → the
   *  read-only `goal` query tool joins the TOP-LEVEL set at a FIXED position
   *  (tail append after the mission quartet; session-start registration, so
   *  the tool-list prefix stays byte-stable within a session — the new slot
   *  is a declared cross-version cold turn, mission-tools precedent). */
  readonly goalFace?: { readonly getRuntime: () => GoalRuntime | undefined };
  /** 132-P1-2 — context_doctor 的晚绑快照盒（session-engine 在 driver 存在
   *  后回填 get；缺席 = 工具诚实拒答，one-shot/REPL 家族纪律）。 */
  readonly contextDoctor?: ContextDoctorBox;
  /** 123-2 — read_session 的台账读取缝（宿主绑 store；缺席 = 诚实拒答）。
   *  只读白名单——defer 闲时轮可用（同 schedule_list 律）。 */
  readonly sessionRead?: SessionReadBox;
  /** M64-A §A: the session's peer-messaging runtime — present → the
   *  list_agents / send_message pair joins the TOP-LEVEL set at a FIXED
   *  position (after the scheduler trio, before the loop tool), registered at
   *  session start like every builtin so the tool-list prefix stays
   *  byte-stable. An INERT runtime (kill switch / sandbox) still registers
   *  the pair — the tools then answer with the refusal (fail-closed, never a
   *  silent no-op; same posture as the cron trio). Subagents never see them. */
  readonly peer?: PeerRuntime;
  /** ω-2b (I3): the session's persisted-tool-result loader — present → the
   *  read-only `session_result` recovery tool joins the TOP-LEVEL set beside
   *  ctx_inspect (fixed position, session-start registration: the tool-list
   *  prefix stays byte-stable all session). Built by the frontends with
   *  {store, sessionId}. Absent → no recovery surface (tests pin that
   *  boundary). Subagents never see it — sidechains are not searched. */
  readonly sessionResult?: { readonly load: import("@wudao/core").SessionResultLoader };
  /** 121 挖掘 TOP5 #1: the session's conversation-ledger corpus loader —
   *  present → the read-only `search_history` tool joins the TOP-LEVEL set
   *  right after session_result (append-only tail, M24: every earlier tool
   *  keeps its exact bytes and index; the new slot is a declared one-time
   *  cross-version cold turn, never mid-session). Built by the frontends
   *  with {store, live sessionId} over the append-only JSONL — a PURE
   *  BYPASS READ (the RL trajectory exporter's source), zero new persisted
   *  files. Absent → zero surface (tests pin that boundary). Subagents
   *  never see it: a child searching the parent's ledger would cross the
   *  sidechain isolation line, and side-*.jsonl transcripts are separate
   *  ledgers this loader never touches. */
  readonly historySearch?: { readonly load: import("@wudao/core").HistorySearchLoader };
  /** 121 §1 续章: the session's persistent-notes face — present → the
   *  note_write / note_read pair joins the TOP-LEVEL set right after
   *  search_history (append-only tail, M24: every earlier tool keeps its
   *  exact bytes and index; the new slots are declared one-time cross-version
   *  cold turns, never mid-session). Storage is PLAIN FILES under
   *  <workspace>/.wudao/notes/<sessionId>/ (append-only, tag-indexed); the
   *  files never enter model context by themselves — note_read is the only
   *  door (按需读取). note_read rides the read class (READ_TOOLS);
   *  note_write is deliberately NOT in any auto-allow roster (the write
   *  face — ask posture by the fail-closed default). Subagents never see
   *  them (the notes dir is parent-session-scoped). */
  readonly notes?: { readonly sessionId: () => string };
  /** 125 项 1（the upstream projectnew_context 形）: the model-side context-rotation face —
   *  present → the `new_context` tool joins the TOP-LEVEL set right after the
   *  notes pair (append-only tail, M24: every earlier tool keeps its exact
   *  bytes and index; the new slot is a declared one-time cross-version cold
   *  turn, never mid-session). The tool's execute reaches the loop's rotation
   *  port through this box; the loop installs the implementation per run, so
   *  between runs (and on every frontend that wires no box) the tool answers
   *  fail-closed. Registered ONLY where compaction is on (a rotation IS a
   *  tier-2 boundary); subagents never see it (child sets draw from the pool,
   *  rotation is a parent-session capability — v1 boundary). */
  readonly newContext?: { readonly portBox: import("@wudao/core").NewContextPortBox };
  /** 夜移 029: the session's loaded skills — present AND enough model-visible
   *  ones (skillSearchEligible: >= SKILL_SEARCH_MIN_SKILLS manifest lines) →
   *  the read-only `discover_skills` search tool joins the TOP-LEVEL set at a
   *  fixed position. Skills are session-static (live reload is
   *  restart-scoped), so the decision is boot-time and the tool-list prefix
   *  stays byte-stable all session; below the threshold the manifest scans
   *  fine and the tool stays OUT (zero surface, tests pin that boundary —
   *  every existing fixture's tool bytes are unchanged). Subagents never see
   *  it (the skill manifest is parent-facing). */
  readonly skills?: readonly LoadedSkill[];
  /** ω99-313: the resident durable-schedule daemon's face — present → the
   *  schedule_add / schedule_list / schedule_remove trio joins the TOP-LEVEL
   *  set at the APPEND-ONLY TAIL (M24: every earlier tool keeps its exact
   *  bytes and index; the new slot is a declared cross-version cold turn).
   *  Absent → zero durable-scheduling surface (the REPL/one-shot/pet-lane
   *  sessions and every hermetic fixture keep their tool bytes unchanged —
   *  缺省关). Subagents never see them (the daemon is a host singleton). */
  readonly schedules?: ScheduleToolFace;
}): Tool[] {
  // M51 §2: the diagnostics layer rides the SAME feature family as
  // write-verify (one construction per tool set — every frontend: one-shot,
  // REPL, TUI, web, worktree children — gets it with no prop threading; the
  // explicit opts.diagnostics stays the test/override seam).
  // M53 §5: --no-diagnostics removes the baseline-diff layer (write-verify
  // receipts stay); --no-elision removes read_file's zero-repeat probe (the
  // contextProbe seam is also the ctx_inspect/pilot source, so elision alone
  // is gated HERE, at the read_file construction, not by dropping the probe).
  const diagnostics = isFeatureAblated("diagnostics")
    ? undefined
    : opts.diagnostics
      ?? (opts.writeVerify !== undefined && opts.writeVerify.enabled
        ? createDiagnosticsLayer({ workspaceRoot: opts.workspaceRoot, config: opts.writeVerify })
        : undefined);
  const readState = opts.readState ?? createReadStateTable();
  // 借鉴弧 ζ1（Reasonix 蒸馏）——陈旧未决写拒绝门：写工具经 LIVE 链访问器
  // （各前端 hand 给 contextProbe 的同一闭包——REPL/one-shot/engine 三处都
  // 是 state.messages 原链）查未决表。readState 在场=本进程内重新读过
  // （freshness gate 重新武装——若未决写真落了盘，mtime 已动，freshness 会
  // 拒；没落盘则心智模型为真，写安全）。无 contextProbe（evals/嵌入方）或
  // 推导失败 = fail-open 不拦（门缺席时 write_file/edit 行为与 ζ1 前逐字节
  // 一致）。worktree 子集（childToolsFor）不挂：子 sidechain 是独立链，v1
  // 诚实边界（同树 task 子代理与父共享本组工具实例——门按工作区事实拦截，
  // 其 read 落共享 readState，经 hasFreshRead 面放行）。
  const pendingWriteGate = opts.contextProbe !== undefined
    ? createPendingWriteGate(
        () => opts.contextProbe?.(),
        (absPath) => readState.get(absPath) !== undefined,
      )
    : undefined;
  // workspace-ux B2: the LIVE agent root. The builtin file tools' options
  // objects carry workspaceRoot as a GETTER over this box (never spread — a
  // spread would evaluate it once — and the core factories resolve it per
  // EXECUTION), so the boundary moves with an agentRootSwitch without
  // rebuilding the tool array. Session-anchored seams below (spill, cron
  // store, the task tool's sidechains, todo's plan.md, the diagnostics layer)
  // keep the boot root.
  const agentRootBox = opts.agentRootBox ?? { current: opts.workspaceRoot };
  const readOnlyTools = [
    createGlobTool({ get workspaceRoot() { return agentRootBox.current; } }),
    createGrepTool({ get workspaceRoot() { return agentRootBox.current; } }),
  ];
  const readFile = createReadFileTool({
    get workspaceRoot() { return agentRootBox.current; },
    ...(opts.contextProbe && !isFeatureAblated("elision") ? { contextProbe: opts.contextProbe } : {}),
    readState,
  });
  // todo_write (M23): the long-task board — context write + .wudao/plan.md copy.
  // Placed with the coding tools so `coder` subagents get it too; it never
  // reaches a child set for read-only roles. The plan.md copy stays anchored
  // to the BOOT root (.wudao is session runtime data, not a workspace file).
  const codingTools = [
    readFile,
    ...readOnlyTools,
    createWriteFileTool({
      get workspaceRoot() { return agentRootBox.current; },
      readState,
      ...(opts.history ? { history: opts.history } : {}),
      ...(opts.turnDiff ? { turnDiff: opts.turnDiff } : {}),
      ...(opts.writeVerify ? { writeVerify: opts.writeVerify } : {}),
      ...(diagnostics ? { diagnostics } : {}),
      ...(pendingWriteGate ? { pendingWrites: pendingWriteGate } : {}),
    }),
    createEditTool({
      get workspaceRoot() { return agentRootBox.current; },
      readState,
      ...(opts.history ? { history: opts.history } : {}),
      ...(opts.turnDiff ? { turnDiff: opts.turnDiff } : {}),
      ...(opts.writeVerify ? { writeVerify: opts.writeVerify } : {}),
      ...(diagnostics ? { diagnostics } : {}),
      ...(pendingWriteGate ? { pendingWrites: pendingWriteGate } : {}),
    }),
    createShellTool({
      get workspaceRoot() { return agentRootBox.current; },
      ...(opts.spillDir ? { spillDir: opts.spillDir } : {}),
      ...(opts.longOutput ? { longOutput: opts.longOutput } : {}),
      ...(opts.sandbox ? { sandbox: opts.sandbox } : {}),
      ...(opts.loginShellEnv !== undefined ? { loginShellEnv: opts.loginShellEnv } : {}),
      ...(opts.logSlimming !== undefined ? { logSlimming: opts.logSlimming } : {}),
    }),
    createTodoTool({ workspaceRoot: opts.workspaceRoot }),
    // 123-3 — critic 终态评审：todo 板 done 项的独立复核（side-call）。
    // contextProbe 是既有的 messages 只读缝；无该缝（evals/嵌入方）不挂。
    // 挂载条件=defer 关（defer 开时它是顶层零配置面不该藏——load_tools
    // 的预算目录已保它的存在性）；晚绑读 state（板/任务话/工作证据）。
    ...(process.env.WUDAO_DEFER_RUN === "1" || opts.contextProbe === undefined ? [] : [createCriticReviewTool({
      model: opts.model,
      getBoard: () => {
        const msgs = (opts.contextProbe as () => readonly AgentMessage[])();
        for (let i = msgs.length - 1; i >= 0; i -= 1) {
          const m = msgs[i];
          if (m === undefined || m.role !== "tool") continue;
          if (!String(m.content).startsWith("[todo board")) continue;
          const text = String(m.content);
          const doneItems = text.split("\n").filter((l) => l.startsWith("☑ ")).map((l) => l.slice(2));
          const incompleteItems = text.split("\n").filter((l) => l.startsWith("◐ ") || l.startsWith("☐ ")).map((l) => l.slice(2));
          if (doneItems.length === 0) return undefined; // 无完成项=无可评审
          return { doneItems, incompleteItems, boardText: text };
        }
        return undefined;
      },
      getTaskStatement: () => {
        for (const m of (opts.contextProbe as () => readonly AgentMessage[])()) {
          if (m.role === "user" && !String(m.content).startsWith("[")) return String(m.content).slice(0, 500);
        }
        return undefined;
      },
      getRecentWork: () => (opts.contextProbe as () => readonly AgentMessage[])().slice(-16),
    })]),
    // 夜移 026 (Strands sleep): bounded temporal wait for the coder roles —
    // letting a background build make progress without a shell permission
    // round. Fixed tail position in the group (prefix stability); worktree
    // children get it too (a child waiting on its own build is the same
    // use case).
    createSleepTool(),
    // 夜移 027 (Strands notebook): compaction-safe scratchpad — working
    // notes that survive context compaction on disk, outside the user's
    // tree. Boot-root anchored like todo's plan.md (.wudao is session
    // runtime data); children get it too (their own drafts, their own
    // .wudao under the worktree root).
    createNotebookTool({ workspaceRoot: opts.workspaceRoot }),
    // ω99-57: the global child→parent mail tool (fixed tail position in the
    // group — prefix stability). ONE copy for the parent's array and every
    // child pool; the sender is runtime-derived (the ambient mail scope
    // runSubagent enters), so the top-level face is the same tool refusing
    // with a typed error — no child-specific prompt section anywhere.
    createParentMessageTool(),
  ];
  // M49 §1: memory surface — write + search at top level; the pool below
  // (what the task tool's children draw from by name) carries BOTH so a role
  // listing memory_search finds it, but the default child set (and every
  // worktree child below) is search-only.
  const memoryTools = opts.memory
    ? [createMemoryWriteTool(opts.memory.store), createMemorySearchTool(opts.memory.store)]
    : [];
  const toolPool = [...codingTools, ...memoryTools];
  // M50 §1: run_script (PTC) — the model batches its tool calls as one JS
  // program over a file-RPC channel in a sandboxed child; ONLY the program's
  // stdout enters context. Every inner call() re-enters the SAME gate the
  // loop uses (`opts.canUseTool`, sidecar layer included — contextProbe
  // precedent), per call. Top level ONLY (children never see it, v1) and
  // never the workflow task tool's allowTools surface by default; recursion
  // (run_script inside a script) is refused inside the tool itself.
  const runScriptTool = createRunScriptTool({
    tools: toolPool,
    gate: opts.canUseTool,
    // workspace-ux B2: the child follows the LIVE agent root (spawn-time read).
    get cwd() { return agentRootBox.current; },
  });
  // 114 取证弧（forensics §3/§6-5）— python_kernel：持久 Python kernel，
  // 会话内跨调用的计算状态车道（挂载位=run_script 邻近缝：紧随其后，
  // append-only——新槽位=跨版本一次性冷点，M24 声明见 python-kernel.ts 头）。
  // 与 run_script 同界的 v1 边界：TOP-LEVEL ONLY——不进 run_script 的内层
  // call() 池（kernel 是纯计算车道不调工具）、不进子 agent 集（childToolsFor
  // 不含它）、不 defer。cwd 沿 live root（kernel spawn 时读；驻留期间 root
  // 切换不改已活 kernel 的 cwd，reset 后跟新根）。idle 回收窗可由前端经
  // opts.pythonKernel 注入（settings pythonKernel.idleTimeoutMs）；缺省
  // 15min。工具带 stop() 面——driver dispose 遍历 tools 收编（kernel 随
  // driver dispose 死）。
  const pythonKernelTool = createPythonKernelTool({
    get cwd() { return agentRootBox.current; },
    ...(opts.pythonKernel?.idleTimeoutMs !== undefined ? { idleTimeoutMs: opts.pythonKernel.idleTimeoutMs } : {}),
  });
  // M30: the registry is shared between the task tool and the agent_* tools —
  // one per tool set unless the frontend hands one in (TUI counts, lifecycle).
  const registry = opts.agents?.registry
    ?? createSessionRegistry({ ...(opts.agents?.maxConcurrent !== undefined ? { maxConcurrent: opts.agents.maxConcurrent } : {}) });
  // ω99-60: the global parent→child steer tool, BOUND to this session's
  // registry — the same instance the task tool spawns through, so a steer
  // addresses exactly this session's bg-N children. Fixed tail position in
  // the session pool (prefix stable; run_script's inner set stays without
  // it — steering is orchestration-adjacent, like task/agent_*). A
  // construction without a registry (core's bare factory) is the typed
  // no-edge refusal, never a silent no-op.
  const sessionPool = [...toolPool, createMessageChildTool(registry)];
  // M30 §D: worktree children get the SAME builtin set re-rooted at their
  // worktree. No contextProbe (the child reads a different tree than the
  // parent's context elides against); sandbox policy rides along. M49 §1:
  // worktree children keep the read-only memory search only.
  const childToolsFor = (root: string): readonly Tool[] => [
    createReadFileTool({ workspaceRoot: root }),
    createGlobTool({ workspaceRoot: root }),
    createGrepTool({ workspaceRoot: root }),
    createWriteFileTool({ workspaceRoot: root, ...(opts.writeVerify ? { writeVerify: opts.writeVerify } : {}), ...(diagnostics ? { diagnostics } : {}) }),
    createEditTool({ workspaceRoot: root, ...(opts.writeVerify ? { writeVerify: opts.writeVerify } : {}), ...(diagnostics ? { diagnostics } : {}) }),
    createShellTool({ workspaceRoot: root, ...(opts.sandbox ? { sandbox: opts.sandbox } : {}), ...(opts.loginShellEnv !== undefined ? { loginShellEnv: opts.loginShellEnv } : {}) }),
    createTodoTool({ workspaceRoot: root }),
    createSleepTool(),
    createNotebookTool({ workspaceRoot: root }),
    // ω99-57: worktree children keep the mail tool (context-free — same
    // serialized definition as the pool copy; fixed tail position).
    createParentMessageTool(),
    // ω99-60: worktree children keep the steer tool too (bound to the same
    // session registry; fixed tail position — grandchild symmetry).
    createMessageChildTool(registry),
    ...(opts.memory ? [createMemorySearchTool(opts.memory.store)] : []),
  ];
  const contextProbe = opts.contextProbe;
  // The orchestration task tool (M30): roster roles, background spawn, child
  // sessions, reportSchema, reasoning receipt. Children NEVER see the
  // orchestration tools (ORCHESTRATION_TOOL_NAMES filter inside).
  const taskTool = createAgentsTaskTool({
    model: opts.model,
    allTools: sessionPool,
    registry,
    workspaceRoot: opts.workspaceRoot,
    runId: opts.agents?.runId ?? "session",
    loopOptions: {
      compaction: { contextWindowTokens: opts.contextWindowTokens },
      // ω99-79: the children's identified deltas ride the parent's
      // loopOptions into core ω99-76's forwarding (the callId arrives
      // namespaced `sub:<childIdentity>:<rawId>`, toolName stays the child's
      // real tool); the box's sink is DRIVER-armed per run — absent box or
      // unarmed sink (idle, or a driver-less frontend) is a safe no-op.
      ...(opts.subagentUpdateBox !== undefined
        ? { onToolUpdate: (delta: IdentifiedOutputDelta) => { opts.subagentUpdateBox!.sink?.(delta); } }
        : {}),
    },
    canUseTool: opts.canUseTool,
    onSubagentEvent: opts.onSubagentEvent,
    // ω99-8: the cost-attribution observer rides the same options thread.
    ...(opts.onSubagentUsage !== undefined ? { onSubagentUsage: opts.onSubagentUsage } : {}),
    ...(opts.getForkContext ? { getForkContext: opts.getForkContext } : {}),
    // Pilot nudge probe: the same live message view read_file elides against.
    ...(contextProbe ? { pilotProbe: () => firstHandWorkProbe(contextProbe) } : {}),
    ...(opts.agents?.resolveModel ? { resolveModel: opts.agents.resolveModel } : {}),
    ...(opts.agents?.defaultEffort !== undefined ? { defaultEffort: opts.agents.defaultEffort } : {}),
    // ω99-86: the live-effort box's getter face — read LATE (at spawn), so
    // the driver's per-run arming governs and an absent box keeps the task
    // tool's spawns byte-identical.
    ...(opts.effortLiveBox !== undefined
      ? { effortLive: () => opts.effortLiveBox!.get?.() }
      : {}),
    // M31 §1: a sandboxed session exempts scoped roles' shell; overlap
    // warnings reach the human through the notice channel.
    ...(opts.sandbox ? { sandboxedRunCommand: true } : {}),
    ...(opts.agents?.onNotice ? { onNotice: opts.agents.onNotice } : {}),
    // M63-B: the SubagentStart/Stop faces ride the task tool.
    ...(opts.agents?.hooks ? { hooks: opts.agents.hooks } : {}),
    // M63-C R1: the fire-runtime view for the subagent position.
    ...(opts.agents?.hookRuntime ? { hookRuntime: opts.agents.hookRuntime } : {}),
    // M64-C §C: named subagents become teammates.
    ...(opts.agents?.teams ? { teams: opts.agents.teams } : {}),
    // ω99-57: the child-mail lane (absent → children draw no mail tool).
    ...(opts.childMail ? { childMail: opts.childMail } : {}),
    // M40 §2: plugin agents join the roster between builtins and workspace.
    ...(opts.agents?.pluginAgents ? { pluginAgents: opts.agents.pluginAgents } : {}),
    childToolsFor,
  });
  // M62 §6: the defer candidates are computed BEFORE baseTools — the auto
  // threshold estimates THEIR schema bytes over this very array.
  const deferCandidates: readonly Tool[] = [taskTool, ...createRegistryTools(registry)];
  // ω99-236: the doc trio's twelve faces, built ONCE from the roster in
  // canonical mount order (make×3 head, then read/append/replace ×9 — see
  // doc-suite.ts). Spread in TWO segments around the computer octet's
  // historical slot below: the default-state bytes are byte-identical to the
  // pre-roster per-face mounts (顺序逐字不变——宪法切片与邻接钉的命).
  const docSuiteTools = createDocSuiteTools(opts.workspaceRoot);
  const baseTools = [
    ...sessionPool,
    runScriptTool,
    // 114: the persistent python kernel — run_script's neighboring slot
    // (append-only; the schema joining the tools list is a declared one-time
    // cross-version cold turn, never mid-session).
    pythonKernelTool,
    // M59 §3: the web surface. web_fetch is ZERO-CONFIG ALWAYS registered
    // (defaults inside core; opts.web?.fetch only tunes maxChars/ports);
    // web_search exists ONLY when a provider is configured. TOP-LEVEL ONLY
    // (v1 boundary): like ask_user/ctx_inspect, the open-world tools stay
    // parent-facing — subagent role pools and worktree children do not draw
    // them, so a child cannot silently gain network egress.
    createWebFetchTool({
      ...(opts.spillDir !== undefined ? { spillDir: opts.spillDir } : {}),
      ...(opts.web?.fetch !== undefined
        ? {
          ...(opts.web.fetch.maxChars !== undefined ? { maxChars: opts.web.fetch.maxChars } : {}),
          ...(opts.web.fetch.allowedPorts !== undefined ? { allowedPorts: opts.web.fetch.allowedPorts } : {}),
        }
        : {}),
    }),
    ...(opts.web?.search !== undefined
      ? [createWebSearchTool(opts.web.search)]
      : []),
    // ω99-112: the browser sextet — top-level only, ONE fixed position after
    // the web face and before the scheduler trio (prefix stability). The
    // runtime owns the whole lifecycle (launch-once, idle reaping, honest
    // kernel errors); click/type-submit carry their ask posture in the
    // permission layer's DEFAULT_ASK_TOOLS, not in the tools.
    // ω99-138: with vision materials the screenshot sink rides along — PNG
    // bytes land in the workspace AttachmentStore (.wudao/attachments) as a
    // durable ImageBlock (the SAME channel the --image flag uses); the
    // closure re-checks the main model's image modality AT EVERY CALL so a
    // text-only main model degrades browser_see to its text table instead of
    // poisoning every later request with a typed image refusal.
    ...(opts.browser !== undefined
      ? browserToolsFor(
          opts.browser,
          opts.browserVision === undefined
            ? undefined
            : async (png) => {
                const vision = opts.browserVision!;
                if (!vision.modelAcceptsImages()) return undefined; // the modality pre-check declines
                const [ref] = await vision.store.saveImages([{ data: Buffer.from(png).toString("base64"), mediaType: "image/png" }]);
                if (ref === undefined) throw new Error("the attachment store returned no ref for the screenshot");
                return { kind: "image" as const, ref };
              },
        )
      : []),
    // M61 §1: the scheduler trio — top-level only, fixed position (prefix
    // stability), built fail-closed over the session's live task table.
    ...(opts.cron !== undefined
      ? createCronTools({
          workspaceRoot: opts.workspaceRoot,
          sessionId: opts.cron.sessionId ?? "session",
          table: opts.cron.table,
          ...(opts.cron.env !== undefined ? { env: opts.cron.env } : {}),
        })
      : []),
    // ω99-118: the page-watch trio — top-level only, fixed position right
    // after the scheduler trio (prefix stability). DUAL gate: the live cron
    // runtime (createTask — the watch shell only consumes, never re-stamps)
    // AND the browser face (a watch that can never look is fail-closed OUT,
    // not registered — same posture as cron's absent seam).
    ...(opts.cron?.runtime !== undefined && opts.browser !== undefined
      ? createWatchTools({ runtime: opts.cron.runtime })
      : []),
    // ω-4a: the monitor trio — top-level only, fixed position beside the
    // scheduler trio (prefix stability), fail-closed over the session's live
    // registry. The tail confinement delegate is core's resolver; kind=command
    // refuses under this set's own sandbox posture.
    ...(opts.monitor !== undefined
      ? createMonitorTools({
          registry: opts.monitor.registry,
          confinePath: (p) => resolveWorkspacePath(opts.workspaceRoot, p),
          ...(opts.monitor.refusal !== undefined ? { refusal: opts.monitor.refusal } : {}),
          ...(opts.sandbox !== undefined ? { sandbox: true } : {}),
        })
      : []),
    ...(opts.loop !== undefined ? [createScheduleWakeupTool(opts.loop.getController)] : []),
    // ω99-15: the mission quartet — top-level only, fixed position after the
    // loop tool (prefix stability), late-bound over the controller box.
    ...(opts.mission !== undefined ? createMissionTools(opts.mission.getController) : []),
    // ω99-249: the goal query tool — top-level only, tail append after the
    // mission quartet (prefix stability), late-bound over the runtime box.
    ...(opts.goalFace !== undefined ? createGoalTools(opts.goalFace.getRuntime) : []),
    // 132-P1-2 — context_doctor（只读账单；defer 闲时轮白名单——同 schedule_list 律）。
    ...(opts.contextDoctor !== undefined ? [createContextDoctorTool(opts.contextDoctor)] : []),
    // 123-2 — read_session（整会话预算读取；只读白名单同律）。
    ...(opts.sessionRead !== undefined ? [createReadSessionTool(opts.sessionRead)] : []),
    // M64-A §A: the peer-messaging pair — top-level only, fixed position
    // (prefix stability), fail-closed over the session runtime.
    ...(opts.peer !== undefined ? createPeerTools(opts.peer) : []),
    // 夜移 029: the skill-search tool — top-level only, fixed position
    // (prefix stability), threshold-gated over the session-static skill list
    // (boot-time decision; below the threshold zero surface). Pure in-memory
    // read; auto-allowed through the isReadOnly tool check + READ_TOOLS.
    ...(opts.skills !== undefined && skillSearchEligible(opts.skills)
      ? [createDiscoverSkillsTool(opts.skills)]
      : []),
    // P2-13 (96 队列 #13): constitution_suggest — top-level only, fixed
    // position (append-only tail, prefix stability), ZERO-CONFIG always
    // registered: the model can ALWAYS suggest a clause into the pending
    // inbox (~/.wudao/constitution-pending/). The destination is hardcoded
    // in the store (no path parameter exists) — the active constitution is
    // unreachable by construction; only /constitution approve writes it.
    createConstitutionSuggestTool(),
    // ω99-236: the doc trio's make faces (roster head — createDocSuiteTools'
    // first DOC_SUITE_MAKE_COUNT entries; the per-face posture comments live
    // in doc-suite.ts beside each constructor now). Same position as the
    // pre-roster mounts: right after constitution_suggest, before the
    // computer octet — 顺序逐字不变.
    ...docSuiteTools.slice(0, DOC_SUITE_MAKE_COUNT),
    // ω99-212: #3 — the computer octet, top-level only, append-only tail
    // right after make_docx (prefix stability), ZERO-CONFIG always-on (the
    // seven system faces need no seam; screen_capture degrades honestly to a
    // typed refusal without computerVision — no capture, no poisoned request).
    // Subagents never see them (physical-input tools are parent-facing, the
    // same posture as the browser sextet). The six action faces' ask posture
    // lives in the CLI permission layer (DEFAULT_ASK_TOOLS), never here.
    // ω99-220: #7 — scroll/drag join the array TAIL (after app_list): the
    // six earlier faces keep their exact bytes and indices (append-only,
    // M24); the deferred tail (task …) shifts two slots — re-pinned in
    // constitution.test.ts on the ω99-123/124/126/212 precedent. One
    // cross-version cold turn for sessions spanning the upgrade, never
    // inside a session.
    ...createComputerTools(
      opts.computerVision === undefined
        ? {}
        : { vision: { store: opts.computerVision.store, modelAcceptsImages: opts.computerVision.modelAcceptsImages } },
    ),
    // ω99-236: the doc trio's read/append/replace faces (roster tail —
    // createDocSuiteTools from DOC_SUITE_MAKE_COUNT on; per-face posture
    // comments live in doc-suite.ts). Same position as the pre-roster mounts:
    // right after the computer octet, before the defer tail — 顺序逐字不变.
    ...docSuiteTools.slice(DOC_SUITE_MAKE_COUNT),
    // M62 §6: the session-resolved defer decision (auto threshold / on /
    // off / env ablation) replaces the always-on default.
    ...markDeferCandidates(deferCandidates, sessionDeferEnabled(deferCandidates, opts.contextWindowTokens)),
    // MCP tools stay eager (see DEFER_CANDIDATE_TOOL_NAMES). M62 §6: a
    // server marked alwaysLoad:true is guaranteed-eager by construction —
    // but note the cache law: the tool-set prefix is frozen per session, so
    // an MCP server appearing/disappearing between sessions invalidates the
    // prefix once (documented in the README MCP section).
    ...(opts.extraTools ?? []),
  ];
  // M52 §3: ctx_inspect rides the TOP-LEVEL set when the frontend wired the
  // live seams (contextProbe + systemPrompt getter) — the model's view of its
  // own budget, measured over the very array it joins (late-bound closure).
  // Read-only, never deferred, never a child tool.
  if (opts.contextProbe !== undefined && opts.getSystemPrompt !== undefined) {
    const probe = opts.contextProbe;
    const sys = opts.getSystemPrompt;
    baseTools.push(
      createCtxInspectTool(() => ({
        systemPrompt: sys(),
        tools: baseTools.map(toModelToolDefinition),
        messages: probe(),
        contextWindowTokens: opts.contextWindowTokens,
      })),
    );
    // 125 项 2（the upstream projectget_context_remaining 形）：水位线查询面 — ctx_inspect
    // 给占用明细，这里给决策面（剩余/距压缩线），与 loop 的 effectiveThreshold
    // 读同一条线（core 的 resolveCompactionThresholdTokens 单一真值点）。
    // 只读（READ_TOOLS 面），top-level only，紧随 ctx_inspect 的家族定位。
    if (opts.contextRemaining !== undefined) {
      const getThreshold = opts.contextRemaining.getThreshold;
      baseTools.push(
        createContextRemainingTool(() => ({
          systemPrompt: sys(),
          tools: baseTools.map(toModelToolDefinition),
          messages: probe(),
          contextWindowTokens: opts.contextWindowTokens,
          threshold: getThreshold(),
        })),
      );
    }
  }
  // ω-2b (I3): the paged tool-result recovery tool — top-level only, fixed
  // position after ctx_inspect (prefix stability), fail-absent when the
  // frontend wired no loader.
  if (opts.sessionResult !== undefined) {
    baseTools.push(createSessionResultTool(opts.sessionResult.load));
  }
  // 121 挖掘 TOP5 #1: the conversation-history search tool — top-level only,
  // fixed position after session_result (the session-ledger retrieval family's
  // second face: session_result pages tool-output originals back in, this one
  // searches the conversation flow compaction swallowed — user/assistant text
  // + assistant reasoning, scope all/recent over the compact boundary).
  // Read-only bypass read of the JSONL; fail-absent when the frontend wired
  // no loader; subagents never see it (sidechain isolation).
  if (opts.historySearch !== undefined) {
    baseTools.push(createSearchHistoryTool(opts.historySearch.load));
  }
  // 121 §1 续章: the persistent-notes pair — top-level only, fixed position
  // right after search_history (the retrieval family's sibling lane:
  // search_history recovers what compaction swallowed from the RAW ledger,
  // note_write/note_read are the model's PROACTIVE save/read over the same
  // long-task knowledge — plain markdown files under .wudao/notes/, one per
  // note, append-only, never entering model context by themselves). The
  // boot workspace root is the anchor (session-anchored seam — agent-root
  // switches do not move it); fail-absent when the frontend wired no
  // session id. Subagents never see them.
  if (opts.notes !== undefined) {
    baseTools.push(...createNotesTools({ workspaceRoot: opts.workspaceRoot, sessionId: opts.notes.sessionId }));
  }
  // 125 项 1: the model-side rotation tool — top-level only, fixed position
  // right after the notes pair (the retrieval family's orchestration sibling:
  // note_write/search_history KEEP knowledge across boundaries, new_context
  // OPENS one deliberately). Fail-absent when the frontend wired no port box.
  if (opts.newContext !== undefined) {
    const box = opts.newContext.portBox;
    baseTools.push(createNewContextTool(() => box.current));
  }
  // ω99-313: the durable schedule trio — top-level only, APPEND-ONLY TAIL
  // (M24: 缺省关 — absent seam keeps every tool byte identical; the daemon
  // is hosted by `wudao ui` alone, so REPL/one-shot/pet sessions and every
  // existing fixture see zero new surface). Session-start registration, so
  // the tool-list prefix stays byte-stable all session.
  if (opts.schedules !== undefined) {
    // 131 弧（zcode off-peak 引进）— defer（闲时）轮的排程不可见律：闲时
    // 火的 spawn 子进程带 WUDAO_DEFER_RUN=1，本轮工具集不挂排程/交棒类
    // （schedule_add/remove/continue_task/defer_task）——防递归在 provider
    // 可见性层解决（zcode 双层 denylist 的第一层）；schedule_list 只读保留
    // （闲时轮里查任务表无害且有用）。
    const deferTurn = process.env.WUDAO_DEFER_RUN === "1";
    if (!deferTurn) baseTools.push(...createScheduleTools(opts.schedules));
    else baseTools.push(...createScheduleTools(opts.schedules).filter((t) => t.name === "schedule_list"));
    // 127 项 1: continue_task — 跨会话交棒面，紧跟 schedules 三件套（同一
    // append-only 尾，M24 会话启动注册）。挂载门 = 守护面带结构化 list（只有
    // daemon 宿主会话接线 schedules；one-shot/REPL/pet/子代理不挂——
    // fail-closed 家族：headless 腿无排程权是 v1 的 D 缺口边界）。live 会话
    // 缝是 EXECUTE-TIME 读（宿主在 createDriverSession 返回后才晚绑
    // liveSessionId——121 项 2 的同款纪律；绑好前调用 = 工具拒答，不静默）。
    // 工具面读 daemon 的 add/list（单宿主法则——绝不直写 schedules.json）；
    // baton 落 .wudao/task-chain/<task_id>.md（纯 markdown，无新 JSON 格式）。
    const scheduleFace = opts.schedules;
    const scheduleList = scheduleFace.list;
    if (scheduleList !== undefined && !deferTurn) { // 131：闲时轮不挂交棒面（防递归同律）
      baseTools.push(
        createContinueTaskTool({
          workspaceRoot: opts.workspaceRoot,
          face: {
            add: (input) => scheduleFace.add(input),
            list: () => scheduleList(),
          },
          sessionId: () => scheduleFace.liveSessionId?.(),
        }),
      );
    }
  }
  return baseTools;
}
