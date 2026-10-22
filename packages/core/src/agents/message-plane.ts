// ω99-66 — the message-plane constitution types (three-channel unification,
// step ①). docs/research/107-message-plane-constitution.md is the prose;
// this file is its machine-readable half: the six-dimension contract every
// message channel declares against. Pure additive — NO implementation
// imports this yet; the three channels (peer `send_message`, teams
// `send_message`, parent↔child `message_parent`·`message_child`) declare
// conformance from the test side (the ω99-51 projection-constitution
// precedent, replayed on the message plane). Step ② migrates the channels
// onto this seam byte-identically; step ③ adjudicates the send_message
// name double-occupancy.

/** Dimension 5's single hard source: the content cap. MAIL_CONTENT_MAX_CHARS
 *  (ω99-57's mail constant) is the canonical bound every channel's cap must
 *  equal — re-exported here so the plane's vocabulary is self-contained.
 *  Peer/teams hold it by import since ω99-67 (closed in 107 §3.5's
 *  blockquote); the conformance nails are import-relation nails. */
export { MAIL_CONTENT_MAX_CHARS } from "./mail.js";
import { MAIL_CONTENT_MAX_CHARS } from "./mail.js";

/** Dimension 1 — addressing: the channel's address space grammar. An
 *  unresolved address is a TYPED refusal the sender can act on, never a
 *  silent drop. */
export interface MessageAddressing {
  /** The grammar, one line (e.g. "session name | short id | full id"). */
  readonly syntax: string;
  readonly unresolvedIsTypedRefusal: boolean;
}

/** Dimension 2 — delivery timing: when a message becomes visible to the
 *  receiver. NEVER mid-tool: a running tool is never interrupted — every
 *  channel lands between tool calls or on the next model input. A channel
 *  declares the SET its edges use (parent↔child spans both directions:
 *  mail lands on the parent's tool-result edge, steer on the child's next
 *  model input). */
export type MessageDeliveryTiming =
  | "between-tool-calls" // the receiver's steering/inbox drain (turn tail)
  | "at-next-model-call"; // the next ModelInput (mailbox / wake / drain)

/** Dimension 3 — inbound policy: what the receiver's boundary does with an
 *  arriving message (the four-tier alignment matrix, 107 §3.3). */
export type MessageInboundPolicyKind =
  | "accept" // delivered directly into the drain
  | "hold" // parked pending HUMAN approval (delivered/denied/expired report)
  | "refuse" // typed rejection at the boundary
  | "gate"; // rides the receiver's prompt gate (allow/block/rewrite)

export interface MessageInboundPolicy {
  readonly kinds: readonly MessageInboundPolicyKind[];
  /** Whether the sender gets a delivery report (peer: per-message
   *  delivered/denied/expired; teams: next wake; mail/steer: none). */
  readonly receipt: "per-message" | "next-wake" | "none";
}

/** Dimension 4 — attribution: the unforgeable sender line. The prefix is
 *  composed by the RUNTIME from ambient identity (session id, teammate
 *  name, child id/role), NEVER from model-supplied arguments — the tool
 *  schema carries no prefix/sender field, so the model can neither forge
 *  nor suppress it. */
export interface MessageAttribution {
  /** The prefix shape, e.g. "[message from subagent <id> (<role>)]". */
  readonly prefixShape: string;
  readonly composedBy: "runtime";
  /** The schema fields the model DOES supply (none may carry attribution). */
  readonly modelSuppliedFields: readonly string[];
}

/** Dimension 5 — content cap. `source: "local"` is recorded step-② debt
 *  (value-equal today), not a violation; the VALUE equality is the hard
 *  invariant (checkMessagePlaneInvariants enforces it). */
export interface MessageContentCap {
  readonly maxChars: number;
  readonly source: "MAIL_CONTENT_MAX_CHARS" | "local";
}

/** Dimension 6 — untrusted semantics: the receiver treats inbound text as
 *  untrusted. Literal `true` fields — the type refuses any declaration
 *  that waters one down. */
export interface MessageUntrustedSemantics {
  readonly bannerDeclared: true;
  readonly cannotApprovePermissions: true;
  readonly cannotChangeConfig: true;
  readonly commandsArePlainText: true;
}

/** One channel's declaration against the six-dimension contract. */
export interface MessagePlane {
  /** Channel identity (stable: "peer" / "teams" / "parent-child"). */
  readonly id: string;
  /** The model-visible tool name(s) this channel registers. */
  readonly toolNames: readonly string[];
  readonly addressing: MessageAddressing;
  readonly delivery: readonly MessageDeliveryTiming[];
  readonly inbound: MessageInboundPolicy;
  readonly attribution: MessageAttribution;
  readonly contentCap: MessageContentCap;
  readonly untrusted: MessageUntrustedSemantics;
}

/** Register a channel declaration (identity — the vocabulary reads
 *  `describeMessagePlane({…})` at every declaration site; test-side until
 *  step ② wires implementations to the seam). */
export function describeMessagePlane(plane: MessagePlane): MessagePlane {
  return plane;
}

/** The constitutional invariants a declaration must satisfy (pure — the
 *  conformance suite calls this per channel and fails on any violation;
 *  these are the cross-channel LAWS, not per-channel choices). */
export function checkMessagePlaneInvariants(plane: MessagePlane): readonly string[] {
  const v: string[] = [];
  if (plane.contentCap.maxChars !== MAIL_CONTENT_MAX_CHARS) {
    v.push(`${plane.id}: content cap ${plane.contentCap.maxChars} !== MAIL_CONTENT_MAX_CHARS (${MAIL_CONTENT_MAX_CHARS})`);
  }
  if (plane.attribution.composedBy !== "runtime") {
    v.push(`${plane.id}: attribution must be runtime-composed`);
  }
  if (plane.attribution.prefixShape.trim() === "") {
    v.push(`${plane.id}: attribution prefix shape is empty`);
  }
  if (plane.attribution.modelSuppliedFields.some((f) => /prefix|sender|banner|from/i.test(f))) {
    v.push(`${plane.id}: a model-supplied field carries attribution vocabulary`);
  }
  if (plane.toolNames.length === 0) v.push(`${plane.id}: no tool names`);
  if (plane.delivery.length === 0) v.push(`${plane.id}: no delivery timing declared`);
  if (plane.addressing.syntax.trim() === "") v.push(`${plane.id}: addressing syntax is empty`);
  if (plane.addressing.unresolvedIsTypedRefusal !== true) {
    v.push(`${plane.id}: unresolved addresses must be typed refusals`);
  }
  if (!plane.untrusted.bannerDeclared) v.push(`${plane.id}: untrusted banner not declared`);
  return v;
}
