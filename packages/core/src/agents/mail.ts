// ω99-57 — child→parent mail (the child half-arc). One globally-registered
// model tool (`message_parent`) + the ambient scope runSubagent enters for an
// attributed child. The model-visible face is IDENTICAL everywhere (same
// schema, same registry order — a fork child's tool array stays byte-equal to
// its parent's, the M30 §A invariant); only the EXECUTION differs, because
// the sender is derived from the ambient scope (the child's runtime
// attribution), never from model-supplied arguments. Outside an attributed
// child the call fails with a deterministic typed error — the top-level
// session needs no child-specific prompt section to explain an absent tool.
//
// The dsh lesson (2026-08-27-adjacent-agent-steer-messaging): a child-only
// `report` tool + a child-side prompt section made the child's request head
// differ from its parent's, killing prefix-cache reuse. Here the tool is
// global and the child guidance rides the child's OWN brief (the isolated
// child's fresh prefix; forks never see it), never the system prompt or the
// tool schema.
import { AsyncLocalStorage } from "node:async_hooks";
import { buildTool } from "../tool.js";
import type { Tool } from "../tool.js";

/** The reserved tool name. NOTE (T0, discovered): dsh names this operation
 *  `send_message`, but wudao's M64-A peer pair already registers a top-level
 *  `send_message {to,text}` and the M64-C teams runtime registers its own
 *  intra-team flavor — the loop dispatches by first name match, so a third
 *  global `send_message` would shadow the peer channel (a red-line surface).
 *  This half-arc uses `message_parent`; unifying the channels under one name
 *  is the follow-up half-arc's scope. */
export const PARENT_MESSAGE_TOOL_NAME = "message_parent";

/** Content cap, aligned with the peer/teams message caps. */
export const MAIL_CONTENT_MAX_CHARS = 8_000;

/** The M35 §2 generic-entry type tag for a persisted send (child sidechain). */
export const SUBAGENT_MESSAGE_TYPE = "subagent-message";

/** Typed refusal outside any attributed child (acceptance 4). */
export const MAIL_NO_EDGE_ERROR =
  "message_parent unavailable: no live parent edge — this loop has no parent to message (the top-level session, a runner without mail wiring, or a context the mail seam does not cover)";

/** Typed refusal inside a shareContext fork (T0-3 ruling: a fork has no
 *  sidechain to attribute and its report already returns via the task
 *  result — extending ForkContext with a spawn identity is the follow-up
 *  half-arc's call if fork messaging earns a concrete need). */
export const MAIL_FORK_REFUSAL =
  "message_parent unavailable: a shareContext fork replays the parent conversation — deliver your findings in your final answer (the task result returns to the parent verbatim)";

/** The ambient mail scope. `edge` = this loop IS an attributed child with a
 *  live parent lane; `none` = the call must refuse, with a reason the model
 *  can act on. Absent (no AsyncLocalStorage store) = the top-level shape. */
export type MailScope =
  | {
      readonly kind: "edge";
      /** The child's durable identity: the sidechain write id when session'd,
       *  else a per-spawn ephemeral id. Signs every delivery (unforgeable —
       *  the model never supplies it). */
      readonly childId: string;
      readonly role: string;
      /** Deliver one message; resolves when the parent lane accepted it. */
      readonly send: (content: string) => Promise<void>;
    }
  | { readonly kind: "none"; readonly reason: string };

const mailScope = new AsyncLocalStorage<MailScope>();

/** Run `fn` (and everything it awaits — the child's whole loop) inside a mail
 *  scope. Tool executions within inherit it through the await chain. */
export function runWithMailScope<R>(scope: MailScope, fn: () => Promise<R>): Promise<R> {
  return mailScope.run(scope, fn);
}

/** The scope of the loop calling, if any (undefined = top-level shape). */
export function currentMailScope(): MailScope | undefined {
  return mailScope.getStore();
}

/** The model-visible steering line: source attribution derived by the
 *  runtime (dsh: "Agent <sender-id> sent a message:"). */
export function formatMailText(childId: string, role: string, content: string): string {
  return `[message from subagent ${childId} (${role})]\n${content}`;
}

/** The globally-registered tool. ONE schema everywhere (parent, isolated
 *  child, worktree child, fork); the parent's own calls get the typed
 *  no-edge refusal, so no child-specific prompt section is needed anywhere. */
export function createParentMessageTool(): Tool {
  return buildTool({
    name: PARENT_MESSAGE_TOOL_NAME,
    promptSnippet: "send an early finding to the session that spawned you",
    promptGuidelines: [
      "Send as soon as it changes what the parent should do next — not only in the final report.",
    ],
    description:
      "Send a message to the parent of the current agent loop — a mid-run finding that changes what the parent should do next. " +
      "Only a subagent dispatched by this session's task tool has a live parent edge; anywhere else the call fails with a typed error. " +
      "The sender is derived by the runtime; the message is one self-contained string.",
    parameters: {
      type: "object",
      properties: {
        content: { type: "string", description: "The message body — self-contained and actionable (cites paths/evidence)." },
      },
      required: ["content"],
      additionalProperties: false,
    },
    async execute({ content }) {
      if (typeof content !== "string" || content.trim() === "") {
        return { content: 'message_parent: "content" must be a non-empty string', isError: true };
      }
      if (content.length > MAIL_CONTENT_MAX_CHARS) {
        return { content: `message_parent: content exceeds ${MAIL_CONTENT_MAX_CHARS} chars (got ${content.length})`, isError: true };
      }
      const scope = currentMailScope();
      if (scope === undefined) return { content: MAIL_NO_EDGE_ERROR, isError: true };
      if (scope.kind === "none") return { content: `message_parent unavailable: ${scope.reason}`, isError: true };
      try {
        await scope.send(content);
        return { content: "message delivered to parent" };
      } catch (err) {
        return { content: `message_parent failed: ${err instanceof Error ? err.message : String(err)}`, isError: true };
      }
    },
    // Dispatch is an in-process lane enqueue: not read-class (it mutates the
    // parent's conversation), not destructive, not open-world, concurrency-safe.
    isDestructive: () => false,
    isOpenWorld: () => false,
    isConcurrencySafe: () => true,
  });
}
