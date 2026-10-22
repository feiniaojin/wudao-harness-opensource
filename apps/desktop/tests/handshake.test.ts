// M43-C suite 2 — the launch handshake against real fake-sidecar processes:
// port/token extraction from live stdout, timeout failure, early-exit failure
// (with stderr tail), and duplicate-line first-wins. Mirrors the Rust shell's
// handshake loop (src-tauri/src/main.rs).
import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { launchSidecar } from "../src/sidecar-protocol.ts";

const FAKE = fileURLToPath(new URL("./fake-sidecar.ts", import.meta.url));
const TOKEN = "A".repeat(43);

function sidecar(mode: string, ...args: string[]): { command: string; args: string[] } {
  return { command: process.execPath, args: [FAKE, mode, ...args] };
}

describe("launchSidecar (handshake)", () => {
  it("extracts url/port/token from the live protocol line", async () => {
    const launched = await launchSidecar({ ...sidecar("url", "0", "41234"), timeoutMs: 10_000 });
    expect(launched.handshake.port).toBe(41234);
    expect(launched.handshake.token).toBe(TOKEN);
    expect(launched.handshake.url).toBe(`http://127.0.0.1:41234/#${TOKEN}`);
    expect(launched.child.pid).toBeGreaterThan(0);
    launched.child.kill("SIGKILL");
  });

  it("waits through a delayed banner and a slow protocol line", async () => {
    const started = Date.now();
    const launched = await launchSidecar({ ...sidecar("url", "400", "41999"), timeoutMs: 10_000 });
    expect(Date.now() - started).toBeGreaterThanOrEqual(350);
    expect(launched.handshake.port).toBe(41999);
    launched.child.kill("SIGKILL");
  });

  it("resolves on the FIRST protocol line when two appear", async () => {
    const launched = await launchSidecar({ ...sidecar("url-twice"), timeoutMs: 10_000 });
    expect(launched.handshake.port).toBe(40001);
    expect(launched.handshake.token).toBe(TOKEN);
    launched.child.kill("SIGKILL");
  });

  it("fails on timeout when no protocol line ever arrives, and kills the child", async () => {
    await expect(
      launchSidecar({ ...sidecar("silent"), timeoutMs: 700 }),
    ).rejects.toThrow(/timed out after 700ms/);
  });

  it("fails on early exit and carries the exit code + stderr tail", async () => {
    await expect(
      launchSidecar({ ...sidecar("exit-early", "1"), timeoutMs: 10_000 }),
    ).rejects.toThrow(/exited before handshake \(code=1 signal=null\)[\s\S]*No API key found/);
  });

  it("fails fast on a missing binary (spawn error)", async () => {
    await expect(
      launchSidecar({ command: "/nonexistent/wudao-server", timeoutMs: 5_000 }),
    ).rejects.toThrow(/failed to spawn/);
  });
});
