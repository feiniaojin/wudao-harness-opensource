// M43-C — the sidecar stdout protocol, as an executable spec.
//
// The desktop shell (Rust) and this module implement the SAME contract:
//   1. the shell spawns the sidecar (standalone-compiled wudao-server, Node
//      SEA) with cwd = the workspace dir;
//   2. the sidecar prints a banner and then exactly one protocol line
//      `open: http://127.0.0.1:<port>/#<token>` (the existing `wudao ui`
//      announce output — nothing new was invented for the desktop);
//   3. the shell navigates the window to that URL (token rides the fragment,
//      existing first-frame auth unchanged);
//   4. when the window/app exits, the shell terminates the sidecar:
//      SIGTERM → wait a grace period → SIGKILL (zombie fallback) → reap.
//
// The parser here is intentionally tiny and total: every input either yields
// a validated handshake or null — never throws. The Rust side
// (src-tauri/src/main.rs) mirrors these exact rules; these tests are the
// shared source of truth.

import { spawn, type ChildProcess } from "node:child_process";

/** The stdout prefix that carries the handshake (`wudao ui`'s announce line). */
export const PROTOCOL_PREFIX = "open: ";

/** Min token length we accept (the server generates 32B base64url ≈ 43 chars). */
export const MIN_TOKEN_LENGTH = 16;

/** The handshake payload extracted from a protocol line. */
export interface SidecarHandshake {
  /** Full URL to navigate to (fragment carries the token). */
  readonly url: string;
  /** TCP port the server bound (1-65535). */
  readonly port: number;
  /** Shared-secret from the URL fragment. */
  readonly token: string;
}

// base64url token charset — anything else in the fragment is not our server.
const URL_PATTERN = /^http:\/\/127\.0\.0\.1:(\d+)\/#([A-Za-z0-9_-]+)$/;

/**
 * Parse one stdout line. Returns the handshake when the line is a valid
 * protocol line, else null — banner noise, prompts and partial lines are all
 * expected input and must not throw.
 */
export function parseProtocolLine(line: string): SidecarHandshake | null {
  if (!line.startsWith(PROTOCOL_PREFIX)) return null;
  const rest = line.slice(PROTOCOL_PREFIX.length);
  const match = URL_PATTERN.exec(rest);
  if (match === null) return null;
  const port = Number(match[1]);
  const token = match[2] ?? "";
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  if (token.length < MIN_TOKEN_LENGTH) return null;
  return { url: `http://127.0.0.1:${port}/#${token}`, port, token };
}

/**
 * Incremental line scanner for a child's stdout stream: feed arbitrary chunks
 * (split mid-line, CRLF, whatever), get complete lines back. The remainder is
 * kept until its newline arrives — a partial protocol line must NOT parse.
 */
export class ProtocolLineScanner {
  private buffer = "";

  /** Feed a chunk; returns the complete lines found in it (LF stripped). */
  push(chunk: string): readonly string[] {
    this.buffer += chunk;
    const lines: string[] = [];
    let idx = this.buffer.indexOf("\n");
    while (idx !== -1) {
      const line = this.buffer.slice(0, idx).replace(/\r$/, "");
      lines.push(line);
      this.buffer = this.buffer.slice(idx + 1);
      idx = this.buffer.indexOf("\n");
    }
    return lines;
  }
}

//
// Launch (handshake) and terminate — process-level halves of the same spec.
// Used by `desktop:smoke` and the tests; the Rust shell mirrors them.
//

export interface LaunchSidecarOptions {
  readonly command: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  /** How long to wait for the protocol line before failing (default 15s). */
  readonly timeoutMs?: number;
  /** Lines of stderr retained for failure reports (default 40). */
  readonly stderrTail?: number;
}

export interface LaunchedSidecar {
  readonly handshake: SidecarHandshake;
  readonly child: ChildProcess;
  /** Last stderr lines (populated best-effort; useful when things die). */
  readonly stderrTail: readonly string[];
}

/**
 * Spawn the sidecar and await its protocol line. Resolves with the handshake
 * and the live child. Rejects when:
 *   - the child exits before a protocol line (early exit; carries exit code
 *     and stderr tail), or
 *   - no protocol line arrives within timeoutMs (the child is terminated).
 * Banner lines before the protocol line are skipped silently.
 */
export function launchSidecar(opts: LaunchSidecarOptions): Promise<LaunchedSidecar> {
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const tailMax = opts.stderrTail ?? 40;

  const child = spawn(opts.command, [...(opts.args ?? [])], {
    ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
    env: { ...process.env, ...(opts.env ?? {}) },
    stdio: ["ignore", "pipe", "pipe"],
  });

  return new Promise<LaunchedSidecar>((resolve, reject) => {
    const scanner = new ProtocolLineScanner();
    const stderrTail: string[] = [];
    let settled = false;

    const fail = (err: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Never leave a stray child behind on the failure path.
      try {
        if (child.pid !== undefined) child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
      reject(err);
    };
    const done = (handshake: SidecarHandshake): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout?.removeListener("data", onData);
      resolve({ handshake, child, stderrTail });
    };

    const timer = setTimeout(() => {
      fail(new Error(`sidecar handshake timed out after ${timeoutMs}ms (no "open:" line on stdout)`));
    }, timeoutMs);
    timer.unref?.();

    const onData = (chunk: Buffer): void => {
      for (const line of scanner.push(chunk.toString("utf8"))) {
        const handshake = parseProtocolLine(line);
        if (handshake !== null) {
          done(handshake);
          return;
        }
      }
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", (chunk: Buffer) => {
      for (const line of scanner.push(chunk.toString("utf8"))) stderrTail.push(line);
      while (stderrTail.length > tailMax) stderrTail.shift();
    });
    child.once("error", (err) => fail(new Error(`sidecar failed to spawn: ${err.message}`)));
    child.once("exit", (code, signal) => {
      if (!settled) {
        const tail = stderrTail.join("\n");
        fail(
          new Error(
            `sidecar exited before handshake (code=${String(code)} signal=${String(signal)})` +
              (tail !== "" ? `\nstderr tail:\n${tail}` : ""),
          ),
        );
      }
    });
  });
}

export interface TerminateSidecarOptions {
  /** Grace period between SIGTERM and the SIGKILL fallback (default 3000ms). */
  readonly graceMs?: number;
}

/**
 * Terminate a sidecar child: SIGTERM (the server's clean-shutdown path),
 * wait up to graceMs, then SIGKILL (zombie fallback), then reap.
 * Resolves with which method ended the process. Idempotent-safe: a child
 * that already exited resolves immediately with "exited".
 */
export async function terminateSidecar(
  child: ChildProcess,
  opts: TerminateSidecarOptions = {},
): Promise<"terminated" | "killed" | "exited"> {
  const graceMs = opts.graceMs ?? 3_000;

  const exited = new Promise<void>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) resolve();
    else child.once("exit", () => resolve());
  });

  if (child.exitCode !== null || child.signalCode !== null) return "exited";

  try {
    if (child.pid !== undefined) child.kill("SIGTERM");
  } catch {
    return "exited";
  }

  const graceful = await Promise.race([
    exited.then((): boolean => true),
    new Promise<boolean>((resolve) => {
      const t = setTimeout(() => resolve(false), graceMs);
      t.unref?.();
    }),
  ]);
  if (graceful) return "terminated";

  try {
    if (child.pid !== undefined) child.kill("SIGKILL");
  } catch {
    /* raced with natural exit — the await below still reaps */
  }
  await exited;
  return "killed";
}
