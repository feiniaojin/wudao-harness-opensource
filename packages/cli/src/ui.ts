// `wudao ui` — the localhost web frontend (M43-A §2/Task 5): the AgentDriver
// wired exactly like the TUI's app.tsx (model/registry/tools/gates/persistence
// seams), minus React — the WS server relays the driver to the browser. The
// flag chain (buildRunPlan / resolveSession / recordModelState) stays in
// index.ts, shared with the TUI path; this module owns the server lifecycle.
// M60: the session wiring itself lives in driver/session-engine.ts (shared
// with the Slack interface); startUiSession composes engine + WS server.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createAskUserTool, createJsonlSessionStore, activeBranchLeafKey, applySummaryMarkers, repairOrphanedToolCalls, resumeChain } from "@wudao/core";
import type { AgentMessage, LoopGates, ModelClient, SessionLeaseBox, Tool } from "@wudao/core";
import type { ProviderConfig } from "@wudao/providers";
import { createUiServer } from "@wudao/server";
import type { UiServer } from "@wudao/server";
// ω99-242 — 中断任务自动续跑：boot 恢复协调器（journal=append-only JSONL +
// 观察-分类-认领-限流 + graceful shutdown checkpoint）。M24 声明：恢复注入发
// 生在 resume 边界=冷转预期（cold turn expected）——细节见 recovery-admission.ts
// 头注与弧报告 §一。
import { createRecoveryCoordinator } from "@wudao/server";
import { createRecoveryPort } from "./recovery-admission.js";
import { createScheduleDaemon, SCHEDULES_SESSION_ID, scheduleWakeRequested } from "./schedules.js";
import type { ScheduleDaemon } from "./schedules.js";
import { loadSchedulesSettings } from "./misc-config.js";
import type { AgentDriver } from "./driver/agent-driver.js";
import { createDriverSession, type DriverSession, type DriverSessionOptions } from "./driver/session-engine.js";
// M63 §B: the settings/credentials ops behind the web settings page.
import { withSettingsOps, readGlobalDefaultPersonaId } from "./driver/settings-ops.js";
// 借鉴弧 α1/α2 — the ask lane (ask_user clarification cards over the wire)
// + the recall op mount (both OPTIONAL UiDriverPort members the wrapper adds).
import { createAskUserLane } from "./driver/ask-user-park.js";
// SDD 2026-08-23 persona Task 4 — the REAL persona-chain reads: the web
// entry supplies them (the session-engine prop defaults stay test stubs).
import { readProviderPersonaBinding } from "./driver/provider-registry-ops.js";
import type { AgentRegistry, RosterPluginAgent } from "./agents/index.js";
import type { LoadedSkill } from "./skills.js";
import type { PluginCommand } from "./plugins.js";
import type { ExtensionRuntime } from "./extensions/api.js";
import type { Sidecar } from "./sidecar.js";
import { readGlobalDefaultPermissionMode, readGlobalSettingsSync } from "./settings-layer.js";
import { VERSION } from "./version.js";
import { modelLabel } from "./log.js";
import { LaneManager, createLaneManager } from "./driver/lane-manager.js";
// PB-2（探针基础设施弧）— 进程内 ProbeBus 单例挂上 server（三读面 op +
// {t:"probe"} 帧）；设置 probe.auditFile 开 JSONL 审计（缺省关：零写零帧）。
import { getDefaultProbeBus, setupProbeAudit } from "./probe.js";

export interface RunUiProps {
  readonly config: ProviderConfig;
  readonly workspaceRoot: string;
  /** workspace-ux B2: the caller's switchable agent-root box (index.ts hands
   *  its hookWorkspaceRoot). Flows to the session engine — the tool set and
   *  the driver share it. Absent → a private box pinned to workspaceRoot. */
  readonly agentRootBox?: { current: string };
  readonly contextWindowTokens: number;
  /** Provider management §7: the per-model window resolver — flows to the
   *  session engine so /provider switches re-resolve the compaction window
   *  knob-aware. Absent → the engine's knob-less chain. */
  readonly resolveWindowTokens?: (provider: string | undefined, model: string) => number;
  /** M62 §7: the auto-compaction master switch (session settings). */
  readonly compactionEnabled?: boolean;
  /** Resumed history (already applySummaryMarkers/repair-processed); seeds state.messages. */
  readonly resumeHistory?: AgentMessage[];
  readonly sessionId?: string;
  /** ω99-211: fresh-mint boot id → the engine defers the session file's
   *  materialization (boot bookkeeping) to the first user submit, so an
   *  abandoned entry leaves no empty session row. Flows straight into
   *  DriverSessionOptions.sessionFresh (see session-engine.ts). */
  readonly sessionFresh?: boolean;
  /** Test seam: scripted model in place of createProvider(config). */
  readonly modelOverride?: ModelClient;
  /** Test seam: stub tools in place of the full workspace tool set. */
  readonly tools?: readonly Tool[];
  /** Sandbox shell (M21); applied to shell only, fail-closed in core. */
  readonly sandbox?: { readonly image?: string };
  /** .wudao/settings.json-configured hooks (M19); forwarded to the loop.
   *  M63-A: also carries the session-surface events the driver fires. */
  readonly hooks?: import("@wudao/core").AgentHooks;
  /** M63-A: the SessionStart source at driver creation ("fork" for
   *  --fork-session); absent → derived from resumeHistory. Flows through the
   *  DriverSessionOptions spread below. */
  readonly sessionStartSource?: import("@wudao/core").SessionStartSource;
  /** M63-B: FileChanged watch targets (onFileChanged plain matchers). */
  readonly fileChangeTargets?: readonly string[];
  /** M63-B: the skills root for the skills-position ConfigChange face. */
  readonly configSkillsPath?: string;
  /** M63-C §3: the asyncRewake sink holder (flows to the driver). */
  readonly rewakeSink?: { current?: (message: string) => void };
  /** M63-C R1: the fire-runtime view + prompt_id box (flow to the driver — the skill-position compile is contract-complete). */
  readonly hookRuntime?: import("./hooks-config.js").NonNeverRuntime;
  readonly promptIdBox?: { current?: string };
  /** M63-C R1 follow-up: the live session id box (see agent-driver options). */
  readonly sessionIdBox?: { current?: string };
  /** R6-I1: the driver installs its notice sink here (hook warn output). */
  readonly hookWarnSink?: { current?: (message: string) => void };
  /** P1-5 (96 队列): boot-time notices appended to the driver's history at
   *  construction (the workspace-trust suppression notice when active). */
  readonly bootNotices?: readonly string[];
  /** P1-5 (96 队列): the workspace-trust gate's live getter feeding the
   *  permission settings watcher (absent = no gate). */
  readonly trustSuppressed?: () => boolean;
  /** MCP + extension tools — appended after the builtin set. */
  readonly extraTools?: readonly Tool[];
  /** 夜移 018 (延迟预取 wudao 适配): the UNAWAITED MCP-tool load the caller
   *  started before boot — the server listens and the web UI paints without
   *  waiting on server handshakes; resolving feeds the driver's addTools
   *  seam (idle append, or run-settle parking). */
  readonly deferredTools?: Promise<readonly Tool[]>;
  /** M23 long-task stop gates. */
  readonly gates?: LoopGates;
  /** M23 turn fuse. Falls back to the version default. */
  readonly maxTurns?: number;
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
  readonly readState?: import("@wudao/core").ReadStateTable;
  /** M46 §1: write-verify config injected into the core write tools. */
  readonly writeVerify?: import("@wudao/core").WriteVerifyConfig;
  /** M46 §2: long-output shaping config for shell. */
  readonly longOutput?: import("@wudao/core").LongOutputConfig;
  /** M59 §3: web runtime for the tool set (fetch caps + optional search). */
  readonly web?: import("./tools.js").WebToolsRuntime;
  /** M59 §2: web.allowDomains — the permission gate's pre-approval list. */
  readonly webAllowDomains?: readonly string[];
  /** M59 §3: the /doctor web node (search provider state). */
  readonly webDoctor?: import("./commands/doctor.js").WebDoctorInput;
  /** M45: the session's sidecar (auto-mode flash classifier). Absent → the
   *  pre-M45 gate; present → high verdicts/breaker escalations park as
   *  pendingPermission carrying the sidecar reason. */
  readonly sidecar?: Sidecar;
  /** --ui-port (0/absent = ephemeral). */
  readonly port?: number;
  /** Open the browser (default: darwin). */
  readonly openBrowser?: boolean;
  /** The built web frontend's directory (default: probe packages/web/dist). */
  readonly staticDir?: string;
  /** Print the banner (default true; tests pass false). */
  readonly announce?: boolean;
  /** ω99-235 (用户四指令 ②「你在小精灵的会话和主窗口应该是独立和隔离的」):
   *  mount the pet lane — a SECOND, isolated driver session (fixed id "pet",
   *  own pet.jsonl, own run state machine, own permission card, own status in
   *  the state frame's `pet` field). 缺省 false：既有调用/夹具零扰动；runUi
   *  显式传 true。车道锁被占（另一进程的精灵车道活着）→ 车道禁用 + 一行诚实
   *  stderr，不阻主窗（server 的 pet ops 得干净 "unsupported"，web relay 降级
   *  主车道 = 今日行为）。 */
  readonly petLane?: boolean;
  /** ω99-235: test seam — the pet lane's scripted model (镜像 modelOverride；
   *  absent → falls back to modelOverride). */
  readonly petModelOverride?: ModelClient;
}

export interface UiSession {
  readonly driver: AgentDriver;
  readonly server: UiServer;
  readonly registry: AgentRegistry;
  /** M61 §4: the durable scheduling daemon this process hosts. */
  readonly schedules: ScheduleDaemon;
  /** ω99-235: the pet lane's driver — present iff petLane:true AND the lane
   *  lock was acquirable (occupied → absent: the pet ops degrade to a clean
   *  "unsupported" and the web relay falls back to the main lane). */
  readonly petDriver?: AgentDriver;
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// ω99-235: #2 — the pet lane (小精灵会话隔离). 车道即隔离单位：pet 不是主
// driver 的一个输入源，而是同进程第二 driver session。本文件自有：固定 id、
// 原始车道锁、no-op 租约盒、startUiSession 的第二会话装配（降配清单+mode 钳
// 制）。引擎侧三缝见 session-engine.ts #1；runUi 调用点见 index.ts #3。
// ---------------------------------------------------------------------------

/** ω99-235 — the pet lane's fixed session id（schedules.ts:28
 *  SCHEDULES_SESSION_ID 同款注释范式：固定短 id 合法——store.ts 的
 *  SESSION_ID_RE 放行、appendEntry 只拒 side- 前缀），所以精灵自己的 JSONL 就是
 *  同一 sessions 目录下的 pet.jsonl——历史可见免费：store.list() 收一切非
 *  side- 的 *.jsonl，pet.jsonl 自动进主窗会话列表（server 给该行标
 *  lane:"pet"）。 */
export const PET_SESSION_ID = "pet";

/** ω99-235 — the pet lane's boot lease: a RAW exclusive-create of the same
 *  .leases/pet.json the core lease machinery writes (identical payload shape
 *  {pid, at, gen}, so every foreign process's readLock/isAlive/dead-pid-steal
 *  logic applies verbatim), deliberately NOT registered in the process-global
 *  `held` registry behind acquireSessionLease: THIS process's main lane must
 *  see the pet lock as a live FOREIGN holder (resume("pet") → occupied, the
 *  ω99-225 三态真话) — a registry entry would make the same-process re-acquire
 *  idempotent (ok:true) and let the main driver ADOPT a live pet session.
 *  Symmetric root cause: the memoized root box tracks ONE current id — a
 *  second session through it would release the main lane's lease at every
 *  acquire (ping-pong); the pet driver therefore rides the no-op box below
 *  (its whole-lifetime protection IS this raw lock — the pet lane never
 *  rotates ids). Stale holders are stolen by rename+read-back (the core
 *  lease's exact posture). No unlink on close by the 09-09 red-line
 *  discipline: the lock's gen survives until the process dies and the next
 *  boot's dead-pid steal recovers it — the same recovery path a crashed
 *  holder always had. */
type PetLaneLock = { readonly ok: true } | { readonly ok: false; readonly holderPid: number };

async function readLaneLock(path: string): Promise<{ pid: number; at: string; gen: string } | undefined> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as { pid?: unknown; at?: unknown; gen?: unknown };
    if (typeof parsed.pid !== "number" || typeof parsed.at !== "string" || typeof parsed.gen !== "string") return undefined;
    return { pid: parsed.pid, at: parsed.at, gen: parsed.gen };
  } catch {
    return undefined; // unreadable/corrupt — the fail-safe reading is STALE (steal)
  }
}

function lanePidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM"; // EPERM = exists, another user
  }
}

async function acquirePetLaneLock(sessionsDir: string): Promise<PetLaneLock> {
  const dir = join(sessionsDir, ".leases");
  const path = join(dir, `${PET_SESSION_ID}.json`);
  const gen = randomUUID();
  const payload = JSON.stringify({ pid: process.pid, at: new Date().toISOString(), gen });
  await mkdir(dir, { recursive: true });
  try {
    await writeFile(path, payload, { flag: "wx" });
    return { ok: true };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; // infrastructure → 上抛（诚实）
    const lock = await readLaneLock(path);
    if (lock !== undefined && lanePidAlive(lock.pid)) return { ok: false, holderPid: lock.pid };
    // Stale (dead holder / junk bytes) — steal by rename + read-back: a
    // concurrent stealer that won the rename keeps its lock, we see its live
    // pid and refuse (our temp is consumed by the rename itself).
    const temp = join(dir, `.steal-${gen}.json`);
    await writeFile(temp, payload, "utf8");
    await rename(temp, path);
    const back = await readLaneLock(path);
    return back !== undefined && back.gen === gen ? { ok: true } : { ok: false, holderPid: back?.pid ?? 0 };
  }
}

/** ω99-235 — the pet lane's no-op lease box: the cross-process guard is the
 *  raw lane lock above (held for the process lifetime); the box hands the
 *  driver's run gate an always-ok lease so the pet lane never touches the
 *  root-memoized box (whose single `current` would ping-pong between the two
 *  lanes' acquires — see acquirePetLaneLock's comment). */
const PET_LANE_LEASE_BOX: SessionLeaseBox = {
  acquire: async () => ({ ok: true, lease: { sessionId: PET_SESSION_ID, release: async () => {} } }),
  rotate: () => {},
  heldNow: () => undefined,
  release: async () => {},
};

/** --ui-port <n>: 1-65535. Absent → undefined (ephemeral); malformed → throw. */
export function parseUiPort(argv: readonly string[]): number | undefined {
  const idx = argv.indexOf("--ui-port");
  if (idx === -1) return undefined;
  const raw = argv[idx + 1];
  const n = Number(raw);
  if (raw === undefined || !Number.isInteger(n) || n < 1 || n > 65535) {
    throw new Error(`--ui-port needs a port number 1-65535 (got "${raw ?? ""}")`);
  }
  return n;
}

// The web build, when it exists (v1-A serves the placeholder otherwise).
async function probeStaticDir(): Promise<string | undefined> {
  // M43-C: standalone packaging (the desktop sidecar) can't probe relative to
  // dist/ — the SEA entry extracts the embedded web build and names it here.
  // Purely an override: unset/invalid falls through to the probe below.
  const override = process.env.WUDAO_UI_STATIC_DIR;
  if (override !== undefined && override !== "") {
    try {
      const info = await stat(override);
      if (info.isDirectory()) return override;
    } catch {
      // fall through to the packaged-dist probe
    }
  }
  const candidate = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "web", "dist");
  try {
    const info = await stat(candidate);
    return info.isDirectory() ? candidate : undefined;
  } catch {
    return undefined;
  }
}

function openOnMacOS(url: string): void {
  if (process.platform !== "darwin") return;
  try {
    spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
  } catch {
    // Opening the browser is best-effort; the printed URL is the contract.
  }
}

export async function startUiSession(props: RunUiProps): Promise<UiSession> {
  const { config, workspaceRoot } = props;
  // M60: the session wiring (gate stack, tool set, persistence, probers) is
  // the shared engine — the web frontend asks park as pendingPermission (no
  // askRelay) exactly as before the extraction.
  // M61 §4: the durable scheduling daemon — THIS resident process is the
  // scheduling host. Created before the driver (the driver routes /schedule
  // and /doctor to it); its notifications land in the driver's history (the
  // web statusline channel), run results append to the dedicated "schedules"
  // session log.
  const schedulesStore = createJsonlSessionStore(join(workspaceRoot, ".wudao", "sessions"));
  const scheduleNotify: { notify?: (line: string) => void } = {};
  // ω99-313: the bound-session continue lane's late-bound seams — the daemon
  // is created BEFORE the driver, so the fire-time reads go through this box
  // (the notify twin's discipline).
  const scheduleExec: {
    continueRun?: (id: string) => Promise<{ readonly started: boolean }>;
    isBusy?: () => boolean;
    lastActivityAt?: () => number;
  } = {};
  // 122 项 1 — 临火睡眠守卫窗（misc 家族：schedules.sleepGuardMs，缺省
  // 10min、0=关；malformed→warning+缺省，never fatal）。等火期间 Mac 不
  // 入睡——「一定能唤起执行」的睡眠半边；读一次、随守护走。
  // 122 项 2 — 离线唤起（schedules.launchAgent，缺省关）：daemon 的
  // reconcile 每轮 live 读设置（设置页开关落地后 ≤ 一个 tick 生效，无需
  // 重启）；这里读一次只是为了跟守卫窗共用同一次 layered 读。
  const schedulesSettings = await loadSchedulesSettings(workspaceRoot);
  const schedules = await createScheduleDaemon({
    workspaceRoot,
    nearFireGuardMs: schedulesSettings.nearFireMs,
    launchAgent: {
      readEnabled: async () => (await loadSchedulesSettings(workspaceRoot)).launchAgent,
    },
    notify: (line) => {
      // Late-bound: the driver exists by the time a fire can land.
      scheduleNotify.notify?.(line);
    },
    appendRun: async (entry) => {
      await schedulesStore.appendEntry(SCHEDULES_SESSION_ID, entry);
    },
    continueRun: (id) => scheduleExec.continueRun?.(id) ?? Promise.resolve({ started: false }),
    isBusy: () => scheduleExec.isBusy?.() ?? false,
    lastActivityAt: () => scheduleExec.lastActivityAt?.() ?? Date.now(),
  });
  // 0.3.11（用户反馈：权限档两入口 1:1 联动）：持久默认档从全局层读入（CLI
  // 旗标在引擎内仍最高）。The engine's prop default stays inert (hermetic
  // direct-construction tests); THIS is the production read. ω99-235: read
  // ONCE — the pet lane's clamp below reads the same value.
  const globalDefaultMode = readGlobalDefaultPermissionMode(readGlobalSettingsSync());
  // 借鉴弧 α1 — the clarification lane: ask_user rides the MAIN session's
  // top-level tail (outside the child pool, the M34 §1 placement discipline).
  // The park is created first so the tool's seam can close over it; the port
  // wrapper below mounts the card on the state frames + the answer op.
  const askLane = createAskUserLane();
  const session = await createDriverSession({
    ...(props as DriverSessionOptions),
    defaultPermissionMode: globalDefaultMode,
    // SDD 2026-08-23 persona Task 4 — the production chain reads (the engine's
    // prop defaults stay test stubs).
    readProviderPersonaBinding,
    readGlobalDefaultPersonaId,
    schedule: schedules,
    topLevelTools: [createAskUserTool({ askUser: askLane.park.askUser })],
  });
  const { driver, registry } = session;
  scheduleNotify.notify = (line: string) => driver.notify(line);
  // 122 项 2 — LaunchAgent 定时唤起回执：launchd 到点用 `open -a` 把 app
  // 拉起，Tauri 壳把 --schedule-wake 译成 WUDAO_SCHEDULE_WAKE=1 递进来
  // （sea-entry 会重写 argv，env 存活）。补跑本身走 daemon boot 的既有
  // applyMissedFire + 立即 tick——这里只补一行诚实回执，不发明新补跑路径。
  if (scheduleWakeRequested(process.env, process.argv)) {
    driver.notify("⏰ 本次启动来自系统定时唤起——到龄的定时任务已在启动时立即补跑（台账可查）");
  }
  // ω99-313: a bound-session fire continues THAT session through the
  // driver's own continueSession (the ω99-286 machine — same prefix, the
  // cache law); a fire landing mid-run skips (notified) instead of forking.
  scheduleExec.continueRun = (id) => driver.continueSession(id);
  scheduleExec.isBusy = () => !driver.isIdle();
  // 131 弧（zcode off-peak 引进）— the idle lane's activity clock：用户活动
  // 的入口点（submit/权限应答/澄清应答/续跑）轻包裹刷新时刻；run settle
  // 刻意不算活动（跑完的宿主就是空闲——defer 的产品语义）。fire 自身的
  // submit 也会刷钟（排队中的第二个闲时任务自然顺延一窗，131 §3.2）。
  // typeof 守卫：未来 driver 面变化时静默降级为钟面语义，不炸。
  const lastActivity = { at: Date.now() };
  for (const key of ["submit", "answerPermission", "answerAskUser", "continueSession"] as const) {
    const orig = (driver as unknown as Record<string, unknown>)[key];
    if (typeof orig !== "function") continue;
    (driver as unknown as Record<string, unknown>)[key] = (...args: unknown[]) => {
      lastActivity.at = Date.now();
      return (orig as (...a: unknown[]) => unknown).apply(driver, args);
    };
  }
  scheduleExec.lastActivityAt = () => lastActivity.at;
  // 121 项 2 — the agent-set schedule's birthplace: schedule_add reads the
  // LIVE session id at execute time (a post-resume rotation is honored; the
  // tool closes over THIS daemon object, so the late bind is visible).
  schedules.liveSessionId = () => driver.getSessionId();

  // ω99-235 — the pet lane（用户指令 ②）: a second, isolated driver session in
  // this same process. 车道即隔离单位：①转写不混流（精灵问答只落 pet.jsonl）；
  // ②主窗 run 进行中的精灵提问是对 PET run 的提交，不再 steer 主 run；③权限卡
  // 各归各道（pet 卡答 pet 的 pendingPermission，主窗 modal 答主车道）；④状态帧
  // 的 `pet` 字段喂精灵窗（主窗不再代喂——主窗忙时精灵窗不映主任务进度，是纯
  // 隔离的有意行为变化）。历史可见免费：store.list() 收一切非 side- 的
  // *.jsonl，pet.jsonl 自动进主窗会话列表。
  let petSession: DriverSession | undefined;
  if (props.petLane === true) {
    const laneLock = await acquirePetLaneLock(join(workspaceRoot, ".wudao", "sessions"));
    if (!laneLock.ok) {
      // occupied → 车道禁用：一行诚实 stderr，不阻主窗（server 无 petDriver →
      // pet ops 干净 unsupported → web relay 降级主车道 = 今日行为）。
      process.stderr.write(
        `⚠️ 小精灵车道不可用：会话 ${PET_SESSION_ID} 正被进程 ${laneLock.holderPid} 占用 — 小精灵本次将并入主会话车道\n`,
      );
    } else {
      // resumeHistory 走既有 load 预处理缝（index.ts resolveSession 同款变换：
      // branch-walk → chain-aware summary projection → orphan repair）；文件
      // 不存在/零消息 = fresh（sessionFresh:true 沿 ω99-211 落盘延迟——一个
      // 从未提问的精灵不落 pet.jsonl 空行）。
      const petStore = createJsonlSessionStore(join(workspaceRoot, ".wudao", "sessions"));
      const petEntries = await petStore.loadSessionEntries(PET_SESSION_ID);
      const petMessages = petEntries.filter((e): e is AgentMessage => "role" in e);
      const petHistory = petMessages.length > 0
        ? repairOrphanedToolCalls(applySummaryMarkers(resumeChain(petMessages, activeBranchLeafKey(petEntries)), { chain: true }))
        : undefined;
      petSession = await createDriverSession({
        ...(props as DriverSessionOptions),
        sessionId: PET_SESSION_ID,
        resumeHistory: petHistory,
        sessionFresh: petHistory === undefined,
        ...(props.petModelOverride !== undefined || props.modelOverride !== undefined
          ? { modelOverride: props.petModelOverride ?? props.modelOverride }
          : {}),
        // —— 降配清单（进程级纠葛，逐条）——
        // 不带 extraTools：terminal 的 setTerminalHistorySink 是进程全局单例
        // （第二会话挂载会偷走主会话的终端审计流），lspToolsFor 与
        // extensions.tools 同理——车道不带任何进程单例工具。
        extraTools: undefined,
        // 不带 deferredTools：MCP 工具只喂主 driver（runUi 的 resolved 回调只
        // 调 session.driver.addTools；本对象里该键本就不进 DriverSessionOptions）。
        // 不带 hooks/fileChangeTargets/configSkillsPath 与各 hook 盒：hook 是会话
        // 级装配面，精灵车道不挂（诚实降配，后续弧按需补）。
        hooks: undefined,
        fileChangeTargets: undefined,
        configSkillsPath: undefined,
        hookRuntime: undefined,
        rewakeSink: undefined,
        promptIdBox: undefined,
        sessionIdBox: undefined,
        hookWarnSink: undefined,
        // 不带 schedules 守护：/schedule 与 /doctor 的 durable 面是主窗独占
        //（pet 的 cron 工具也走 inert refusal——见 cronDisabled）。
        schedule: undefined,
        // sidecar 共享实例跟车（ω99-270）：精灵车道恒 auto 放行后，逐动作审计
        // 走主车道同一 in-process 实例——check 无会话态（纯函数分类器），breaker
        // 进程级共享是诚实语义（高危连击熔断对两车道一起生效）。托付但有审计：
        // 226「auto 档真化」的契约在精灵车道同构成立，不因车道分叉而裸奔。
        sidecar: props.sidecar,
        // 不带 pluginCommands/pluginAgents/extensions：插件面随主车道。
        pluginCommands: undefined,
        pluginAgents: undefined,
        extensions: undefined,
        // read-state 表车道隔离：主车道共享表是测试缝，精灵车道读自己的。
        readState: undefined,
        // agentRootBox 不传递：精灵车道锚 boot 工作区（主车道 agentRootSwitch
        // 不牵动精灵——引擎缺省即私有盒钉 workspaceRoot）。
        agentRootBox: undefined,
        // 主窗 boot 提示不重复进精灵车道。
        bootNotices: undefined,
        trustSuppressed: undefined,
        webDoctor: undefined,
        // 精灵车道的启动提示走 stderr（操作员道，不混主窗 banner）。
        startupNotice: (line: string) => {
          process.stderr.write(`${line}\n`);
        },
        // mode 恒 auto（ω99-270: #1 热修，用户令 09-10）：「我都用小精灵了，还找我
        // 要权限……比我自己去完成任务更费劲」——唤起小精灵=托付行为本身，精灵
        // 车道就是托付车道，不再随主窗缺省档钳到 workspace/ask（235 时代的「精
        // 灵车道未获托付」设定作废：托付在入口处已给，不在档位里再要一次）。
        // 安全边界不变：layers 1-4 运营 deny 规则照管、4.65 凭据闸 mode 免疫
        // （读真实凭据仍问）、bypass 免疫安全检查照跑——托付不等于敞开凭据。
        defaultPermissionMode: "auto",
        // 精灵车道自有的 no-op 租约盒 + inert cron + 无自动命名（显示层固定
        // 「小精灵」，pet.jsonl 不写 session_name 条目）——三者的根因注释见
        // DriverSessionOptions 对应 prop 与 acquirePetLaneLock。
        sessionLeases: PET_LANE_LEASE_BOX,
        cronDisabled: true,
        autoTitle: false,
        // ω99-248: #13 — pet 权限不入持久面：精灵车道的 ask 由本进程的车道卡
        // 即答，pet.jsonl 不落 permission_ask 证据（车道隔离；恢复协调器本就
        // 排除 pet——持久面也不写，纪律两侧都成立）。
        persistPermissionAsks: false,
      });
    }
  }

  const staticDir = props.staticDir !== undefined ? props.staticDir : await probeStaticDir();
  // ω99-242: #7 — the crash-recovery coordinator (重启不丢托付): boot 时观察-分类-
  // 认领-限流地续跑被中断的托付会话；journal 是 <root>/.wudao/recovery.jsonl
  // （append-only 单文件，绝不进各 session JSONL）。无 journal 且无 active
  // mission 的老工作区零行为零 IO（fold 空 + bootCandidates 空）。恢复 admission
  // = resume + verify-first submit，全程正常权限管线（§二.8 零旁路）。
  const recovery = createRecoveryCoordinator({
    journalPath: join(workspaceRoot, ".wudao", "recovery.jsonl"),
    port: createRecoveryPort({ driver, workspaceRoot }),
  });
  // M63 §B: the settings/credentials ops ride the same driver port (same
  // first-frame auth as every op); the setMode mode list is the 0.3.14
  // four-tier set (workspace/ask/auto/plan — the retired read-only and the
  // 0.3.11 default/acceptEdits pair are gone).
  // ω99-235: the pet lane's driver rides the same server as an OPTIONAL
  // narrow port (absent → the pet ops answer "unsupported" and state frames
  // carry no `pet` field — the settings-ops precedent).
  // 0.4.0 集成缝：车道管理器+工厂——web 发 resume {id, sid} 到未挂 sid 时
  // 自动开副车道（LaneManager.open 降配 preset 装配），打通多 driver 并发。
  const laneManager = createLaneManager({ main: session, base: props as DriverSessionOptions });
  // PB-2 — 探针遥测车道：audit 的 boot notice 归 announce 块统一排（此处静默
  // 装配）；bus 无论 audit 与否都挂上（读面 op 恒可用）。
  const probeAuditPath = await setupProbeAudit({ workspaceRoot, out: () => {} });
  const server = await createUiServer({
    driver: askLane.mount(withSettingsOps(driver, { workspaceRoot }), driver),
    ...(petSession !== undefined ? { petDriver: petSession.driver } : {}),
    recovery,
    port: props.port,
    staticDir,
    modes: ["workspace", "ask", "auto", "plan"],
    laneFactory: (sessionId) => laneManager.open(sessionId),
    probeBus: getDefaultProbeBus(),
  });

  if (props.announce !== false) {
    process.stdout.write(
      `wudao ui v${VERSION} · ${modelLabel(config)} · session ${driver.getSessionId().slice(0, 8)} · ${workspaceRoot}\n` +
        `open: ${server.url}\n` +
        `(loopback only · the token rides the URL fragment and never appears in a request line)\n` +
        `Ctrl+C to stop\n`,
    );
    if (probeAuditPath !== undefined) {
      process.stdout.write(`探针审计已开启 → ${probeAuditPath}\n`);
    }
    if (props.openBrowser !== false) openOnMacOS(server.url);
  }

  return {
    driver,
    server,
    registry,
    schedules,
    ...(petSession !== undefined ? { petDriver: petSession.driver } : {}),
    close: async () => {
      // ω99-242 invariant 3 — the graceful-shutdown checkpoint MUST land
      // before the engine dies: stop() freezes the in-flight session's
      // recovery intent (journal append only), so the close/abort below can
      // never erase it. Bounded and idempotent.
      await recovery.stop();
      // M43-B review: SIGINT must exit even with a run in flight — abort the
      // driver's fetch/tool race first (its pending request would otherwise
      // hold the event loop open past the server close).
      await session.close();
      // ω99-235: the pet lane goes down with the host (the raw lane lock's
      // release posture: no unlink — the dead-pid steal owns recovery).
      await petSession?.close();
      await server.close();
      // M61 §4: stop the daemon's tick with the host.
      schedules.stop();
    },
  };
}

/** The CLI entry: serve until SIGINT (the http listener keeps the process alive). */
export async function runUi(props: RunUiProps): Promise<void> {
  const session = await startUiSession(props);
  // 夜移 018: the deferred MCP load lands once the server is already
  // listening — the desktop's time-to-UI never pays the handshake sum.
  if (props.deferredTools !== undefined) {
    void props.deferredTools.then(
      (tools) => { if (tools.length > 0) session.driver.addTools(tools); },
      () => { /* loadMcpToolsFor warns per-server; boot stays up */ },
    );
  }
  await new Promise<void>((resolve) => {
    const stop = (): void => {
      process.stdout.write("⏹ wudao ui stopped\n");
      resolve();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
  await session.close();
}
