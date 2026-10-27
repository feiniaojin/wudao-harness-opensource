// #48 wiring — the lease's three enforcement lanes, end-to-end in-process:
//   engine boot   createDriverSession acquires sessionId0 BEFORE anything
//                 writes; a foreign live holder refuses the boot outright
//                 (the server/desktop must not come up double-opened), and
//                 close() releases the lease gracefully
//   driver run    the RUN is the write gate: startRun acquires the current
//                 session id before the first model call — a held session
//                 refuses with a ⚠️ history notice and the model is never
//                 called (no run → no appends → no interleaving)
//   driver resume adoption fail-fasts BEFORE the swap (held → false + the
//                 same honest notice; the current session stands)
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createScriptedModel } from "@wudao/core";
import type { ProviderConfig } from "@wudao/providers";
import { createDriverSession } from "../src/driver/session-engine.js";
import type { DriverSession } from "../src/driver/session-engine.js";
import { createAgentDriver } from "../src/driver/agent-driver.js";
import type { AgentDriverOptions } from "../src/driver/agent-driver.js";
import { summarizeToolCall } from "../src/log.js";

const config: ProviderConfig = { apiKey: "test-key", baseURL: "http://127.0.0.1:1/v1", model: "fake-model-x" };

const lockPath = (root: string, id: string): string => join(root, ".wudao", "sessions", ".leases", `${id}.json`);

/** Seed a LIVE foreign holder (our pid is alive and not in this process's
 *  lease registry — indistinguishable from another running wudao). */
const seedForeign = (root: string, id: string): void => {
  mkdirSync(dirname(lockPath(root, id)), { recursive: true });
  writeFileSync(lockPath(root, id), JSON.stringify({ pid: process.pid, at: new Date().toISOString(), gen: "foreign" }), "utf8");
};

const sessions: DriverSession[] = [];
const roots: string[] = [];
afterEach(async () => {
  for (const s of sessions.splice(0)) await s.close();
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

async function until(cond: () => boolean | Promise<boolean>, what: string, timeoutMs = 4000): Promise<void> {
  const start = Date.now();
  while (!(await cond())) {
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

function makeDriver(opts: Partial<AgentDriverOptions> & Pick<AgentDriverOptions, "model" | "tools">) {
  return createAgentDriver({ systemPrompt: "s", summarize: summarizeToolCall, ...opts });
}

describe("#48 engine boot lease — createDriverSession", () => {
  it("refuses the boot when a live foreign process holds the session (receipt names id + pid)", async () => {
    const ws = mkdtempSync(join(tmpdir(), "wudao-lease-eng-"));
    roots.push(ws);
    seedForeign(ws, "held-boot");
    await expect(
      createDriverSession({
        config,
        workspaceRoot: ws,
        contextWindowTokens: 64_000,
        modelOverride: createScriptedModel([]),
        tools: [],
        sessionId: "held-boot",
      }),
    ).rejects.toThrow(/held-boot/);
    expect(existsSync(lockPath(ws, "held-boot"))).toBe(true); // the foreign lock stands untouched
  });

  it("acquires the boot session's lease and close() releases it", async () => {
    const ws = mkdtempSync(join(tmpdir(), "wudao-lease-eng-"));
    roots.push(ws);
    const session = await createDriverSession({
      config,
      workspaceRoot: ws,
      contextWindowTokens: 64_000,
      modelOverride: createScriptedModel([]),
      tools: [],
      sessionId: "fresh-boot",
    });
    sessions.push(session);
    expect(existsSync(lockPath(ws, "fresh-boot"))).toBe(true);
    await session.close();
    expect(existsSync(lockPath(ws, "fresh-boot"))).toBe(false);
  });
});

describe("#48 driver run gate + resume lane", () => {
  it("a held session refuses the RUN: ⚠️ notice, model never called", async () => {
    const ws = mkdtempSync(join(tmpdir(), "wudao-lease-run-"));
    roots.push(ws);
    seedForeign(ws, "held-run");
    const model = createScriptedModel([{ role: "assistant", content: "should never run" }]);
    const driver = makeDriver({ model, tools: [], workspaceRoot: ws, sessionId: "held-run" });
    driver.submit("hello");
    await until(() => driver.getHistory().some((h) => h.kind === "notice"), "lease refusal notice");
    const notice = driver.getHistory().find((h) => h.kind === "notice");
    expect(notice?.kind === "notice" ? notice.text : "").toContain("held-run");
    expect(String(process.pid)).toMatch(/\d+/); // the receipt names the holder pid
    expect(notice?.kind === "notice" ? notice.text : "").toContain(String(process.pid));
    expect(model.calls).toBe(0);
    expect(driver.getStatus().busy).toBe(false);
    driver.dispose();
  });

  it("resume() fail-fasts on a held id (occupied outcome + notice, no adoption); adopts a free id and holds it", async () => {
    const ws = mkdtempSync(join(tmpdir(), "wudao-lease-res-"));
    roots.push(ws);
    // Seed real sessions: held-res EXISTS (another process is running it —
    // the realistic collision) and free-sess is adoptable.
    mkdirSync(join(ws, ".wudao", "sessions"), { recursive: true });
    const line = `${JSON.stringify({ role: "user", content: "q" })}\n${JSON.stringify({ role: "assistant", content: "a" })}\n`;
    for (const id of ["free-sess", "held-res"]) writeFileSync(join(ws, ".wudao", "sessions", `${id}.jsonl`), line, "utf8");
    seedForeign(ws, "held-res");
    const box: { current?: string } = {};
    const driver = makeDriver({ model: createScriptedModel([]), tools: [], workspaceRoot: ws, sessionId: "start-sess", sessionIdBox: box });
    // ω99-225: the refusal is the occupied outcome (holder pid = the seeded
    // foreign holder), never a bare false.
    expect(await driver.resume("held-res")).toEqual({ ok: false, reason: "occupied", holderPid: process.pid });
    const notice = driver.getHistory().find((h) => h.kind === "notice");
    expect(notice?.kind === "notice" ? notice.text : "").toContain("held-res");
    // No swap happened: the driver still runs as start-sess.
    expect(box.current).toBe("start-sess");
    // Free id: adopted AND its lease is now ours.
    expect(await driver.resume("free-sess")).toEqual({ ok: true });
    expect(box.current).toBe("free-sess");
    expect(existsSync(lockPath(ws, "free-sess"))).toBe(true);
    driver.dispose();
  });
});
