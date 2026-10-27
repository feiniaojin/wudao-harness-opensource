// packages/providers/src/stream-idle.ts — ω99-315 流式看门狗双档化。
// M58 §B 的单档看门狗（45s 硬超时 → StreamIdleError 走既有梯子）演进为两档：
//
//   soft  缺省 90s（DEFAULT_STREAM_IDLE_SOFT_MS）——只在静默 gap 超过阈值时
//         发一次 onStreamIdleWarning 回调，绝不取消、绝不产生额外模型请求。
//         推理模型（悟道/DeepSeek/GLM/Qwen）的长静默思考是合法的：先警示，
//         不动连接。每个 gap 至多警告一次（收到 chunk 即重置）。
//   hard  缺省 300s（DEFAULT_STREAM_IDLE_HARD_MS）——abort 下载（reader.cancel）
//         并抛富化的 StreamIdleError（idleMs / 收到的字节数 / 软警告时间线），
//         走既有重试梯子。hard 锚定 gap 起点：soft 的唤配不滑移 hard 的死线。
//
// M24 前缀缓存不变量的直接变现：重试重发的是同一个 ModelInput 的同一份
// 序列化字节（各适配器的请求体构建是确定性的），重连命中 provider 前缀
// 缓存——重连成本≈增量 token，而不是冷缓存重算。
//
// 分层边界（ω99-315 钉死）：看门狗只「检测挂死 + 取消」；恢复走既有两臂
// ——providers 的 pre-delta 重试梯子（withRetryStream）与 core 的
// callModelWithTurnRecovery 恢复臂（post-delta）。绝不在这造第二套重试。

/** ω99-315: soft 档缺省 90s —— 推理模型的长静默是合法的，先警示不取消。 */
export const DEFAULT_STREAM_IDLE_SOFT_MS = 90_000;

/** ω99-315: hard 档缺省 300s —— 真挂死不超过用户容忍（5 分钟无字节）。 */
export const DEFAULT_STREAM_IDLE_HARD_MS = 300_000;

/** Node's setTimeout wraps beyond 2^31-1 ms into an IMMEDIATE fire — a
 *  garbage-large idle value must degrade to "wait as long as possible", not
 *  "abort instantly". */
export const MAX_STREAM_IDLE_TIMEOUT_MS = 2_147_483_647;

/**
 * M58 §B 引入的 hard 档缺省（当年 45s 单档）。ω99-315 双档化后它就是 hard
 * 档的缺省（300s）——legacy 名字与 import 面保留（`WUDAO_STREAM_IDLE_MS` 与
 * `streamIdleTimeoutMs` 选项仍指 hard 档）。
 */
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = DEFAULT_STREAM_IDLE_HARD_MS;

/** WUDAO_STREAM_IDLE_MS (integer ms ≥ 0); junk falls back to the default,
 *  0 disables the watchdog (both tiers when it is the only override), values
 *  past the setTimeout limit clamp to it. ω99-315: still the HARD tier's env
 *  override — the soft tier has no env (it warns only; settings keys own it). */
export function defaultStreamIdleTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.WUDAO_STREAM_IDLE_MS;
  if (raw === undefined || raw === "") return DEFAULT_STREAM_IDLE_TIMEOUT_MS;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? Math.min(n, MAX_STREAM_IDLE_TIMEOUT_MS) : DEFAULT_STREAM_IDLE_TIMEOUT_MS;
}

/** ω99-315: 一次软警告的可观测载荷。`softWarns` 是本流自开始起每次软警告
 *  的相对时刻（ms）——硬超时抛出的 StreamIdleError 携带同一时间线。 */
export interface StreamIdleWarningInfo {
  /** The soft budget that lapsed (the configured softMs, not wall-elapsed). */
  readonly idleMs: number;
  /** Wire bytes received since the stream started (attribution). */
  readonly bytesSoFar: number;
  /** Elapsed-ms timeline (stream start) of every soft warning so far. */
  readonly softWarns: readonly number[];
}

/** The typed idle-timeout abort. Retryable by the ladder (unlike a USER abort,
 *  which surfaces as AbortError and is never retried). ω99-315 enriches it with
 *  the forensic triple the brief demands: idle duration / received bytes / the
 *  soft-warning timeline. */
export class StreamIdleError extends Error {
  readonly idleMs: number;
  /** ω99-315: wire bytes received before the abort. */
  readonly bytes: number;
  /** ω99-315: elapsed-ms timeline of soft warnings before the abort. */
  readonly softWarns: readonly number[];

  constructor(idleMs: number, detail: { bytes?: number; softWarns?: readonly number[] } = {}) {
    super(`stream idle for ${idleMs}ms without a chunk — watchdog abort`);
    this.name = "StreamIdleError";
    this.idleMs = idleMs;
    this.bytes = detail.bytes ?? 0;
    this.softWarns = detail.softWarns ?? [];
  }
}

/** The resolved two-tier budget. 0 in a slot disables that tier. */
export interface StreamIdleBudget {
  readonly softMs: number;
  readonly hardMs: number;
}

/** What a factory resolves once and threads into its stream attempt: the
 *  budget plus the soft tier's warn hook. */
export type StreamIdleRuntime = StreamIdleBudget & {
  readonly onSoftWarning?: (info: StreamIdleWarningInfo) => void;
};

/** ω99-315: option/env → the two-tier budget. Precedence:
 *    hard  hardMs（新键） → legacyTimeoutMs（M58 单档选项）→ WUDAO_STREAM_IDLE_MS
 *          （M58 env）→ 300s 缺省；
 *    soft  softMs（新键）→ 90s 缺省；但 legacyTimeoutMs === 0（M58 的「0 关
 *          看门狗」逃生口）在没有新键时同时关掉 soft——老用户的 0 语义不变。 */
export function resolveStreamIdleBudget(
  opts: { softMs?: number; hardMs?: number; legacyTimeoutMs?: number },
  env: NodeJS.ProcessEnv = process.env,
): StreamIdleBudget {
  const hardMs = opts.hardMs ?? opts.legacyTimeoutMs ?? defaultStreamIdleTimeoutMs(env);
  const softMs = opts.softMs ?? (opts.legacyTimeoutMs === 0 ? 0 : DEFAULT_STREAM_IDLE_SOFT_MS);
  return {
    softMs: Math.min(softMs, MAX_STREAM_IDLE_TIMEOUT_MS),
    hardMs: Math.min(hardMs, MAX_STREAM_IDLE_TIMEOUT_MS),
  };
}

/**
 * The per-stream dual-tier watchdog state machine (shared by the openai
 * engine's inline SSE loop and the anthropic/responses sseDataLines).
 *
 *   arm()        (re)arm for a pending read. Idempotent WITHIN a gap: after a
 *                soft warning the hard timer keeps its original deadline.
 *   chunk(bytes) a read resolved with payload — the gap is over; both timers
 *                reset and the byte counter accrues.
 *   race(read)   race the pending read against the HARD tier only (the soft
 *                tier is a pure side-effect callback — it never wakes the
 *                consumer, never yields an event, and therefore can never
 *                trip the retry ladder's produced guard).
 *   dispose()    tear the timers down (finally seam).
 *
 * The hard timer rejects FIRST and cancels the body SECOND — Node resolves the
 * pending read synchronously inside reader.cancel() (done:true), and the race
 * must adopt the typed error, not the cancel's done. The user's abort signal
 * stays untouched: a USER abort surfaces as AbortError (never retried); only
 * idle-timeout aborts retry.
 */
export interface StreamIdleGuard {
  arm(): void;
  chunk(bytes: number): void;
  race<T>(read: Promise<T>): Promise<T>;
  dispose(): void;
}

export function createStreamIdleGuard(
  budget: StreamIdleBudget,
  opts: {
    /** The soft tier's warn hook — fires at most once per silent gap. */
    onSoftWarning?: (info: StreamIdleWarningInfo) => void;
    /** The hard tier's body teardown (reader.cancel) — reject first, then this. */
    cancel?: () => void;
  } = {},
): StreamIdleGuard {
  const startedAt = Date.now();
  let bytes = 0;
  const softWarns: number[] = [];
  let softTimer: ReturnType<typeof setTimeout> | undefined;
  let hardTimer: ReturnType<typeof setTimeout> | undefined;
  let hardRace: Promise<never> | undefined;
  let armed = false;

  const clearTimers = (): void => {
    if (softTimer !== undefined) clearTimeout(softTimer);
    if (hardTimer !== undefined) clearTimeout(hardTimer);
    softTimer = undefined;
    hardTimer = undefined;
    hardRace = undefined;
    armed = false;
  };

  return {
    arm(): void {
      if (armed) return; // hard keeps its original deadline across a soft wake
      armed = true;
      if (budget.softMs > 0) {
        softTimer = setTimeout(() => {
          softTimer = undefined;
          softWarns.push(Date.now() - startedAt);
          opts.onSoftWarning?.({ idleMs: budget.softMs, bytesSoFar: bytes, softWarns: [...softWarns] });
        }, budget.softMs);
      }
      if (budget.hardMs > 0) {
        hardRace = new Promise<never>((_, reject) => {
          hardTimer = setTimeout(() => {
            // Reject FIRST, cancel second (see the interface comment).
            reject(new StreamIdleError(budget.hardMs, { bytes, softWarns: [...softWarns] }));
            opts.cancel?.();
          }, budget.hardMs);
        });
      }
    },
    chunk(b: number): void {
      bytes += b;
      clearTimers();
    },
    race<T>(read: Promise<T>): Promise<T> {
      return hardRace !== undefined ? Promise.race([read, hardRace]) : read;
    },
    dispose(): void {
      clearTimers();
    },
  };
}
