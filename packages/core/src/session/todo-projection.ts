// ω99-51 — the FIRST registered projection unit: the todo domain. State =
// the latest board-bearing message on the chain — the verbatim semantics of
// the plan-review backscan (packages/cli/src/plan.ts lastTodoBoard), which
// T0 measured as: scan the LIVE message chain (the same sequence every
// consumer scans — post branch-projection, post tier-2 wholesale
// replacement, post stub), return the LAST message whose content
// parseTodoBoard recognizes, RAW content + parse. The fold is fed that
// sequence by the cli wiring (array-identity resync: a replaced array →
// reset+refeed; the same array grown → feed the tail), so the derivation is
// byte-equal to the old backscan BY CONSTRUCTION (see
// packages/core/tests/o99-51-session-projection.test.ts, acceptance 1).
// Compaction fidelity rides the shapes the compactors already produce: the
// tier-2 restored board (a user message whose header carries "(restored)")
// still parses; a stubbed old board stops parsing and the fold falls to the
// earlier board — exactly what the backscan did.
import { parseTodoBoard } from "../tools/todo.js";
import type { ParsedTodoBoard } from "../tools/todo.js";
import type { AgentMessage } from "../types.js";
import { defineProjection } from "./projection.js";

/** The todo domain state — whole-value: every change carries the complete
 *  board (never a delta). `content` is the RAW board-bearing message
 *  content (what the plan-review flow prints and re-embeds verbatim);
 *  `board` is its parse. Both undefined on a board-less chain. */
export interface TodoProjectionState {
  readonly content: string | undefined;
  readonly board: ParsedTodoBoard | undefined;
}

/** The todo projection unit. Defensive fold (no Schema.parse culture): a
 *  message whose content is not a string or does not parse leaves the state
 *  untouched — the SAME reference, so gate 1 skips it for free. */
export const todoProjection = defineProjection<TodoProjectionState, AgentMessage>({
  key: "todo",
  init: () => ({ content: undefined, board: undefined }),
  apply: (message, state) => {
    const content = typeof message.content === "string" ? message.content : undefined;
    const board = content === undefined ? undefined : parseTodoBoard(content);
    if (board === undefined) return state;
    return { content, board };
  },
});
