// ω-5a I20 — MCP frame tracing (the mcpsnoop import): an opt-in, crash-safe
// side-channel that records every JSON-RPC frame the client sends or receives
// plus transport lifecycle events (spawn/exit/timeout/abort). Zero
// dependencies; zero observable behavior when WUDAO_MCP_TRACE is unset.
//
// Modes (WUDAO_MCP_TRACE):
//   unset | ""                     → off (parseTraceEnv returns undefined)
//   1 | true | stderr              → header frames → process.stderr
//   <path> (contains "/" or ends .jsonl) → header frames → sync file append
//   <value>:full | full@<path> | full → full mode: bodies included (capped)
//
// Crash-safety: the file sink appends each record SYNCHRONOUSLY — a hung or
// crashed client process still leaves every frame it exchanged on disk, which
// is the entire point of the facility (inspector-style post-mortems).
//
// Redaction: header mode NEVER writes params/result bytes (method/id/size/
// latency only); full mode writes the wire line capped at TRACE_BODY_CAP —
// the explicit env opt-in is the consent boundary for recording possibly
// sensitive tool arguments to a local file or stderr.
import { truncateSafe } from "@wudao-org/core"; // 113-A4
import { appendFileSync } from "node:fs";

/** Cap on the `body` field (full mode only). */
export const TRACE_BODY_CAP = 2048;
/** Cap on the lifecycle `detail` field. */
export const TRACE_DETAIL_CAP = 200;

/** One traced frame or lifecycle event. Records are plain JSON values — the
 *  sink serializes one record per line. */
export interface McpFrameRecord {
  /** ISO timestamp. */
  readonly ts: string;
  /** Request/notification out, response in, lifecycle event. */
  readonly dir: "→" | "←" | "lifecycle";
  readonly method?: string;
  /** The client-side request id (requests and their responses only). */
  readonly id?: number;
  /** The frame's UTF-8 byte length (the JSON payload, excluding the newline). */
  readonly bytes: number;
  /** Responses only: request-send → settle. */
  readonly latencyMs?: number;
  /** Lifecycle only: spawn/exit/timeout/abort reason (capped). */
  readonly detail?: string;
  /** The wire line, ONLY in full mode (capped at TRACE_BODY_CAP). */
  readonly body?: string;
}

export type TraceMode = "off" | "header" | "full";

/** Injectable file-write seam (tests); defaults to node:fs appendFileSync. */
export interface TraceFsPath {
  writeSync(path: string, s: string): void;
}

/** Cap the body field (full mode). */
export function capTraceBody(line: string): string {
  return line.length > TRACE_BODY_CAP ? truncateSafe(line, TRACE_BODY_CAP) : line;
}

/** Cap the lifecycle detail field. */
export function capTraceDetail(detail: string): string {
  return detail.length > TRACE_DETAIL_CAP ? truncateSafe(detail, TRACE_DETAIL_CAP) : detail;
}

function isPathToken(t: string): boolean {
  return t.includes("/") || t.endsWith(".jsonl");
}

/**
 * Parse WUDAO_MCP_TRACE into `{mode, sink}`, or undefined when off.
 *
 * - unset/"" → undefined (off — the default; nothing is ever recorded).
 * - "1"/"true"/"stderr" → header mode → process.stderr.
 * - a path (any token containing "/" or ending ".jsonl") → header mode →
 *   one synchronous append per record.
 * - the "full" suffix (":full" after a value, or "full@<path>", or bare
 *   "full") enables capped bodies.
 * - any other token → undefined (off — fail-closed: an unrecognized value
 *   must not silently record frames anywhere).
 *
 * Header mode strips `body` from every record before writing (redaction);
 * full mode passes records through. The injected `fsPath` replaces the
 * appendFileSync call (deterministic tests).
 */
export function parseTraceEnv(
  v: string | undefined,
  fsPath?: TraceFsPath,
): { readonly mode: TraceMode; readonly sink: (r: McpFrameRecord) => void } | undefined {
  if (v === undefined || v === "") return undefined;
  let token = v.trim();
  if (token === "") return undefined;
  let full = false;
  if (token.endsWith(":full")) {
    full = true;
    token = token.slice(0, -":full".length);
  } else if (token.startsWith("full@")) {
    full = true;
    token = token.slice("full@".length);
  }
  const mode: TraceMode = full ? "full" : "header";
  // Redaction lives in the SINK: records may carry bodies (the emitter does
  // not know the mode), header-mode sinks strip the field before writing.
  const redact = (r: McpFrameRecord): McpFrameRecord => (mode === "header" && r.body !== undefined ? { ...r, body: undefined } : r);
  const line = (r: McpFrameRecord): string => `${JSON.stringify(redact(r))}\n`;
  if (token === "full" || token === "" || token === "1" || token === "true" || token === "stderr") {
    return { mode, sink: (r) => { process.stderr.write(line(r)); } };
  }
  if (isPathToken(token)) {
    const write = fsPath?.writeSync ?? ((path: string, s: string) => appendFileSync(path, s));
    return { mode, sink: (r) => { write(token, line(r)); } };
  }
  return undefined;
}
