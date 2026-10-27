import { randomUUID } from "node:crypto";
import type { AgentMessage, Terminal } from "./types.js";
import type { ImageBlock, FileBlock } from "./attachments.js";
import type { AgentState } from "./state.js";
import type { Tool, IdentifiedOutputDelta } from "./tool.js";
import type { ModelClient, ModelInput } from "./model-client.js";
import type { LoopOptions, LoopEvent } from "./loop.js";
import { runAgentLoop } from "./loop.js";
import { BUILTIN_ROLES, toSubagentType } from "./agents/roster.js";
import type { SessionStore } from "./session/store.js";
import { repairOrphanedToolCalls } from "./session/validate.js";
// ω99-57: child→parent mail — the ambient scope + the global tool's
// delivery/format constants (agents/mail.ts owns the model-visible face).
import { runWithMailScope, formatMailText, MAIL_FORK_REFUSAL, SUBAGENT_MESSAGE_TYPE } from "./agents/mail.js";
// 128-3（codex 21eb35513d 引进）— per-chain 压缩所有权的投影件过滤所需前缀。
import { SUMMARY_MARKER, COMPACTION_STUB_PREFIX, CLEARED_MARKER, EMERGENCY_DROP_PREFIX, SKILL_PRUNED_PREFIX } from "./compaction-markers.js";
import type { MailScope } from "./agents/mail.js";

export interface SubagentType {
  readonly name: string;
  readonly description: string;
  readonly systemPrompt: string;
  readonly toolNames: readonly string[];
}

// M30 §A: the builtin subagent types migrated into the role roster
// (agents/roster.ts, same schema, workspace-shadowable). The legacy export
// stays as a derived alias so existing consumers compile and behave the same;
// it now also covers the new builtin roles (manager / adversarial-reviewer /
// consultant) — additive, nothing old was renamed or removed.
export const BUILTIN_SUBAGENT_TYPES: Record<string, SubagentType> = Object.fromEntries(
  Object.entries(BUILTIN_ROLES).map(([id, profile]) => [id, toSubagentType(profile)]),
);

/** The parent conversation a fork (shareContext) subagent replays. */
export interface ForkContext {
  readonly systemPrompt: string;
  readonly tools: readonly Tool[];
  readonly messages: readonly AgentMessage[];
}

// The nested-task guard. The fork keeps the parent's FULL tool array —
// byte-identical, because dropping ANY tool would break the byte-level
// prefix sharing that is the fork's entire purpose — but `task` refuses to
// run inside a forked child, so forks never nest.
// Orchestration tools a fork child must NOT keep live: task would recurse,
// and the agent_* tools would let a shared-context child await/cancel the
// PARENT's background agents (M30-β review: fail-closed, refuse them all).
// M34 §1: ask_user joins them — only the TOP-LEVEL session can ask the user
// (a forked child's question would race the parent's terminal).
const FORK_REFUSED_TOOLS = new Set(["task", "agent_await", "agent_status", "agent_cancel", "ask_user"]);

function refusingTaskClone(tool: Tool): Tool {
  const reason = tool.name === "ask_user"
    ? "ask_user is unavailable inside a forked subagent — only the top-level session can ask the user; decide yourself with your best judgment"
    : `${tool.name} is unavailable inside a forked subagent — do the work yourself in this shared context`;
  return {
    ...tool,
    async execute() {
      return { content: reason, isError: true };
    },
  };
}

// Drop trailing assistant messages whose tool calls have no results yet (the
// fork is spawned from INSIDE such a call — replaying it would send the
// provider an orphaned tool_call). What remains is exactly the message
// sequence of the parent's last real request.
function trimUnansweredToolCalls(messages: readonly AgentMessage[]): AgentMessage[] {
  const out = [...messages];
  while (out.length > 0) {
    const last = out[out.length - 1];
    if (last !== undefined && last.role === "assistant" && last.toolCalls && last.toolCalls.length > 0) out.pop();
    else break;
  }
  return out;
}

export interface RunSubagentOptions {
  readonly model: ModelClient;
  readonly allTools: readonly Tool[];
  readonly subagentType: SubagentType;
  readonly prompt: string;
  /** M80 (direction b): images riding the ISOLATED child's first user
   *  message — durable refs only (bytes stay in the AttachmentStore; the
   *  provider's request-build resolver turns them into transient data
   *  URLs). The rider lands on the child's OWN new-prefix first message;
   *  the parent's replayed prefix bytes never move (the M24 cache
   *  invariant). Absent/empty → text-only child, byte-identical to
   *  pre-M80. Not combinable with `forkFrom` (a fork replays the parent's
   *  image-bearing history verbatim) or a resume/fork child session (its
   *  first message is the steering seam over an existing transcript) —
   *  both combinations fail closed below. */
  readonly promptImages?: readonly ImageBlock[];
  /** ω99-55: files NEVER ride child input — the child domain law (dsh
   *  mirror: "subagents do not upload files independently"). The option
   *  exists only to make the refusal STRUCTURAL: any caller reaching for it
   *  fails closed here, before a session is created or the loop runs. The
   *  supported hand-off is by PATH — the parent's attachment handle names
   *  the saved read-only path, the parent includes it in the prompt text,
   *  and the child reads it with the ordinary file tools (the store lives
   *  in the shared workspace, so the path resolves identically). */
  readonly promptFiles?: readonly FileBlock[];
  /** M24 B2: when set, run a FORK instead of an isolated subagent — the
   *  child reuses the parent's system prompt, full tool array, and message
   *  snapshot, plus one trailing `[subagent task] <prompt>` user message. */
  readonly forkFrom?: ForkContext;
  /** The child's turn fuse is POLICY (M41): callers state it; core keeps no
   *  default. The registry resolves it from spawn/role/registry-level
   *  budgets; direct callers (the core task tool, embedders) pass their own. */
  readonly loopOptions: Omit<LoopOptions, "canUseTool" | "maxTurns"> & { readonly maxTurns: number };
  readonly canUseTool?: LoopOptions["canUseTool"];
  readonly onEvent?: (event: LoopEvent) => void;
  /** M30 §B grace iteration: when a NON-EMPTY whitelist is set, a max_turns
   *  fuse no longer ends the run silently. Instead the child gets one final
   *  grace turn whose tools are restricted to `graceTools` ∩ the role's
   *  tools, plus a forced-answer nudge — the budget-limited worker writes
   *  its report instead of evaporating. An empty array disables grace. */
  readonly graceTools?: readonly string[];
  /** M30 §B telemetry receipt: called once, right before the final answer is
   *  returned, with the run's budget/usage facts (the registry synthesizes
   *  the [WORKER_REPORT] from these). */
  readonly onResult?: (info: SubagentRunInfo) => void;
  /** M30 §C: run the child as a RESUMABLE session — the full transcript is
   *  appended to `side-<id>.jsonl` in the same JSONL root as the parent.
   *  "new" persists a fresh child; "resume" continues `id`'s transcript
   *  (byte-identical rebuild + one steering message); "fork" copies `id`'s
   *  transcript into a NEW sidechain and leaves the source untouched.
   *  Not combinable with `forkFrom` (a shareContext fork replays the parent
   *  conversation — there is no transcript of its own to persist). */
  readonly session?: ChildSessionOptions;
  /** M30 §C steering seam: fires before a resume/fork rebuild continues.
   *  Return the steering text (replaces the default `[resume] <prompt>`
   *  message), undefined to take the default. */
  readonly onBeforeResume?: (info: ResumeSeamInfo) => string | undefined;
  /** M63-B: the child's SubagentStart/Stop hook faces. onStart fires at the
   *  child loop's start; onStop at its stop seam with the PARENT's Stop-hook
   *  blocking mechanics (a block keeps the child working one more turn,
   *  capped by the same block cap). Children otherwise stay hookless (the
   *  M9 isolation posture — only these two faces cross the boundary).
   *  M63-C §3 EXCEPTION: `runHooks` — the subagent-position hooks declared
   *  on the agent's profile — apply DURING this child's run (composed UNDER
   *  the start/stop faces; still no session-surface inheritance). */
  readonly subagentHooks?: {
    readonly onStart?: (agentType: string, info: { readonly sessionId?: string }) => void | Promise<void>;
    readonly onStop?: (agentType: string, state: AgentState) => import("./loop.js").SubagentStopDecision | Promise<import("./loop.js").SubagentStopDecision>;
  };
  /** M63-C §3: the subagent-position hooks (from the role profile's
   *  frontmatter/hooks node) — armed for THIS child's run only. */
  readonly runHooks?: import("./loop.js").AgentHooks;
  /** ω99-5b §B: the structured finishing tool's name (goose final_output
   *  parity). When set and the transcript carries a tool_use of that name,
   *  the report is that call's arguments as canonical JSON — providers shape
   *  tool arguments far more reliably than free text, so the captured call
   *  IS the report. Absent such a call the last assistant text stands
   *  (pre-ω99-5b behavior). The loop itself is untouched: a final_output
   *  call is an ordinary tool turn; the run ends when the model stops
   *  calling tools (maxTurns bounds a disobedient model). */
  readonly finalTool?: string;
  /** ω99-57 (child→parent half-arc): wire the mail edge for THIS child. When
   *  set (and this is not a shareContext fork — forks have no sidechain to
   *  attribute and refuse with a typed error), the child's loops run inside
   *  a mail scope: the globally-registered message_parent tool derives its
   *  sender from the scope (never from model arguments) and each send is
   *  (a) formatted with the child's durable identity, (b) enqueued on the
   *  parent lane via `deliver`, and (c) recorded on the child's OWN
   *  sidechain as an M35 §2 generic entry. Absent → no scope → the tool's
   *  typed no-edge refusal (behavior identical for unattributed runners). */
  readonly parentMail?: ParentMailSink;
}

/** ω99-57: the spawn-site lane sink — receives the FORMATTED steering text
 *  (source attribution already applied by runSubagent). The parent's drain
 *  semantics belong to the parent's steering lane, not to the child. */
export interface ParentMailSink {
  readonly deliver: (text: string) => void;
}

export interface ChildSessionOptions {
  readonly mode: "new" | "resume" | "fork";
  /** Required for "resume" and "fork" (the source sidechain id); optional
   *  for "new" (generated when omitted). */
  readonly id?: string;
  /** The JSONL session store (same root as the parent's sessions). */
  readonly store: SessionStore;
}

export interface ResumeSeamInfo {
  /** The SOURCE sidechain id being resumed or forked. */
  readonly id: string;
  readonly priorMessages: readonly AgentMessage[];
}

/** What a finished child reports about its own run (M30 §B). */
export interface SubagentRunInfo {
  /** True iff the turn-budget fuse fired and a grace turn produced the
   *  final answer (always false when grace is disabled/unused). */
  readonly budgetLimited: boolean;
  /** model turns consumed (turn_started events), grace included. */
  readonly turns: number;
  /** tool calls completed (successful or not), both phases. */
  readonly toolCalls: number;
  /** Sum of provider-reported usage across all model calls. cacheHitTokens
   *  rides along (ω-1) so parent-side cache accounting sees the child's real
   *  prefix-cache savings — a multi-agent run's cache numbers sum across its
   *  nodes (Strands accumulates the same counters). */
  readonly usage: { readonly promptTokens: number; readonly completionTokens: number; readonly cacheHitTokens: number };
  /** 133 #6（codex 63475131ce 形）— the run's terminal shape, additive: the
   *  reason (completed runs read "completed"), and on a loop-safety abort
   *  the evidence + the denial-circuit flag. The PARENT's Task tool consumes
   *  these to select the behavioral-contract notification. */
  readonly terminalReason?: Terminal["reason"];
  readonly loopEvidence?: string;
  readonly denialCircuit?: true;
}

// The grace-turn instruction. The model has ONE turn left and only the
// whitelisted tools: no new work, write the report, flag the budget limit so
// the parent can re-dispatch with a higher ceiling.
const GRACE_NOTE =
  "[system note: your turn budget is exhausted — this is ONE final grace turn. Only the tools listed for this turn remain; do NOT start new work. Write your final worker report now: what you completed (with evidence), what remains, and state that you are budget-limited so the parent can re-dispatch you with a higher budget.]";

const DEFAULT_RESUME_STEERING =
  "[resume] continue this child session from where it left off — do not repeat completed work.";

// M30 §C single-writer guard: one in-flight run per sidechain id, process
// wide. Two concurrent writers to one append-only JSONL would interleave
// lines from different runs — fail closed instead.
const inFlightChildSessions = new Set<string>();

/** The ONE isolated-child builder — spawn, resume, and session-fork all go
 *  through it, so a resume's system prompt and tool array are byte-identical
 *  to the original spawn's BY CONSTRUCTION (only the messages differ). */
function buildIsolatedState(
  subagentType: SubagentType,
  allTools: readonly Tool[],
  messages: AgentMessage[],
): AgentState {
  const tools = subagentType.toolNames
    .map((name) => allTools.find((t) => t.name === name))
    .filter((t): t is Tool => t !== undefined);
  return { systemPrompt: subagentType.systemPrompt, messages, tools, status: "running" };
}

// 夜移 036: per-child reminder-thread ids (see the sessionBudget rebind in
// runSubagent) — a process-wide monotonic counter keeps them unique.
let subagentThreadSeq = 0;

// ω99-57: per-spawn ephemeral mail ids for sessionless children (durable
// children sign with their sidechain write id instead — see runSubagent).
let mailEphSeq = 0;

// ω99-5b §B: canonical JSON (recursively sorted keys) for a finalTool report —
// the same normalization the CLI's structured-output canonicalJson applies,
// so a captured tool_use report is byte-stable across runs (evals, cache
// accounting). Core-local: core stays schema-lib-free.
function canonicalReportJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalReportJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalReportJson((value as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** ω99-8b: the stamp every child loop's model call carries. Downstream
 *  meters partition on it — the CLI's client-level cost ledger SKIPS the tag
 *  (the task tool's ω99-8 forwarder owns the subagent row, so a same-client
 *  child counts EXACTLY once) and the waste monitor's P0-1 MAIN-only turn
 *  stats exclude it (a child rides side prefixes). Request metadata only:
 *  querySource never touches the prompt bytes (M24 prefix-cache safe by
 *  construction). */
export const CHILD_QUERY_SOURCE = "subagent";

/** ω99-8b: wrap the parent's client so each child-loop call is tagged
 *  querySource="subagent" (module-level wrapper — the ModelClient interface
 *  stays untouched). An explicit tag on the input (child-internal
 *  "summarizer"/"loop-reflector" side calls) always wins — the stamp only
 *  fills the untagged default. The spread keeps the client's shape (modelId)
 *  and re-binds both methods over the ORIGINAL client, so the tag survives
 *  even a cache-tracking wrapper that rebuilds the input. */
export function withChildQuerySource(model: ModelClient): ModelClient {
  const stamp = (input: ModelInput): ModelInput =>
    input.querySource === undefined ? { ...input, querySource: CHILD_QUERY_SOURCE } : input;
  const stream = model.stream; // local: narrowing survives into the closure
  return {
    ...model,
    generate: (input) => model.generate(stamp(input)),
    ...(stream !== undefined ? { stream: (input) => stream(stamp(input)) } : {}),
  };
}

export async function runSubagent(options: RunSubagentOptions): Promise<string> {
  const session = options.session;
  if (session !== undefined && options.forkFrom !== undefined) {
    throw new Error("child sessions are not supported for shareContext forks — a fork replays the parent conversation and has no transcript of its own");
  }

  // ω99-55: the file hand-off law (see promptFiles) — fail closed on ANY
  // child shape, before a sidechain id is minted or the loop starts.
  if (options.promptFiles !== undefined && options.promptFiles.length > 0) {
    throw new Error("file blocks cannot ride subagent input — pass the uploaded file's saved read-only path (the parent's attachment handle names it) in the prompt text instead; children read it with the ordinary file tools");
  }

  // M80: the image hand-off has exactly ONE landing spot — a fresh isolated
  // child's first user message. Every other combination would silently drop
  // the refs, so each fails closed here (never a silent no-op).
  if (options.promptImages !== undefined && options.promptImages.length > 0) {
    if (options.forkFrom !== undefined) {
      throw new Error("promptImages are not supported for shareContext forks — the fork replays the parent's image-bearing history verbatim");
    }
    if (session !== undefined && (session.mode === "resume" || session.mode === "fork")) {
      throw new Error("promptImages ride a fresh isolated child's first message — they are not supported when resuming or session-forking a child transcript");
    }
  }

  // --- M30 §C session resolution + single-writer guard ---------------------
  let writeId: string | undefined;
  let priorMessages: AgentMessage[] = [];
  let continuing = false; // resume or session-fork: rebuild from prior transcript
  if (session !== undefined) {
    if (session.mode === "resume" || session.mode === "fork") {
      if (session.id === undefined) {
        throw new Error(`child session mode "${session.mode}" requires an id`);
      }
      priorMessages = await session.store.loadSidechain(session.id);
      if (priorMessages.length === 0) {
        throw new Error(`no prior child session "${session.id}" to ${session.mode}`);
      }
      // A transcript that ends mid-turn (crash while a tool call was open)
      // must not be replayed as an orphaned tool_use to the provider.
      priorMessages = repairOrphanedToolCalls(priorMessages);
      continuing = true;
      // fork writes to a NEW sidechain (the source stays untouched); resume
      // continues the same file. "new" may generate its id.
      writeId = session.mode === "fork" ? `fork-${randomUUID()}` : session.id;
    } else {
      writeId = session.id ?? randomUUID();
    }
    if (inFlightChildSessions.has(writeId)) {
      throw new Error(`child session "${writeId}" already has a writer in flight (single-writer guard)`);
    }
    inFlightChildSessions.add(writeId);
  }

  // Declared before the try so the finally-block tail flush can see them.
  // `state` is assigned as the first statement inside the try; flush() can
  // only run after that (the initial flush call is the next statement).
  let state: AgentState;
  // 128-3（codex 21eb35513d 引进）— per-chain 压缩所有权：sidechain 持久化
  // 从索引基改为身份基 + 投影件过滤（TUI 主链 persist.ts 的同律）。
  //
  // 旧索引基的静默证据损毁（本弧的测试亲证 9/12）：tier-2 压缩把
  // state.messages 换血成 [summary, kept-tail]（更短），persistFrom（旧计数）
  // 失位——压缩后的新消息直到计数追上旧水位才再落盘，其前的整段永不落
  // 盘；resume 重放的是缺尾的损坏转录。身份基天然免疫换血/重排。
  //
  // 投影件不落 sidechain（主链同律）：压缩摘要/紧急丢弃/技能修剪标记是
  // live 上下文的投影艺术品，不是证据——盘上只留原始消息 + 边界条目，
  // resume 全量裸重放（证据永在），压缩只在活上下文里发生。
  const persisted = new Set<AgentMessage>(session?.mode === "resume" ? priorMessages : []);
  const persistableSidechainMessage = (m: AgentMessage): boolean =>
    !(m.role === "user" && (m.content.startsWith(SUMMARY_MARKER) || m.content.startsWith(EMERGENCY_DROP_PREFIX) || m.content.startsWith(SKILL_PRUNED_PREFIX)))
    && !(m.role === "tool" && (m.content.startsWith(COMPACTION_STUB_PREFIX) || m.content.startsWith(CLEARED_MARKER) || m.content.startsWith(SKILL_PRUNED_PREFIX)));
  const flush = async (): Promise<void> => {
    if (session === undefined || writeId === undefined) return;
    for (const m of state.messages) {
      if (persisted.has(m) || !persistableSidechainMessage(m)) continue;
      persisted.add(m);
      await session.store.appendSidechain(writeId, m);
    }
  };

  try {
    if (options.forkFrom) {
      // Fork branch: the child's first request extends the parent's last real
      // request byte-for-byte (shared prefix = everything the parent paid
      // for; the child pays only its own increment: the task brief + turns).
      state = {
        systemPrompt: options.forkFrom.systemPrompt,
        messages: [
          ...trimUnansweredToolCalls(options.forkFrom.messages),
          { role: "user", content: `[subagent task] ${options.prompt}` },
        ],
        tools: options.forkFrom.tools.map((t) => (FORK_REFUSED_TOOLS.has(t.name) ? refusingTaskClone(t) : t)),
        status: "running",
      };
    } else if (continuing) {
      // Resume/session-fork: same builder as a fresh spawn (byte-identical
      // prefix), prior transcript + exactly ONE appended steering message.
      const seam = options.onBeforeResume?.({ id: session!.id!, priorMessages });
      const steering = seam !== undefined
        ? seam
        : options.prompt.trim().length > 0
          ? `[resume] ${options.prompt}`
          : DEFAULT_RESUME_STEERING;
      const messages = steering.length > 0
        ? [...priorMessages, { role: "user" as const, content: steering }]
        : [...priorMessages];
      state = buildIsolatedState(options.subagentType, options.allTools, messages);
    } else {
      // Fresh isolated child. Unchanged semantics — coder/research children
      // never see the parent conversation. M80: the explicitly handed-off
      // image refs ride THIS first message (the child's own new prefix; the
      // parent's bytes are untouched). Absent/empty → no `images` key at
      // all, byte-identical to the pre-M80 shape.
      state = buildIsolatedState(options.subagentType, options.allTools, [
        {
          role: "user",
          content: options.prompt,
          ...(options.promptImages !== undefined && options.promptImages.length > 0
            ? { images: [...options.promptImages] }
            : {}),
        },
      ]);
    }

    // Incremental persistence of the initial messages (brief, or the copied
    // transcript + steering for a fork) happens via the hoisted flush().
    await flush();

    // Telemetry aggregated across the budget phase AND the grace phase.
    let turns = 0;
    let toolCalls = 0;
    let promptTokens = 0;
    let completionTokens = 0;
    let cacheHitTokens = 0;
    const track = (event: LoopEvent): void => {
      if (event.type === "turn_started") turns += 1;
      else if (event.type === "tool_call_finished") toolCalls += 1;
      else if (event.type === "usage") {
        promptTokens += event.usage.promptTokens;
        completionTokens += event.usage.completionTokens ?? 0;
        cacheHitTokens += event.usage.cacheHitTokens;
      }
    };

    // ω99-76: the child's ONE identity per lifecycle — the sidechain write id
    // when session'd (stable across resume), else a per-spawn ephemeral id.
    // Hoisted above the loopOptions literal because TWO consumers sign with
    // it: the mail edge (ω99-57) and the onToolUpdate namespace below.
    const childIdentity = writeId ?? `eph-${(mailEphSeq += 1)}`;

    const loopOptions = {
      maxTurns: options.loopOptions.maxTurns,
      canUseTool: options.canUseTool,
      compaction: options.loopOptions.compaction,
      // Propagate M15/M18 plumbing: a parent abort must stop the child loop,
      // and the child gets its own steering seam (unused by the CLI today).
      signal: options.loopOptions.signal,
      steering: options.loopOptions.steering,
      // 夜移 036: the session-tree budget is SHARED (same instance — the
      // child's responses draw from the parent's pool) but the child gets
      // its OWN threadId, so reminder dedup is per-thread: a reminder the
      // root just received does not suppress the child's (codex: every
      // thread observes crossed thresholds). Both passes below spread this
      // same object — the grace turn is the same thread.
      ...(options.loopOptions.sessionBudget !== undefined
        ? {
            sessionBudget: {
              budget: options.loopOptions.sessionBudget.budget,
              threadId: `sub:${options.subagentType.name}:${(subagentThreadSeq += 1)}`,
            },
          }
        : {}),
      // ω99-76: forward the child's identified tool deltas to the PARENT's
      // run-level sink — ω99-63's last missing arm (the value already flows
      // here through every spawn path's transparent spread; only this rebuild
      // dropped it). The callId is NAMESPACED with the child's identity
      // (`sub:<child>:<rawId>`): parent and child are independent requests
      // whose providers each number from call_0, so a bare forward would
      // collide in the parent's sink — with the namespace the collision is
      // structurally impossible and the frontend can attribute child
      // activity. toolName stays the child's REAL tool name. Absent → no
      // key, byte-identical literal (dream/review/kernel-policy and every
      // other onToolUpdate-less caller see zero change). Sink exception
      // semantics MIRROR the parent loop's bare call (a throwing sink
      // surfaces as the child tool's error result inside executeToolCall's
      // try, exactly as it would in the parent — parity, no added isolation).
      // The wrapper is an observer only: abort/steering/budget flows untouched.
      ...(options.loopOptions.onToolUpdate !== undefined
        ? {
            onToolUpdate: (delta: IdentifiedOutputDelta): void => {
              options.loopOptions.onToolUpdate!({
                ...delta,
                toolCallId: `sub:${childIdentity}:${delta.toolCallId}`,
              });
            },
          }
        : {}),
      // ω99-86 (53 停泊债清偿): forward the run's reasoning-effort trail to
      // the child loop — the parent's LIVE /effort level (the CLI's
      // effort-live box) rides every spawn's loopOptions, and the child's
      // assistant messages stamp it exactly like the parent's (ω99-53's
      // persistence-only seam in loop.ts — final + interrupted partial; it
      // is NEVER a wire field, the child's requests keep following the model
      // client's own config). 五段通路第四段: driver box → task-tool spawn →
      // registry spread (verbatim) → THIS whitelist → the loop's stamp.
      // Same conditional-spread shape as onToolUpdate above: absent ⇒ no
      // key, byte-identical literal (every effortSent-less caller —
      // dream/review/kernel-policy and embedders — sees zero change).
      ...(options.loopOptions.effortSent !== undefined
        ? { effortSent: options.loopOptions.effortSent }
        : {}),
    };

    // M63-B: the SubagentStart/Stop faces ride the CHILD loop's existing
    // onRunStart/onRunStop seams — the stop decision maps onto the loop's own
    // block mechanics (one more turn + the block cap), so a blocking
    // SubagentStop behaves exactly like a blocking Stop in the parent.
    const subHooks = options.subagentHooks;
    const typeName = options.subagentType.name;
    // M63-C §3: the subagent-position hooks (the run's own) chain AFTER the
    // lifecycle faces; both are isolated (a throwing profile hook cannot
    // kill the child).
    const profileHooks = options.runHooks;
    const childHooks = (subHooks !== undefined && (subHooks.onStart !== undefined || subHooks.onStop !== undefined)) || profileHooks !== undefined
      ? {
          onRunStart: async (): Promise<void> => {
            try {
              await subHooks?.onStart?.(typeName, { ...(writeId !== undefined ? { sessionId: writeId } : {}) });
            } catch {
              /* observer isolation */
            }
            try {
              await profileHooks?.onRunStart?.(state);
            } catch {
              /* observer isolation */
            }
          },
          onRunStop: subHooks?.onStop !== undefined || profileHooks?.onRunStop !== undefined
            ? async (stopState: AgentState): Promise<import("./loop.js").StopHookDecision> => {
                let decision: import("./loop.js").SubagentStopDecision = "allow";
                try {
                  decision = (await subHooks?.onStop?.(typeName, stopState)) ?? "allow";
                } catch {
                  decision = "allow";
                }
                if (typeof decision === "object") {
                  // both spellings ({block} and {continue:false}) are the
                  // loop's stop-block contract — pass through verbatim.
                  return decision;
                }
                try {
                  const profileDecision = await profileHooks?.onRunStop?.(stopState);
                  if (typeof profileDecision === "object") return profileDecision;
                } catch {
                  /* observer isolation */
                }
                return "allow";
              }
            : undefined,
          // The non-lifecycle profile faces ride through verbatim (isolated
          // by the loop's own per-hook try/catch semantics).
          ...(profileHooks !== undefined
            ? Object.fromEntries(
                Object.entries(profileHooks)
                  .filter(([k]) => k !== "onRunStart" && k !== "onRunStop")
                  .map(([k, v]) => [k, v]),
              )
            : {}),
        }
      : undefined;

    // Manual next() drain (instead of for-await) because the generator's
    // RETURN value — the Terminal — is what decides whether a grace turn is
    // due. Each drained event also persists whatever new messages landed.
    const drain = async (gen: AsyncGenerator<LoopEvent, Terminal>): Promise<Terminal> => {
      let next = await gen.next();
      while (!next.done) {
        track(next.value);
        options.onEvent?.(next.value);
        // 128-3 — per-chain 压缩所有权：tier-2 边界条目落 sidechain（one-shot
        // 主链 lane 的同款纪律）。该链的下一个压缩据此续链（firstKeptEntryId），
        // 审计据此见窗口。fire-safe：边界是簿记不是证据——丢了退化为「无边界」
        // （resume 裸重放，下个压缩自行重推 span），绝不挡火。
        if (next.value.type === "compacted" && next.value.tier === 2 && session !== undefined && writeId !== undefined) {
          await session.store.appendSidechainEntry(writeId, {
            type: "compact_boundary",
            data: {
              firstKeptEntryId: next.value.firstKeptEntryId,
              reason: next.value.reason,
              tier: next.value.tier,
            },
          } as import("./session/store.js").SessionEntry).catch(() => {
            /* boundary is bookkeeping, never a gate */
          });
        }
        await flush();
        next = await gen.next();
      }
      return next.value;
    };

    // ω99-8b: every model call of this child (main pass AND grace pass) rides
    // the tagged wrapper — meters downstream partition cost exactly-once.
    const childModel = withChildQuerySource(options.model);

    // ω99-57: the mail scope this child's loops run inside. An edge scope is
    // built ONLY where the attribution is real: the spawn site wired a lane
    // (options.parentMail) and this is not a shareContext fork. The child's
    // identity is `childIdentity` (hoisted above the loopOptions literal —
    // the SAME id the onToolUpdate namespace signs with), derived by the
    // runtime, so the sender the parent sees cannot be forged from arguments.
    const mailRole = options.subagentType.name;
    const mailScope: MailScope | undefined = options.forkFrom !== undefined
      ? { kind: "none", reason: MAIL_FORK_REFUSAL }
      : options.parentMail !== undefined
        ? {
            kind: "edge",
            childId: childIdentity,
            role: mailRole,
            send: async (content: string): Promise<void> => {
              // (a)+(b): deliver to the parent lane FIRST — lane acceptance
              // is the commitment (dsh: inbox acceptance precedes everything).
              options.parentMail!.deliver(formatMailText(childIdentity, mailRole, content));
              // (c): the child-side record rides its own sidechain (M35 §2
              // generic entry, the ω99-43 receipts' channel shape). Best
              // effort AFTER delivery: a bookkeeping failure never un-delivers.
              if (session !== undefined && writeId !== undefined) {
                try {
                  await session.store.appendSidechainEntry(writeId, {
                    type: SUBAGENT_MESSAGE_TYPE,
                    data: { role: mailRole, content, ts: new Date().toISOString() },
                  });
                } catch {
                  /* delivered; the record is observability, never a gate */
                }
              }
            },
          }
        : undefined;
    const runMain = (): Promise<Terminal> =>
      drain(runAgentLoop(state, childModel, childHooks !== undefined ? { ...loopOptions, hooks: childHooks } : loopOptions));

    const terminal = mailScope === undefined ? await runMain() : await runWithMailScope(mailScope, runMain);


    // M30 §B grace iteration: flip the fuse instead of dying. The child keeps
    // its transcript and system prompt (byte-identical prefix); only the tool
    // array narrows to the whitelist and one instruction lands. The grace
    // loop gets its own tiny fuse (2) so its final-turn nudge forces an
    // answer even if the model spends the grace turn on todo_write.
    const graceEnabled = options.graceTools !== undefined && options.graceTools.length > 0;
    let budgetLimited = false;
    let graceTerminal: Terminal | undefined;
    // 133 #6：终因捕获（lastTerminal 块作用域外可见——onResult 回执用）。
    let terminalShape: Pick<Terminal, "reason"> & Pick<Partial<Terminal>, "loopEvidence" | "denialCircuit"> | undefined;
    if (terminal.reason === "max_turns" && graceEnabled) {
      budgetLimited = true;
      const whitelist = new Set(options.graceTools);
      state.tools = state.tools.filter((t) => whitelist.has(t.name));
      state.messages.push({ role: "user", content: GRACE_NOTE });
      // M63-B R1 fix (b): the grace pass re-enters runAgentLoop with ONLY
      // the stop face — re-passing the full childHooks would fire onStart a
      // second time for the same child lifecycle. ω99-57: the grace pass runs
      // under the SAME mail scope (a budget-limited child may still message).
      const runGrace = (): Promise<Terminal> =>
        drain(runAgentLoop(state, childModel, {
          ...loopOptions,
          maxTurns: 2,
          ...(childHooks?.onRunStop !== undefined ? { hooks: { onRunStop: childHooks.onRunStop } } : {}),
        }));
      graceTerminal = mailScope === undefined ? await runGrace() : await runWithMailScope(mailScope, runGrace);
    }

    // M63-B R1 fix (a): EXACTLY-ONCE onStop per child lifecycle. The reused
    // stop seam fires only on a NATURAL no-tool-call stop; max_turns/aborted
    // terminals end the loop without consulting the hook. Fire the stop face
    // here — OBSERVATIONALLY (a block decision is ignored: the fuse is spent
    // / the abort is external, there is no "one more turn" to grant) — when
    // the LAST pass of this child ended non-completed (a grace pass that
    // stops naturally has already fired the seam itself).
    {
      const lastTerminal = graceTerminal ?? terminal;
      terminalShape = lastTerminal;
      if (subHooks?.onStop !== undefined && lastTerminal.reason !== "completed") {
        try {
          await subHooks.onStop(typeName, state);
        } catch {
          /* observer isolation */
        }
      }
    }

    options.onResult?.({
      budgetLimited,
      turns,
      toolCalls,
      usage: { promptTokens, completionTokens, cacheHitTokens },
      // 133 #6：终因随回执——父链按终因选通知（denialCircuit → 行为契约）。
      ...(terminalShape !== undefined
        ? {
            terminalReason: terminalShape.reason,
            ...(terminalShape.loopEvidence !== undefined ? { loopEvidence: terminalShape.loopEvidence } : {}),
            ...(terminalShape.denialCircuit === true ? { denialCircuit: true } : {}),
          }
        : {}),
    });

    // ω99-5b §B: the finalTool report extraction seam. Reverse scan — the
    // LAST tool_use of that name wins (a corrected resubmission supersedes an
    // earlier call). Falls through to the legacy last-assistant-text return
    // when no such call exists, so finalTool-agnostic callers are untouched.
    if (options.finalTool !== undefined) {
      for (let i = state.messages.length - 1; i >= 0; i -= 1) {
        const m = state.messages[i];
        if (m === undefined || m.role !== "assistant" || m.toolCalls === undefined) continue;
        for (let j = m.toolCalls.length - 1; j >= 0; j -= 1) {
          const call = m.toolCalls[j];
          if (call !== undefined && call.name === options.finalTool) {
            return canonicalReportJson(call.arguments);
          }
        }
      }
    }

    const last = state.messages.at(-1);
    return last?.role === "assistant" ? last.content : "(subagent produced no final answer)";
  } finally {
    if (writeId !== undefined) {
      // Tail flush BEFORE releasing the writer: a crashed child still leaves
      // a resumable partial transcript, and the guard must never outlive the
      // run that holds it.
      try {
        await flush();
      } finally {
        inFlightChildSessions.delete(writeId);
      }
    }
  }
}
