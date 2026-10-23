// ω99-7 — auto-refine: the automatic trigger layer over /refine (prime-agent
// _maybeAutoRefine 防抖语义全搬, 按 wudao 缝重落; qm consolidation 规则已并进
// REFINE_SYSTEM_PROMPT). Two levels: a turn counter / compaction event decides
// WHETHER to consider a refine, then one CHEAP model call (a JSON boolean
// gate) decides whether the full refine is worth its tokens — only then does
// the EXISTING ω99-3a pipeline run (planRefinement + applyRefinement), so the
// auto path gains ZERO new write permissions and inherits the three safety
// disciplines verbatim (create 必 pending / update 必转 pending / delete 只建议).
//
// 红线（改动前重读）:
//  - 默认 OFF（refine-auto-config: enabled=false）。OFF 时 observeAutoRefineOnHooks
//    返回 hooks 原对象——接线字节零变化。
//  - 绝不 block run: onRunStop 包装是观察侧——先放行底层决策, run 真正停下
//    （决策=allow）才评估触发; auto-refine 无权拦 run。
//  - 失败必盖 cooldown 章（防每轮重试）: 门解析失败、门网络炸、apply 炸都盖章。
//  - 门解析复用 refine.ts 的 extractProposalJson（三级容错）, 不另抄一份。
//
// 语义取舍（prime-agent → wudao, 报告有载）:
//  - 计数标记 = 内存基线（时间戳 + assistant 计数基线）, 不落盘——会话重启
//    即重数, 可接受。基线存"计数"而非消息索引: 压缩会重写 state.messages,
//    索引会漂, 计数只会保守归零（max(0, cur-baseline)）。
//  - branch 版本守卫未搬: wudao 的 refine 写的是 memory store 而非会话历史,
//    会话分叉不 invalidate 已落 store 的编辑。
//  - shouldRefine=false（含解析失败）统一盖章+清零; prime-agent 在 compact 触发
//    且 turns 已达标时会保留 turn 复审, wudao 从简不保留（更保守, 少花调用）。
import { truncateSafe, truncateTailSafe } from "@wudao/core"; // 113-A4
import type { AgentHooks, AgentMessage, AgentState, ModelClient, StopHookDecision } from "@wudao/core";
import { extractProposalJson, planRefinement, applyRefinement, serializeTrajectory } from "./refine.js";
import { openMemoryStore, openSessionMemoryStore } from "./store.js";
import type { MemoryStore } from "./store.js";
import { loadRefineAutoSettings, resolveRefineAutoSettings } from "../refine-auto-config.js";
import type { RefineAutoSettings, RefineAutoWarn } from "../refine-auto-config.js";

/** The two trigger sources: the assistant-turn counter and compaction. */
export type AutoRefineTriggerReason = "turns" | "compact";

/** The pure decision's verdict. run=false reasons: off (feature disabled),
 *  busy (a refine is in flight — the shell parks the trigger as pending),
 *  cooldown-skip (a recent attempt stamped the cooldown — the shell PRESERVES
 *  the pending flags so the signal survives into the next window), not-yet
 *  (neither trigger qualifies). */
export type AutoRefineDecision =
  | { readonly run: true; readonly reason: AutoRefineTriggerReason }
  | { readonly run: false; readonly reason: "off" | "busy" | "cooldown-skip" | "not-yet" };

export interface AutoRefineDecisionInput {
  readonly assistantTurnsSince: number;
  readonly compactPending: boolean;
  readonly cfg: RefineAutoSettings;
  readonly now: number;
  /** The last cooldown stamp; 0 = never (the sentinel). */
  readonly lastAt: number;
  readonly inProgress: boolean;
}

/** Pure: the two-level trigger's first level. Cooldown outranks both
 *  triggers (a stamped failure must not re-enter on the same signal);
 *  compact outranks turns (rarer, higher-signal checkpoint); a disabled
 *  compact trigger falls through to the turn check (prime-agent's
 *  reason-rewriting, decided here instead). */
export function shouldTriggerAutoRefine(s: AutoRefineDecisionInput): AutoRefineDecision {
  if (!s.cfg.enabled) return { run: false, reason: "off" };
  if (s.inProgress) return { run: false, reason: "busy" };
  if (s.lastAt > 0 && s.now - s.lastAt < s.cfg.cooldownMs) return { run: false, reason: "cooldown-skip" };
  if (s.compactPending && s.cfg.compact) return { run: true, reason: "compact" };
  if (s.assistantTurnsSince >= s.cfg.turnInterval) return { run: true, reason: "turns" };
  return { run: false, reason: "not-yet" };
}

/** The counting surface: assistant MESSAGES since the in-memory baseline (a
 *  tool-call-only round is still an assistant turn — the model acted). */
export function countAssistantTurns(messages: readonly AgentMessage[]): number {
  let n = 0;
  for (const m of messages) if (m.role === "assistant") n += 1;
  return n;
}

// ---------------------------------------------------------------------------
// ω99-7b — the edit-activity digest: a deterministic portrait of WHAT the run
// wrote, injected into the SAME gate call (zero extra model calls, zero new
// state). Why: serializeTrajectory renders only tool NAMES (14 edits vs 14
// reads look identical to the gate) and the 40k tail beheads long runs —
// precisely the runs that trip the 25-turn trigger; the digest hands the gate
// in its first tokens what it would otherwise have to guess from 40k.
// ---------------------------------------------------------------------------

/** The digest over the last `sinceAssistantCount` assistant messages (含其间
 *  交错的 tool/user 消息) — the SAME counting face as countAssistantTurns
 *  (role==="assistant"), so the window is exactly turnsSinceLastReview
 *  messages deep: 与 turnsSince = count - baseline 的语义严格一致. */
export interface EditActivitySummary {
  readonly writeCalls: number; // write_file + edit 调用次数
  readonly files: readonly string[]; // 去重 path（arguments.path 字符串）, 字典序
}

export function summarizeEditActivity(
  messages: readonly AgentMessage[],
  sinceAssistantCount: number,
): EditActivitySummary {
  // 窗口不复用全量 messages — 上次复审已精炼过的活动不重复计入（turn-50 触发
  // 不把 turn-25 已复审的编辑再算一遍）。从尾部向前, 数过第 N 条 assistant 即停。
  let writeCalls = 0;
  let assistantSeen = 0;
  const files = new Set<string>();
  for (const m of [...messages].reverse()) {
    if (m.role !== "assistant") continue;
    if (assistantSeen >= sinceAssistantCount) break;
    assistantSeen += 1;
    for (const c of m.toolCalls ?? []) {
      // 只数写工具 — 写活动是决策信号, 读不是（YAGNI）; read_file/shell 不数。
      if (c.name !== "write_file" && c.name !== "edit") continue;
      writeCalls += 1;
      const p = c.arguments["path"]; // write-scope-guard.ts:55 同键
      if (typeof p === "string") files.add(p); // 非 string path: 次数仍计入, 文件不收
    }
  }
  return { writeCalls, files: [...files].sort() };
}

// ---------------------------------------------------------------------------
// The cheap gate — ONE model call, one JSON boolean (prime-agent
// reviewAutoRefine; parsing reuses extractProposalJson's三级容错).
// ---------------------------------------------------------------------------

/** prime-agent's gate rides a 40k trajectory tail (vs the full refine's 80k)
 *  — the gate must stay cheaper than what it gates. */
const AUTO_REFINE_GATE_TRAJECTORY_CHARS = 40_000;

/** The digest line's file-list cap: beyond 12 the list truncates to the
 *  lexicographic first 12 + " (+N more)" — the line stays byte-deterministic
 *  (sort order pinned, so identical inputs yield identical prompt bytes). */
const ACTIVITY_DIGEST_MAX_FILES = 12;

function formatEditActivity(s: EditActivitySummary): string {
  if (s.files.length === 0) return `write_file/edit calls: ${s.writeCalls}`;
  const shown = s.files.slice(0, ACTIVITY_DIGEST_MAX_FILES);
  const elided = s.files.length - shown.length;
  const list = shown.join(", ") + (elided > 0 ? ` (+${elided} more)` : "");
  return `write_file/edit calls: ${s.writeCalls} across ${s.files.length} files (${list})`;
}

export const AUTO_REFINE_GATE_SYSTEM_PROMPT = [
  "你是 wudao 的 auto-refine 门卫（cheap gate）：判断这个检查点是否值得跑一次完整的 /refine 精炼。",
  "Decide whether this checkpoint deserves a full /refine pass. Approve when the trajectory contains durable operational lessons (tool lessons, workflow preferences, plan-gate timing) worth persisting; reject one-off noise, transient tool outputs, and mid-task checkpoints where nothing has settled.",
  'Output JSON ONLY — exactly this shape, no prose, no code fence: {"shouldRefine": true|false, "rationale": "short reason"}',
].join("\n");

export interface AutoRefineGateVerdict {
  readonly shouldRefine: boolean;
  readonly rationale: string;
}

/** One model.generate → the boolean verdict. NEVER throws on an unparseable
 *  reply (garbage ⇒ shouldRefine=false); a transport failure (network)
 *  PROPAGATES — the runtime's catch is what stamps the cooldown for those. */
export async function reviewAutoRefineGate(
  model: ModelClient,
  messages: readonly AgentMessage[],
  context: { readonly reason: AutoRefineTriggerReason; readonly turnsSinceLastReview: number },
): Promise<AutoRefineGateVerdict> {
  const userPrompt = [
    `Trigger: ${context.reason}; ${context.turnsSinceLastReview} assistant turns since the last auto-refine review.`,
    "",
    // ω99-7b: the digest rides BEFORE the trajectory tail so the gate reads the
    // activity portrait in its first tokens — 覆盖已被 40k 截头吞掉的窗口起点。
    // 门内计算（签名不变）: 从 messages + turnsSinceLastReview 纯函数导出, 零新状态。
    "## Run activity since last review",
    formatEditActivity(summarizeEditActivity(messages, context.turnsSinceLastReview)),
    "",
    "## Session trajectory (tail)",
    truncateTailSafe(serializeTrajectory(messages), AUTO_REFINE_GATE_TRAJECTORY_CHARS),
    "",
    'Answer {"shouldRefine": true|false, "rationale": "…"} — nothing else.',
  ].join("\n");
  const reply = await model.generate({
    systemPrompt: AUTO_REFINE_GATE_SYSTEM_PROMPT,
    messages: [{ role: "user", content: userPrompt }],
    tools: [],
  });
  const parsed = extractProposalJson(reply.content);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { shouldRefine: false, rationale: "gate reply unparseable" };
  }
  const r = parsed as Record<string, unknown>;
  return {
    shouldRefine: r["shouldRefine"] === true,
    rationale: typeof r["rationale"] === "string" ? r["rationale"] : "",
  };
}

// ---------------------------------------------------------------------------
// The runtime — decision + gate + the EXISTING pipeline, with the debounce.
// ---------------------------------------------------------------------------

/** The in-memory marker (计数基线 + cooldown 章 + 两旗), exposed read-only
 *  for tests/diagnostics. baselineTurns is the assistant count AT the last
 *  reset; `0` means "never stamped" for lastAt. */
export interface AutoRefineSnapshot {
  readonly lastAt: number;
  readonly baselineTurns: number;
  readonly inProgress: boolean;
  readonly pendingTurns: boolean;
  readonly pendingCompact: boolean;
}

export interface AutoRefineRuntime {
  readonly cfg: RefineAutoSettings;
  /** A compaction just landed (any tier, manual or auto) — arms the compact
   *  trigger, evaluated at the NEXT run stop. No-op when the compact trigger
   *  is disabled (the flag would never be consumable). */
  noteCompacted(): void;
  /** A run just stopped. The full two-level evaluation (decision → gate →
   *  maybe the /refine pipeline); never rejects to the caller. */
  noteRunStopped(messages: readonly AgentMessage[], model: ModelClient | undefined): Promise<void>;
  snapshot(): AutoRefineSnapshot;
}

export interface AutoRefineDeps {
  readonly cfg: RefineAutoSettings;
  readonly workspaceRoot: string;
  /** Test seam; default = the /refine command's own store resolution. */
  readonly openStore?: () => MemoryStore;
  /** Where the receipt lands (a notice channel — never the conversation). */
  readonly onNotice?: (text: string) => void;
  readonly now?: () => number;
}

export function createAutoRefineRuntime(deps: AutoRefineDeps): AutoRefineRuntime {
  const now = deps.now ?? Date.now;
  const openStore = deps.openStore ?? (() => openSessionMemoryStore(deps.workspaceRoot) ?? openMemoryStore(deps.workspaceRoot));
  let lastAt = 0;
  let baselineTurns = 0;
  let inProgress = false;
  let pendingTurns = false;
  let pendingCompact = false;

  async function runTrigger(reason: AutoRefineTriggerReason, messages: readonly AgentMessage[], model: ModelClient | undefined): Promise<void> {
    const turnsSince = Math.max(0, countAssistantTurns(messages) - baselineTurns);
    const d = shouldTriggerAutoRefine({
      assistantTurnsSince: turnsSince,
      compactPending: pendingCompact,
      cfg: deps.cfg,
      now: now(),
      lastAt,
      inProgress,
    });
    if (!d.run) {
      if (d.reason === "busy" || d.reason === "cooldown-skip") {
        // 触发挂 pending 分因由保留 — busy/cooldown 都不丢信号, 下次 run 停止再评估.
        if (reason === "compact") pendingCompact = true;
        else pendingTurns = true;
      }
      return;
    }
    // The flag that fired is consumed; the OTHER flag stays for its own cycle.
    if (d.reason === "compact") pendingCompact = false;
    else pendingTurns = false;
    if (model === undefined) {
      // A frontend without a resident model: nothing to plan through (the
      // dream-verb precedent). No stamp — a later stop with a model retries.
      return;
    }
    inProgress = true;
    try {
      const verdict = await reviewAutoRefineGate(model, messages, { reason: d.reason, turnsSinceLastReview: turnsSince });
      if (!verdict.shouldRefine) {
        // false（含解析失败）: 盖章 + 清零 — prime-agent 语义, wudao 统一两路.
        lastAt = now();
        baselineTurns = countAssistantTurns(messages);
        pendingTurns = false;
        pendingCompact = false;
        return;
      }
      // 过门 → 原样跑 ω99-3a 管线（零新写权限, 三纪律继承）; the gate's
      // rationale rides as instructions so the proposer knows WHY it was let through.
      const store = openStore();
      const instructions = `Auto-refine checkpoint (${d.reason}; ${turnsSince} assistant turns since the last review). Gate rationale: ${verdict.rationale}`;
      const plan = await planRefinement(model, messages, store, instructions);
      const { receipt } = await applyRefinement(deps.workspaceRoot, store, plan);
      deps.onNotice?.(receipt);
      lastAt = now();
      baselineTurns = countAssistantTurns(messages);
      pendingTurns = false;
      pendingCompact = false;
    } catch {
      // 失败必盖 cooldown 章（防每轮重试）: gate 网络炸 / apply 炸都盖章; 计数
      // 保留 — 冷却过后 turns 重新达标即重试（prime-agent 的 catch 语义）.
      lastAt = now();
    } finally {
      inProgress = false;
    }
  }

  return {
    cfg: deps.cfg,
    noteCompacted(): void {
      if (deps.cfg.compact) pendingCompact = true;
    },
    async noteRunStopped(messages, model) {
      if (!deps.cfg.enabled) return;
      // compact 优先（更稀有、更高信号的检查点）; a parked turns trigger
      // re-evaluates here too — every stop is a fresh decision.
      const reason: AutoRefineTriggerReason = pendingCompact ? "compact" : "turns";
      try {
        await runTrigger(reason, messages, model);
      } catch {
        /* observational — a runtime bug never surfaces into the run */
      }
    },
    snapshot: () => ({ lastAt, baselineTurns, inProgress, pendingTurns, pendingCompact }),
  };
}

// ---------------------------------------------------------------------------
// The wiring seams — the observational hooks wrapper + the process singleton.
// ---------------------------------------------------------------------------

/** Wrap `hooks` so a stopped run and a landed compaction reach the runtime.
 *  rt undefined → hooks returned UNCHANGED (byte-zero when the feature is
 *  OFF). Observational: the inner stop decision passes through VERBATIM and
 *  the trigger fires only when the run actually stops (decision = "allow") —
 *  auto-refine has no vote on whether a run continues. The stop is AWAITED
 *  (never detached): a one-shot frontend's process must not exit mid-refine,
 *  and the cooldown + turn interval keep this rare for the opt-in user. */
export function observeAutoRefineOnHooks(
  hooks: AgentHooks | undefined,
  rt: AutoRefineRuntime | undefined,
  getModel: () => ModelClient | undefined,
): AgentHooks | undefined {
  if (rt === undefined) return hooks;
  const innerStop = hooks?.onRunStop;
  const innerPostCompact = hooks?.onPostCompact;
  return {
    ...hooks,
    onRunStop: async (state: AgentState): Promise<StopHookDecision> => {
      let decision: StopHookDecision = "allow";
      if (innerStop !== undefined) {
        try {
          decision = await innerStop(state);
        } catch {
          decision = "allow"; // the loop's own throw-degrades-to-allow contract
        }
      }
      if (decision !== "allow") return decision; // the run continues — no trigger
      try {
        await rt.noteRunStopped(state.messages, getModel());
      } catch {
        /* observational isolation */
      }
      return "allow";
    },
    onPostCompact: async (messages: readonly AgentMessage[], trigger: "manual" | "auto"): Promise<void> => {
      try {
        await innerPostCompact?.(messages, trigger);
      } finally {
        try {
          rt.noteCompacted();
        } catch {
          /* observational isolation */
        }
      }
    },
  };
}

/** The process-level singleton (the reflectRuntimeFor precedent): the loop
 *  seams (repl / driver / headless) resolve auto-refine through ONE lazy
 *  load — the first caller's root wins; OFF (default / kill switch / failed
 *  load) resolves to undefined so the frontends attach nothing at all. */
let refineAutoRuntimeCache: Promise<AutoRefineRuntime | undefined> | undefined;

export function refineAutoRuntimeFor(
  workspaceRoot: string,
  opts: { readonly warn?: RefineAutoWarn; readonly env?: NodeJS.ProcessEnv; readonly onNotice?: (text: string) => void } = {},
): Promise<AutoRefineRuntime | undefined> {
  if (refineAutoRuntimeCache === undefined) {
    refineAutoRuntimeCache = loadRefineAutoSettings(workspaceRoot, opts.warn ?? (() => {}), opts.env ?? process.env)
      .then((settings) => {
        const cfg = resolveRefineAutoSettings(settings, opts.env ?? process.env);
        return cfg.enabled
          ? createAutoRefineRuntime({ cfg, workspaceRoot, ...(opts.onNotice !== undefined ? { onNotice: opts.onNotice } : {}) })
          : undefined;
      })
      .catch((): undefined => undefined); // a broken settings read degrades to OFF
  }
  return refineAutoRuntimeCache;
}

/** Test seam — drop the memoized runtime (a new root/env takes effect). */
export function resetRefineAutoRuntimeCache(): void {
  refineAutoRuntimeCache = undefined;
}
