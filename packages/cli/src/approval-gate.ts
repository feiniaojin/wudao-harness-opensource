// ω99-56 — the file-edits approval gate (deslop). A skill whose frontmatter
// declares `approval-gate: file-edits` runs the session under a per-path
// human-approval posture for the edit class (edit/write_file): an edit the
// pipeline would silently allow ASKS instead, the y/a/p/N ask menu answers
// through the EXISTING applyAskAnswer machinery, and an `a`/`p` answer's
// path-scoped session rule ("edit:<path>") becomes the receipt that keeps
// that exact tool+path ask-free for the session's remainder.
//
// Position (deliberately OUTSIDE the 5-layer static pipeline — no new layer):
// the driver's run gate consults this BEFORE the frontend gate and flips only
// its receipt-less ALLOWS into asks; deny/protected-file/ask outcomes pass
// through untouched (narrowing composes, widening is impossible). The receipt
// store is driver-local — fed from askPermission's answers (the ONE seam both
// ask paths share: the parked pendingPermission and the frontend's
// onPermissionAsk), so it can never drift from what the human actually
// granted: both derive from the same applyAskAnswer call.
import { applyAskAnswer, FILE_EDIT_TOOLS, ruleMatches } from "./permission.js";
import type { AskAnswer } from "./permission.js";

/** The only gate mode v1 recognizes (tolerant parse: anything else is
 *  ignored, exactly like every other unknown frontmatter posture). */
export type ApprovalGateMode = "file-edits";

/** The per-driver gate state: `armed` flips at /skill:<name> invocation and
 *  back at /clear; `receipts` holds the path-scoped session rules recorded
 *  from the human's a/p answers while armed. `humanSettled` is the ω99-70
 * per-call marker: the input object of a call the human JUST decided at
 * this lane's ask seam (identity-keyed, not content — every layer passes
 * the same reference down and a NEW call is a NEW object, so the marker can
 * never outlive its call). */
export interface ApprovalGateState {
  armed: boolean;
  readonly receipts: Set<string>;
  humanSettled: Record<string, unknown> | null;
}

export function createApprovalGateState(): ApprovalGateState {
  return { armed: false, receipts: new Set<string>(), humanSettled: null };
}

/** Is this call in the gated class (the file-edit tools)? Read-class and
 *  command tools are never gated — the posture covers deletions, not work. */
export function approvalGatedCall(toolName: string): boolean {
  return FILE_EDIT_TOOLS.has(toolName);
}

/** Does a recorded receipt cover this exact call? Same ruleMatches semantics
 *  as the pipeline's session-allowlist layer (normalizePath prefix match), so
 *  `edit:src/a.ts` covers src/a.ts and nothing else — a sibling path, or the
 *  other edit tool on the same path, keeps asking. */
export function approvalReceiptMatches(receipts: ReadonlySet<string>, toolName: string, input: Record<string, unknown>): boolean {
  for (const r of receipts) {
    if (ruleMatches(r, toolName, input)) return true;
  }
  return false;
}

/** Record the receipt for an ask the human just answered — but ONLY while
 *  armed and ONLY for the gated class: the same applyAskAnswer that owns the
 *  protected-write degradation (a settings write yields NO rule) produces the
 *  path-scoped rule, so the receipt can never be wider than the grant. */
export function recordApprovalReceipt(state: ApprovalGateState, answer: AskAnswer, toolName: string, input: Record<string, unknown>): void {
  if (!state.armed || !approvalGatedCall(toolName)) return;
  const { sessionRule } = applyAskAnswer(answer, toolName, input);
  if (sessionRule !== null) state.receipts.add(sessionRule);
}

// ---------------------------------------------------------------------------
// ω99-70 — "this call the human already decided" (the single-ask rule).
// The armed gate flips only SILENT allows. But the frontend layer it
// consults can itself ask the human (the M45 sidecar high-risk escalation
// resolves INSIDE the decide stack, through the very ask seam the gate's
// flip would use): the human answers y, an allow bubbles back up, and the
// gate — seeing only "allow" — flipped it into a SECOND ask of a call the
// human had just decided. The fix is one judgment, shared by both lanes'
// gate blocks: a call the human settled at the ask seam is never flipped.
// ---------------------------------------------------------------------------

/** Mark, at the lane's ask seam (the one place a human answer lands — the
 *  driver's askPermission, the REPL's askHuman), that THIS call was just
 *  human-decided. Same armed/gated scoping as recordApprovalReceipt: the
 *  marker only exists where a gate could consult it. Called when the answer
 *  is in hand (the ask resolved), so a still-pending ask marks nothing. */
export function markHumanSettled(state: ApprovalGateState, toolName: string, input: Record<string, unknown>): void {
  if (!state.armed || !approvalGatedCall(toolName)) return;
  state.humanSettled = input;
}

/** The gate-block side of ω99-70: after the consult (o.canUseTool /
 *  layeredDecide) returns its allow, was THIS exact call settled by the
 *  human inside it? Identity is the call's input object — every layer
 *  passes the same reference, and a new call (same content, fresh object)
 *  is a NEW decision, so `y` (allow-once) can never silently grow into a
 *  session allow. One-shot: the matching consume clears the marker. */
export function humanSettledThisCall(state: ApprovalGateState, input: Record<string, unknown>): boolean {
  if (state.humanSettled !== input) return false;
  state.humanSettled = null;
  return true;
}
