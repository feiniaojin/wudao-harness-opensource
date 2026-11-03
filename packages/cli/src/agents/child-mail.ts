// ω99-57 — the parent-side child-mail lane. Child→parent messages ride the
// PARENT's steering channel as ONE additional LOW-priority lane (T0-2
// ordering: user queue → cron → peer → CHILD MAIL → monitor → system),
// drained by the driver's take() before every model call and at the run
// settle seam, with the same fire-on-idle wake the peer lane has. The lane
// is deliberately dumb: it receives already-formatted steering texts (the
// child's identity was applied by core's runSubagent) and hands them out
// FIFO — the dsh next-step-FIFO + waking accounting is the lane semantics
// the parent steering channel already owns, not new machinery here.
import type { ParentMailSink } from "@wudao-org/core";

/** The lane the driver drains and the task tool feeds. */
export interface ChildMailLane {
  /** Enqueue one formatted message (the task tool's sink side). */
  readonly submit: (text: string) => void;
  /** Dequeue the next message (the driver's take side), FIFO. */
  readonly take: () => string | undefined;
  /** Pending count (status surfaces; never a control input). */
  readonly size: () => number;
}

export function createChildMailLane(): ChildMailLane {
  const queue: string[] = [];
  return {
    submit: (text) => { queue.push(text); },
    take: () => queue.shift(),
    size: () => queue.length,
  };
}

/** Adapt a lane into core's spawn-site sink (the task tool threads this into
 *  runSubagent/registry spawns as `parentMail`). */
export function laneAsParentMail(lane: ChildMailLane): ParentMailSink {
  return { deliver: (text) => { lane.submit(text); } };
}
