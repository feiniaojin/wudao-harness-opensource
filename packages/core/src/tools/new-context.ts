// 125 项 1（codex new_context 形，125 报告 B3/落地序 #6）— the model-side
// context-rotation tool. Compaction in wudao is HARNESS-decided (threshold,
// boundary economics, overflow ladder); the one piece of information only the
// model has — "my context is polluted / the subtask is done and the old window
// is dead weight" — had no channel. This tool IS that channel: the model asks
// for a fresh window with a rationale, optionally naming facts that MUST
// survive (preserve); the harness answers with a tier-2 rotation boundary.
//
//   · 语义：codex 的 rotation-within-session 立场（125 §1.1 公理 1）——不换会
//     话，session 内开新窗。轮转走正常 tier-2 压缩边界（前缀本来就要重写，
//     M24 零额外缓存代价）；摘要头部带 `[context rotated by agent: …]` 身份
//     行（125b 窗口链落地前的窗口身份缝）；preserve 文本既织进摘要指令、又
//     逐字骑在冻结摘要上（下线 provider/零 LLM 路径都丢不了）。
//   · 端口：工具的 execute 经 LATE-BOUND 端口盒调用（goalFace 的 getRuntime
//     同款纪律）——盒子由宿主建、loop 在运行期安装实现（cap 检查/预检/当场
//     轮转），运行外或未接线前端 fail-closed。轮转在工具执行内完成（工具
//     结果是「已轮转 + 新窗口号」的诚实回执，不是承诺）。
//   · 预算：每会话最多 AGENT_ROTATION_CAP 次模型侧轮转（GoalState budget 同
//     族——计数骑 M35 §2 generic session lane 的 context_rotation 条目，
//     resume 重放恢复；防滥用帽是本工具的专属守卫，不占压缩 thrash 名额）。
//   · 边界：interruptBehavior "block"——轮转是一次摘要调用，原子完成（不与
//     abort/detach 赛跑）；非并发安全（任何含本工具的批走顺序路径，轮转期
//     间兄弟调用的结果追加重排在压缩后的数组上，配对不破）。子代理集不含
//     本工具（rotation 是父会话能力，v1 边界）。
import { buildTool } from "../tool.js";
import type { Tool, ToolParameterSchema } from "../tool.js";
import type { GenericSessionEntry, SessionEntry } from "../session/store.js";

/** The tool's wire name (the loop's port wiring and tests key on it). */
export const NEW_CONTEXT_TOOL_NAME = "new_context";
/** Per-session cap on MODEL-side rotations (the abuse guard — the thrash
 *  breaker owns AUTO compaction spirals, this owns the model's initiative;
 *  the session lane's context_rotation entries are the durable count). */
export const AGENT_ROTATION_CAP = 10;
/** Max chars of the rationale ARGUMENT (the model-facing cap; the summary
 *  header line re-caps to ROTATION_RATIONALE_HEADER_CAP_CHARS). */
export const NEW_CONTEXT_RATIONALE_MAX_CHARS = 500;
/** Max chars of the preserve ARGUMENT (the note-content cap family — preserve
 *  is key facts, not a document; rides the summary verbatim). */
export const NEW_CONTEXT_PRESERVE_MAX_CHARS = 4000;

// ---------------------------------------------------------------------------
// The session-lane counter (GoalState budget 同族): one append-only
// `{type: "context_rotation", data}` row per SUCCESSFUL rotation; resume
// replays the count. Never a message — load() filters generic entries.
// ---------------------------------------------------------------------------

/** The entry type on the M35 §2 generic lane. */
export const CONTEXT_ROTATION_ENTRY_TYPE = "context_rotation";

/** The `data` contract of a context_rotation row. */
export interface ContextRotationEntryData {
  /** The window the rotation OPENED (summary-marker count after the swap). */
  readonly window: number;
  readonly rationale: string;
  /** ISO timestamp of the rotation. */
  readonly at: string;
}

/** The canonical entry factory — one row per successful model-side rotation. */
export function buildContextRotationEntry(data: ContextRotationEntryData): GenericSessionEntry {
  return { type: CONTEXT_ROTATION_ENTRY_TYPE, data: { window: data.window, rationale: data.rationale, at: data.at } };
}

/** Read-side fail-safe parse (the goal-state discipline: any structurally
 *  wrong field drops the WHOLE row — never throws, never partially loads). */
export function parseContextRotationData(data: unknown): ContextRotationEntryData | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  const d = data as Record<string, unknown>;
  if (typeof d.window !== "number" || !Number.isInteger(d.window) || d.window < 1) return undefined;
  if (typeof d.rationale !== "string") return undefined;
  if (typeof d.at !== "string") return undefined;
  return { window: d.window, rationale: d.rationale, at: d.at };
}

/** File-order replay: how many model-side rotations THIS session has spent
 *  (corrupt rows skip silently — the counter is a budget, not an audit). */
export function countContextRotations(entries: readonly SessionEntry[]): number {
  let n = 0;
  for (const e of entries) {
    if ("role" in e) continue;
    if (e.type !== CONTEXT_ROTATION_ENTRY_TYPE) continue;
    if (parseContextRotationData(e.data) !== undefined) n += 1;
  }
  return n;
}

// ---------------------------------------------------------------------------
// The port (late-bound): the HOST owns the box, the LOOP installs the
// implementation for the run's lifetime. Tool execute only ever speaks to it.
// ---------------------------------------------------------------------------

/** What the model asked for. */
export interface AgentRotationRequest {
  readonly rationale: string;
  readonly preserve?: string;
}

/** Why a rotation was refused (each code maps to one typed tool-result line —
 *  the model gets an actionable reason, never a bare "no"). */
export type AgentRotationRefusalCode =
  | "cap" // the session's AGENT_ROTATION_CAP is spent
  | "nothing-to-rotate" // no compactable span (early window) — nothing a boundary would replace
  | "already-rotated-this-turn" // one rotation per turn; a second call in the same batch is redundant
  | "deferred"; // a PreCompact hook deferred it — the reason rides the message

export type AgentRotationOutcome =
  | { readonly ok: true; readonly window: number; /** Rotations left this session after this one. */ readonly remaining: number }
  | { readonly ok: false; readonly code: AgentRotationRefusalCode; readonly error: string };

/** The loop-wired face: validates, fires the rotation compaction NOW (the
 *  same tier-2 machinery the threshold path uses, with the rotation riders),
 *  and answers with the window the boundary opened. Implemented per-run by
 *  runAgentLoop's contextRotation seam; absent outside a run. */
export interface NewContextPort {
  rotate(req: AgentRotationRequest): Promise<AgentRotationOutcome>;
}

/** The single-slot box the host creates once per session and threads into
 *  BOTH the tool factory (read side) and LoopOptions.contextRotation (the
 *  loop's install side). Between runs the slot is empty — the tool answers
 *  fail-closed, exactly like an unwired frontend. */
export interface NewContextPortBox {
  current?: NewContextPort;
}

// ---------------------------------------------------------------------------
// Pure arg validation + receipts (the single source for every message the
// tool emits — never hand-built at call sites).
// ---------------------------------------------------------------------------

export function validateNewContextArgs(args: Record<string, unknown>): { ok: true; req: AgentRotationRequest } | { ok: false; error: string } {
  const rationale = args["rationale"];
  if (typeof rationale !== "string" || rationale.trim() === "") {
    return { ok: false, error: `new_context: rationale must be a non-empty string (why rotate NOW — e.g. "subtask A complete, old exploration is dead weight")` };
  }
  if (rationale.length > NEW_CONTEXT_RATIONALE_MAX_CHARS) {
    return { ok: false, error: `new_context: rationale exceeds the ${NEW_CONTEXT_RATIONALE_MAX_CHARS}-char cap (got ${rationale.length})` };
  }
  const preserve = args["preserve"];
  if (preserve !== undefined && (typeof preserve !== "string" || preserve.trim() === "")) {
    return { ok: false, error: `new_context: preserve, when given, must be a non-empty string (facts that MUST survive the rotation)` };
  }
  if (typeof preserve === "string" && preserve.length > NEW_CONTEXT_PRESERVE_MAX_CHARS) {
    return { ok: false, error: `new_context: preserve exceeds the ${NEW_CONTEXT_PRESERVE_MAX_CHARS}-char cap (got ${preserve.length}) — note_write the details instead and preserve only the pointers` };
  }
  return { ok: true, req: { rationale: rationale.trim(), ...(preserve !== undefined ? { preserve: (preserve as string).trim() } : {}) } };
}

/** The success receipt — confirmation + the window the boundary opened + the
 *  remaining budget (the model knows it rotated and where it stands). */
export function newContextReceipt(window: number, remaining: number): string {
  return [
    `[context rotated] window ${window} — 旧上下文已冻结为一份摘要（新上下文首条 [context rotated by agent] 消息）；环境状态（文件、进程、todo）不受影响。`,
    `剩余模型侧轮转额度：${remaining}/${AGENT_ROTATION_CAP}。在新窗口里继续当前任务；需要旧细节时用 search_history / session_result 回取。`,
  ].join("\n");
}

/** The typed refusal receipts (one line per code — actionable, never a bare no). */
export function newContextRefusal(code: AgentRotationRefusalCode, error: string): string {
  switch (code) {
    case "cap":
      return `new_context: 本会话的 ${AGENT_ROTATION_CAP} 次模型侧轮转额度已用完（${error}）。继续用现有上下文工作；harness 的阈值压缩照常兜底。`;
    case "nothing-to-rotate":
      return `new_context: 没有可轮转的内容（${error}）——当前上下文还很轻，边界没有可替换的历史。额度未消耗；等上下文真正变重（完成一个大子任务后）再轮转。`;
    case "already-rotated-this-turn":
      return `new_context: 本轮已经轮转过（${error}）。一次轮转一个窗口；不要在同一轮里连调两次。`;
    case "deferred":
      return `new_context: 压缩前置钩子推迟了这次轮转（${error}）。额度未消耗；稍后（下一轮）可再试。`;
  }
}

// ---------------------------------------------------------------------------
// The tool. Registered TOP-LEVEL only (the engine path; subagents never see
// it — rotation is a parent-session capability, v1 boundary).
// ---------------------------------------------------------------------------

const PARAMETERS: ToolParameterSchema = {
  type: "object",
  properties: {
    rationale: {
      type: "string",
      description: `为什么现在轮转（1-${NEW_CONTEXT_RATIONALE_MAX_CHARS} 字符，必填）——会作为身份行骑在新窗口的摘要头部。适合：一个大子任务刚完成、旧探索已成包袱、方向切换。`,
    },
    preserve: {
      type: "string",
      description: `必须带进新上下文的关键信息（≤${NEW_CONTEXT_PRESERVE_MAX_CHARS} 字符，可选）：结论、文件路径、关键决定。会逐字注入新上下文并织入摘要。`,
    },
  },
  required: ["rationale"],
  additionalProperties: false,
};

export function createNewContextTool(getPort: () => NewContextPort | undefined): Tool {
  return buildTool({
    name: NEW_CONTEXT_TOOL_NAME,
    promptSnippet: "rotate to a fresh context window when this one has become baggage",
    promptGuidelines: [
      "Use it when a sub-task just finished and the old exploration is now dead weight — not as a substitute for finishing the current step.",
      "Pass the facts that must survive (conclusions, file paths, decisions); anything you leave out is gone.",
    ],
    description:
      "主动轮转上下文：把当前历史冻结为一份摘要，开一个干净的新窗口继续（session 不变、环境状态不变）。在【一个子任务刚完成且旧上下文不再需要】时使用；不要在任务中途使用——未完成的活跃状态（刚读的文件内容、进行中的推理链）会被压缩掉。先写 note_write 想保留的细节，再用本工具轮转。每会话上限 10 次；工具结果会告知新窗口号。",
    parameters: PARAMETERS,
    // Rewrites the conversation view (a compaction boundary) — not read-only.
    isReadOnly: () => false,
    // Non-concurrency-safe BY DESIGN: a batch containing this tool takes the
    // sequential path, so the mid-execute history swap can never race a
    // sibling call's result append.
    isConcurrencySafe: () => false,
    // History is persisted append-only (the JSONL keeps the pre-rotation
    // rows); nothing user-visible is destroyed — the boundary is a view swap.
    isDestructive: () => false,
    isOpenWorld: () => false,
    // A rotation is one summarizer call and must settle atomically — never
    // raced against abort/detach mid-compaction (a half rotation would leave
    // the receipt/history pair inconsistent).
    interruptBehavior: "block",
    async execute(args) {
      const validated = validateNewContextArgs(args);
      if (!validated.ok) return { content: validated.error, isError: true };
      const port = getPort();
      if (port === undefined) {
        return { content: "new_context: 该前端未接线模型侧轮转（运行外或会话引擎未启用压缩）——工具不可用，继续用现有上下文工作", isError: true };
      }
      const out = await port.rotate(validated.req);
      if (!out.ok) return { content: newContextRefusal(out.code, out.error), isError: true };
      return { content: newContextReceipt(out.window, out.remaining) };
    },
  });
}
