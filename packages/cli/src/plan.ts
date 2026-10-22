// M37 §1 — plan mode (/plan <goal> + --plan). A plan run is READ-ONLY: the
// whitelist below rides the permission gate (any other tool is denied with a
// plan-mode reason), the loop's plan gate (LoopGates.plan) forces the plan to
// land as a todo_write board, and the review flow (ok / 改 <意见>) is parsed
// here so the REPL and the TUI share one state machine.
import { randomUUID } from "node:crypto";
import { parseTodoBoard, nodeKey, createProjectionDriver, todoProjection } from "@wudao/core";
import type { AgentMessage, PermissionDecision } from "@wudao/core";

/** Tools a plan run may use: the read-only lane (read/glob/grep/agent_status)
 *  plus todo_write (the plan IS the board — todo_write writes only the
 *  harness's own .wudao/plan.md, never user code) and ask_user (asking IS the
 *  review loop's raw material). Everything else — write_file/edit/shell/
 *  task/… — waits for the approved execution run. */
export const PLAN_MODE_TOOLS: ReadonlySet<string> = new Set([
  "read_file",
  "glob",
  "grep",
  "agent_status",
  "todo_write",
  "ask_user",
]);

/** The plan-mode leg of a permission gate: undefined when the tool is
 *  whitelisted (the caller's normal pipeline decides), a deny decision when it
 *  is not. Layered BEFORE the normal gate so the whitelist is strictest. */
export function planModeDenied(toolName: string): PermissionDecision | undefined {
  if (PLAN_MODE_TOOLS.has(toolName)) return undefined;
  return { behavior: "deny", reason: `plan mode is read-only — ${toolName} is not available until the plan is approved` };
}

/** The plan-run user message: goal + the read-only contract + the structured
 *  plan shape (goal/steps/risks/verification) as a todo_write board. */
export function buildPlanPrompt(goal: string): string {
  return [
    "<plan-request>",
    `Plan mode — read-only until approved. Goal: ${goal}`,
    "",
    "Explore the workspace with the read-only tools (read_file/glob/grep), then present a structured plan as a todo board via todo_write:",
    "- cover goal, steps, risks, and verification",
    "- every step is one board item, all items pending (no item in_progress — execution happens only after the user approves)",
    "Then answer with a short plan summary. Do not write or modify files, run commands, or spawn subagents — those are denied in this run.",
    "</plan-request>",
  ].join("\n");
}

/** The revision-run user message (改 <意见>): still read-only, the board gets
 *  updated in place (todo_write is a full replacement). */
export function buildPlanRevisionPrompt(feedback: string): string {
  return [
    "<plan-revision>",
    "Plan mode (revision) — still read-only. The user reviewed the plan board and asks for changes:",
    feedback,
    "",
    "Revise the plan: re-explore with the read-only tools if needed, replace the board via todo_write with the updated steps, then answer with the updated plan summary (goal/steps/risks/verification).",
    "</plan-revision>",
  ].join("\n");
}

/** The post-approval execution user message: the board verbatim + the normal
 *  long-task discipline (one in_progress at a time, verify before done). */
export function buildPlanExecutionPrompt(board: string): string {
  return [
    "<plan-approved>",
    "The user approved this plan. Execute it now: work the board top-to-bottom — exactly one item in_progress at a time, mark an item done only after its verification passes, and run the relevant tests/build as you go.",
    "",
    board,
    "",
    "</plan-approved>",
  ].join("\n");
}

/** Short confirmations that approve a plan under review (case-insensitive,
 *  trimmed). Spec §1: 用户 ok(或短确认)→ 以该板进入执行. */
export const PLAN_APPROVAL_WORDS: readonly string[] = [
  "ok", "y", "yes", "go", "approve", "好", "可以", "执行",
];

/** One review-time input line while a plan board awaits review: an approval,
 *  a revision request (改 <意见>), or undefined when the line is not
 *  review-shaped (the frontend falls through to normal prompt handling and the
 *  board stays under review). */
export function parsePlanReviewInput(line: string): { kind: "approve" } | { kind: "revise"; feedback: string } | undefined {
  const trimmed = line.trim();
  if (trimmed === "") return undefined;
  const lower = trimmed.toLowerCase();
  if (PLAN_APPROVAL_WORDS.includes(lower)) return { kind: "approve" };
  const m = /^改\s+(.+)$/.exec(trimmed);
  if (m?.[1]) return { kind: "revise", feedback: m[1].trim() };
  return undefined;
}

/** The one-line hint printed under a freshly produced plan board. */
export const PLAN_REVIEW_HINT =
  'plan ready — reply "ok" (or a short confirmation) to execute it, "改 <意见>" to revise';

/** 审批痕 (approval trace, M1 authz-registry review follow-up): the raw line
 *  the human typed to approve a plan, pushed VERBATIM as ONE genuine user
 *  message BEFORE the <plan-approved> wrapper — temporal order: the human
 *  spoke first, the harness wrapped second. The confirmation starts with no
 *  registry marker, so classifyAuthzMessage reads it as genuine-user and the
 *  authz evidence channel finally sees the approval ACT, not just the
 *  approved content. Node shape follows the canonical turn push
 *  (driver/agent-driver.ts submitCore): a fresh uuid linked at the chain
 *  predecessor's nodeKey. Callers push at the approval moment — a turn
 *  boundary, BEFORE the execution run starts, never mid-run (M24: the
 *  history stays append-only; the warm prefix is never rewritten). The
 *  revise path needs no trace: buildPlanRevisionPrompt embeds the user's
 *  feedback bytes verbatim inside the wrapper, which is exactly why it is
 *  not a registered synthetic marker. */
export function appendPlanApprovalTrace(messages: AgentMessage[], rawConfirmation: string): void {
  const parentKey = messages.length > 0 ? nodeKey(messages[messages.length - 1] as AgentMessage) : undefined;
  messages.push({
    role: "user",
    content: rawConfirmation,
    uuid: randomUUID(),
    ...(parentKey !== undefined ? { parentUuid: parentKey } : {}),
  });
}

/** The one-shot y/N decision over the RAW trimmed confirmation line
 *  (confirmLine semantics, extracted pure so both call sites and the tests
 *  share ONE spelling): case-insensitive y/yes approve; everything else —
 *  including the empty line and any other word — declines. The raw line
 *  itself is NOT folded here: the approval trace pushes its own bytes. */
export function planConfirmApproves(rawTrimmedLine: string): boolean {
  const lower = rawTrimmedLine.toLowerCase();
  return lower === "y" || lower === "yes";
}

/** The latest todo board in a message list — the plan artifact a finished
 *  plan run leaves behind (tool result or restored user message). */
export function lastTodoBoard(messages: readonly AgentMessage[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (m !== undefined && parseTodoBoard(m.content) !== undefined) return m.content;
  }
  return undefined;
}

/** ω99-51 (session projection seam, todo domain): the consumer-side bridge
 *  onto the core projection driver. `current(messages)` returns EXACTLY what
 *  lastTodoBoard(messages) returns — the fold is fed the same live chain the
 *  backscan scanned, so the derivation is byte-equal by construction (the
 *  equivalence corpus lives in packages/core/tests/o99-51-session-projection.test.ts).
 *  Sync semantics (measured T0, see docs/research/106-*.md §3): a REPLACED
 *  array reference (load / rewind / tier-2 wholesale replacement / branch
 *  switch — every mutation site swaps the reference, none mutates in place)
 *  resets and refeeds the whole chain; the SAME array grown (the loop pushes
 *  in place) feeds just the tail. One source per session lifecycle; share it
 *  across a session's consumers ("同一 session 共享 driver"). */
export interface TodoBoardSource {
  /** Fold the chain's unseen tail (or restart on a replaced array). Cheap
   *  when already in sync: one reference + length check. */
  sync(messages: readonly AgentMessage[]): void;
  /** The latest board content — lastTodoBoard's exact value, via the seam. */
  current(messages: readonly AgentMessage[]): string | undefined;
}

export function createTodoBoardSource(): TodoBoardSource {
  const driver = createProjectionDriver(todoProjection);
  let fed: readonly AgentMessage[] | undefined;
  let fedLen = 0;
  const sync = (messages: readonly AgentMessage[]): void => {
    if (messages !== fed) {
      driver.reset();
      fed = messages;
      fedLen = 0;
    }
    for (; fedLen < messages.length; fedLen += 1) driver.feed(messages[fedLen] as AgentMessage);
  };
  return {
    sync,
    current: (messages: readonly AgentMessage[]): string | undefined => {
      sync(messages);
      return driver.snapshot().state.content;
    },
  };
}
