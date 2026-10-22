// ω99-316 — /btw 侧问引擎（the upstream project sideQuestion 三宝石的 wudao 落地）。
//
// 旁路 run = detached loop：克隆主投影构造独立 State，跑 core runAgentLoop，
// 绝不触碰 session AgentState/JSONL/store——主线零扰动（M24）。三宝石：
//   1. 同表封禁：旁路声明与主线程完全相同的工具表（名/描述/schema 序列化
//      字节同一——loop 的 defer controller 对冻结表是 passthrough，全表
//      序列化）但 execute 全部返回结构化冻结错误。空表会让 provider 把
//      工具序列化进 system prompt 前缀之外，丢前缀缓存、整段对话全价重读。
//   2. 每轮重克隆：本函数无跨调用状态；caller（driver）把上一轮的侧问
//      transcript 作为 priorTurns 追加在最新主投影之后（永远看最新主上下文）。
//   3. <side_question> 标签+指令（buildBtwEnvelope）+ 保留主会话 thinking
//      档位（reasoningEffort 同传——stampSideModelClient 盖章）。
//
// 快照卫生（诚实边界）：主 run 的 loop 在模型调用后立即 push assistant
// （可能带 toolCalls），工具结果后落——mid-run 快照会捕获悬空 assistant 或
// 部分批次，发给 provider 会 400。snapshotForSideLane 把尾部不完整的
// tool-call 批次整段截掉（只影响旁路所见，永不改写主历史）。
import type { AgentMessage, AgentState, ModelClient, ModelInput, Tool } from "@wudao/core";
import { runAgentLoop } from "@wudao/core";
import { BTW_MAX_TOKENS, BTW_QUERY_SOURCE, buildBtwEnvelope } from "./btw.js";

/** The side loop's turn cap (brief §2): 3 model calls, then the honest
 *  footnote — a side lane must never become a second main session. */
export const SIDE_QUESTION_MAX_TURNS = 3;

/** The structured frozen-error content every declared tool's execute returns
 *  on the side lane. The model self-corrects off this result next turn. */
export const SIDE_TOOLS_FROZEN_RESULT =
  "旁路问答中工具冻结——这里是旁路问答，工具不会真正执行。请直接依据已有上下文回答，不要调用工具。";

/** The honest footnote appended when the turn cap is exhausted (the answer
 *  may be incomplete — say so, never silently truncate). */
export const SIDE_QUESTION_TURNS_EXHAUSTED_NOTE = "（旁路回答轮数用尽，可能不完整）";

export interface SideQuestionRunInput {
  readonly question: string;
  readonly systemPrompt: string;
  /** The MAIN projection snapshot at request time (already sanitized or
   *  raw — sanitize runs inside either way). */
  readonly messages: readonly AgentMessage[];
  /** Earlier side turns (Q/A pairs from prior /btw rounds of this session) —
   *  appended AFTER the fresh main projection (per-round re-clone). */
  readonly priorTurns?: readonly AgentMessage[];
  readonly tools: readonly Tool[];
  readonly model: ModelClient;
  /** The session's live thinking level (brief §2: 保留主会话 thinking 档位).
   *  Undefined/empty = no override (the provider config's own effort). */
  readonly reasoningEffort?: string;
  readonly signal?: AbortSignal;
}

export interface SideQuestionRunResult {
  readonly answer: string;
  readonly rounds: number;
  readonly truncated: boolean;
  /** This round's side transcript (sanitized: envelope + model turns, no
   *  dangling tail) — the caller accumulates it across rounds. */
  readonly turns: readonly AgentMessage[];
}

/** The wire shape the server op returns (brief §2: {answer, rounds}): the
 *  answer text (carrying the honest footnote when the turn cap exhausted)
 *  and the model-call rounds it took. */
export interface SideQuestionResult {
  readonly answer: string;
  readonly rounds: number;
}

/** Trim a mid-run snapshot to its last STABLE point: a trailing tool-result
 *  run whose owning assistant's batch is missing/partial, or a dangling
 *  tool-call assistant, never reaches the side projection (a provider would
 *  reject the unpaired block). Pure — the input array is never touched. */
export function snapshotForSideLane(messages: readonly AgentMessage[]): AgentMessage[] {
  let end = messages.length;
  // Phase 1: a trailing tool-result run must be complete and owned.
  {
    let t = end;
    while (t > 0 && messages[t - 1]!.role === "tool") t -= 1;
    if (t < end) {
      const owner = t > 0 ? messages[t - 1] : undefined;
      // The walk above guarantees every element in this run is role "tool".
      const results = messages.slice(t, end) as unknown as { readonly toolCallId: string }[];
      const complete =
        owner !== undefined &&
        owner.role === "assistant" &&
        (owner.toolCalls?.length ?? 0) === results.length &&
        (owner.toolCalls ?? []).every((c, k) => results[k]!.toolCallId === c.id);
      if (!complete) end = Math.max(0, t - 1); // drop the partial run AND its owner
    }
  }
  // Phase 2: a dangling tool-call assistant (batch announced, no results —
  // the loop parks mid-tool) is a half message — drop it.
  while (end > 0) {
    const last = messages[end - 1]!;
    if (last.role === "assistant" && (last.toolCalls?.length ?? 0) > 0) {
      end -= 1;
      continue;
    }
    break;
  }
  return messages.slice(0, end);
}

/** The same-table freeze: identical name/description/parameters (the exact
 *  same field references — serialization bytes are the same objects), execute
 *  swapped for the structured frozen error, shouldDefer stripped (the
 *  load_tools meta-tool would REALLY execute on the side lane — a freeze
 *  violation). */
export function freezeToolsForSideLane(tools: readonly Tool[]): Tool[] {
  return tools.map((tool) => {
    const frozen: Tool = {
      ...tool,
      execute: async () => ({ content: SIDE_TOOLS_FROZEN_RESULT, isError: true }),
    };
    if ("shouldDefer" in frozen) delete (frozen as { shouldDefer?: unknown }).shouldDefer;
    return frozen;
  });
}

/** Wrap the session's ModelClient with the side-lane stamps: querySource
 *  "btw" (the provider retry ladder's background allowlist — bail on
 *  overload instead of amplifying), maxTokens cap, and the session's live
 *  reasoningEffort when one is set (absent = the provider config's own —
 *  request bytes otherwise unchanged). */
export function stampSideModelClient(model: ModelClient, effort?: string): ModelClient {
  const stamp = (input: ModelInput): ModelInput => ({
    ...input,
    querySource: BTW_QUERY_SOURCE,
    maxTokens: BTW_MAX_TOKENS,
    ...(effort !== undefined && effort !== "" ? { reasoningEffort: effort } : {}),
  });
  const stream = model.stream;
  const wrapped: ModelClient = {
    ...(model.modelId !== undefined ? { modelId: model.modelId } : {}),
    generate: (input: ModelInput) => model.generate(stamp(input)),
    ...(stream !== undefined ? { stream: (input: ModelInput) => stream(stamp(input)) } : {}),
  };
  return wrapped;
}

/** Run one side question on a detached, sanitized, frozen clone. The main
 *  session's state/history/store are never touched (the caller owns that
 *  invariant — this function only reads what it was handed). */
export async function runSideQuestion(input: SideQuestionRunInput): Promise<SideQuestionRunResult> {
  const base = snapshotForSideLane(input.messages);
  const messages: AgentMessage[] = [
    ...base,
    ...snapshotForSideLane(input.priorTurns ?? []),
    { role: "user", content: buildBtwEnvelope(input.question) },
  ];
  const prefixLen = messages.length;
  const sideState: AgentState = {
    systemPrompt: input.systemPrompt,
    messages,
    tools: freezeToolsForSideLane(input.tools),
    status: "running",
  };
  const gen = runAgentLoop(sideState, stampSideModelClient(input.model, input.reasoningEffort), {
    maxTurns: SIDE_QUESTION_MAX_TURNS,
    // The side lane is unattended: no recovery nudges, the turn cap is the
    // only ladder (a nudge would spend main-prefix-invisible extra rounds).
    outputLimitRecovery: { maxNudges: 0 },
    emptyFinalRecovery: { maxNudges: 0 },
    ...(input.signal !== undefined ? { signal: input.signal } : {}),
  });
  let rounds = 0;
  let reason = "completed";
  for (;;) {
    const next = await gen.next();
    if (next.done) {
      reason = next.value.reason;
      break;
    }
    if (next.value.type === "model_call_started") rounds += 1;
  }
  sideState.status = "idle";
  // The answer = the last non-empty assistant text in the side transcript.
  let answer = "";
  for (const m of sideState.messages) {
    if (m.role === "assistant" && m.content.trim() !== "") answer = m.content.trim();
  }
  const truncated = reason === "max_turns";
  if (truncated) {
    answer = answer === "" ? SIDE_QUESTION_TURNS_EXHAUSTED_NOTE : `${answer}\n\n${SIDE_QUESTION_TURNS_EXHAUSTED_NOTE}`;
  }
  // The side transcript this round adds (sanitized — a dangling tool-call
  // tail never rides into the next round's priorTurns).
  const turns = snapshotForSideLane(sideState.messages.slice(prefixLen));
  return { answer, rounds, truncated, turns };
}
