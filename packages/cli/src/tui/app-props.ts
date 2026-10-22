// 拆分运动 C：从 app.tsx 原样外提的 WudaoAppProps 类型面（TUI 壳的注入缝，
// 纯类型模块）。app.tsx 逐名 re-export 保公共面（测试/入口零演进）。
import type {
  AgentHooks,
  AgentMessage,
  AskUserOption,
  FileHistory,
  LoopGates,
  ModelClient,
  ReadStateTable,
  SessionStartSource,
  Tool,
  TurnDiffTracker,
} from "@wudao/core";
import type { ProviderConfig } from "@wudao/providers";
import type { Mode } from "../permission.js";
import type { Sidecar } from "../sidecar.js";
import type { PeerRuntime } from "../peer/runtime.js";
import type { LoadedSkill } from "../skills.js";
import type { PluginCommand } from "../plugins.js";
import type { ExtensionRuntime } from "../extensions/api.js";
import type { AgentRegistry, RosterPluginAgent } from "../agents/index.js";
import type { ResolvedKeybindings } from "./keybindings.js";

export interface WudaoAppProps {
  readonly config: ProviderConfig;
  readonly workspaceRoot: string;
  /** ω99-315: the dual-tier idle watchdog budget (streamIdleSoftMs /
   *  streamIdleHardMs), loaded by the async bootstrap and spread into every
   *  provider this shell builds. Absent = provider defaults (tests). */
  readonly streamIdle?: { streamIdleSoftMs: number; streamIdleHardMs: number };
  readonly contextWindowTokens: number;
  /** Provider management §7: the per-model window resolver (registry
   *  contextLength → provider default → env; settings-knob-aware when index.ts
   *  passes its layered view). /model and /provider switches re-resolve
   *  through it at their apply points — switching the model switches the
   *  window. Absent → the knob-less chain over the static boot value. */
  readonly resolveWindowTokens?: (provider: string | undefined, model: string) => number;
  /** M62 §7: the auto-compaction master switch (false → the driver gets NO
   *  compaction; manual /compact still works). */
  readonly compactionEnabled?: boolean;
  /** 125 项 1（the upstream formatresolveCompactSpec 形）：预留感知触发线的 misc 旋钮
   *  （compaction.thresholdRatio/headroomTokens；boot 由 index.ts 解析一次）。
   *  缺席 = 缺省（0.8/2048 —— reserve 缺席时平比字节不变）。 */
  readonly compactionSettings?: import("../misc-config.js").CompactionSettings;
  /** Resumed history (already applySummaryMarkers/repair-processed); seeds state.messages. */
  readonly resumeHistory?: AgentMessage[];
  /** Session id when resuming; a fresh `wudao-<time>-<rand>` id is created otherwise. */
  readonly sessionId?: string;
  /** Test seam: scripted model used in place of createProvider(config). */
  readonly modelOverride?: ModelClient;
  /** Test seam: stub tools in place of the full workspace tool set. */
  readonly tools?: readonly Tool[];
  /** Sandbox shell (M21); applied to shell only, fail-closed in core. */
  readonly sandbox?: { readonly image?: string };
  /** .wudao/settings.json-configured hooks (M19); forwarded to the loop and
   *  consulted by the permission gate (M63-A onPermissionRequest). */
  readonly hooks?: AgentHooks;
  /** M63-A: the SessionStart source at driver creation ("fork" for
   *  --fork-session); absent → derived from resumeHistory. */
  readonly sessionStartSource?: SessionStartSource;
  /** M63-B: FileChanged watch targets (onFileChanged plain matchers). */
  readonly fileChangeTargets?: readonly string[];
  /** M63-B: the skills root for the skills-position ConfigChange face. */
  readonly configSkillsPath?: string;
  /** M63-C §3: the asyncRewake sink holder (flows to the driver). */
  readonly rewakeSink?: { current?: (message: string) => void };
  /** M63-C R1: the fire-runtime view + prompt_id box (flow to the driver). */
  readonly hookRuntime?: import("../hooks-config.js").NonNeverRuntime;
  readonly promptIdBox?: { current?: string };
  readonly sessionIdBox?: { current?: string };
  readonly hookWarnSink?: { current?: (message: string) => void };
  /** P1-5 (96 队列): boot-time notices appended to the driver's history at
   *  construction (the workspace-trust suppression notice when the gate is
   *  active). Absent = none (byte-stable for every existing caller/test). */
  readonly bootNotices?: readonly string[];
  /** P1-5 (96 队列): the workspace-trust gate's live getter (trust.ts's
   *  effectiveSuppressed) feeding the permission settings watcher — absent
   *  = no gate (index.ts passes it, pinned false by --trust-workspace). */
  readonly trustSuppressed?: () => boolean;
  /** MCP tools (mcp__*) — appended after the builtin set; also turns on the
   *  trailing MCP section of the system prompt. */
  readonly extraTools?: readonly Tool[];
  /** M23 long-task stop gates, resolved by the caller from settings + env. */
  readonly gates?: import("@wudao/core").LoopGates;
  /** M23 turn fuse (env/longTask-resolved). Falls back to maxTurns(). */
  readonly maxTurns?: number;
  /** M27 skills (loaded by the caller): drive the prompt tail manifest (only
   *  when a read tool is present) and `/skill:name` resolution. */
  readonly skills?: readonly LoadedSkill[];
  /** M36 plugin slash commands (loaded by the caller): `/<name> args` expands
   *  the template and submits it through the normal prompt path. */
  readonly pluginCommands?: readonly PluginCommand[];
  /** M40 §2: plugin agents (collected by the caller) — the task tool's roster
   *  plugin layer (builtin < plugin < workspace). */
  readonly pluginAgents?: readonly RosterPluginAgent[];
  /** M39 extensions (loaded by the caller): `/<name> args` runs the
   *  extension handler (notice → notify line, ctx.submit → a user turn), and
   *  the runtime's session binding (appendEntry/readEntries) rides this
   *  App's session store + id (re-bound when /clear rotates the id). */
  readonly extensions?: ExtensionRuntime;
  /** 夜移 018 (延迟预取 wudao 适配): the UNAWAITED MCP-tool load the caller
   *  started before first paint (boot never blocks on server handshakes).
   *  Resolving feeds the driver's addTools seam — typically inside the
   *  user's typing window, before the first run (a late arrival parks at
   *  run settle; the receipt names the boundary either way). */
  readonly deferredTools?: Promise<readonly import("@wudao/core").Tool[]>;
  /** M30: background agent registry shared with the task tool. Created when
   *  absent; pass one to observe it (tests, alternative frontends). */
  readonly agentsRegistry?: AgentRegistry;
  /** M32: the session's read-state table — shared by the tool set (edit/write
   *  freshness gate) and the external-change prober wired inside useAgent. */
  readonly readState?: import("@wudao/core").ReadStateTable;
  /** M37 §2: the session's file history (write_file/edit snapshots → /rewind).
   *  Absent → the App creates one per session id under
   *  .wudao/history/<session>/ (rotating with /clear); pass one to share an
   *  instance with a stubbed tool set in tests. */
  readonly fileHistory?: FileHistory;
  /** 夜移 032 stage-2: the session's net-change tracker (write_file/edit
   *  records, the driver's settle receipt renders it). Absent → the App
   *  creates one per session (the fileHistory sharing pattern); pass one to
   *  share an instance with a stubbed tool set in tests. */
  readonly turnDiff?: TurnDiffTracker;
  /** M35 §3: explicit keybindings (tests / alternative frontends). Absent →
   *  the App loads `.wudao/keybindings.json` once at mount (defaults when
   *  there is no file). */
  readonly keybindings?: ResolvedKeybindings;
  /** M45: the session's sidecar (auto-mode flash safety classifier). Absent
   *  (disabled via settings/env/flag) → the gate is exactly the pre-M45
   *  layered decision. Present → auto-mode write/exec calls classify first
   *  and high verdicts escalate through the same permission prompt. */
  readonly sidecar?: Sidecar;
  /** M59 §3: web runtime for the tool set (fetch caps + optional search). */
  readonly web?: import("../tools.js").WebToolsRuntime;
  /** M59 §2: web.allowDomains — the permission gate's pre-approval list. */
  readonly webAllowDomains?: readonly string[];
  /** M59 §3: the /doctor web node (search provider state). */
  readonly webDoctor?: import("../commands/doctor.js").WebDoctorInput;
  /** M64-A §A: the session's peer-messaging runtime (built by the
   *  entrypoint; present → list_agents/send_message join the tool set,
   *  deliveries ride the driver's steering lane, holds park as asks). */
  readonly peer?: PeerRuntime;
  /** M64-C §C: the team name (one team per session; default "default"). */
  readonly teamName?: string;
  /** SDD 2026-08-23 persona Task 3: per-provider persona binding read (the
   *  provider card's `persona` field). string = bound persona id; null =
   *  explicitly unbound; undefined = no card / no field (falls through the
   *  chain). The default stub is the TEST seam — production (index.ts runTui)
   *  supplies the real registry read (Task 4). */
  readonly readProviderPersonaBinding?: (providerId: string) => string | null | undefined;
  /** SDD 2026-08-23 persona Task 4: the global default persona id read
   *  (settings.json persona.id — the chain's last leg). Same seam contract:
   *  the stub default keeps direct-construction tests hermetic; index.ts
   *  passes the real settings read. */
  readonly readGlobalDefaultPersonaId?: () => string | undefined;
  /** 0.3.11（用户反馈：权限档两入口 1:1 联动）: the entry-resolved initial
   *  permission mode (CLI flag > persisted permissions.defaultMode). Same
   *  seam contract: absent = argv-only (hermetic direct-construction tests);
   *  index.ts runTui passes resolveInitialMode's production read. */
  readonly initialPermissionMode?: Mode;
}
