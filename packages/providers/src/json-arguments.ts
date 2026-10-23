// 拆分运动 C：从 openai-compatible.ts 原样外提的流式 tool-call 参数 JSON 修复梯子
//（波次 7 #33，a reference harness parse_json_with_repair）。纯函数模块，零依赖。
/** 波次 7 #33 (a reference harness parse_json_with_repair + truncation salvage): the
 *  deterministic repair ladder for streamed tool-call arguments. Torn SSE
 *  fragments, literal control chars from local backends, and the 2M-cap
 *  marker all poison the accumulated JSON — the old catch{} returned {}
 *  SILENTLY (the tool ran with no arguments, or died on a misleading
 *  "missing required field" validation error). Ladder, cheapest first:
 *    1. strict parse (zero-change fast path)
 *    2. ```json fence strip (a reference harness: only when BOTH fence ends present)
 *    3. first balanced object payload in prose (a reference harness, ≤64 starts)
 *    4. escape literal C0 controls inside strings (wudao extension — the
 *       local-backend trigger)
 *    5. truncation salvage: close an open string + the bracket stack, then
 *       a second pass that drops the trailing partial member first
 *  Anything unsalvageable falls back to `_unparsed` — the SAME visible
 *  convention as anthropic.ts and responses.ts, never a silent {}. */
export function parseToolCallArguments(raw: string): Record<string, unknown> {
  // Empty/whitespace args are a NORMAL stream edge (a no-arg tool, or the
  // fragment stream not started) — not damage; keep the legacy {}.
  if (raw.trim() === "") return {};
  const direct = tryParseObject(raw);
  if (direct !== undefined) return direct;
  const unfenced = stripCodeFence(raw);
  if (unfenced !== raw) {
    const p = tryParseObject(unfenced);
    if (p !== undefined) return p;
  }
  const extracted = firstBalancedObjectPayload(unfenced);
  if (extracted !== undefined) {
    const p = tryParseObject(extracted);
    if (p !== undefined) return p;
  }
  const base = escapeControlChars(extracted ?? unfenced);
  const closed = tryParseObject(closeTruncatedJson(base));
  if (closed !== undefined) return closed;
  const trimmed = tryParseObject(closeTruncatedJson(trimPartialMember(base)));
  if (trimmed !== undefined) return trimmed;
  return { _unparsed: raw };
}

/** Strict parse that accepts only object-shaped results (the legacy
 *  predicate — arrays pass through as the record cast, matching the old
 *  parseArguments behavior). */
function tryParseObject(text: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** a reference harness repair_json_text_once: strip a ```json / ``` fence — only when
 *  BOTH the prefix and the closing fence are present; anything else is
 *  returned trimmed, untouched. */
function stripCodeFence(raw: string): string {
  const trimmed = raw.trim();
  const afterPrefix = trimmed.startsWith("```json") ? trimmed.slice(6)
    : trimmed.startsWith("```") ? trimmed.slice(3)
    : null;
  if (afterPrefix === null) return trimmed;
  if (!afterPrefix.endsWith("```")) return trimmed;
  return afterPrefix.slice(0, -3).trim();
}

// Repair scans untrusted model text once per possible container start; keep
// the fallback bounded when malformed output contains a delimiter flood.
const JSON_REPAIR_CANDIDATE_LIMIT = 64;

/** a reference harness first_valid_json_payload: the first `{`/`[` start whose payload
 *  is balanced AND parses as an object. Skips balanced-but-poisoned
 *  candidates (their content may still be recovered by stage 4 via the
 *  unfenced fallback — that is exactly a reference harness's unwrap_or shape). */
function firstBalancedObjectPayload(raw: string): string | undefined {
  let attempted = 0;
  for (let start = 0; start < raw.length; start += 1) {
    const open = raw[start];
    if (open !== "{" && open !== "[") continue;
    attempted += 1;
    if (attempted > JSON_REPAIR_CANDIDATE_LIMIT) break;
    const end = balancedJsonEnd(raw, start);
    if (end === undefined) continue;
    const candidate = raw.slice(start, end);
    if (tryParseObject(candidate) !== undefined) return candidate;
  }
  return undefined;
}

/** String/escape-aware balanced scan: index AFTER the closer matching the
 *  opener at `start`, or undefined when the payload is torn or mismatched. */
function balancedJsonEnd(raw: string, start: number): number | undefined {
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  for (let i = start; i < raw.length; i += 1) {
    const ch = raw[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{" || ch === "[") stack.push(ch);
    else if (ch === "}" || ch === "]") {
      const opener = stack.pop();
      if (opener === undefined) return undefined;
      if ((opener === "{") !== (ch === "}")) return undefined;
      if (stack.length === 0) return i + 1;
    }
  }
  return undefined;
}

/** String-aware C0 escape (wudao extension): raw control characters inside
 *  strings are invalid JSON that local backends emit literally. \n \r \t
 *  get named escapes, the rest \\u00XX. */
function escapeControlChars(text: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  for (const ch of text) {
    if (inString) {
      if (escaped) { out += ch; escaped = false; continue; }
      if (ch === "\\") { out += ch; escaped = true; continue; }
      if (ch === '"') { out += ch; inString = false; continue; }
      if (ch < " ") {
        out += ch === "\n" ? "\\n" : ch === "\r" ? "\\r" : ch === "\t" ? "\\t" : `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`;
        continue;
      }
      out += ch;
      continue;
    }
    if (ch === '"') { inString = true; out += ch; continue; }
    out += ch;
  }
  return out;
}

/** Truncation salvage pass 1: close an open string (dropping a dangling
 *  escape backslash so it cannot eat the closer) and append the bracket
 *  closers in reverse stack order. */
function closeTruncatedJson(text: string): string {
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  for (const ch of text) {
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{" || ch === "[") stack.push(ch);
    else if (ch === "}" || ch === "]") stack.pop();
  }
  let out = inString && escaped ? text.slice(0, -1) : text;
  if (inString) out += '"';
  for (let i = stack.length - 1; i >= 0; i -= 1) out += stack[i] === "{" ? "}" : "]";
  return out;
}

/** Truncation salvage pass 2: cut back to the last member boundary outside
 *  strings (`,` `:` `{` `[`) so a dangling partial member does not poison
 *  the closure. */
function trimPartialMember(text: string): string {
  let lastBoundary = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "," || ch === ":" || ch === "{" || ch === "[") lastBoundary = i;
  }
  return lastBoundary === -1 ? text : text.slice(0, lastBoundary);
}
