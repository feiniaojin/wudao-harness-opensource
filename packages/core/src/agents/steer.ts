// ω99-60 — parent→child steer (the parent half-arc; the reverse of ω99-57's
// mail). One globally-registered model tool (`message_child`) the PARENT uses
// to steer a RUNNING background child (a registry `bg-N`): the submission
// lands on the child's per-spawn FIFO mailbox and is consumed by the core
// loop's EXISTING steering drain — the same path, the same onPromptSubmit
// gate, the same `steered` event, the same append-only user turn (and the
// child sidechain records it for free). Zero new loop concepts: dsh's
// child-side "safe step / inbox" is wudao's model-call boundary + steering
// seam, reused verbatim.
//
// Unforgeability (the mirror of 57's runtime-derived sender): the model
// supplies ONLY {id, content}; the `[steer from parent]` attribution is
// composed inside the registry (formatSteerText) and the bg-N address space
// is registry-local — a loop whose tools were assembled without a registry
// gets the typed no-edge refusal below, never a forged steer.
//
// The content cap mirrors 57's MAIL_CONTENT_MAX_CHARS (single source — the
// import changes no byte of mail.ts).
import { buildTool } from "../tool.js";
import type { Tool } from "../tool.js";
import { MAIL_CONTENT_MAX_CHARS } from "./mail.js";

/** The reserved tool name. No collision with the M64-A peer `send_message`
 *  or the M64-C teams flavor — the loop dispatches by first name match. */
export const CHILD_MESSAGE_TOOL_NAME = "message_child";

/** The content cap — 57's value, single-sourced (re-exported, not mirrored:
 * the import changes no byte of mail.ts). */
export { MAIL_CONTENT_MAX_CHARS } from "./mail.js";

/** The model-visible attribution line: composed by the registry at submit
 *  time, never by the model (the unforgeable steering prefix). */
export const STEER_FROM_PARENT_PREFIX = "[steer from parent]";

/** Typed refusal where no registry was wired into the tool (acceptance 3). */
export const STEER_NO_EDGE_ERROR =
  "message_child unavailable: no agent registry wired into this tool — this loop has no background children to steer (a context the steer seam does not cover)";

/** The formatted steering text the child's drain appends (registry-internal). */
export function formatSteerText(content: string): string {
  return `${STEER_FROM_PARENT_PREFIX}\n${content}`;
}

/** The per-child FIFO mailbox the registry owns (57's lane shape: submit at
 *  the tool edge, take at the child's steering drain). */
export interface SteerMailbox {
  readonly submit: (text: string) => void;
  readonly take: () => string | undefined;
}

export function createSteerMailbox(): SteerMailbox {
  const queue: string[] = [];
  return {
    submit: (text) => { queue.push(text); },
    take: () => queue.shift(),
  };
}

/** The structural slice of AgentRegistry the tool needs — core's registry is
 *  the only implementer; embedders may hand any steerable face. */
export interface SteerRegistry {
  steer(id: string, content: string): void;
}

/** The globally-registered tool. The registry binding is the steer edge:
 *  the tools-assembly site closes the session's registry in (the same
 *  instance its task tool spawns through); a construction without one is
 *  the typed no-edge refusal, so no prompt section is needed anywhere. */
export function createMessageChildTool(registry?: SteerRegistry): Tool {
  return buildTool({
    name: CHILD_MESSAGE_TOOL_NAME,
    description:
      "Steer a background child that is still running — deliver a course correction that lands on its next model call as a [steer from parent] user turn. " +
      "Address the child by its bg-N id (from the task receipt or agent_status); an unknown or already-finished id fails with a typed error. " +
      "The attribution is composed by the runtime; the steer text is one self-contained string.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "The background agent to steer — its bg-N id (from the task receipt or agent_status)." },
        content: { type: "string", description: "The steer text — self-contained and actionable (cites paths/evidence)." },
      },
      required: ["id", "content"],
      additionalProperties: false,
    },
    async execute({ id, content }) {
      if (typeof id !== "string" || id.trim() === "") {
        return { content: 'message_child: "id" must be a non-empty string', isError: true };
      }
      if (typeof content !== "string" || content.trim() === "") {
        return { content: 'message_child: "content" must be a non-empty string', isError: true };
      }
      if (content.length > MAIL_CONTENT_MAX_CHARS) {
        return { content: `message_child: content exceeds ${MAIL_CONTENT_MAX_CHARS} chars (got ${content.length})`, isError: true };
      }
      if (registry === undefined) return { content: STEER_NO_EDGE_ERROR, isError: true };
      try {
        registry.steer(id, content);
        return { content: `steer delivered to ${id} — it lands on the child's next model call` };
      } catch (err) {
        return { content: `message_child failed: ${err instanceof Error ? err.message : String(err)}`, isError: true };
      }
    },
    // An in-process mailbox enqueue: not read-class (it changes the child's
    // next input), not destructive, not open-world, concurrency-safe.
    isDestructive: () => false,
    isOpenWorld: () => false,
    isConcurrencySafe: () => true,
  });
}
