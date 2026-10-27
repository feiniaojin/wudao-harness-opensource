// Structural validation + repair for entries loaded from a session file.
// Session JSONL is untrusted on disk (partial writes, manual edits, older
// formats) — load must never feed malformed messages into the loop/provider.
import type { AgentMessage, ToolResultMessage } from "../types.js";
import { isValidImageBlock, isValidFileBlock } from "../attachments.js";
import type { SessionEntry } from "./store.js";

export const UNAVAILABLE_TOOL_RESULT = "[session resumed: previous tool result unavailable]";

/** M79: an optional `images` field must be an array of well-formed image
 *  blocks wherever it may appear (user turns and tool results). A malformed
 *  field invalidates the whole message line — same skip-on-load posture as a
 *  junk content field. */
function validImagesField(msg: Record<string, unknown>): boolean {
  if (msg.images === undefined) return true;
  if (!Array.isArray(msg.images) || msg.images.length === 0) return false;
  return msg.images.every((b) => isValidImageBlock(b));
}

/** ω99-55: an optional `files` field is valid ONLY on user turns, as an
 *  array of well-formed file blocks (tools never emit files; a files field
 *  anywhere else — assistant, tool — invalidates the line, same
 *  skip-on-load posture). */
function validFilesField(msg: Record<string, unknown>, role: string): boolean {
  if (msg.files === undefined) return true;
  if (role !== "user") return false;
  if (!Array.isArray(msg.files) || msg.files.length === 0) return false;
  return msg.files.every((b) => isValidFileBlock(b));
}

export function isValidAgentMessage(m: unknown): m is AgentMessage {
  if (typeof m !== "object" || m === null) return false;
  const msg = m as Record<string, unknown>;
  if (msg.role === "user" || msg.role === "assistant") {
    if (typeof msg.content !== "string") return false;
    if (!validImagesField(msg)) return false;
    if (!validFilesField(msg, msg.role)) return false;
    if (msg.toolCalls !== undefined) {
      if (!Array.isArray(msg.toolCalls)) return false;
      for (const c of msg.toolCalls) {
        if (typeof c !== "object" || c === null) return false;
        const call = c as Record<string, unknown>;
        if (typeof call.id !== "string" || typeof call.name !== "string"
          || typeof call.arguments !== "object" || call.arguments === null) return false;
      }
    }
    return true;
  }
  if (msg.role === "tool") {
    return typeof msg.toolCallId === "string" && typeof msg.name === "string" && typeof msg.content === "string"
      && validImagesField(msg);
  }
  return false;
}

/** M28: a session line is valid if it is a well-formed message OR a
 *  well-formed model-state entry. Unknown entry types and malformed shapes
 *  are skipped on load (same tolerant posture as messages).
 *  M35 §2: a GENERIC `{type: string, data}` entry is valid too — `data`
 *  present marks the generic shape (a `{type, x}` line with no `data` key
 *  stays junk, exactly like before). */
export function isValidSessionEntry(v: unknown): v is SessionEntry {
  if (isValidAgentMessage(v)) return true;
  if (typeof v !== "object" || v === null) return false;
  const e = v as Record<string, unknown>;
  if (e.type === "model_change") {
    return typeof e.model === "string"
      && (e.provider === undefined || typeof e.provider === "string")
      && typeof e.at === "string";
  }
  if (e.type === "thinking_level_change") {
    return typeof e.level === "string";
  }
  // M63 §A: a provider switch entry — endpoint identity change.
  if (e.type === "provider_change") {
    return typeof e.provider === "string"
      && typeof e.model === "string"
      && (e.from === undefined || typeof e.from === "string")
      && typeof e.at === "string";
  }
  if (e.type === "session_name") {
    // 夜移 005: optional writer tag (derived | manual | llm) — additive.
    return typeof e.name === "string"
      && (e.source === undefined || e.source === "derived" || e.source === "manual" || e.source === "llm");
  }
  if (typeof e.type === "string" && "data" in e) return true; // generic M35 entry
  return false;
}

/** For each assistant toolCall whose result message is missing, inject a
 *  synthetic tool result after the contiguous run of tool results that
 *  answers the assistant message, so the sequence stays provider-legal
 *  (every tool_call needs a tool result). Idempotent. */
export function repairOrphanedToolCalls(messages: readonly AgentMessage[]): AgentMessage[] {
  const out: AgentMessage[] = [];
  let i = 0;
  while (i < messages.length) {
    const m = messages[i];
    if (!m) {
      i++;
      continue;
    }
    out.push(m);
    i++;
    if (m.role !== "assistant" || !m.toolCalls?.length) continue;
    // The tool results answering this assistant message are the contiguous
    // "tool" run right after it; consume them so orphans are appended after.
    const answered = new Set<string>();
    while (i < messages.length && messages[i]?.role === "tool") {
      const r = messages[i] as ToolResultMessage;
      answered.add(r.toolCallId);
      out.push(r);
      i++;
    }
    const orphans = m.toolCalls.filter((c) => !answered.has(c.id));
    for (const o of orphans) {
      const synthetic: ToolResultMessage = { role: "tool", toolCallId: o.id, name: o.name, content: UNAVAILABLE_TOOL_RESULT };
      out.push(synthetic);
    }
  }
  return out;
}
