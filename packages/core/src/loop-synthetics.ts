// 拆分运动（借鉴弧 δ 顺带件，file-size 棘轮「把压力推向拆分」）：loop.ts 的
// 纯合成层外提——模型面合成结果常量（截断/中止两态/持久化失败/输出上限/
// 空回复/断流恢复）、恢复错误分类（TurnRetryClass 族）、abort/timeout 赛跑
// 机器、当前时间注记格式化、后台过载鸭子判定。全部逐字节搬家，行为零变
// 化；loop.ts 经 import + re-export 维持既有公共面（tests/index 导入路径不
// 动）。本文件永不 import loop.ts（单向依赖）。

export type TurnRetryClass = "idle" | "429" | "5xx" | "network" | "other";

/** ω99-315: classify a recovery-path error. Duck-typed exactly like the rest
 *  of the core↔providers port (core never imports the providers package):
 *  StreamIdleError on `name`, ProviderHttpError on its message shape. */
export function classifyTurnRetryError(err: unknown): TurnRetryClass {
  if (err instanceof Error && err.name === "StreamIdleError") return "idle";
  const status = err instanceof Error ? /^provider (?:request|stream) failed: (\d{3})/.exec(err.message)?.[1] : undefined;
  if (status !== undefined) {
    if (status === "429") return "429";
    if (Number(status) >= 500) return "5xx";
    return "other";
  }
  return "network";
}


// M23 §3a: the turn budget is a runaway FUSE, not the normal stop condition —
// long tasks are driven by the todo board (gates), not the turn counter.
export const DEFAULT_MAX_TURNS = 200;

/** M61 §3: the stop-hook block cap — after this many consecutive
 *  continuations without any tool use, the run stops regardless of the hook
 *  (Terminal.stopBlockCapped). The /goal stall guard's official semantics. */
export const STOP_BLOCK_CAP = 3;

/** M70 §1 (the upstream project): the explanatory error result for a length-truncated tool
 *  call. A stop_reason of "length" means the token limit cut the generation
 *  MID-ARGUMENTS — whatever arguments survived salvage-parsing are silently
 *  incomplete and may even pass schema validation. The guard fails EVERY tool
 *  call of such a message with this text instead of executing anything; the
 *  model re-issues complete calls on the next turn. */
export const TRUNCATED_TOOL_CALL_RESULT = "参数被截断，内容不完整，无法安全执行——请重新发起完整的工具调用";

/** 波次 8 #41 (the upstream format#13+#18): the two synthetic tool results that keep a
 *  tool-phase abort's history PAIRED. The interrupted assistant (its
 *  tool_call batch) is already committed with `interrupted: true` (夜移 001);
 *  these answer every call that never got a real result, so resume/replay
 *  never hits repairOrphanedToolCalls' blind backfill — and the model can
 *  tell "may have side-effected → verify first" from "never ran → safe to
 *  re-issue" (the whole point of a ref's TOOL_OUTCOME_UNKNOWN /
 *  TOOL_NOT_STARTED split). Model-facing, like TRUNCATED_TOOL_CALL_RESULT. */
export const ABORTED_UNKNOWN_TOOL_RESULT = "[已中断] 工具在执行途中被中止,结果未知——副作用可能已发生也可能未发生;重新发起前请先验证现状,不要盲目重试";
export const ABORTED_NOT_STARTED_TOOL_RESULT = "[已中断] 工具在中止前尚未开始执行,什么都没有发生——可以安全地重新发起";

/** 波次 8 #45 (the upstream formatsession-checkpoint-policy): the fail-closed synthetic for
 *  a tool batch whose pre-dispatch durability barrier REJECTED. Nothing ran —
 *  running side-effecting bodies with no durable record of their dispatch is
 *  how a crash becomes an untraceable mutation — so the batch fails whole and
 *  the model sees why. Model-facing, like TRUNCATED_TOOL_CALL_RESULT. */
export const PERSIST_FAILED_TOOL_RESULT = "[会话写入失败] 工具未执行——会话记录此刻无法落盘,本批全部工具调用已取消,未产生任何副作用;待会话存储恢复后可安全地重新发起";

/** 夜移 013 — the output-limit recovery ladder's resume-mid-thought note
 *  (真 the upstream formatquery.ts:1188-1256 tier-2 nudge 的中文化身, same imperatives: no
 *  apology, no recap, pick up mid-thought, smaller steps). Appended as a
 *  plain user message AFTER the truncated assistant — pure append, so the
 *  KV-cache prefix stays byte-stable. A DIFFERENT family from M70's guard:
 *  that one is for truncated TOOL calls (never execute); this one is for
 *  truncated TEXT answers (keep writing). */
export const OUTPUT_LIMIT_NUDGE = "[输出被截断] 输出长度达到上限,内容被切断。直接从中断处继续写——不要道歉、不要复述已写内容、不要总结;从中断点接着写,把剩余内容拆成更小的部分。";

/** 夜移 013 — the default nudge budget (consecutive truncations without a
 *  clean turn in between; any non-length turn resets the episode). */
export const DEFAULT_OUTPUT_LIMIT_NUDGES = 3;

// 夜移 033 (the upstream projectpackages/ai/src/utils/overflow.ts Case 3) — a length-stop
// carrying ZERO output tokens over a ≥99%-full window is not a truncation:
// the server silently truncated the oversized INPUT (Xiaomi MiMo style),
// leaving no room to generate a single token. Nudging — appending MORE
// tokens into that window — deterministically repeats the failure and burns
// the ladder budget before landing the WRONG terminal. The honest move is a
// reactive compaction (the M58 vocabulary this loop already owns). Pure so
// evals can pin the arithmetic; fail-open edges — no completion count, or an
// unknown window (0) — keep the ordinary 013 nudge path.
export const isZeroOutputOverflow = (
  completionTokens: number | undefined,
  promptTokens: number,
  windowTokens: number,
): boolean =>
  completionTokens === 0
  && windowTokens > 0
  && promptTokens >= Math.floor(0.99 * windowTokens);

/** 夜移 024 — the empty-final guard's synthetic user note (Reasonix
 *  emptyFinalRetryMessage 的中文化身, same imperatives: continue the task,
 *  concise VISIBLE answer, reasoning alone is not an answer). Appended as a
 *  plain user message AFTER the blank assistant turn — pure append, so the
 *  KV-cache prefix stays byte-stable. This is the SECOND line of defense:
 *  the provider layer already gave a reasoning-only blank one frozen
 *  byte-identical replay (M48 §2); this nudge is a different-instruction
 *  request, the last chance before the blank settles. */
export const EMPTY_FINAL_NUDGE = "[空回复] 上一条回复没有任何可见内容。继续当前任务，直接给出简洁、可见的回答；不要只输出思考。";

/** 夜移 024 — the default nudge budget. Reasonix allows 3; wudao allows 1
 *  because the provider layer already fronted the first retry for the
 *  reasoning-only shape, and a third attempt at a degenerate mode rarely
 *  recovers. The budget counts consecutive blank finals; any tool round
 *  resets it. */
export const DEFAULT_EMPTY_FINAL_NUDGES = 1;

/** ω99-9 — the mid-stream recovery arm's continuation note (the upstream harness #571
 * `[turn_retried]` 尾部追注的 wudao 落地； same imperatives as
 * OUTPUT_LIMIT_NUDGE: no apology, no recap, continue from the break). A
 * transport failure AFTER delivered deltas committed the prefix as an
 * `interrupted` assistant message; this note follows it as a plain user
 * message and the resent call carries both — pure append, so the KV-cache
 * prefix stays byte-stable (M24). Frozen constant by design: from the first
 * recovery on these bytes are part of the request prefix, so any wording
 * change mid-session invalidates warm caches. */
export const TURN_RECOVERY_NOTE = "[turn_retried] 上一条回复在流式输出途中因传输故障中断，已收到的部分已保留。从中断处直接继续写——不要道歉、不要复述、不要重复已输出的内容。";

/** ω99-9 — the per-turn budget for post-delta mid-stream recovery. Counted
 * separately from the provider layer's pre-delta retry ladder (the upstream harness 混计
 * 20 的教训): the two failures mean different things — received content
 * proves the connection worked, so recovery here must not burn the ladder's
 * budget, and a "streams a little then dies" endpoint is bounded by its OWN
 * small absolute cap before the failure finally propagates. Per-turn: the
 * next turn starts at zero. */
export const MAX_TURN_RECOVERY_ATTEMPTS = 3;


// ω99-9: the providers package stamps background-overload failures with this
// name at its boundary (M70 §3 — a background/subagent query hitting an
// overload must back off immediately, never be revived into more load). Core
// never imports providers, so the recovery arm duck-types on `name` — the
// same port contract isContextLengthError established.
export function isBackgroundOverloadError(err: unknown): boolean {
  return err instanceof Error && err.name === "BackgroundOverloadError";
}


// A shared per-batch promise that rejects when the signal fires, raced against
// tool executions so a hung tool cannot outlive an abort. `cleanup` removes the
// listener; the no-op catch keeps a rejection that lands outside an active
// race from surfacing as an unhandled rejection. If the signal is already
// aborted, rejects immediately.
export function createAbortRace(signal: AbortSignal): { promise: Promise<never>; cleanup: () => void } {
  let cleanup = () => {};
  const promise = new Promise<never>((_, reject) => {
    // If already aborted, reject immediately
    if (signal.aborted) {
      reject(Object.assign(new Error("This operation was aborted"), { name: "AbortError" }));
      return;
    }
    const onAbort = () => reject(Object.assign(new Error("This operation was aborted"), { name: "AbortError" }));
    signal.addEventListener("abort", onAbort, { once: true });
    cleanup = () => signal.removeEventListener("abort", onAbort);
  });
  void promise.catch(() => {});
  return { promise, cleanup };
}

/** 夜移 002: the executor's timeout signal — rejected by raceToolTimeout so
 *  executeToolCall's catch can map it to the structured timeout result. */
/** 夜移 003: deterministic current-time note (hand-formatted — no locale
 *  dependency, so tests and prefix-cache byte-stability hold on any host):
 *  [current time: 2026-08-28 01:35 +08:00 Friday (local)] */
const TIME_NOTE_WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;
export function formatTimeReminderNote(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const tz = -d.getTimezoneOffset();
  const sign = tz >= 0 ? "+" : "-";
  const a = Math.abs(tz);
  return `[current time: ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())} ${sign}${pad(Math.floor(a / 60))}:${pad(a % 60)} ${TIME_NOTE_WEEKDAYS[d.getDay()] ?? ""} (local)]`;
}

export class ToolTimeoutError extends Error {
  constructor(ms: number) {
    super(`[timeout after ${ms}ms]`);
    this.name = "ToolTimeoutError";
  }
}

/** 夜移 002 (the upstream formattimeout-policy, hardened): race a tool call against its
 *  declared timeoutMs. The underlying promise is never cancelled — when the
 *  timer wins, the race rejects with ToolTimeoutError and the abandoned
 *  promise keeps running detached with its result discarded (the Promise
 *  construction below attaches handlers to it, so a later rejection never
 *  surfaces as unhandled). */
export function raceToolTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new ToolTimeoutError(ms)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

// M58 §A: the terminal context-overflow failure. `compacted` distinguishes
// the two paths: true = the reactive compaction ran and the retried call
// STILL overflowed; false = no compaction could run (not configured, or the
// overflow surfaced after streamed deltas, which can never be replayed). In
// both the task does not fit the model's window; the message carries the
// spec's explicit guidance (/clear or a smaller task) and matches the actual
// path. The `hard: true` field separates the terminal variant from the
// provider's first-shot ContextLengthError while keeping the duck-type NAME
// so front-ends keying on isContextLengthError recognize the whole family.
export class ContextOverflowHardError extends Error {
  readonly hard: true;
  readonly compacted: boolean;

  constructor(detail: string, compacted: boolean) {
    super(
      compacted
        ? `context still exceeds the model window after reactive compaction (${detail}). Start a fresh session with /clear or split the task into smaller pieces.`
        : `context exceeds the model window and no compaction could run (${detail}). Start a fresh session with /clear or split the task into smaller pieces.`,
    );
    this.name = "ContextLengthError";
    this.hard = true;
    this.compacted = compacted;
  }
}

/** 133 #5（the upstream projectff 引进）— content_filter 终因的恢复指导（512B 帽
 * 中文定制+国产模型现实：DeepSeek/GLM 敏感词过滤的刚需面）。核心纪律：
 * 不当瞬时故障、禁绕过、给合规替代、继续无关授权工作。注入卫生：不复述
 * 被拦内容原文。 */
export const CONTENT_FILTER_GUIDANCE = `[内容过滤] 你的回复被内容安全过滤拦下了。这不是网络故障,重试同样的内容只会再次被拦。
请遵守:1) 不要以重复、换格式、拆分、编码、用工具或子代理等方式绕过过滤;2) 简述你能完成的替代方案(换一个合规的表述角度继续任务);3) 如果当前话题无法继续,转到用户授权的其它工作上。`;
