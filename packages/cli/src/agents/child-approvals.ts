// ω99-43 — durable child approval receipts (the upstream format #5543's mechanism,
// wudao's landing). A session'd child's human ask/answer used to live only
// in process memory: the parent dies → the sidechain carries the message
// flow but ZERO approval trace → a resumed child re-asks the same question
// (or, headless, silently re-denies). The receipt closes that hole WITHOUT
// a new store: it rides the child's OWN sidechain file as an M35 §2 generic
// entry, and the key is CONTENT-ADDRESSED — `<tool>#<hash(canonicalJson(
// input))>`, i.e. core's callFingerprint verbatim (single canonical
// serializer; never a second key-ordering). Content addressing structurally
// kills the upstream's boot-id hazard: different content never matches, and the
// same content matching across a restart IS the continuity feature.
//
// Lifecycle: the face is built at the child's spawn site (the task tool,
// where the sidechain store + id are resolved) and lives inside the ω-4e
// AskContext — a per-spawn memory object that dies with the child's gate.
// No new env, no new config face, no global singleton.
import { callFingerprint } from "@wudao/core";
import type { PermissionDecision, SessionStore } from "@wudao/core";

/** The generic-entry type tag (brief §1.1). Old readers never see it in the
 *  message stream — loadSidechain filters non-messages — and entry readers
 *  treat it as any other GenericSessionEntry. */
export const APPROVAL_RECEIPT_TYPE = "approval-receipt";

/** One receipt's payload — the writer's contract, not the store's. */
export interface ApprovalReceiptData {
  readonly tool: string;
  readonly inputKey: string;
  readonly decision: PermissionDecision;
  /** ISO timestamp of the human's answer. */
  readonly ts: string;
}

/** The face the ask seam consumes (brief §1.3/§1.4): a replay lookup before
 *  the decision, a fail-closed commit after it. */
export interface ChildApprovalFace {
  /** The recorded decision for exactly this (tool, input), or undefined. */
  readonly lookup: (toolName: string, input: Record<string, unknown>) => PermissionDecision | undefined;
  /** Append the receipt to the child's sidechain; a rejection must surface
   *  (the caller blocks execution — a decision that cannot be committed
   *  never happened). */
  readonly commit: (toolName: string, input: Record<string, unknown>, decision: PermissionDecision) => Promise<void>;
}

/** The content-addressed identity of an ask — loop-safety's call key shape,
 *  byte-for-byte (argument order never changes the key). */
export function approvalInputKey(toolName: string, input: Record<string, unknown>): string {
  return callFingerprint({ name: toolName, args: input });
}

function isValidDecision(v: unknown): v is PermissionDecision {
  if (typeof v !== "object" || v === null) return false;
  const d = v as Record<string, unknown>;
  return d.behavior === "allow" || (d.behavior === "deny" && (d.reason === undefined || typeof d.reason === "string"));
}

/** Structural validation of a receipt line — the sidechain is untrusted on
 *  disk (torn writes, manual edits); a malformed receipt is skipped, never
 *  fatal, never answered from. */
function receiptFrom(entry: unknown): ApprovalReceiptData | undefined {
  if (typeof entry !== "object" || entry === null) return undefined;
  const e = entry as Record<string, unknown>;
  if (e.type !== APPROVAL_RECEIPT_TYPE || typeof e.data !== "object" || e.data === null) return undefined;
  const d = e.data as Record<string, unknown>;
  if (typeof d.tool !== "string" || typeof d.inputKey !== "string" || typeof d.ts !== "string") return undefined;
  if (!isValidDecision(d.decision)) return undefined;
  return { tool: d.tool, inputKey: d.inputKey, decision: d.decision, ts: d.ts };
}

/** Build the face over a child's sidechain: load the already-persisted
 *  receipts (a resume's continuity — decisions the human gave the PREVIOUS
 *  process) into a per-spawn index, and commit new ones through the store's
 *  append-only entry path. Later duplicates of one inputKey win (last
 *  recorded decision is the human's latest word). */
export async function buildChildApprovals(store: SessionStore, sideId: string): Promise<ChildApprovalFace> {
  const index = new Map<string, PermissionDecision>();
  for (const entry of await store.loadSidechainEntries(sideId)) {
    const r = receiptFrom(entry);
    if (r !== undefined) index.set(r.inputKey, r.decision);
  }
  return {
    lookup: (toolName, input) => index.get(approvalInputKey(toolName, input)),
    async commit(toolName, input, decision) {
      const inputKey = approvalInputKey(toolName, input);
      await store.appendSidechainEntry(sideId, {
        type: APPROVAL_RECEIPT_TYPE,
        data: { tool: toolName, inputKey, decision, ts: new Date().toISOString() },
      });
      // The receipt is durable the moment it lands — a second identical ask
      // within the same run replays it (the human already answered exactly
      // this content).
      index.set(inputKey, decision);
    },
  };
}
