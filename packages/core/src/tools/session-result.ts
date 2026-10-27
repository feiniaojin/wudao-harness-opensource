// ω-2b (I3) — session paged tool-result recovery (Reasonix tool_result
// capability, adapted). The full bytes of every tool result already live in
// the session JSONL (compaction stubs never persist — the originals are the
// record); the 100-char stub a microcompact leaves behind used to be a dead
// end. This tool pages those originals back into context on demand:
//   · 16KB default page, 24KB hard max;
//   · offsets/total in UTF-16 code units; sha256 over the FULL body's UTF-8
//     bytes rides every header (the model can verify page provenance and
//     detect content drift across a resume);
//   · page edges snap off surrogate halves (the JS analogue of Reasonix's
//     UTF-8 rune snapping) so pages always concatenate back to the original;
//   · the result_ref (pure sha256 of id+content, marker-embedded by the
//     compaction stubs) disambiguates retried duplicate tool_call_ids and
//     pins the exact candidate the stub pointed at.
// The injected `load` keeps core store-shape-agnostic; the CLI builds it
// with {store, sessionId} — a full-file scan per call, acceptable at
// recovery-call rarity (no store index: a deliberate non-goal).
import { createHash } from "node:crypto";
import { buildTool } from "../tool.js";
import type { Tool, ToolParameterSchema } from "../tool.js";
import type { ToolResultMessage } from "../types.js";

/** Default page size, UTF-16 code units (Reasonix: 16KB default). */
export const SESSION_RESULT_PAGE_DEFAULT = 16 * 1024;
/** Hard page-size ceiling, UTF-16 code units (Reasonix: 24KB max). */
export const SESSION_RESULT_PAGE_MAX = 24 * 1024;

/** The stable pointer to one exact (toolCallId, content) pair: the first 12
 *  hex chars of sha256 over id + NUL + body's UTF-8 bytes. Pure — the same
 *  pair always yields the same ref (marker-embedded args ride compaction
 *  stubs; a retried duplicate id with different content yields a different
 *  ref, which is exactly the disambiguation the ref exists for). The NUL
 *  separator cannot occur in a JSON-encoded id, so the concatenation is
 *  unambiguous. */
export function toolResultRef(toolCallId: string, body: string): string {
  return `tr-${createHash("sha256").update(`${toolCallId}\0${body}`, "utf8").digest("hex").slice(0, 12)}`;
}

/** One page's provenance header (rendered as the result's first JSON line). */
export interface SessionResultPageHeader {
  readonly result_ref: string;
  readonly offset: number;
  readonly next_offset: number;
  readonly total: number;
  readonly sha256: string;
  readonly complete: boolean;
}

/** True when the unit at `i` is a LOW surrogate (the second half of a pair):
 *  an offset landing here split a code point — snap the page start BACK one
 *  unit so the whole pair rides this page. */
function isLowSurrogateAt(s: string, i: number): boolean {
  const c = s.charCodeAt(i);
  return c >= 0xdc00 && c <= 0xdfff;
}

/** True when the unit at `i` is a HIGH surrogate whose LOW partner fell at
 *  `i + 1`: an end landing here split a pair — snap the end BACK one unit so
 *  the partner rides the NEXT page. */
function splitsPairAtEnd(s: string, end: number): boolean {
  if (end <= 0 || end >= s.length) return false;
  const c = s.charCodeAt(end - 1);
  if (!(c >= 0xd800 && c <= 0xdbff)) return false;
  return isLowSurrogateAt(s, end);
}

/** Page one tool-result body. Pure: the header carries the ref, the snapped
 *  window, the total, the whole-body sha256, and the completion bit; the
 *  returned page plus the follow-up pages concatenate to `body` exactly.
 *  Throws on a negative offset or a limit outside [1, SESSION_RESULT_PAGE_MAX]
 *  (argument errors — the tool surfaces them as typed error results). */
export function pageToolResult(
  body: string,
  offset: number,
  limit: number,
  resultRef?: string,
): { header: SessionResultPageHeader; page: string } {
  if (!Number.isInteger(offset) || offset < 0) {
    throw new Error(`session_result: offset must be an integer ≥ 0 (got ${String(offset)})`);
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > SESSION_RESULT_PAGE_MAX) {
    throw new Error(`session_result: limit must be an integer in [1, ${SESSION_RESULT_PAGE_MAX}] (got ${String(limit)})`);
  }
  const total = body.length;
  // Snap the start off a surrogate half (back one unit — the split pair
  // belongs to this page, never lost).
  let start = Math.min(offset, total);
  if (start > 0 && isLowSurrogateAt(body, start)) start -= 1;
  // Snap the end off a split pair (back one unit — the partner belongs to
  // the next page).
  let end = Math.min(start + limit, total);
  if (splitsPairAtEnd(body, end)) end -= 1;
  const page = body.slice(start, end);
  const nextOffset = end;
  return {
    header: {
      result_ref: resultRef ?? toolResultRef("", body),
      offset: start,
      next_offset: nextOffset,
      total,
      sha256: createHash("sha256").update(body, "utf8").digest("hex"),
      complete: nextOffset >= total,
    },
    page,
  };
}

/** The candidate list a recovery call resolves over (the loader's contract:
 *  every persisted tool result with this id, FILE ORDER = oldest first). */
export type SessionResultLoader = (toolCallId: string) => Promise<readonly ToolResultMessage[]>;

const PARAMETERS: ToolParameterSchema = {
  type: "object",
  properties: {
    tool_call_id: { type: "string", description: "the tool_call_id of the stubbed/cleared result to recover" },
    result_ref: { type: "string", description: "the tr-… ref embedded in the stub marker (required when the id was retried with different content)" },
    offset: { type: "number", description: `start offset in UTF-16 code units (default 0; snapped off surrogate halves)` },
    limit: { type: "number", description: `page size in UTF-16 code units (default ${SESSION_RESULT_PAGE_DEFAULT}, max ${SESSION_RESULT_PAGE_MAX})` },
  },
  required: ["tool_call_id"],
  additionalProperties: false,
};

/** The read-only recovery tool. `load` supplies the session's persisted
 *  results for an id (newest-first resolution happens here); the result is
 *  ONE JSON header line + the page body. */
export function createSessionResultTool(load: SessionResultLoader): Tool {
  return buildTool({
    name: "session_result",
    description:
      "Recover the full bytes of an old tool result that compaction stubbed or cleared (the stub marker names the tool_call_id and result_ref to use). " +
      "Pages through the retained original: each call returns one JSON header line (result_ref, offset, next_offset, total, sha256, complete) plus up to 16KB of body. " +
      `Follow next_offset for the next page until complete is true; pages concatenate exactly to the original. Do NOT use it for [SKILL_PRUNED] markers — reload those with read_file instead.`,
    parameters: PARAMETERS,
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    async execute(args) {
      const id = args["tool_call_id"];
      if (typeof id !== "string" || id === "") {
        return { content: "session_result: tool_call_id must be a non-empty string", isError: true };
      }
      const ref = args["result_ref"];
      if (ref !== undefined && (typeof ref !== "string" || ref === "")) {
        return { content: "session_result: result_ref, when given, must be a non-empty string", isError: true };
      }
      const offset = args["offset"] === undefined ? 0 : Number(args["offset"]);
      const limit = args["limit"] === undefined ? SESSION_RESULT_PAGE_DEFAULT : Number(args["limit"]);
      // Newest-first resolution: a retried id's LATEST result is the one the
      // model most likely wants; the ref pins the exact one when it matters.
      const candidates = [...await load(id)].reverse();
      if (candidates.length === 0) {
        return { content: `session_result: no tool result found for tool_call_id "${id}" in this session`, isError: true };
      }
      const refOf = (m: ToolResultMessage): string => toolResultRef(id, m.content);
      const selected =
        ref !== undefined
          ? candidates.find((m) => refOf(m) === ref)
          : candidates.length === 1
            ? candidates[0]
            : undefined;
      if (selected === undefined) {
        const refs = candidates.map((m) => `"${refOf(m)}"`).join(", ");
        return ref !== undefined
          ? { content: `session_result: result_ref "${ref}" matches none of the ${candidates.length} result(s) for tool_call_id "${id}" — candidates: ${refs}`, isError: true }
          : { content: `session_result: tool_call_id "${id}" is ambiguous (${candidates.length} persisted results) — retry with the result_ref of the one you want: ${refs}`, isError: true };
      }
      try {
        const { header, page } = pageToolResult(selected.content, offset, limit, refOf(selected));
        return { content: `${JSON.stringify(header)}\n${page}` };
      } catch (err) {
        return { content: err instanceof Error ? err.message : String(err), isError: true };
      }
    },
  });
}
