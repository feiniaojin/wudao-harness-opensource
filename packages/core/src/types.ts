// Core message + transition types for the agent loop.
// These are provider-neutral shapes owned by core (not provider SDK types).
import type { ImageBlock, FileBlock } from "./attachments.js";

export interface ToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: Record<string, unknown>;
}

export interface ToolResult {
  readonly content: string;
  readonly isError?: boolean;
  /** M49 §4 — result PROVENANCE: the source class of the content ("user-file"
   *  for workspace file reads, "mcp" for external-server results; web etc. are
   *  future). Purely a runtime annotation: the loop surfaces it on the
   *  tool_call_finished event so frontends can taint-track. It is NEVER
   *  serialized onto ToolResultMessage (no wire / persistence pollution). */
  readonly provenance?: string;
  /** ω99-138 — images this tool produced, as durable refs. The loop carries
   *  them onto the ToolResultMessage (which owns the M79 persistence/wire
   *  contract); empty/absent keeps every byte of the pre-138 shape. The first
   *  builtin emitter is browser_see — screenshots land in the workspace
   *  AttachmentStore via the injected sink BEFORE this field is set, so no
   *  bytes ever ride here (refs only, same discipline as user images). */
  readonly images?: readonly ImageBlock[];
}

export interface UserMessage {
  readonly role: "user";
  readonly content: string;
  /** M53 §1 — branch-node metadata (persistence-only). `uuid` identifies this
   *  node in the session tree; `parentUuid` names the node this one follows.
   *  Linear turns point at their chain predecessor; a BRANCH turn (an edited
   *  resubmit) points at the parent of the message it replaces, so the old
   *  turns stay on the tree while the active chain diverges. The provider
   *  serializer maps role/content explicitly — these fields never reach the
   *  wire, and the canonical prefix-byte serializer is unaffected. */
  readonly uuid?: string;
  readonly parentUuid?: string;
  /** M79: images riding this user turn, as durable refs (never bytes — the
   *  JSONL and every cache-pin see only ImageAttachmentRef; the transient
   *  data URL is resolved by the provider at request build). Absent on
   *  text-only turns, whose serialization is byte-identical to pre-M79. */
  readonly images?: readonly ImageBlock[];
  /** ω99-55: generic files riding this user turn, as content-addressed
   *  blocks (name/bytes/attachmentId — the bytes live in the AttachmentStore
   *  under `.wudao/attachments`, never in the JSONL). Request build projects
   *  each block to deterministic handle TEXT naming the model-visible
   *  read-only path (offloadRequestFiles) — no wire ever carries file bytes;
   *  the model reads lazily with the ordinary file tools. User turns only:
   *  no tool emits files, and the subagent lane refuses them outright. */
  readonly files?: readonly FileBlock[];
}

export interface AssistantMessage {
  readonly role: "assistant";
  readonly content: string;
  /** Same persistence-only branch metadata (M53): the loop does not set it
   *  today, but resume/walk code treats a missing parentUuid as "follows the
   *  previous entry in file order", so assistant/tool nodes need no ids. */
  readonly uuid?: string;
  readonly parentUuid?: string;
  readonly toolCalls?: ToolCall[];
  // DeepSeek/OpenAI-compatible "reasoning_content". Captured end-to-end and
  // surfaced in streams. Whether it is serialized BACK to the provider is the
  // M47 per-provider contract (providers config `reasoningReplay`):
  // never (default) | toolCallTurns | always. When replay is on, the bytes
  // sent are these stored bytes, verbatim.
  readonly reasoning?: string;
  /** M70 §1: the provider's finish_reason (OpenAI vocabulary: "stop",
   *  "length", "tool_calls", "content_filter", ...). "length" = the token
   *  limit cut the generation mid-stream — the loop's truncated tool-call
   *  guard fails every tool call in such a message instead of executing
   *  salvage-parsed arguments (pi). Persistence-only metadata: it never
   *  reaches the wire on replay. */
  readonly stopReason?: string;
  /** 夜移 001 (dsh interrupted-stream finalization): true when this message
   *  is the delivered prefix of a stream the user aborted — committed so the
   *  transcript matches what streamed and resume/replay stay valid.
   *  Persistence-only metadata (same contract as stopReason and uuid): never
   *  serialized to the wire, never replayed. */
  readonly interrupted?: true;
  /** ω99-53: the reasoning effort THIS turn's request ran at (LoopOptions.
   *  effortSent — the driver threads the provider config's current level in;
   *  interrupted partials carry the same value, it is the same request).
   *  Persistence-only metadata (same contract as stopReason/interrupted):
   *  it rides the JSONL so a later effort switch is attributable against the
   *  previous turn (cache-report's effort_changed cause), but it NEVER
   *  reaches the wire — the provider serializers map role/content/etc.
   *  explicitly, so request bytes are unaffected (M47 discipline; pinned by
   *  a serializePrompt byte test). */
  readonly effort?: string;
}

export interface ToolResultMessage {
  readonly role: "tool";
  readonly toolCallId: string;
  readonly name: string;
  readonly content: string;
  readonly isError?: boolean;
  /** Persistence-only branch metadata (M53) — see UserMessage. */
  readonly uuid?: string;
  readonly parentUuid?: string;
  /** M79: images produced by this tool result, as durable refs. The `tool`
   *  wire role stays string-only: the provider serializer buffers these into
   * ONE synthetic user message immediately following the tool block (prefix
   * "Attached image(s) from tool result:"), adapting any string-only tool
   * wire format (dsh serialize parity). No builtin tool emits images yet —
   * the shape is the M79 foundation. */
  readonly images?: readonly ImageBlock[];
}

export type AgentMessage = UserMessage | AssistantMessage | ToolResultMessage;

// Loop lifecycle: each iteration ends with a typed transition.
// run-budget (2026-08-24): "run_budget_exhausted" is the run-level wall-clock
// fuse (LoopOptions.maxRunMs) — fired at a turn TOP, before the model call,
// never mid-call. Cooperative by design: the preemptive mechanism is
// signal/abort ("aborted"); this reason only ever means the elapsed budget
// ran out between turns. finalMessage is absent (no final answer existed).
// 夜移 036 (codex rollout_budget): "session_budget_exhausted" = the SESSION-
// TREE weighted token budget (LoopOptions.sessionBudget) went dry — recorded
// right after the response's usage landed, so the response's tool calls never
// execute. Sticky: later runs burn one call each, record, and fail the same
// way. finalMessage is absent (the run failed, no answer is trusted).
// 夜移 013: "output_limit" = the output-limit recovery ladder exhausted its
// nudge budget on a text-only stop_reason:"length" truncation — the final
// answer exists but was cut by the output cap and did not recover.
// finalMessage carries that last truncated assistant.
export type TerminalReason = "completed" | "max_turns" | "aborted" | "run_budget_exhausted" | "output_limit" | "session_budget_exhausted";

export interface Terminal {
  readonly reason: TerminalReason;
  readonly finalMessage?: AssistantMessage;
  /** M48 §1: present only on a loop-safety forced abort (the run's second
   *  loop verdict) — the detector's evidence string, for UI/audit. */
  readonly loopEvidence?: string;
  /** 133 #6（codex 63475131ce 形）— present only on a loop-safety abort
   *  whose offending streak was ENTIRELY permission denials（否决墙）.
   *  Persistence-only metadata（same contract as loopEvidence——never
   *  reaches the wire）; the PARENT chain consumes it to select the
   *  behavioral-contract notification（"用户确认前禁止恢复/重试"）. */
  readonly denialCircuit?: true;
  /** ω-4b: present only on a loop-safety abort that went through the
   *  reflection fork — "challenger-confirmed" (the fork's second opinion
   *  agreed the run is stuck, with its rationale) or "challenger-unavailable"
   *  (the fork failed; the detector's verdict won untouched). Absent when
   *  the fork never ran (disabled, un armed kind, spent, or verdict 2 with
   *  no reflection option). The detector's `loopEvidence` above stays
   *  authoritative in every case. */
  readonly loopReflection?: {
    readonly outcome: "challenger-confirmed" | "challenger-unavailable";
    readonly rationale?: string;
  };  /** M61 §3: present when the stop-hook block cap ended the run — three
   *  consecutive continuations with no tool use. The /goal stall guard keys
   *  on it: pause evaluation, return control, keep the goal. */
  readonly stopBlockCapped?: true;
  /** M63-A: present when a PostToolBatch hook ended the run at a batch
   *  boundary ({continue:false}) — the batch's results are all in history,
   *  and the model was NOT called again (stop gates/onRunStop skipped: the
   *  hook already decided). `finalMessage` is the tool-call assistant
   *  message that carried the batch. */
  readonly postToolBatchStop?: true;
  /** 弧 δ (penguin 367ab084 思想, additive-only): present when a mid-flight
   *  tool call was detached to the background and the run closed at the
   *  batch boundary for it — same settling shape as postToolBatchStop (the
   *  batch's results stand, the model is not called again), but the cause
   *  is the USER's detach gesture. The detached call is answered in history
   *  by the BACKGROUNDED synthetic; its real result merges later through
   *  the consumer's background lane (the ω-4a monitor seam's sibling). */
  readonly backgrounded?: true;
}

export type ContinueReason = "next_turn";

export interface Continue {
  readonly reason: ContinueReason;
}

export type Transition = Terminal | Continue;
