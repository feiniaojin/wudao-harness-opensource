// Hook stdout-JSON decision parsers — module-level segment extracted from
// hooks-config.ts (ω99 file-size discipline arc A): every "parse hook
// stdout as contract X" pure function plus the fileChangeTargets watcher
// plan. No IO, no runtime state.
import { truncateSafe } from "@wudao-org/core"; // 113-A4
import type { PermissionDecision, StopHookDecision } from "@wudao-org/core";
import type { HooksSettings } from "./hooks-config-types.js";

/** Parse stdout as the SubagentStop contract — the Stop spelling
 *  ({"continue":false}) or the block spelling ({"block":true}), both meaning
 *  "keep the child working". Anything else = allow. */
export function parseBlockJsonStop(stdout: string): { continue: false; reason?: string } | undefined {
  const first = stdout.split("\n").map((l) => l.trim()).find((l) => l !== "");
  if (first === undefined || !first.startsWith("{")) return undefined;
  try {
    const parsed = JSON.parse(first) as { block?: unknown; reason?: unknown; blockReason?: unknown };
    if (parsed["block"] !== true) return undefined;
    const reason = typeof parsed.reason === "string" && parsed.reason !== ""
      ? parsed.reason
      : typeof parsed.blockReason === "string" && parsed.blockReason !== ""
        ? parsed.blockReason
        : undefined;
    return { continue: false, ...(reason !== undefined ? { reason } : {}) };
  } catch {
    return undefined;
  }
}

/** M63-B: the FileChanged watcher plan — each SINGLE-TOKEN matcher value is
 *  a literal filename to watch (the spec's 字面文件名 — path characters are
 *  part of the name, so the plain/regex discrimination does not apply; a
 *  comma/pipe LIST or an absent matcher has no single enumerable target and
 *  contributes nothing — a matcherless entry still FIRES for every watched
 *  file, it just does not add one). */
export function fileChangeTargets(settings: HooksSettings): readonly string[] {
  const out: string[] = [];
  for (const entry of settings.onFileChanged ?? []) {
    const matcher = entry.matcher?.trim();
    // A comma/pipe LIST has no single target; regex metacharacters (other
    // than `.` — a path character) mark a RegExp spelling with no literal
    // file to watch.
    if (
      matcher !== undefined && matcher !== "" && !matcher.includes(",") && !matcher.includes("|")
      && !/[\\^$*+?()[\]{}]/.test(matcher)
    ) {
      out.push(matcher);
    }
  }
  return out;
}

// The stdout-first-line block protocol for preToolUse hooks: exactly
// {"block":true,"reason":"…"} (extra keys tolerated; reason falls back to a
// generic). Anything else — plain text, other JSON, malformed JSON — is not a
// block. M63-A §2: "blockReason" is the accepted alias spelling (the CC
// UserPromptSubmit contract) — same meaning wherever "block" appears.
export function parseBlockJsonLine(stdout: string): { block: true; reason: string } | undefined {
  const first = stdout.split("\n").map((l) => l.trim()).find((l) => l !== "");
  if (first === undefined || !first.startsWith("{")) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(first);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const rec = parsed as Record<string, unknown>;
  if (rec["block"] !== true) return undefined;
  const reason = typeof rec["reason"] === "string" && rec["reason"] !== ""
    ? rec["reason"]
    : typeof rec["blockReason"] === "string" && rec["blockReason"] !== ""
      ? rec["blockReason"]
      : "blocked by hook";
  return { block: true, reason };
}

/** M63-A: parse a preCompact hook's stdout as the DEFER contract.
 *  {"defer":true[,"reason"]} → defer; anything else (plain text, other JSON,
 *  junk) = proceed with the compaction. */
export function parseDeferJson(stdout: string): { defer: true; reason?: string } | undefined {
  const text = stdout.trim();
  if (text === "") return undefined;
  try {
    const parsed = JSON.parse(text) as { defer?: unknown; reason?: unknown };
    if (parsed["defer"] !== true) return undefined;
    return { defer: true, ...(typeof parsed.reason === "string" && parsed.reason !== "" ? { reason: parsed.reason } : {}) };
  } catch {
    return undefined;
  }
}

/** M63-A: parse a permissionRequest hook's stdout as the DECISION contract.
 *  {"decision":"allow"} → allow; {"decision":"deny"[,"reason"]} → deny;
 *  anything else = no opinion (the pipeline continues). */
export function parsePermissionDecisionJson(stdout: string): PermissionDecision | undefined {
  const text = stdout.trim();
  if (text === "") return undefined;
  try {
    const parsed = JSON.parse(text) as { decision?: unknown; reason?: unknown };
    if (parsed["decision"] === "allow") return { behavior: "allow" };
    if (parsed["decision"] === "deny") {
      return { behavior: "deny", ...(typeof parsed.reason === "string" && parsed.reason !== "" ? { reason: `permission hook: ${parsed.reason}` } : { reason: "denied by permission hook" }) };
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/** M63-C §2: parse a preToolUse hook's stdout as the REWRITE contract.
 *  {"updatedInput":{…}} (a non-empty object) replaces the call's arguments;
 *  anything else is not a rewrite (block is parseBlockJsonLine's business). */
export function parseUpdatedInputJson(stdout: string): Record<string, unknown> | undefined {
  const text = stdout.trim();
  if (text === "" || !text.startsWith("{")) return undefined;
  try {
    const parsed = JSON.parse(text) as { updatedInput?: unknown };
    if (parsed.updatedInput === null || typeof parsed.updatedInput !== "object" || Array.isArray(parsed.updatedInput)) return undefined;
    return parsed.updatedInput as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/** M63-A: parse a postToolBatch hook's stdout as the CONTINUE contract —
 *  the Stop-hook spelling. {"continue":false[,"reason"]} ends the run at the
 *  batch boundary; anything else = allow. */
export function parseContinueFalseJson(stdout: string): { continue: false; reason?: string } | undefined {
  const text = stdout.trim();
  if (text === "") return undefined;
  try {
    const parsed = JSON.parse(text) as { continue?: unknown; reason?: unknown };
    if (parsed["continue"] !== false) return undefined;
    return { continue: false, ...(typeof parsed.reason === "string" && parsed.reason !== "" ? { reason: parsed.reason } : {}) };
  } catch {
    return undefined;
  }
}

// The JSON summary handed to onRunStop commands on stdin.
/** M61 §3: parse a stop hook's stdout as the prompt-based Stop contract.
 *  {"continue": false[, "reason"]} → block; {"continue": true} or anything
 *  unparsable → undefined (allow; the exit-code path owns hard failures). */
export function parseStopHookJson(stdout: string): StopHookDecision | undefined {
  const text = stdout.trim();
  if (text === "") return undefined;
  try {
    const parsed = JSON.parse(text) as { continue?: unknown; reason?: unknown };
    if (parsed["continue"] === false) {
      return typeof parsed.reason === "string" && parsed.reason !== ""
        ? { continue: false, reason: parsed.reason }
        : { continue: false };
    }
    return undefined;
  } catch {
    return undefined;
  }
}

// M62 §5 — the additionalContext contract. A postToolUse hook exiting 0 may
// answer on stdout with the CC-style envelope; the inner string becomes
// model-visible context at the next model call. Anything else (plain text,
// other JSON, junk) is NOT context.
export const MAX_ADDITIONAL_CONTEXT_CHARS = 8_192;
const ADDITIONAL_CONTEXT_TRUNCATION = "\n[… additionalContext truncated at 8k chars …]";

/** Parse a TeammateIdle hook's stdout as {"continue":true,"feedback":"…"}
 *  (M64-C §C). Anything else is no opinion (stays idle). */
export function parseTeammateContinueJson(stdout: string): import("@wudao-org/core").TeammateIdleDecision | undefined {
  const text = stdout.trim();
  if (text === "") return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
  const rec = parsed as Record<string, unknown>;
  if (rec.continue !== true) return undefined;
  const feedback = typeof rec.feedback === "string" && rec.feedback !== "" ? rec.feedback : undefined;
  return { continue: true, ...(feedback !== undefined ? { feedback } : {}) };
}

/** Parse hook stdout as {"hookSpecificOutput":{"additionalContext":"…"}}.
 *  Undefined when the stdout is not that shape (plain stdout ≠ context). */
export function parseAdditionalContext(stdout: string): string | undefined {
  const text = stdout.trim();
  if (text === "") return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
  const outer = (parsed as Record<string, unknown>)["hookSpecificOutput"];
  if (typeof outer !== "object" || outer === null || Array.isArray(outer)) return undefined;
  const value = (outer as Record<string, unknown>)["additionalContext"];
  if (typeof value !== "string" || value === "") return undefined;
  return value;
}

/** Cap an additionalContext payload at 8k chars on a line boundary. Pure. */
export function capAdditionalContext(text: string): string {
  if (text.length <= MAX_ADDITIONAL_CONTEXT_CHARS) return text;
  const capped = truncateSafe(text, MAX_ADDITIONAL_CONTEXT_CHARS);
  const lastNl = capped.lastIndexOf("\n");
  return (lastNl === -1 ? capped : capped.slice(0, lastNl)) + ADDITIONAL_CONTEXT_TRUNCATION;
}
