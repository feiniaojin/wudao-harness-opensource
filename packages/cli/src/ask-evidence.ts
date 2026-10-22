// ω-4e — the asker context: WHO is asking at a permission ask, and WHAT the
// genuine user last said (63-omega-4e-design.md §3.3).
//
// wudao's ask-tier risk gate is the HUMAN, and the permission gate is
// deliberately SHARED between the parent and every child (one
// createPermissionGate product threaded through the task tool). Without this
// module, a fork/isolated child's ask is indistinguishable from the main
// agent's, and the human has nothing to check the request against — the upstream project's
// threat ("a worker's transcript can contain forwarded or assistant-authored
// text claiming the user approved something"), except wudao's reviewer at
// this tier is a person.
//
// The context rides a `node:async_hooks` AsyncLocalStorage — the only
// primitive correct under CONCURRENT children (registry background agents,
// parallel task fan-out, team peers): each child's decorated gate closure is
// created at its spawn site and runs `storage.run(ctx, () => gate(...))`, so
// every ask fired anywhere inside that child's call chain reads THAT child's
// asker while siblings sit at their own asks. A module-level variable would
// cross-contaminate the interleaving window (set → await settings read →
// ask-text build); ALS closes it. Stdlib only; this is the codebase's first,
// small, load-bearing use.
//
// The decorator is pass-through faithful: it returns the inner gate's
// decision verbatim — context plumbing, not a policy layer (capability ≠
// policy). `loop.ts` and the `canUseTool` signature are untouched.
import { AsyncLocalStorage } from "node:async_hooks";
import { buildAuthzExcerpt, renderAskDigest } from "@wudao/core";
import type { AgentMessage, AskerInfo } from "@wudao/core";
import type { ChildApprovalFace } from "./agents/child-approvals.js";

export type { AskerInfo } from "@wudao/core";

export interface AskContext {
  readonly asker: AskerInfo;
  readonly getRootMessages: () => readonly AgentMessage[] | undefined;
  /** ω99-43: the child's durable approval receipts (session'd children
   *  only). Undefined on every top-level ask AND every sessionless child —
   *  the receipt layer is inert there, byte-identical to the pre-ω99-43
   *  ask path. The face is a per-spawn object (built where the child's
   *  sidechain is resolved); it never widens policy — it can only restate a
   *  decision the human already gave for exactly this (tool, input). */
  readonly approvals?: ChildApprovalFace;
}

/** The permission-gate call shape (LoopOptions["canUseTool"]) — unchanged by
 *  this module; the decorator preserves it exactly. */
export type PermissionGateFn = (toolName: string, input: Record<string, unknown>) => unknown;

const askStorage = new AsyncLocalStorage<AskContext>();

/** Wrap a child's permission gate with its asker context. Every ask fired
 *  inside the gate's call chain (one-shot askApprove, REPL askHuman, the
 *  driver's parked/frontend ask — whichever surface this gate reaches) reads
 *  this child's asker; the decision itself passes through verbatim.
 *  ω99-43: a session'd child also carries its approval-receipt face — the
 *  ask seam replays/commits durable decisions through it. The 4th param is
 *  optional so every existing call site (and the ALS-undefined top level)
 *  stays byte-identical. */
export function decorateChildGate<G extends PermissionGateFn>(
  gate: G,
  asker: AskerInfo,
  getRootMessages: () => readonly AgentMessage[] | undefined,
  approvals?: ChildApprovalFace,
): G {
  const wrapped = (toolName: string, input: Record<string, unknown>): unknown =>
    askStorage.run({ asker, getRootMessages, ...(approvals !== undefined ? { approvals } : {}) }, () => gate(toolName, input));
  return wrapped as G;
}

/** The asker context of the current async chain — undefined on the happy
 *  path (every top-level ask), which is the byte-identical guarantee. */
export function currentAskContext(): AskContext | undefined {
  return askStorage.getStore();
}

/** The digest lines for the ask text, or undefined when there is no asker
 *  context (top-level asks render exactly as today). With a context but no
 *  reachable root messages (embedder without getForkContext), the asker line
 *  still renders — clean degradation, never a fabricated instruction. */
export function askDigestPrefix(): string | undefined {
  const ctx = askStorage.getStore();
  if (ctx === undefined) return undefined;
  const messages = ctx.getRootMessages();
  return renderAskDigest(buildAuthzExcerpt(messages ?? []), ctx.asker);
}
