// M62 §7 — the misc settings keys (research 34's missing-key triage). One
// module owns every small resolver so index.ts threads them once at startup.
// Posture throughout: tolerant parsing (junk warns and falls back to the
// default, never fatal); effective merged settings in, resolved values out.
//
//   claudeMdExcludes    glob list — M54b loading skips matching context files
//                       (the loader warns on dead patterns).
//   autoCompactWindow   the window behind the 0.8× auto-compaction trigger,
//                       clamped 100k–1M; default = the env/context window.
//   autoCompactEnabled  master switch for AUTO compaction (manual /compact
//                       keeps working); default on.
//   memoryEnabled/memoryDirectory — the M49 store's switch + location.
//   mcpEnabled/mcpTimeouts        — the MCP master switch + timeouts.
//   lsp                 — the LSP tool's opt-in gate {enabled: false default}.
//   schedules.sleepGuardMs — near-fire sleep guard window (122 项 1; ms,
//                       0=off; default 10min).
//   schedules.launchAgent — LaunchAgent offline wake opt-in (122 项 2;
//                       default FALSE — fail-closed system footprint).
//   agents.aimdMaxConcurrent — the subagent fan-out ceiling under the AIMD
//                       gate (121 项 1; int 1..16; default = the kernel-policy
//                       static cap 3 — zero behavior change by default).
//   fallbackModel       ordered model chain — see providers' §7 seam.
//
// All scalar across tiers (the layered merge resolves precedence; project
// beats global, local beats project — §3).

import { resolve } from "node:path";
import {
  PYTHON_KERNEL_DEFAULT_IDLE_TIMEOUT_MS, DEFAULT_COMPACTION_THRESHOLD_RATIO, DEFAULT_COMPACTION_HEADROOM_TOKENS,
  resolveOutputReserveTokens,
} from "@wudao-org/core";
import { loadLayeredSettings } from "./settings-layer.js";
import { SCHEDULE_NEAR_FIRE_GUARD_MS } from "./schedules-model.js";
import { KERNEL_POLICY } from "./kernel-policy.js";

/** Parse `claudeMdExcludes` (string[]; junk entries dropped with a warning). */
export function parseClaudeMdExcludes(
  effective: Readonly<Record<string, unknown>> | undefined,
  warn: (m: string) => void = () => {},
): string[] {
  const raw = effective?.["claudeMdExcludes"];
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    warn('⚠️ settings: "claudeMdExcludes" must be an array of globs; ignored');
    return [];
  }
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string" || item.trim() === "") {
      warn("⚠️ settings: claudeMdExcludes entries must be non-empty strings; entry dropped");
      continue;
    }
    out.push(item.trim());
  }
  return out;
}

// ---------------------------------------------------------------------------
// autoCompactWindow + autoCompactEnabled (§7)
// ---------------------------------------------------------------------------

/** Spec clamp range for autoCompactWindow (tokens). */
export const AUTO_COMPACT_WINDOW_MIN = 100_000;
export const AUTO_COMPACT_WINDOW_MAX = 1_000_000;

export interface AutoCompactSettings {
  readonly enabled: boolean;
  /** The window the 0.8× trigger computes against — autoCompactWindow when
   *  configured (clamped), else the env/context window unchanged. */
  readonly windowTokens: number;
}

/** Resolve the auto-compaction settings. The 0.8× doctrine is untouched —
 *  this only opens the WINDOW and the switch to configuration. */
export function resolveAutoCompactSettings(
  effective: Readonly<Record<string, unknown>> | undefined,
  envWindowTokens: number,
  warn: (m: string) => void = () => {},
): AutoCompactSettings {
  const enabledRaw = effective?.["autoCompactEnabled"];
  let enabled = true;
  if (enabledRaw !== undefined) {
    if (typeof enabledRaw === "boolean") enabled = enabledRaw;
    else warn('⚠️ settings: "autoCompactEnabled" must be a boolean; using the default (on)');
  }
  const windowRaw = effective?.["autoCompactWindow"];
  if (windowRaw === undefined) return { enabled, windowTokens: envWindowTokens };
  if (typeof windowRaw !== "number" || !Number.isFinite(windowRaw) || windowRaw <= 0) {
    warn(`⚠️ settings: "autoCompactWindow" must be a positive token count (clamped ${AUTO_COMPACT_WINDOW_MIN}-${AUTO_COMPACT_WINDOW_MAX}); keeping ${envWindowTokens}`);
    return { enabled, windowTokens: envWindowTokens };
  }
  const clamped = Math.min(Math.max(Math.round(windowRaw), AUTO_COMPACT_WINDOW_MIN), AUTO_COMPACT_WINDOW_MAX);
  if (clamped !== windowRaw) {
    warn(`⚠️ settings: autoCompactWindow ${windowRaw} clamped to ${clamped} (allowed ${AUTO_COMPACT_WINDOW_MIN}-${AUTO_COMPACT_WINDOW_MAX})`);
  }
  return { enabled, windowTokens: clamped };
}

// ---------------------------------------------------------------------------
// memoryEnabled + memoryDirectory (§7 — the M49 store's knobs)
// ---------------------------------------------------------------------------

export interface MemorySettings {
  readonly enabled: boolean;
  /** Absolute store path (memoryDirectory resolved against the workspace
   *  root; default <root>/.wudao/memory.jsonl — the M49 location). */
  readonly path: string;
}

export function resolveMemorySettings(
  workspaceRoot: string,
  effective: Readonly<Record<string, unknown>> | undefined,
  warn: (m: string) => void = () => {},
): MemorySettings {
  let enabled = true;
  const enabledRaw = effective?.["memoryEnabled"];
  if (enabledRaw !== undefined) {
    if (typeof enabledRaw === "boolean") enabled = enabledRaw;
    else warn('⚠️ settings: "memoryEnabled" must be a boolean; using the default (on)');
  }
  const defaultPath = `${resolve(workspaceRoot)}/.wudao/memory.jsonl`;
  const dirRaw = effective?.["memoryDirectory"];
  if (dirRaw === undefined) return { enabled, path: defaultPath };
  if (typeof dirRaw !== "string" || dirRaw.trim() === "") {
    warn('⚠️ settings: "memoryDirectory" must be a non-empty path; using the default');
    return { enabled, path: defaultPath };
  }
  const dir = dirRaw.trim();
  const path = dir.endsWith(".jsonl") ? resolve(workspaceRoot, dir) : resolve(workspaceRoot, dir, "memory.jsonl");
  return { enabled, path };
}

// ---------------------------------------------------------------------------
// mcpEnabled (§7) — the master switch. Timeouts live in mcp/tools.ts
// (parseMcpTimeouts) next to the defaults they override.
// ---------------------------------------------------------------------------

export function resolveMcpEnabled(effective: Readonly<Record<string, unknown>> | undefined, warn: (m: string) => void = () => {}): boolean {
  const raw = effective?.["mcpEnabled"];
  if (raw === undefined) return true;
  if (typeof raw === "boolean") return raw;
  warn('⚠️ settings: "mcpEnabled" must be a boolean; using the default (on)');
  return true;
}

// ---------------------------------------------------------------------------
// P2-9（96 队列 #9）lsp.enabled — the LSP tool's opt-in gate. Default FALSE
// (fail-closed process surface: starting a language server is cost and attack
// area, so nothing spawns until the operator writes
// `"lsp": {"enabled": true}`). Junk reads as off, never fatal.
// ---------------------------------------------------------------------------

export function resolveLspEnabled(effective: Readonly<Record<string, unknown>> | undefined, warn: (m: string) => void = () => {}): boolean {
  const node = effective?.["lsp"];
  if (node === undefined) return false;
  if (typeof node !== "object" || node === null || Array.isArray(node)) {
    warn('⚠️ settings: "lsp" must be an object like {"enabled": true}; LSP stays off');
    return false;
  }
  const enabled = (node as Record<string, unknown>)["enabled"];
  if (enabled === undefined) return false;
  if (typeof enabled === "boolean") return enabled;
  warn('⚠️ settings: "lsp.enabled" must be a boolean; LSP stays off');
  return false;
}

// ---------------------------------------------------------------------------
// ω99-236: #6 — docSuite.enabled — the doc trio's opt-out gate (09-09 用户
// 指令 ①「你的这些xlsx等功能，都应该是插件，你不能整合到内核里」的使能门). Default
// TRUE — the OPPOSITE of lsp's fail-closed false: the Excel/Word/PPT twelve
// faces already ship and run with the product, so absence keeps them on
// (opt-out; every existing session keeps its exact tool list — the arc's
// 默认态字节零变 anchor). The lsp.enabled NESTED-node read shape, with the
// mcpEnabled junk tolerance (default-on gates read junk as the default with a
// warning, never fatal). The gate controls MOUNTING only (doc-suite.ts's
// createDocSuiteTools head → []); the rosters stay statically consumed
// (permission / file-receipt / log spreads are name lists, absent names are
// inert). Off takes effect on the NEXT session (no mid-session removal seam —
// a mid-session flip would shift tool-list bytes and break the prefix cache;
// restart to apply, the lsp boundary).
// ---------------------------------------------------------------------------

export function resolveDocSuiteEnabled(effective: Readonly<Record<string, unknown>> | undefined, warn: (m: string) => void = () => {}): boolean {
  const node = effective?.["docSuite"];
  if (node === undefined) return true;
  if (typeof node !== "object" || node === null || Array.isArray(node)) {
    warn('⚠️ settings: "docSuite" must be an object like {"enabled": false}; the doc suite stays on');
    return true;
  }
  const enabled = (node as Record<string, unknown>)["enabled"];
  if (enabled === undefined) return true;
  if (typeof enabled === "boolean") return enabled;
  warn('⚠️ settings: "docSuite.enabled" must be a boolean; the doc suite stays on');
  return true;
}

// ---------------------------------------------------------------------------
// P2-12（96 队列 #12）terminal.enabled — the PTY terminal tool's opt-in gate.
// Default FALSE (fail-closed process surface: a persistent shell is cost and
// attack area, so nothing spawns until the operator writes
// `"terminal": {"enabled": true}`). Junk reads as off, never fatal.
// ---------------------------------------------------------------------------

export function resolveTerminalEnabled(effective: Readonly<Record<string, unknown>> | undefined, warn: (m: string) => void = () => {}): boolean {
  const node = effective?.["terminal"];
  if (node === undefined) return false;
  if (typeof node !== "object" || node === null || Array.isArray(node)) {
    warn('⚠️ settings: "terminal" must be an object like {"enabled": true}; the terminal tool stays off');
    return false;
  }
  const enabled = (node as Record<string, unknown>)["enabled"];
  if (enabled === undefined) return false;
  if (typeof enabled === "boolean") return enabled;
  warn('⚠️ settings: "terminal.enabled" must be a boolean; the terminal tool stays off');
  return false;
}

// ---------------------------------------------------------------------------
// 114 取证弧 — pythonKernel.idleTimeoutMs：持久 Python kernel 的空闲回收
// 窗口。工具本体零门控常挂（run_script 同款——它是纯计算车道，不是新进
// 程面门控对象）；这里只开 idle 窗到配置。0=永不 idle 回收（进程退出钩
// 仍然兜底——kernel 不比 harness 进程活得久）。misc 家族同款容忍姿势：
// malformed/错型 → warning + 缺省，never fatal。
// ---------------------------------------------------------------------------

export interface PythonKernelSettings {
  /** 空闲回收窗口（ms）；0=永不（进程退出钩兜底）。 */
  readonly idleTimeoutMs: number;
}

export const DEFAULT_PYTHON_KERNEL_SETTINGS: PythonKernelSettings = {
  idleTimeoutMs: PYTHON_KERNEL_DEFAULT_IDLE_TIMEOUT_MS, // 单一真值点：core 常量（15min）
};

/** node 级孪生（session-engine 已持 layered effective map 时用这个）。 */
export function pythonKernelSettingsFromNode(
  node: unknown,
  warn: (m: string) => void = () => {},
): PythonKernelSettings {
  if (node === undefined) return DEFAULT_PYTHON_KERNEL_SETTINGS;
  if (node === null || typeof node !== "object" || Array.isArray(node)) {
    warn('⚠️ .wudao/settings.json: "pythonKernel" must be an object; defaults applied');
    return DEFAULT_PYTHON_KERNEL_SETTINGS;
  }
  const record = node as Record<string, unknown>;
  const unknown = Object.keys(record).filter((k) => k !== "idleTimeoutMs");
  if (unknown.length > 0) {
    warn(`⚠️ .wudao/settings.json: unknown pythonKernel key(s) ignored: ${unknown.join(", ")}`);
  }
  const raw = record["idleTimeoutMs"];
  if (raw === undefined) return DEFAULT_PYTHON_KERNEL_SETTINGS;
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0) {
    warn('⚠️ pythonKernel.idleTimeoutMs must be a non-negative integer (0 disables idle reaping); using the default');
    return DEFAULT_PYTHON_KERNEL_SETTINGS;
  }
  return { idleTimeoutMs: raw };
}

/** boot 路径一把读：layered settings → pythonKernel 节点（stream-idle-config
 *  同款 Loader contract）。 */
export async function loadPythonKernelSettings(
  workspaceRoot: string,
  warn: (m: string) => void = () => {},
): Promise<PythonKernelSettings> {
  const layered = await loadLayeredSettings(workspaceRoot);
  return pythonKernelSettingsFromNode(layered.effective["pythonKernel"], warn);
}

// ---------------------------------------------------------------------------
// tools.defer (§6) — the settings node {tools: {defer: "auto"|"on"|"off"}}.
// ---------------------------------------------------------------------------

/** Read `tools.defer` from the effective record (tolerant; undefined when
 *  absent/malformed — the default "auto" applies downstream). */
export function readDeferModeSetting(
  toolsNode: unknown,
  warn: (m: string) => void = () => {},
): "auto" | "on" | "off" | undefined {
  if (typeof toolsNode !== "object" || toolsNode === null || Array.isArray(toolsNode)) return undefined;
  const tools = toolsNode as Record<string, unknown>;
  const raw = (tools as Record<string, unknown>)["defer"];
  if (raw === undefined) return undefined;
  if (raw === "auto" || raw === "on" || raw === "off") return raw;
  warn('⚠️ settings: tools.defer must be "auto" | "on" | "off"; using the default (auto)');
  return undefined;
}

// ---------------------------------------------------------------------------
// 122 项 1/项 2 — schedules 节点：sleepGuardMs（临火睡眠守卫的窗，ms）+
// launchAgent（LaunchAgent 离线唤起，bool）。守护在最近一次 fire 进窗时持有
// caffeinate 断言（等火期间 Mac 不入睡）；launchAgent 打开后守护把
// 「下一次有任何火」同步进用户域 launchd plist（应用完全关闭时到点由系统
// 拉起——见 docs/research/122-launchagent-design.md）。缺省：窗 10min（域常
// 量 SCHEDULE_NEAR_FIRE_GUARD_MS）、launchAgent 关（fail-closed 家族——向
// ~/Library/LaunchAgents/ 写文件是用户可见的系统足迹，必须显式 opt-in）。
// misc 家族同款容忍姿势：malformed/错型 → warning + 缺省，never fatal。
// sleepGuardMs 的 0=显式关（合法值，不是垃圾）。
// ---------------------------------------------------------------------------

export interface SchedulesSettings {
  /** 临火窗（ms）；0=关。 */
  readonly nearFireMs: number;
  /** 离线唤起（LaunchAgent）；缺省关。 */
  readonly launchAgent: boolean;
}

export const DEFAULT_SCHEDULES_SETTINGS: SchedulesSettings = {
  nearFireMs: SCHEDULE_NEAR_FIRE_GUARD_MS, // 单一真值点：域常量（10min）
  launchAgent: false,
};

/** node 级解析（boot 路径已持 layered effective map 时用这个）。122 项 2 起
 *  是 schedules 节点的唯一解析器——sleepGuard 的旧门面委托到这里（警告语
 *  字节不变，见 omega99/122 测试钉）。 */
export function schedulesSettingsFromNode(
  node: unknown,
  warn: (m: string) => void = () => {},
): SchedulesSettings {
  if (node === undefined) return DEFAULT_SCHEDULES_SETTINGS;
  if (node === null || typeof node !== "object" || Array.isArray(node)) {
    warn('⚠️ .wudao/settings.json: "schedules" must be an object; defaults applied');
    return DEFAULT_SCHEDULES_SETTINGS;
  }
  const record = node as Record<string, unknown>;
  const unknown = Object.keys(record).filter((k) => k !== "sleepGuardMs" && k !== "launchAgent");
  if (unknown.length > 0) {
    warn(`⚠️ .wudao/settings.json: unknown schedules key(s) ignored: ${unknown.join(", ")}`);
  }
  let launchAgent = false;
  const launchRaw = record["launchAgent"];
  if (launchRaw !== undefined) {
    if (typeof launchRaw === "boolean") launchAgent = launchRaw;
    else warn('⚠️ schedules.launchAgent must be a boolean (offline wake stays off); using the default');
  }
  const raw = record["sleepGuardMs"];
  if (raw === undefined) return { ...DEFAULT_SCHEDULES_SETTINGS, launchAgent };
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0) {
    warn('⚠️ schedules.sleepGuardMs must be a non-negative integer of ms (0 disables the near-fire sleep guard); using the default');
    return { ...DEFAULT_SCHEDULES_SETTINGS, launchAgent };
  }
  return { nearFireMs: raw, launchAgent };
}

export interface ScheduleSleepGuardSettings {
  /** 临火窗（ms）；0=关。 */
  readonly nearFireMs: number;
}

export const DEFAULT_SCHEDULE_SLEEP_GUARD_SETTINGS: ScheduleSleepGuardSettings = {
  nearFireMs: SCHEDULE_NEAR_FIRE_GUARD_MS, // 单一真值点：域常量（10min）
};

/** 122 项 1 的旧门面（ui.ts 的既有读面）——委托组合解析器，只取窗；行为与
 *  警告语字节不变（launchAgent 是已知键，不再误报 unknown）。 */
export function scheduleSleepGuardFromNode(
  node: unknown,
  warn: (m: string) => void = () => {},
): ScheduleSleepGuardSettings {
  const { nearFireMs } = schedulesSettingsFromNode(node, warn);
  return { nearFireMs };
}

/** boot 路径一把读：layered settings → schedules 节点（pythonKernel 同款
 *  Loader contract）。 */
export async function loadSchedulesSettings(
  workspaceRoot: string,
  warn: (m: string) => void = () => {},
): Promise<SchedulesSettings> {
  const layered = await loadLayeredSettings(workspaceRoot);
  return schedulesSettingsFromNode(layered.effective["schedules"], warn);
}

/** 122 项 1 的旧加载门面——委托组合加载器，只取窗。 */
export async function loadScheduleSleepGuardSettings(
  workspaceRoot: string,
  warn: (m: string) => void = () => {},
): Promise<ScheduleSleepGuardSettings> {
  const { nearFireMs } = await loadSchedulesSettings(workspaceRoot, warn);
  return { nearFireMs };
}

// ---------------------------------------------------------------------------
// agents (121 项 1) — the subagent fan-out ceiling under the AIMD gate.
// ---------------------------------------------------------------------------

export interface AgentsSettings {
  /** The AIMD gate's ceiling = the registry's effective static cap. Default
   *  = kernel-policy's maxConcurrent (3): with no setting the gate is born at
   *  the exact pre-121 operating point (zero behavior change by default). */
  readonly aimdMaxConcurrent: number;
}

/** Ceiling bounds — the same clamp the session registry applies
 *  (1..HARD_MAX_CONCURRENT), so a settings value can never exceed what an
 *  explicit programmatic cap could. */
export const AGENTS_AIMD_MAX_MIN = 1;
export const AGENTS_AIMD_MAX_MAX = 16;

export const DEFAULT_AGENTS_SETTINGS: AgentsSettings = {
  aimdMaxConcurrent: KERNEL_POLICY.registry.maxConcurrent, // 单一真值点：kernel-policy 的静态帽（缺省=零行为变化）
};

export function agentsSettingsFromNode(
  node: unknown,
  warn: (m: string) => void = () => {},
): AgentsSettings {
  if (node === undefined) return DEFAULT_AGENTS_SETTINGS;
  if (node === null || typeof node !== "object" || Array.isArray(node)) {
    warn('⚠️ .wudao/settings.json: "agents" must be an object; defaults applied');
    return DEFAULT_AGENTS_SETTINGS;
  }
  const record = node as Record<string, unknown>;
  const unknown = Object.keys(record).filter((k) => k !== "aimdMaxConcurrent");
  if (unknown.length > 0) {
    warn(`⚠️ .wudao/settings.json: unknown agents key(s) ignored: ${unknown.join(", ")}`);
  }
  const raw = record["aimdMaxConcurrent"];
  if (raw === undefined) return DEFAULT_AGENTS_SETTINGS;
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < AGENTS_AIMD_MAX_MIN || raw > AGENTS_AIMD_MAX_MAX) {
    warn(`⚠️ agents.aimdMaxConcurrent must be an integer in [${AGENTS_AIMD_MAX_MIN}, ${AGENTS_AIMD_MAX_MAX}] (the subagent fan-out ceiling); using the default`);
    return DEFAULT_AGENTS_SETTINGS;
  }
  return { aimdMaxConcurrent: raw };
}

/** boot 路径一把读：layered settings → agents 节点（schedules 同款 Loader
 *  contract；生产面由 session-engine 读入后传入 createSessionRegistry）。 */
export async function loadAgentsSettings(
  workspaceRoot: string,
  warn: (m: string) => void = () => {},
): Promise<AgentsSettings> {
  const layered = await loadLayeredSettings(workspaceRoot);
  return agentsSettingsFromNode(layered.effective["agents"], warn);
}

// ---------------------------------------------------------------------------
// 125 项 1（dsh resolveCompactSpec 形）— compaction 节点：thresholdRatio +
// headroomTokens。缺省 0.8 / 2048 = 预留感知公式只在 outputReserve 在场时才
// 改变触发线（reserve 缺席 → 平比，字节不变）。misc 家族同款容忍姿势：
// malformed/错型 → warning + 缺省，never fatal。
// ---------------------------------------------------------------------------

export interface CompactionSettings {
  /** 平比帽（threshold = min(ratio×window, window − reserve − headroom) 的
   *  第一项）；缺省 0.8（M24 行为锚点）。 */
  readonly thresholdRatio: number;
  /** 触发线之下的固定安全余量（token）；缺省 2048。 */
  readonly headroomTokens: number;
}

export const DEFAULT_COMPACTION_SETTINGS: CompactionSettings = {
  // 单一真值点：core 的常量（misc 家族不复制数字——pythonKernel 先例）。
  thresholdRatio: DEFAULT_COMPACTION_THRESHOLD_RATIO,
  headroomTokens: DEFAULT_COMPACTION_HEADROOM_TOKENS,
};

export function compactionSettingsFromNode(
  node: unknown,
  warn: (m: string) => void = () => {},
): CompactionSettings {
  if (node === undefined) return DEFAULT_COMPACTION_SETTINGS;
  if (node === null || typeof node !== "object" || Array.isArray(node)) {
    warn('⚠️ .wudao/settings.json: "compaction" must be an object; defaults applied');
    return DEFAULT_COMPACTION_SETTINGS;
  }
  const record = node as Record<string, unknown>;
  const unknown = Object.keys(record).filter((k) => k !== "thresholdRatio" && k !== "headroomTokens");
  if (unknown.length > 0) {
    warn(`⚠️ .wudao/settings.json: unknown compaction key(s) ignored: ${unknown.join(", ")}`);
  }
  const ratioRaw = record["thresholdRatio"];
  let thresholdRatio = DEFAULT_COMPACTION_SETTINGS.thresholdRatio;
  if (ratioRaw !== undefined) {
    if (typeof ratioRaw !== "number" || !Number.isFinite(ratioRaw) || ratioRaw <= 0 || ratioRaw > 1) {
      warn('⚠️ compaction.thresholdRatio must be a number in (0, 1]; using the default (0.8)');
    } else {
      thresholdRatio = ratioRaw;
    }
  }
  const headroomRaw = record["headroomTokens"];
  let headroomTokens = DEFAULT_COMPACTION_SETTINGS.headroomTokens;
  if (headroomRaw !== undefined) {
    if (typeof headroomRaw !== "number" || !Number.isInteger(headroomRaw) || headroomRaw < 0) {
      warn('⚠️ compaction.headroomTokens must be a non-negative integer of tokens; using the default (2048)');
    } else {
      headroomTokens = headroomRaw;
    }
  }
  return { thresholdRatio, headroomTokens };
}

/** boot 路径一把读：layered settings → compaction 节点（schedules 同款
 * Loader contract；生产面由各前端装进 loop 的 compaction 选项）。 */
export async function loadCompactionSettings(
  workspaceRoot: string,
  warn: (m: string) => void = () => {},
): Promise<CompactionSettings> {
  const layered = await loadLayeredSettings(workspaceRoot);
  return compactionSettingsFromNode(layered.effective["compaction"], warn);
}

/** 125 项 1 的装配缝：live ProviderConfig（/model //provider 切换后重读）+
 * misc 设置 → loop compaction 选项的三个新字段。预留解析走 core 的
 * resolveOutputReserveTokens（windowMode 已画像且请求帽已知 → reserve =
 * maxTokens；unknown/无帽 → 缺席 = 平比，零行为变化）。 */
export function compactionThresholdFields(
  config: { readonly maxTokens?: number; readonly windowMode?: import("@wudao-org/core").CompactionWindowMode },
  settings: CompactionSettings,
): { readonly thresholdRatio: number; readonly headroomTokens: number; readonly outputReserveTokens?: number } {
  const outputReserveTokens = resolveOutputReserveTokens(config.maxTokens, config.windowMode);
  return {
    thresholdRatio: settings.thresholdRatio,
    headroomTokens: settings.headroomTokens,
    ...(outputReserveTokens !== undefined ? { outputReserveTokens } : {}),
  };
}

// ---------------------------------------------------------------------------
// fallbackModel (§7) — the ordered chain threaded into ProviderConfig.
// ---------------------------------------------------------------------------

export function parseFallbackModels(
  effective: Readonly<Record<string, unknown>> | undefined,
  warn: (m: string) => void = () => {},
): string[] {
  const raw = effective?.["fallbackModel"];
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    warn('⚠️ settings: "fallbackModel" must be an ordered array of model names; ignored');
    return [];
  }
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string" || item.trim() === "") {
      warn("⚠️ settings: fallbackModel entries must be non-empty strings; entry dropped");
      continue;
    }
    out.push(item.trim());
  }
  return out;
}

