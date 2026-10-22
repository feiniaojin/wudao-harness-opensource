// M43-C suite 3 — exit cleanup: window close → sidecar dies, with the
// SIGTERM → grace → SIGKILL zombie fallback and full reaping. Mirrors the
// Rust shell's terminate() (src-tauri/src/main.rs).
import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { launchSidecar, terminateSidecar } from "../src/sidecar-protocol.ts";

const FAKE = fileURLToPath(new URL("./fake-sidecar.ts", import.meta.url));

function sidecar(mode: string, ...args: string[]): { command: string; args: string[] } {
  return { command: process.execPath, args: [FAKE, mode, ...args] };
}

function exitState(child: { exitCode: number | null; signalCode: string | null }): string {
  if (child.exitCode !== null) return `code=${child.exitCode}`;
  return `signal=${child.signalCode}`;
}

describe("terminateSidecar (exit cleanup)", () => {
  it("SIGTERMs a well-behaved sidecar within the grace window", async () => {
    const launched = await launchSidecar({ ...sidecar("url"), timeoutMs: 10_000 });
    const method = await terminateSidecar(launched.child, { graceMs: 3_000 });
    expect(method).toBe("terminated");
    expect(exitState(launched.child)).toBe("signal=SIGTERM");
  });

  // Windows: Node's kill("SIGTERM") is an immediate TerminateProcess — a
  // signal handler cannot swallow it, so the zombie path is untestable there.
  it.skipIf(process.platform === "win32")("falls back to SIGKILL when the sidecar ignores SIGTERM (zombie)", async () => {
    const launched = await launchSidecar({ ...sidecar("ignore-term"), timeoutMs: 10_000 });
    const started = Date.now();
    const method = await terminateSidecar(launched.child, { graceMs: 500 });
    expect(method).toBe("killed");
    // It waited the grace period before escalating…
    expect(Date.now() - started).toBeGreaterThanOrEqual(450);
    // …and reaped: the exit is observable, no dangling process.
    expect(exitState(launched.child)).toBe("signal=SIGKILL");
    expect(launched.child.exitCode).toBeNull();
  });

  it("resolves 'exited' immediately for an already-dead child (idempotent re-run)", async () => {
    const launched = await launchSidecar({ ...sidecar("url"), timeoutMs: 10_000 });
    launched.child.kill("SIGKILL");
    await new Promise<void>((resolve) => launched.child.once("exit", () => resolve()));
    const method = await terminateSidecar(launched.child, { graceMs: 100 });
    expect(method).toBe("exited");
  });

  it("leaves nothing behind after terminate (no residue)", async () => {
    const launched = await launchSidecar({ ...sidecar("ignore-term"), timeoutMs: 10_000 });
    await terminateSidecar(launched.child, { graceMs: 300 });
    // After the awaited terminate the pid is gone: a second kill must throw
    // ESRCH (or the process is already reaped) — never silently succeed on a
    // live pid.
    let residue = false;
    try {
      process.kill(launched.child.pid as number, 0);
      residue = true;
    } catch {
      residue = false;
    }
    expect(residue).toBe(false);
  });
});
