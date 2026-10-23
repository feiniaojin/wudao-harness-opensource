// M58 §C#12 — bang mode: an input line starting with `!` runs the rest as a
// shell command in the user's shell. USER-INITIATED by construction (the
// human typed the line) — it never crosses the permission gate, the same
// trust class as the user typing in a terminal (CC's `!` semantics). The
// captured output is echoed (capped) and the command+output prefix the NEXT
// submitted user message as context, so the model sees what the user saw.
import { truncateSafe } from "@wudao/core"; // 113-A4
import { spawn } from "node:child_process";

/** Captured-output cap (spec: stdout 截 16k). */
export const BANG_OUTPUT_CAP = 16_000;

/** The command a `!`-prefixed line names, or undefined when the line is not
 *  a bang command (no leading `!`, or nothing after it). Leading whitespace
 *  before the `!` is tolerated; the command itself is trimmed. */
export function parseBangCommand(text: string): string | undefined {
  const trimmed = text.trimStart();
  if (!trimmed.startsWith("!")) return undefined;
  const rest = trimmed.slice(1).trim();
  return rest === "" ? undefined : rest;
}

export interface BangResult {
  readonly command: string;
  /** stdout+stderr, captured up to BANG_OUTPUT_CAP chars. */
  readonly output: string;
  readonly truncated: boolean;
  readonly code: number | null;
}

/** Run `command` in the user's shell ($SHELL, /bin/sh fallback) and capture
 *  stdout+stderr (capped). Never rejects — a spawn failure resolves as an
 *  output line, so the echo + next-message context still happen. */
export function runBangCommand(command: string, env: NodeJS.ProcessEnv = process.env): Promise<BangResult> {
  const shell = (env.SHELL ?? "").trim() !== "" ? (env.SHELL as string) : "/bin/sh";
  return new Promise((resolve) => {
    const child = spawn(shell, ["-c", command], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    const adopt = (chunk: Buffer | string): void => {
      if (out.length >= BANG_OUTPUT_CAP) return;
      out += chunk.toString("utf8");
    };
    child.stdout.on("data", adopt);
    child.stderr.on("data", adopt);
    child.on("error", (err) => {
      resolve({ command, output: `spawn failed: ${err.message}`, truncated: false, code: null });
    });
    child.on("close", (code) => {
      const truncated = out.length > BANG_OUTPUT_CAP;
      resolve({
        command,
        output: truncated ? truncateSafe(out, BANG_OUTPUT_CAP) : out,
        truncated,
        code,
      });
    });
  });
}

/** The human-facing echo of a finished command (what the user "saw"). */
export function formatBangEcho(r: BangResult): string {
  const parts = [`$ ${r.command}`];
  parts.push(r.output === "" ? "（无输出）" : r.output); // ω99-166e-i: #8（用户回显臂；:91 信封臂保持英文）
  if (r.truncated) parts.push(`[输出已在 ${BANG_OUTPUT_CAP} 字符处截断——完整捕获仍随下一条消息附送]`); // ω99-166e-i: #9（截断提示中文化；:94 信封臂保持英文）
  if (r.code !== null && r.code !== 0) parts.push(`（退出码 ${r.code}）`); // ω99-166e-i: #10（退出码回显中文化；:95 信封臂保持英文）
  return parts.join("\n");
}

/** The envelope's closing token — what embedded content must never emit
 *  raw (review fix, MINOR 1). */
const SHELL_CONTEXT_CLOSE = "</shell_context>";

/** Neutralize the envelope's closing token inside embedded content: a
 *  capture carrying the literal `</shell_context>` (e.g. `!cat` of a file
 *  that contains it) would otherwise break OUT of the block and let the
 *  rest of the capture pose as top-level user message bytes. The
 *  backslash-escaped form is model-legible and no longer the raw closer. */
export function neutralizeShellContextClose(text: string): string {
  return text.split(SHELL_CONTEXT_CLOSE).join("<\\/shell_context>");
}

/** The context block prefixed onto the NEXT submitted user message: the
 *  command plus its capped capture, envelope-tagged like the harness's other
 *  model-facing injections. Both embedded fields are closing-token-
 *  neutralized (MINOR 1), so the ONLY raw `</shell_context>` in the message
 *  is the envelope's own last line. */
export function buildBangContextPrefix(r: BangResult): string {
  const lines = [
    "<shell_context>",
    "The user ran this command in their terminal right before this message:",
    `$ ${neutralizeShellContextClose(r.command)}`,
    r.output === "" ? "(no output)" : neutralizeShellContextClose(r.output),
  ];
  if (r.truncated) lines.push(`[output truncated at ${BANG_OUTPUT_CAP} chars]`);
  if (r.code !== null && r.code !== 0) lines.push(`(exit code ${r.code})`);
  lines.push(SHELL_CONTEXT_CLOSE);
  return lines.join("\n");
}
