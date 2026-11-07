// ω99 拆分运动 弧 B：session-engine 的两个门面类型（原文件模块级段外提，
// 纯移动——正文与 doc 注释逐字保留；session-engine.ts re-export 门面保公共面）。
import type { AgentHooks, AgentMessage, LoopGates, ModelClient, Tool } from "@wudao-org/core";
import type { ProviderConfig } from "@wudao-org/providers";
import type { AskAnswer, SessionAllowlist } from "../permission.js";
import type { Sidecar } from "../sidecar.js";
import type { AgentRegistry, RosterPluginAgent } from "../agents/index.js";
import type { LoadedSkill } from "../skills.js";
import type { PluginCommand } from "../plugins.js";
import type { ExtensionRuntime } from "../extensions/api.js";
import type { GoalController } from "../goal.js";
import type { MissionController } from "../mission.js";
import type { AgentDriver, AgentDriverOptions } from "./agent-driver.js";

export interface DriverSessionOptions {
  readonly config: ProviderConfig;
  readonly workspaceRoot: string;
  /** workspace-ux B2: the switchable agent-root box, SHARED by the tool set
   *  (the builtin file tools' boundary + shell cwd read it at execution
   *  time) and the driver (agentRootSwitch's apply point writes it). In
   *  production index.ts hands its hookWorkspaceRoot box so hook payloads
   *  follow the same root. Absent → a private box pinned here (identical
   *  behavior; the op still works, external followers just don't move). */
  readonly agentRootBox?: { current: string };
  readonly contextWindowTokens: number;
  /** Provider management §7: the per-model window resolver — /provider
   *  switches re-resolve the driver's compaction window through it (registry
   *  contextLength → provider default → env; settings-knob-aware when the
   *  boot passes its layered view). Absent → the knob-less chain. */
  readonly resolveWindowTokens?: (provider: string | undefined, model: string) => number;
  /** M62 §7: the auto-compaction master switch (false → the driver gets NO
   *  compaction — the loop runs un-compacted; manual /compact still works). */
  readonly compactionEnabled?: boolean;
  /** Resumed history (already applySummaryMarkers/repair-processed); seeds state.messages. */
  readonly resumeHistory?: AgentMessage[];
  readonly sessionId?: string;
  /** ω99-211: true when sessionId was freshly minted this boot (no file on
   *  disk). The boot bookkeeping (model_change + workspace_root) is DEFERRED
   *  to the first user submit — an abandoned entry then leaves no empty
   *  session row behind (Buddy 模式进门=欢迎界面，零空会话). `wudao ui`
   *  passes it from resolveSession's fresh mint; direct constructions keep
   *  the default (false = today's write-at-boot semantics, hermetic tests). */
  readonly sessionFresh?: boolean;
  /** Test seam: scripted model in place of createProvider(config). */
  readonly modelOverride?: ModelClient;
  /** SDD 2026-08-23 persona Task 3: per-provider persona binding read (the
   *  provider card's `persona` field). string = bound persona id; null =
   *  explicitly unbound; undefined = no card / no field (falls through the
   *  chain). The default stub is the TEST seam — production (ui.ts
   *  startUiSession) supplies the real registry read (Task 4). */
  readonly readProviderPersonaBinding?: (providerId: string) => string | null | undefined;
  /** SDD 2026-08-23 persona Task 4: the global default persona id read
   *  (settings.json persona.id — the chain's last leg). Same seam contract:
   *  the stub default keeps direct-construction tests hermetic; ui.ts passes
   *  the real settings read. */
  readonly readGlobalDefaultPersonaId?: () => string | undefined;
  /** 0.3.11（用户反馈：权限档两入口 1:1 联动）：新会话的默认权限档
   *  （全局 settings.json permissions.defaultMode — 向导⑤/设置页持久化的
   *  那份）。CLI 旗标（--auto/--ask/--plan）仍然最高。0.3.14 四档值
   *  （workspace/ask/auto/plan）。Same seam contract: absent = 不读（直接构造
   *  的测试保持密封），ui.ts 传真实读。 */
  readonly defaultPermissionMode?: "workspace" | "ask" | "auto" | "plan";
  /** Test seam: stub tools in place of the full workspace tool set. */
  readonly tools?: readonly Tool[];
  /** Sandbox shell (M21); applied to shell only, fail-closed in core. */
  readonly sandbox?: { readonly image?: string };
  /** .wudao/settings.json-configured hooks (M19); forwarded to the loop and
   *  consulted by the permission gate (M63-A onPermissionRequest). */
  readonly hooks?: AgentHooks;
  /** M63-A: the SessionStart source at driver creation ("fork" for
   *  --fork-session); absent → derived from resumeHistory. */
  readonly sessionStartSource?: import("@wudao-org/core").SessionStartSource;
  /** M63-B: literal filenames the FileChanged watcher watches (from the
   *  onFileChanged config's plain matchers; the fire seam is
   *  hooks.onFileChanged). Absent/empty → no watcher. */
  readonly fileChangeTargets?: readonly string[];
  /** M63-B: the skills root to stat-poll for the skills-position ConfigChange
   *  face (the settings positions ride the permission watcher's consult).
   *  Absent → no skills face. */
  readonly configSkillsPath?: string;
  /** M63-C §3: the asyncRewake sink holder (the driver binds it to its
   *  system steering lane). */
  readonly rewakeSink?: { current?: (message: string) => void };
  /** M63-C R1: the fire-runtime view + prompt_id box (the driver's
   *  skill-position overlay compiles contract-complete). */
  readonly hookRuntime?: AgentDriverOptions["hookRuntime"];
  readonly promptIdBox?: AgentDriverOptions["promptIdBox"];
  readonly sessionIdBox?: AgentDriverOptions["sessionIdBox"];
  readonly hookWarnSink?: AgentDriverOptions["hookWarnSink"];
  /** P1-5 (96 队列): boot notices → the driver's history at construction
   *  (the workspace-trust suppression notice when the gate is active). */
  readonly bootNotices?: AgentDriverOptions["bootNotices"];
  /** P1-5 (96 队列): the workspace-trust gate's live getter feeding the
   *  permission settings watcher (absent = no gate). */
  readonly trustSuppressed?: () => boolean;
  /** MCP + extension tools — appended after the builtin set. */
  readonly extraTools?: readonly Tool[];
  /** M60: top-level tools appended AFTER the builtin+extra set (the Slack
   *  refusal ask_user — one-shot pushes its ask_user the same way). */
  readonly topLevelTools?: readonly Tool[];
  /** M23 long-task stop gates. */
  readonly gates?: LoopGates;
  /** M23 turn fuse. Falls back to the version default. */
  readonly maxTurns?: number;
  /** ω-long-2 — budget-window resets one run may take (弧 C continuation).
   *  Absent → `defaultMaxSlices()` (unlimited). 0 disables slicing. */
  readonly maxSlices?: number;
  /** M27 skills: /skill: routing + the prompt tail manifest. */
  readonly skills?: readonly LoadedSkill[];
  /** M36 plugin slash commands (parse routing + the data face). */
  readonly pluginCommands?: readonly PluginCommand[];
  /** M40 plugin agents (the task tool's roster plugin layer). */
  readonly pluginAgents?: readonly RosterPluginAgent[];
  /** M39 extensions (tools + commands + the session entry channel). */
  readonly extensions?: ExtensionRuntime;
  /** M32: the session's read-state table (shared with a stub tool set in tests);
   *  absent → a fresh one per session (the same instance the tool set uses). */
  readonly readState?: import("@wudao-org/core").ReadStateTable;
  /** M46 §1: write-verify config injected into the core write tools. */
  readonly writeVerify?: import("@wudao-org/core").WriteVerifyConfig;
  /** M46 §2: long-output shaping config for shell. */
  readonly longOutput?: import("@wudao-org/core").LongOutputConfig;
  /** M59 §3: web runtime for the tool set (fetch caps + optional search). */
  readonly web?: import("../tools.js").WebToolsRuntime;
  /** M59 §2: web.allowDomains — the permission gate's pre-approval list. */
  readonly webAllowDomains?: readonly string[];
  /** M59 §3: the /doctor web node (search provider state). */
  readonly webDoctor?: import("../commands/doctor.js").WebDoctorInput;
  /** Startup notice sink (the pending memory-review line); defaults to stdout. */
  readonly startupNotice?: (line: string) => void;
  /** M45: the session's sidecar (auto-mode flash classifier). Absent → the
   *  pre-M45 gate; present → high verdicts/breaker escalations reach the ask
   *  seam carrying the sidecar reason. */
  readonly sidecar?: Sidecar;
  /** M61 §4: the durable scheduling daemon (the `wudao ui` host passes its
   *  daemon so /schedule and /doctor reach it). */
  readonly schedule?: import("../schedules.js").ScheduleDaemon;
  /** M60: the frontend-owned permission ask (the Slack Block Kit relay).
   *  Present → "ask" decisions and sidecar escalations resolve through it and
   *  its `session` answers record the same allowlist rule the TUI records.
   *  Absent → asks park as status.pendingPermission (answerPermission). */
  readonly askRelay?: (
    toolName: string,
    summary: string,
    input: Record<string, unknown>,
    ctx?: { readonly sidecarReason?: string; readonly askDigest?: string; readonly askReview?: string; readonly spoof?: import("@wudao-org/core").SpoofInspection },
  ) => Promise<AskAnswer>;
  /** M64-A §A: the session's peer-messaging name (--name; /rename follows
   *  live). Absent → argv --name → the cwd-derived default. */
  readonly sessionName?: string;
  /** M64-A §A: force the peer surface off for this session (tests/hosts that
   *  own their sockets). */
  readonly noPeer?: boolean;
  /** ω99-235: #1 — the pet lane's three engine seams (this block: lease box,
   *  cron inert, auto-title off — the cli ui.ts pet lane threads all three;
   *  each prop defaults to today's single-lane behavior).
   *
   *  The OWN lease box: the root-memoized box (sessionLeaseBoxFor) tracks
   *  ONE current id — a second concurrent same-process session through it
   *  would RELEASE the first lane's lease at every acquire (the box's
   *  rotation semantics). Absent → the memoized root box (unchanged). */
  readonly sessionLeases?: import("@wudao-org/core").SessionLeaseBox;
  /** ω99-235: construct the session's cron runtime INERT (the refusal
   *  posture — the cron tools answer fail-closed). The pet lane sets this: a
   *  second same-process runtime over the same .wudao/cron.json arms fires
   *  into its OWN memory (the ω-1 reload guard covers clean-vs-disk, not
   *  runtime-vs-runtime), so a boot-window race arms the same due task in
   *  both lanes and it fires twice. Absent → the live runtime (unchanged). */
  readonly cronDisabled?: boolean;
  /** ω99-235: the session's auto-title fork (a background session_name entry
   *  write after the first exchange). The pet lane opts out — its display
   *  name is fixed at the layer above, and a fixed-id lane never needs a
   *  derived title. Absent → true (today's behavior). */
  readonly autoTitle?: boolean;
  /** ω99-248: #12 — the parked-ask persistence fork (the permission_ask
   *  recovery evidence on the session JSONL). The pet lane opts out: its
   *  asks are lane-local and never enter the persistent face (车道隔离).
   *  Absent → true (today's behavior). */
  readonly persistPermissionAsks?: boolean;
  /** 多 driver 并发弧 A: construct the session's memory runtime INERT and
   *  skip the pending-review boot notice. The side lanes of a lane manager
   *  set this: memory.jsonl is a WORKSPACE-GLOBAL file (recon E1 — the pet
   *  precedent never isolated it, tolerable at N=1), and N side lanes each
   *  running their own refresh/pending-write would multiply concurrent
   *  writers over one file. The main lane keeps the live runtime; side
   *  lanes run pure loop+tools+session. Absent → the live runtime
   *  (unchanged). */
  readonly memoryDisabled?: boolean;
}

export interface DriverSession {
  readonly driver: AgentDriver;
  readonly registry: AgentRegistry;
  /** The gate's session allowlist (`a`/总是 answers record here — Slack
   *  approvals and TUI approvals share the exact same store). */
  readonly allowlist: SessionAllowlist;
  /** ω99-13b: the /goal controller's late-bound box — the engine's model
   *  wrapper meters /goal --budget main-call tokens through it (the driver
   *  fills .current at creation; tests observe/replace it). */
  readonly goalBox: { current?: GoalController };
  /** ω99-15: the mission campaign controller's late-bound box — the tool
   *  set's mission_* quartet reads it (filled at engine tail below, after
   *  the driver exists so restore notices ride the history channel). */
  readonly missionBox: { current?: MissionController };
  close(): Promise<void>;
}
