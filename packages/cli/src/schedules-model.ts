// ω99 拆分运动 弧 B：schedules 域模型外提（常量/类型/台账形状校验——原
// schedules.ts 模块级段逐字保留；schedules.ts re-export 门面保公共面）。

import { SESSION_ID_RE } from "@wudao/core";

export const SCHEDULES_STORE_FILE = "schedules.json";
export const SCHEDULES_SESSION_ID = "schedules";
export const SCHEDULE_RUN_ENV = "WUDAO_SCHEDULE_RUN";
/** How often the daemon re-checks due-ness (unref'd). */
export const SCHEDULE_TICK_MS = 30_000;
/** ω99-313 — the breaker threshold: this many consecutive failed fires
 *  disables the task (+ one notification). Competing schedulers fail
 *  silently; this one tells the user and stops burning. */
export const SCHEDULE_BREAKER_FAILURES = 3;
/** Captured stdout tail per run (the session log's preview line). */
export const RUN_PREVIEW_CHARS = 2_000;
/** M61 review fix: a durable child that hangs must not wedge the task — kill
 *  after this and record the failure (the task stays schedulable: the next
 *  due re-fires normally). 30 minutes covers long-but-legitimate headless
 *  runs while bounding the daemon's exposure. */
export const SCHEDULE_RUN_TIMEOUT_MS = 30 * 60_000;
/** 借鉴弧 α3（the upstream ec58e08a35 思想）— 漏火有界重跑：fire 已被消耗（表已
 *  前进）但子进程从未到达模型（持续宕机窗口）时，隔多久补跑一次。the upstream
 *  梯子 5/15/30min≤3 次；这里收窄为「最多 1 次、单一延迟」——判据更严（子
 *  进程自己盖的 UNREACHED 章，非 daemon 猜输出）。 */
export const SCHEDULE_MISS_RETRY_DELAY_MS = 5 * 60_000;
/** 借鉴弧 α3 — 子进程（`wudao -p` 一次性运行）死于瞬态 provider 错误且
 *  「模型从未产出任何字节」（零 assistant/reasoning 增量）时，在 stderr 盖
 *  这一章。daemon 只信这个类型化章，绝不解析输出文本猜「没到达模型」。
 *  章本身与调度无关（任何一次性运行都盖）——它是「本次运行零模型接触」
 *  的诚实回执。 */
export const SCHEDULE_MODEL_UNREACHED_MARKER = "WUDAO_MODEL_UNREACHED=1";
/** 借鉴弧 ε — 同信号防抖窗（ms）：编辑器一次保存会触发 fs.watch 的
 *  rename+change 事件串、webhook 发送方会重试——窗口内的重复信号只算
 *  一次（首到即收，其余吸收）。这是「事件无『火』概念、但同信号防抖
 *  必须」的落点（digest-c 候选 C3 的收窄声明）。 */
export const SCHEDULE_EVENT_DEBOUNCE_MS = 2_000;
/** 借鉴弧 ε — webhook 监听的回环纪律：只绑 127.0.0.1（server v1-A 同
 *  律，fail-closed）；默认端口（WUDAO_SCHEDULE_WEBHOOK_PORT 可覆写）。
 *  默认关 = 没有生效的 webhook 任务时监听根本不存在（绑都不绑）。 */
export const SCHEDULE_WEBHOOK_HOST = "127.0.0.1";
export const SCHEDULE_WEBHOOK_DEFAULT_PORT = 47_610;
export const SCHEDULE_WEBHOOK_PORT_ENV = "WUDAO_SCHEDULE_WEBHOOK_PORT";
/** webhook 请求体只排空不消费（v1 预设任务原样跑），超过此量直接断连。 */
export const SCHEDULE_WEBHOOK_BODY_CAP = 1_000_000;
/** 122 项 1 — 临火睡眠守卫的缺省窗（ms）：最近一次 fire（含武装中的
 *  missRetryAt）距 now 在窗内时，守护持有 prevent-sleep 断言——Mac 在
 *  「等火」的间隙不入睡，火准时（入睡=计时器冻结，火被推迟到唤醒后，
 *  这正是本常数要堵的洞）。必须显著大于 SCHEDULE_TICK_MS（30s 的
 *  tick 节拍决定守卫最晚在 T-9:30 才合闸）；可经 settings 的
 *  schedules.sleepGuardMs 覆写，0=关。 */
export const SCHEDULE_NEAR_FIRE_GUARD_MS = 10 * 60_000;

// 122 项 2 — LaunchAgent 离线唤起（应用完全关闭时的准时唤起；方案见
// docs/research/122-launchagent-design.md）。四个字面各有测试钉：
// label/plist 文件名沿应用 identifier 派生（com.feiaojin.wudao-harness-desktop
// 家族）；app 名 = Tauri productName（`open -a` 的 LaunchServices 查找键，
// 中文 UTF-8 对 launchctl 无碍）；唤醒旗标从 launchd 一路透传到 sidecar。
export const SCHEDULE_LAUNCHAGENT_LABEL = "com.feiaojin.wudao-harness.schedules";
export const SCHEDULE_LAUNCHAGENT_PLIST_FILE = "com.feiaojin.wudao-harness.schedules.plist";
export const SCHEDULE_LAUNCHAGENT_APP_NAME = "悟道Harness";
/** The argv flag the plist's `open --args` appends (the Tauri shell reads
 *  it, translates to the env below for the sidecar). */
export const SCHEDULE_WAKE_ARG = "--schedule-wake";
/** The env the Tauri shell hands the sidecar (sea-entry rewrites argv; env
 *  survives). The sidecar reads it for the wake receipt — the catch-up
 *  itself is the daemon boot's EXISTING applyMissedFire + immediate tick. */
export const SCHEDULE_WAKE_ENV = "WUDAO_SCHEDULE_WAKE";
/** 127 项 2（F1）— origin 车道占用跳过的重排延迟：origin 会话被活租约占用
 *  （桌面开着该会话）时，本次火跳过并重排（quota-park re-arm 同款 +2min
 *  节律）——绝不 spawn 一个注定撞租约 boot 失败的子进程白烧熔断计数。 */
export const SCHEDULE_ORIGIN_OCCUPIED_RETRY_MS = 2 * 60_000;
/** 127 项 2（F1）— 占用跳过的连续帽：一次 `at` 火连续 N 次因占用跳过后放弃
 *  （火被消耗、诚实通知）——不设帽的占用跳过是无限重排+通知噪音。 */
export const SCHEDULE_ORIGIN_OCCUPIED_SKIP_CAP = 5;
/** 131 弧 — defer（闲时）触发的空闲窗：默认/最小/最大（分钟）。 */
export const DEFER_IDLE_DEFAULT_MINUTES = 15;
export const DEFER_IDLE_MIN_MINUTES = 5;
export const DEFER_IDLE_MAX_MINUTES = 120;

export type DurableSchedule = { type: "cron"; expr: string } | { type: "at"; at: number }
  // ω99-313: the structured-calendar family — no cron-string parsing (the
  // Chinese-language user + a settings UI select better shapes directly).
  | { type: "every"; intervalMs: number }
  | { type: "weekly"; weekdays: readonly number[]; time: string }
  // 借鉴弧 ε — the event family（第 4 类触发：盯信号，不看钟）。v1 两个
  // 源：file（工作区内相对路径，fs.watch+防抖）与 webhook（回环 POST，
  // token 鉴权）。存储形：webhook 必带 token（add 时守护生成）；加载侧
  // 少 token 的行按畸形丢弃（validDurable 的 normalize-not-reject 律）。
  | { type: "event"; source: EventSource }
  // 131 弧（zcode off-peak 引进）— the idle family（第 5 类触发：等空闲，
  // 不看钟也不盯信号）。defer_task 工具面排入的闲时任务：一次性，最早
  // 可火时刻物化为 nextRunAt（add 时 = createdAt + idleMinutes），真火
  // 还需 daemon 的空闲资格（!busy 且距最后活动 ≥ idleMinutes）。
  | { type: "idle"; idleMinutes: number };

/** 借鉴弧 ε — 事件触发源的存储形。 */
export type EventSource =
  | { readonly kind: "file"; readonly path: string }
  | { readonly kind: "webhook"; readonly token: string };

/** 借鉴弧 ε — add 面的事件源输入形：webhook 不带 token（守护在 add 时
 *  生成并落库——token 从不出现在调用方的构造参数里）。 */
export type EventSourceInput =
  | { readonly kind: "file"; readonly path: string }
  | { readonly kind: "webhook" };

/** add 面可接受的 schedule 全集（DurableSchedule + webhook 的 token-less
 *  输入形——守护归一化后才会落库）。 */
export type AddableSchedule = DurableSchedule | { readonly type: "event"; readonly source: EventSourceInput };

/** ω99-313 — the structured trigger forms (the computeNextRun family; the
 *  cron form stays on the legacy durableNextFire path). */
export type StructuredSchedule =
  | { type: "at"; at: number }
  | { type: "every"; intervalMs: number }
  | { type: "weekly"; weekdays: readonly number[]; time: string };

/** 113-C1（qm #1593 形）— per-task runtime tier. Reuses the EXISTING
 *  resolution surfaces (persona registry for persona; the provider/model
 *  flags a human run uses; the effort catalog consults at the child's run
 *  start) — no new tier system. Every field optional; absent = the
 *  session/env default, spawn bytes unchanged. */
export interface ScheduleRuntimeOverrides {
  /** Model id handed to the child run's `--model` (highest precedence there,
   *  past env pins — args.ts R3-T002). */
  readonly model?: string;
  /** Provider id handed to the child run's `--provider`. */
  readonly provider?: string;
  /** Persona id handed to the child run via WUDAO_PERSONA (the bootstrap
   *  chain's own env — typed-checked against the merged registry at add). */
  readonly persona?: string;
  /** Reasoning-effort tier handed to `--reasoning-effort`. The three-value
   *  low lane (schedules are the cost-control surface; the child's own
   *  preflight consults the effort catalog for real support). */
  readonly effort?: "low" | "medium" | "high";
}

/** The add/load faces' shared effort union (typed rejection elsewhere). */
export const SCHEDULE_RUNTIME_EFFORTS = ["low", "medium", "high"] as const;

// 121 项 2（the upstream project d72beaf9e durable wake + the upstream project 5ab0e6df3 形）—
// 「agent 自己安排的周期性再注入」的持久锚：schedule_add 工具面在 agent
// 设定时自动盖上当前会话的 origin；fire 时 spawn 车道不全新开跑，而是
// resume 该会话（跨重启 durable——resume 读盘上 JSONL，不依赖宿主存活），
// prompt 前缀「[定时续跑] …」。用户手设（/schedule 命令面）不带 origin，
// 行为不变（全新 spawn）。与既有 sessionId 绑定（313 的 continue 车道，
// 需在宿主内、且有未完尾）互补：origin 是「settled 尾也照跑」的无头车道。
export interface ScheduleOrigin {
  /** The session whose conversation the fire resumes (the agent's own
   *  session at schedule_add time). */
  readonly sessionId: string;
  /** Optional human-facing hint overriding the schedule prompt in the fired
   *  turn's prefix (absent = the prompt itself). */
  readonly contextHint?: string;
}

/** Stamp-side shape gate (shared by the add door and the tool face): the id
 *  must be path-safe and NOT a sidechain file (the same discipline the
 *  driver's continueSession applies — side- 前缀是副链，绝不当作主会话). */
export function validScheduleOriginSessionId(id: string): boolean {
  return SESSION_ID_RE.test(id) && !id.startsWith("side-");
}

/** Load-side origin normalization (normalize-not-reject): a well-formed
 *  sessionId keeps the field (with an optional well-formed hint); anything
 *  else drops it whole — the task stays schedulable on the plain spawn lane
 *  rather than dying at load. */
function validOrigin(v: unknown): ScheduleOrigin | undefined {
  if (typeof v !== "object" || v === null) return undefined;
  const o = v as Record<string, unknown>;
  if (typeof o.sessionId !== "string" || !validScheduleOriginSessionId(o.sessionId)) return undefined;
  const hint = typeof o.contextHint === "string" && o.contextHint.trim() !== "" ? o.contextHint : undefined;
  return { sessionId: o.sessionId, ...(hint !== undefined ? { contextHint: hint } : {}) };
}

/** 113-C1 — typed door check for a runtime tier: returns the refusal text or
 *  undefined. Pure (the persona registry check is async and lives at the
 *  daemon's add face). */
export function scheduleRuntimeError(runtime: Partial<ScheduleRuntimeOverrides>): string | undefined {
  for (const key of ["model", "provider", "persona"] as const) {
    const v = runtime[key];
    if (v !== undefined && (typeof v !== "string" || v.trim() === "")) return `runtime.${key} 需为非空字符串`;
  }
  const e = runtime.effort;
  if (e !== undefined && !(SCHEDULE_RUNTIME_EFFORTS as readonly string[]).includes(e)) {
    return `runtime.effort 需为 low|medium|high（收到 "${String(e)}"）`;
  }
  if (runtime.model === undefined && runtime.provider === undefined && runtime.persona === undefined && runtime.effort === undefined) {
    return "runtime 档位需至少一个字段";
  }
  return undefined;
}

/** 113-C1 — the persisted shape of one runtime field, normalize-not-reject:
 *  garbage drops the FIELD (never the task), same discipline as the other
 *  optional DurableTask faces. */
function validRuntimeField(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() !== "" ? v : undefined;
}

/** 113-C1 — load-side runtime normalization: each known field kept only when
 *  well-formed, the effort union checked, an emptied object dropped whole. */
function validRuntime(v: unknown): ScheduleRuntimeOverrides | undefined {
  if (typeof v !== "object" || v === null) return undefined;
  const t = v as Record<string, unknown>;
  const model = validRuntimeField(t.model);
  const provider = validRuntimeField(t.provider);
  const persona = validRuntimeField(t.persona);
  const effort = validRuntimeField(t.effort);
  const runtime: { model?: string; provider?: string; persona?: string; effort?: "low" | "medium" | "high" } = {
    ...(model !== undefined ? { model } : {}),
    ...(provider !== undefined ? { provider } : {}),
    ...(persona !== undefined ? { persona } : {}),
    ...(effort !== undefined && (SCHEDULE_RUNTIME_EFFORTS as readonly string[]).includes(effort) ? { effort: effort as "low" | "medium" | "high" } : {}),
  };
  return Object.keys(runtime).length > 0 ? runtime : undefined;
}

export interface DurableTask {
  readonly id: string;
  readonly schedule: DurableSchedule;
  readonly prompt: string;
  /** Absolute path of the workspace the task runs in. */
  readonly workspace: string;
  /** Where the task was created (session id, "/schedule", "web", …). */
  readonly createdFrom: string;
  readonly createdAt: number;
  readonly lastFiredAt?: number;
  /** ω99-5a: a paused task is skipped by the daemon until unpaused (no
   *  catch-up — missed fires are not compensated). */
  readonly paused?: true;
  /** ω99-313 — "task" runs the prompt (continue-or-spawn); "reminder" is the
   *  LIGHT path: zero model requests, a pure local notification with snooze.
   *  Absent = "task" (the pre-313 store rows all are). */
  readonly kind?: "task" | "reminder";
  /** ω99-313 — the circuit breaker's off switch: 3 consecutive failures set
   *  enabled=false (+ one notification); `/schedule unpause` re-opens.
   *  Absent = enabled. */
  readonly enabled?: boolean;
  /** ω99-313 — bind the fire to a session: an unfinished tail continues THAT
   *  session (same request prefix — the cache-friendly path); a settled tail
   *  or no binding spawns a fresh headless run. */
  readonly sessionId?: string;
  /** ω99-313 — the per-fire token ceiling carried on the schedule (stored +
   *  surfaced; the v1 spawn path has no flag to consume it — honest debt,
   *  see the report). */
  readonly budgetTokens?: number;
  /** 113-C1（qm #1593 形）— the per-task runtime tier: model/provider/persona/
   *  effort overrides consumed ONLY at the spawn lane's driver startup (a
   *  fresh headless run — the storedModelDefaults-family resolution chain);
   *  a bound continue lane keeps the running session's own runtime (the
   *  running-session contract is pinned in tests). Absent = defaults,
   *  behavior byte-zero. */
  readonly runtime?: ScheduleRuntimeOverrides;
  /** ω99-313 — the reminder's default snooze length (minutes). A fired
   *  `at`-reminder with snoozeMinutes lingers for one snooze window instead
   *  of self-deleting. */
  readonly snoozeMinutes?: number;
  /** ω99-313 — materialized next run (epoch ms). The structured family's
   *  due-ness reads THIS (not a re-derivation) so applyMissedFire can clamp
   *  it and a fire can recompute it from the actual fire time. Absent on
   *  legacy rows (the durableNextFire derivation covers them). */
  readonly nextRunAt?: number;
  /** ω99-313 — consecutive failed fires (the breaker trips at 3). A success
   *  resets to 0. */
  readonly consecutiveFailures?: number;
  /** ω99-313 — a fired snoozeable reminder lingers until this instant; a
   *  `/schedule snooze` inside the window re-arms it, the passing window
   *  retires it. */
  readonly snoozeUntil?: number;
  /** 借鉴弧 α3 — 漏火补跑的武装时刻（epoch ms）：上一次 cron fire 已被消耗
   *  （表已前进）但子进程带着 UNREACHED 章死掉（模型零接触）时武装；tick
   *  到点发射一次「miss-retry」车道（不推进表、不再武装——有界性由「仅
   *  triggeredBy==="cron" 的失败可武装」钉死，补跑自身的失败永远不再补）。
   *  暂停/停用/到达自然下火时视为弃权。 */
  readonly missRetryAt?: number;
  /** 121 项 2 — agent 自设的出生地（schedule_add 工具面自动盖章）：fire 时
   *  的 spawn 车道 resume 该会话而非全新开跑（详见 ScheduleOrigin）。缺席
   *  = 用户手设/既有行——全新 spawn，行为不变。 */
  readonly origin?: ScheduleOrigin;
}

export interface SchedulesFile {
  readonly version: 1;
  readonly tasks: readonly DurableTask[];
}

export class SchedulesRefusedError extends Error {
  constructor(reason: "disabled" | "symlink", detail: string) {
    super(reason === "disabled" ? `durable scheduling disabled (WUDAO_DISABLE_CRON=1)` : `schedules store refused: ${detail} is a symlink`);
    this.name = "SchedulesRefusedError";
  }
}

export function validDurable(v: unknown): DurableTask | undefined {
  if (typeof v !== "object" || v === null) return undefined;
  const t = v as Record<string, unknown>;
  const id = t.id;
  const prompt = t.prompt;
  const workspace = t.workspace;
  const createdFrom = t.createdFrom;
  const createdAt = t.createdAt;
  if (typeof id !== "string" || id.length !== 8) return undefined;
  if (typeof prompt !== "string" || typeof workspace !== "string" || typeof createdFrom !== "string" || typeof createdAt !== "number") return undefined;
  const s = t.schedule as Record<string, unknown> | undefined;
  if (typeof s !== "object" || s === null) return undefined;
  let schedule: DurableSchedule | undefined;
  if (s.type === "cron" && typeof s.expr === "string") schedule = { type: "cron", expr: s.expr };
  else if (s.type === "at" && typeof s.at === "number") schedule = { type: "at", at: s.at };
  // ω99-313: the structured family — normalize-not-reject per field; a
  // malformed variant (e.g. intervalMs <= 0) drops the TASK like the
  // pre-313 malformed cron/at rows did (the store never re-arms garbage).
  else if (s.type === "every" && typeof s.intervalMs === "number" && Number.isInteger(s.intervalMs) && s.intervalMs >= SCHEDULE_MIN_INTERVAL_MS) {
    schedule = { type: "every", intervalMs: s.intervalMs };
  } else if (s.type === "weekly" && Array.isArray(s.weekdays) && typeof s.time === "string" && validWeekdays(s.weekdays) && validTimeOfDay(s.time)) {
    schedule = { type: "weekly", weekdays: [...new Set(s.weekdays as number[])].sort((a, b) => a - b), time: s.time };
  }
  // 借鉴弧 ε — the event family：file 路径过同一逃逸门；webhook 少
  // token/短 token 的行按畸形丢弃（token 是监听鉴权的唯一凭据，缺了
  // 的行永远收不到信号——丢弃并在 discardedAtLoad 里说话，不静默留尸）。
  else if (s.type === "event" && typeof s.source === "object" && s.source !== null) {
    const src = s.source as Record<string, unknown>;
    if (src.kind === "file" && typeof src.path === "string" && validWatchPath(src.path)) {
      schedule = { type: "event", source: { kind: "file", path: src.path } };
    } else if (src.kind === "webhook" && typeof src.token === "string" && /^[A-Za-z0-9_-]{16,}$/.test(src.token)) {
      schedule = { type: "event", source: { kind: "webhook", token: src.token } };
    }
  }
  // 131 弧 — idle 族：正整数才是形；越界值夹回产品窗（normalize，不拒收
  // ——手编行/旧版本宽窗同纪律）。
  else if (s.type === "idle" && typeof s.idleMinutes === "number" && Number.isInteger(s.idleMinutes) && s.idleMinutes >= 1 && s.idleMinutes <= 240) {
    schedule = { type: "idle", idleMinutes: Math.min(DEFER_IDLE_MAX_MINUTES, Math.max(DEFER_IDLE_MIN_MINUTES, s.idleMinutes)) };
  }
  if (schedule === undefined) return undefined;
  // 121 项 2: origin's load-side normalization (same discipline).
  const origin = validOrigin(t.origin);
  // 113-C1: the runtime tier's load-side normalization (normalize-not-reject
  // per field; an emptied object drops whole).
  const runtime = validRuntime(t.runtime);
  return {
    id,
    schedule,
    prompt,
    workspace,
    createdFrom,
    createdAt,
    ...(typeof t.lastFiredAt === "number" ? { lastFiredAt: t.lastFiredAt } : {}),
    // ω99-5a: normalize-not-reject — a garbage paused value (e.g. "yes")
    // drops the FIELD, never the task.
    ...(t.paused === true ? { paused: true } : {}),
    // ω99-313: same discipline for the new faces — garbage drops the field.
    ...(t.kind === "task" || t.kind === "reminder" ? { kind: t.kind } : {}),
    ...(typeof t.enabled === "boolean" ? { enabled: t.enabled } : {}),
    ...(typeof t.sessionId === "string" && t.sessionId !== "" ? { sessionId: t.sessionId } : {}),
    ...(typeof t.budgetTokens === "number" && Number.isInteger(t.budgetTokens) && t.budgetTokens > 0 ? { budgetTokens: t.budgetTokens } : {}),
    // 113-C1: normalize-not-reject — a garbage runtime field drops the field,
    // a fully-garbage runtime object drops itself (the task stays runnable
    // on defaults rather than dying at load).
    ...(runtime !== undefined ? { runtime } : {}),
    ...(typeof t.snoozeMinutes === "number" && Number.isInteger(t.snoozeMinutes) && t.snoozeMinutes > 0 ? { snoozeMinutes: t.snoozeMinutes } : {}),
    ...(typeof t.nextRunAt === "number" ? { nextRunAt: t.nextRunAt } : {}),
    ...(typeof t.consecutiveFailures === "number" && Number.isInteger(t.consecutiveFailures) && t.consecutiveFailures >= 0 ? { consecutiveFailures: t.consecutiveFailures } : {}),
    ...(typeof t.snoozeUntil === "number" ? { snoozeUntil: t.snoozeUntil } : {}),
    ...(typeof t.missRetryAt === "number" ? { missRetryAt: t.missRetryAt } : {}),
    // 121 项 2: origin — normalize-not-reject（sessionId 形状坏=整字段丢，
    // contextHint 非字符串=只丢 hint；手编行/未来迁移同纪律）。
    ...(origin !== undefined ? { origin } : {}),
  };
}

export interface SchedulesStore {
  readonly tasks: readonly DurableTask[];
  /** ω99-322 — rows the load-time validator dropped (a hand-edited store or
   *  a future migration silently losing entries is a fact the user must be
   *  TOLD, not left to discover). Counts only a PARSED file's invalid rows;
   *  a missing file or unparseable JSON stays 0 (no tasks array to count). */
  readonly discardedAtLoad: number;
  save(tasks: readonly DurableTask[]): Promise<void>;
}

export const SCHEDULE_MIN_INTERVAL_MS = 60_000;

/** 0-6 (JS Date#getDay convention, 0 = Sunday), de-duplicated allowed. */
export function validWeekdays(days: readonly number[]): boolean {
  if (days.length === 0) return false;
  return days.every((d) => Number.isInteger(d) && d >= 0 && d <= 6);
}

/** "HH:MM" (24h local). */
export function validTimeOfDay(time: string): boolean {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(time);
}

/** 借鉴弧 ε — file 触发源的可盯路径判据（add 与加载共用）：必须是非空
 *  相对路径（绝不让绝对路径/盘符混进来——watch 永远锚在任务自己的
 *  workspace 上）、不含 `..` 段（无路径逃逸）、无 NUL。纯函数。 */
export function validWatchPath(path: string): boolean {
  if (path === "" || path === "." || path.includes("\0")) return false;
  if (path.startsWith("/") || path.startsWith("\\") || /^[A-Za-z]:[\\/]/.test(path)) return false;
  const parts = path.split(/[\\/]+/);
  return !parts.some((p) => p === "..");
}

/** 借鉴弧 ε — add 面的事件源校验（输入形）：返回错误文案，合法则
 *  undefined。webhook 无调用方参数（token 守护生成）→ 恒合法。 */
export function eventSourceError(source: EventSourceInput): string | undefined {
  if (source.kind === "file") {
    if (!validWatchPath(source.path)) {
      return "文件触发源需为工作区内相对路径（不支持绝对路径或 ..）";
    }
    return undefined;
  }
  return undefined;
}
